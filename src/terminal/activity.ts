import { stripVTControlCharacters } from 'node:util';
import type { Writable } from 'node:stream';
import { decodeOutput } from '../process/exec';
import { resolveTerminalPolicy, type TerminalPolicy } from './policy';
import { styleText } from './style';
import { createTerminalLayout, type TerminalLayout } from './layout';

/** 活动执行期间可更新的阶段与原始日志，调用范围限于活动回调 */
export interface ActivityFeedback {
  /** 更新当前步骤；不代表整个活动已经完成 */
  stage(label: string): void;
  /** 接收一个流的原始字节；完整日志模式等待输出写入后返回 */
  output(chunk: { stream: 'stdout' | 'stderr'; data: Buffer }): Promise<void>;
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
  options: { context?: readonly string[]; layout?: TerminalLayout } = {},
): Promise<T> {
  if (activeOutputs.has(output)) throw new Error('同一终端不能同时展示多个活动');
  activeOutputs.add(output);
  const layout = options.layout ?? createTerminalLayout(policy, { columns: () => output.columns });
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
  const pending = new Set<Promise<void>>();
  const onError = (error: Error) => { writeError ??= error; };
  output.on('error', onError);

  function write(value: string | Buffer): Promise<void> {
    if (writeError) return Promise.reject(writeError);
    const promise = new Promise<void>((resolve, reject) => {
      output.write(value, error => error ? reject(error) : resolve());
    });
    pending.add(promise);
    void promise.then(() => pending.delete(promise), error => {
      pending.delete(promise);
      onError(error);
    });
    return promise;
  }

  function clear(): string {
    if (!frame.length) return '';
    const width = Math.max(1, (output.columns ?? 80));
    const rows = frame.reduce((sum, line) => sum + Math.max(1, Math.ceil(Bun.stringWidth(line) / width)), 0);
    frame = [];
    return '\r\x1b[2K' + '\x1b[1A\r\x1b[2K'.repeat(Math.max(0, rows - 1));
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
    if (closed || busy || writeError) return;
    if (live && performance.now() - started < 300) return;
    const previous = clear();
    if (live) {
      const width = Math.max(1, (output.columns ?? 80) - 1);
      const count = Math.max(0, Math.min(3, (output.rows ?? 24) - 2));
      const mark = ['|', '/', '-', '\\'][Math.floor((performance.now() - started) / 160) % 4];
      frame = [fit(`  ${mark} ${status()}`, width), ...(count ? recent().slice(-count) : []).map(line => fit(`    ${line}`, width))];
      busy = true;
      // 裁剪和清屏始终使用可见文字，颜色不参与宽度计算
      const heading = frame[0]!;
      const colored = heading.startsWith(`  ${mark}`)
        ? '  ' + styleText(mark, 'accent', policy) + heading.slice(3) : heading;
      void write(previous + [colored, ...frame.slice(1)].join('\n'))
        .finally(() => { busy = false; }).catch(() => {});
    } else {
      const logs = policy.logMode === 'summary' ? recent().map(line => `    ${line}\n`).join('') : '';
      busy = true;
      void write(layout.line('info', `进行中 ${status()}`) + `\n${logs}`)
        .finally(() => { busy = false; }).catch(() => {});
    }
  }

  // 完整日志可能停在字符或行中间，此时插入状态文字会破坏原始输出
  const timer = policy.logMode === 'summary' ? setInterval(render, live ? 160 : 10000) : undefined;
  timer?.unref();
  if (live) output.on('resize', render);
  let failure: unknown;
  let failed = false;
  try {
    const section = layout.section(options.context ?? []);
    if (section) await write(section);
    if (!live) await write(layout.line('info', text(label)) + '\n');
    return await work({
      stage(next) {
        if (closed) throw new Error('活动已经结束');
        if (next === current) return;
        current = next;
        lines.length = 0;
        partial.stdout = partial.stderr = undefined;
        if (!live) {
          const newline = policy.logMode === 'full' && lastByte !== 10 ? '\n' : '';
          lastByte = 10;
          void write(newline + layout.line('info', text(next)) + '\n').catch(() => {});
        }
      },
      async output({ stream, data }) {
        if (closed) throw new Error('活动已经结束');
        lastOutput = performance.now();
        if (policy.logMode === 'full') {
          await write(data);
          if (data.length) lastByte = data[data.length - 1]!;
        } else {
          append(stream, data);
        }
      },
    });
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    closed = true;
    if (timer) clearInterval(timer);
    output.removeListener('resize', render);
    await Promise.allSettled(pending);
    const exitCode = failure && typeof failure === 'object' && 'exitCode' in failure ? failure.exitCode : undefined;
    const outcome = failed ? exitCode === 130 || exitCode === 143 ? '已取消 ' : '失败 ' : '';
    const type = outcome === '已取消 ' ? 'warn' : failed ? 'error' : 'success';
    try {
      if (!writeError) {
        const newline = policy.logMode === 'full' && lastByte !== 10 ? '\n' : '';
        await write(clear() + newline + layout.line(type, outcome + text(label), performance.now() - started) + '\n');
      }
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      output.removeListener('error', onError);
      activeOutputs.delete(output);
    }
    if (!failed && writeError) throw writeError;
  }
}
