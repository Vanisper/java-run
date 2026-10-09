import { stripVTControlCharacters } from 'node:util';
import type { Writable } from 'node:stream';
import { decodeOutput } from '../process/exec';
import { resolveTerminalPolicy, type TerminalPolicy } from './policy';
import { createTerminalLayout, formatDuration, type TerminalLayout } from './layout';
import { createLinePrefixer } from './line-prefix';
import type { LogType } from '../logging/logger';

/** 活动执行期间可更新的阶段与原始日志，调用范围限于活动回调 */
export interface ActivityFeedback {
  /** 更新当前步骤；不代表整个活动已经完成 */
  stage(label: string): void;
  /** 接收原始字节；mode 可覆盖默认显示模式，完整模式等待写入后返回 */
  output(chunk: { stream: 'stdout' | 'stderr'; data: Buffer }, mode?: 'summary' | 'full'): Promise<void>;
  /** 在当前组内追加一条日志 */
  log(type: LogType, message: string): Promise<void>;
  /** 在当前组内追加标签与关键值 */
  detail(label: string, value: string): Promise<void>;
  /** 暂停活动重绘并执行交互；回调收到组内前缀，交互与命令须串行执行 */
  interact<T>(work: (linePrefix: string) => Promise<T>): Promise<T>;
}

type ActivityOutput = Writable & { columns?: number; rows?: number };
const activeOutputs = new WeakSet<Writable>();

function text(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f]/g, ' ');
}

function fit(value: string, width: number): string {
  const clean = text(value);
  if (Bun.stringWidth(clean) <= width) return clean;
  let result = '';
  for (const { segment } of new Intl.Segmenter().segment(clean)) {
    if (Bun.stringWidth(result + segment) > width - 1) break;
    result += segment;
  }
  return result + '…';
}

/**
 * 在活动执行期间展示阶段、耗时和最近输出
 *
 * @description
 * - 只有 work 成功返回才显示完成，异常原样传递
 * - 不读取 stdin；返回或抛错前停止重绘并等待自身输出结束
 * - summary 仅预览最近三行，每行最多 16 KiB，完整诊断由命令执行器保存
 */
export async function activity<T>(
  label: string,
  work: (feedback: ActivityFeedback) => Promise<T>,
  policy: TerminalPolicy = resolveTerminalPolicy({}),
  output: ActivityOutput = process.stderr,
  options: {
    context?: readonly string[];
    layout?: TerminalLayout;
    /** 开始执行前展开组，即使工作很快结束 */
    expanded?: boolean;
    /** 覆盖取消判定，默认使用约定退出码 130 / 143 */
    isCancelled?: (error: unknown) => boolean;
    /** 失败时补充组内诊断；诊断失败不替换原异常 */
    onFailure?: (error: unknown, feedback: ActivityFeedback) => Promise<void>;
  } = {},
): Promise<T> {
  if (activeOutputs.has(output)) throw new Error('同一终端不能同时展示多个活动');
  activeOutputs.add(output);
  const layout = options.layout ?? createTerminalLayout(policy);
  const context = options.context ?? [];
  const border = '│ ';
  const prefixOutput = createLinePrefixer(border);
  const started = performance.now();
  const live = policy.rewrite && policy.animation && policy.logMode === 'summary';
  type PreviewLine = { data: Buffer; complete: boolean };
  const partial: Record<'stdout' | 'stderr', PreviewLine | undefined> = { stdout: undefined, stderr: undefined };
  const lines: PreviewLine[] = [];
  let current = label;
  let lastOutput = started;
  let frame: string[] = [];
  let closed = false;
  let busy = false;
  let writeError: Error | undefined;
  let lastByte = 10;
  let expansion: Promise<void> | undefined;
  let expandTimer: ReturnType<typeof setTimeout> | undefined;
  let suspended = 0;
  const pending = new Map<Promise<void>, (error: Error) => void>();
  const onError = (error: Error) => {
    writeError ??= error;
    for (const reject of pending.values()) reject(writeError);
  };
  const onClose = () => onError(output.errored ?? new Error('终端输出流已关闭'));
  output.on('error', onError);
  output.on('close', onClose);

  function write(value: string | Buffer): Promise<void> {
    if (output.destroyed) onClose();
    if (writeError) return Promise.reject(writeError);
    let complete!: () => void;
    let fail!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    pending.set(promise, fail);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    try {
      output.write(value, error => error ? onError(error) : complete());
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  function clear(): string {
    if (!frame.length) return '';
    const width = Math.max(1, (output.columns ?? 80));
    const rows = frame.reduce((sum, line) => sum + Math.max(1, Math.ceil(Bun.stringWidth(line) / width)), 0);
    frame = [];
    return '\r\x1b[2K' + '\x1b[1A\r\x1b[2K'.repeat(Math.max(0, rows - 1));
  }

  function expand(): Promise<void> {
    if (expansion) return expansion;
    if (expandTimer) clearTimeout(expandTimer);
    const stage = !live && current !== label ? border + layout.line('info', text(current)) + '\n' : '';
    expansion = write(layout.heading(label, context) + '\n' + stage);
    return expansion;
  }

  function announce(): Promise<void> {
    const newline = policy.logMode === 'full' && lastByte !== 10 ? '\n' : '';
    lastByte = 10;
    prefixOutput.reset();
    return write(newline + border + layout.line('info', text(current)) + '\n');
  }

  async function boundary(): Promise<void> {
    await expand();
    await Promise.allSettled(pending.keys());
    const separator = clear() + (lastByte !== 10 ? '\n' : '');
    if (separator) await write(separator);
    lastByte = 10;
    prefixOutput.reset();
  }

  async function message(value: string): Promise<void> {
    if (closed) throw new Error('活动已经结束');
    suspended++;
    try {
      await boundary();
      await write(value.split('\n').map(line => border + line).join('\n') + '\n');
    } finally {
      suspended--;
    }
  }

  function append(stream: 'stdout' | 'stderr', data: Buffer): void {
    let start = 0;
    for (let index = 0; index <= data.length; index++) {
      const end = index < data.length && (data[index] === 10 || data[index] === 13);
      if (!end && index !== data.length) continue;
      const segment = data.subarray(start, index);
      let line = partial[stream];
      if (segment.length || line) {
        line ??= { data: Buffer.alloc(0), complete: false };
        line.data = Buffer.concat([line.data, segment.subarray(0, Math.max(0, 16384 - line.data.length))]);
        line.complete = end;
        const old = lines.indexOf(line);
        if (old !== -1) lines.splice(old, 1);
        lines.push(line);
        if (lines.length > 3) lines.shift();
        partial[stream] = end ? undefined : line;
      }
      start = index + 1;
    }
  }

  function recent(): string[] {
    return lines.flatMap(line => {
      let decoded: string | undefined;
      // 未收齐或被预览限额截断的 UTF-8 字符暂不显示
      const incomplete = !line.complete || line.data.length === 16384;
      for (let missing = 0; missing <= (incomplete ? 3 : 0) && missing <= line.data.length; missing++) {
        try {
          decoded = new TextDecoder('utf-8', { fatal: true }).decode(line.data.subarray(0, line.data.length - missing));
          break;
        } catch { /* 非 UTF-8 行在换行后再检测编码 */ }
      }
      if (decoded === undefined && line.complete) decoded = decodeOutput(line.data);
      return decoded ? [text(decoded)] : [];
    });
  }

  function status(): string {
    const elapsed = ((performance.now() - started) / 1000).toFixed(1);
    const silent = Math.floor((performance.now() - lastOutput) / 1000);
    return `${text(current)} · ${elapsed}s${silent >= 10 ? ` · ${silent}s 无新输出` : ''}`;
  }

  function render(): void {
    if (closed || busy || suspended || writeError) return;
    if (live && performance.now() - started < 300) return;
    if (!expansion) {
      void expand().then(render).catch(() => {});
      return;
    }
    const previous = clear();
    if (live) {
      const width = Math.max(1, (output.columns ?? 80) - 1);
      const count = Math.max(0, Math.min(3, (output.rows ?? 24) - 2));
      const mark = ['|', '/', '-', '\\'][Math.floor((performance.now() - started) / 160) % 4];
      const prefix = border + layout.line('info', '', { indicator: mark });
      frame = [fit(prefix + status(), width), ...(count ? recent().slice(-count) : []).map(line => fit(`│ ${line}`, width))];
      busy = true;
      // 裁剪和清屏始终使用可见文字，颜色不参与宽度计算
      const visible = frame[0]!;
      const plainPrefix = text(prefix);
      const colored = visible.startsWith(plainPrefix) ? prefix + visible.slice(plainPrefix.length)
        : visible;
      void write(previous + [colored, ...frame.slice(1)].join('\n'))
        .finally(() => { busy = false; }).catch(() => {});
    } else {
      const logs = policy.logMode === 'summary' ? recent().map(line => `${border}${line}\n`).join('') : '';
      busy = true;
      void write(border + layout.line('info', `进行中 ${status()}`) + `\n${logs}`)
        .finally(() => { busy = false; }).catch(() => {});
    }
  }

  // 完整日志可能停在字符或行中间，此时插入状态文字会破坏原始输出
  const timer = policy.logMode === 'summary' ? setInterval(render, live ? 160 : 10000) : undefined;
  timer?.unref();
  if (!live) {
    expandTimer = setTimeout(() => { void expand().catch(() => {}); }, 300);
    expandTimer.unref();
  }
  if (live) output.on('resize', render);
  let failure: unknown;
  let failed = false;
  const feedback: ActivityFeedback = {
    stage(next) {
      if (closed) throw new Error('活动已经结束');
      if (next === current) return;
      current = next;
      lines.length = 0;
      partial.stdout = partial.stderr = undefined;
      if (!live && expansion) {
        void announce().catch(() => {});
      }
    },
    async output({ stream, data }, mode = policy.logMode) {
      if (closed) throw new Error('活动已经结束');
      lastOutput = performance.now();
      if (mode === 'full') {
        if (!data.length) return;
        suspended++;
        try {
          await expand();
          await Promise.allSettled(pending.keys());
          const previous = clear();
          if (previous) await write(previous);
          await write(prefixOutput.push(data));
          lastByte = data[data.length - 1]!;
        } finally {
          suspended--;
        }
      } else {
        append(stream, data);
      }
    },
    log: (type, value) => message(layout.line(type, value)),
    detail: (label, value) => message(layout.details(label, value)),
    async interact(work) {
      if (closed) throw new Error('活动已经结束');
      suspended++;
      try {
        await boundary();
        return await work(border);
      } finally {
        lines.length = 0;
        partial.stdout = partial.stderr = undefined;
        lastByte = 10;
        prefixOutput.reset();
        lastOutput = performance.now();
        suspended--;
      }
    },
  };
  try {
    if (options.expanded) await expand();
    return await work(feedback);
  } catch (error) {
    failed = true;
    failure = error;
    suspended++;
    try { await options.onFailure?.(error, feedback); } catch { /* 保留原始失败 */ }
    throw error;
  } finally {
    closed = true;
    if (timer) clearInterval(timer);
    if (expandTimer) clearTimeout(expandTimer);
    output.removeListener('resize', render);
    await Promise.allSettled(pending.keys());
    const exitCode = failure && typeof failure === 'object' && 'exitCode' in failure ? failure.exitCode : undefined;
    const cancelled = failed && (options.isCancelled?.(failure) ?? (exitCode === 130 || exitCode === 143));
    const type = cancelled ? 'warn' : failed ? 'error' : 'success';
    try {
      if (!writeError) {
        const newline = lastByte !== 10 ? '\n' : '';
        const durationMs = performance.now() - started;
        const code = typeof exitCode === 'number' && exitCode !== 0 ? ` (exit code ${exitCode})` : '';
        const result = expansion
          ? '└ ' + layout.line(type, `${cancelled ? 'Cancelled' : failed ? 'Failed' : 'Done'} in ${formatDuration(durationMs)}${code}`, { indicator: false })
          : layout.line(type, label + (cancelled ? '（已取消）' : failed ? '（失败）' : ''), { context, durationMs, indicator: false });
        await write(clear() + newline + result + '\n');
      }
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      // 写入回调可能先于 error 事件结束，等本轮事件排空后再释放监听
      if (writeError) await new Promise<void>(resolve => setTimeout(resolve, 0));
      output.removeListener('error', onError);
      output.removeListener('close', onClose);
      activeOutputs.delete(output);
    }
    if (!failed && writeError) throw writeError;
  }
}
