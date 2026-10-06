import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import search from '@inquirer/search';
import { resolveTerminalPolicy, type TerminalPolicy } from '../terminal/policy';
import { styleText } from '../terminal/style';

/** 用户取消交互选择，SIGTERM 返回 143，其他取消返回 130 */
export class SelectionCancelledError extends Error {
  readonly exitCode: number;

  constructor(signal?: 'SIGINT' | 'SIGTERM') {
    super('已取消选择');
    this.name = 'SelectionCancelledError';
    this.exitCode = signal === 'SIGTERM' ? 143 : 130;
  }
}

/** 交互选项的稳定标识和展示文字 */
export interface SelectionCandidate {
  value: string;
  label: string;
  /** 按键菜单完成后的答案，未提供时显示稳定标识 */
  shortLabel?: string;
  /** 当前候选的补充说明，也参与输入筛选 */
  description?: string;
}

/** 选择菜单的呈现选项 */
export interface SelectionPresentation {
  /** 按键菜单完成后的简短提问，未提供时沿用原提问 */
  completedQuestion?: string;
  /** 提问与确认行的前缀，纯文本菜单也用于候选和输入提示 */
  linePrefix?: string;
}

/**
 * 在终端中选择候选项，返回原始稳定标识
 *
 * @description
 * - 根据 policy 使用方向键和筛选或纯文本序号输入，菜单输出到 stderr
 * - 非交互环境立即失败，要求通过参数或项目配置指定目标
 * - EOF、Ctrl+C 或信号取消抛出 SelectionCancelledError
 * - 返回或抛错前释放输入监听，恢复原有输入模式；先前未流动的输入保持暂停
 * - 调用方只应在目标缺失且确实需要用户选择时调用
 */
export async function chooseCandidate(
  candidates: readonly SelectionCandidate[],
  question: string,
  policy = resolveTerminalPolicy({}),
  presentation: SelectionPresentation = {},
): Promise<string> {
  if (!candidates.length) throw new Error('没有可供选择的候选项，请使用 --module / --main 或 .java-run.json 指定目标');
  if (policy.input === 'none') {
    throw new Error('当前为非交互环境，请使用 --module / --main 或 .java-run.json 明确指定目标');
  }
  if (process.stdin.readableEnded || process.stdin.destroyed) throw new SelectionCancelledError();

  const wasRaw = process.stdin.isRaw;
  const wasFlowing = process.stdin.readableFlowing;
  // readline 的按键解码器只接触本次代理流，避免残留监听读取后续 Java 应用的输入
  const input = new PassThrough() as PassThrough & { setRawMode?: (enabled: boolean) => void };
  if (typeof process.stdin.setRawMode === 'function') {
    input.setRawMode = enabled => { process.stdin.setRawMode(enabled); };
  }
  const controller = new AbortController();
  let cancellation: Error | undefined;
  let abortTask: ReturnType<typeof setImmediate> | undefined;
  function cancel(error: Error): void {
    cancellation ??= error;
    // Inquirer 首次渲染延迟到 setImmediate，等待该轮完成再取消才能一并清理其监听
    abortTask ??= setImmediate(() => controller.abort(cancellation));
  }
  const onEnd = () => cancel(new SelectionCancelledError());
  const onInterrupt = () => cancel(new SelectionCancelledError('SIGINT'));
  const onTerminate = () => cancel(new SelectionCancelledError('SIGTERM'));
  const onError = (error: Error) => cancel(error);
  const onKeypress = (_text: string, key: { ctrl?: boolean; name?: string }) => {
    if (key.ctrl && (key.name === 'c' || key.name === 'd')) onInterrupt();
  };

  process.stdin.on('end', onEnd);
  process.stdin.on('close', onEnd);
  process.stdin.on('error', onError);
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  input.on('keypress', onKeypress);
  try {
    if (policy.input === 'line' && wasRaw) process.stdin.setRawMode(false);
    const pending = policy.input === 'keys'
      ? chooseSearch(candidates, question, policy, input, controller.signal, presentation)
      : chooseLine(candidates, question, input, controller.signal, presentation);
    process.stdin.pipe(input);
    const selected = await pending;
    if (cancellation) throw cancellation;
    return selected;
  } catch (error) {
    if (cancellation) throw cancellation;
    if (error instanceof Error && error.name === 'ExitPromptError') throw new SelectionCancelledError();
    throw error;
  } finally {
    if (abortTask) clearImmediate(abortTask);
    process.stdin.unpipe(input);
    process.stdin.removeListener('end', onEnd);
    process.stdin.removeListener('close', onEnd);
    process.stdin.removeListener('error', onError);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    input.removeListener('keypress', onKeypress);
    input.destroy();
    if (typeof process.stdin.setRawMode === 'function' && process.stdin.isRaw !== wasRaw) {
      process.stdin.setRawMode(Boolean(wasRaw));
    }
    if (wasFlowing === true) process.stdin.resume();
    else process.stdin.pause();
  }
}

function displayText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\r\n\t]/g, ' ');
}

function chooseSearch(
  candidates: readonly SelectionCandidate[],
  question: string,
  policy: TerminalPolicy,
  input: PassThrough,
  signal: AbortSignal,
  presentation: SelectionPresentation,
): Promise<string> {
  const accent = (text: string) => styleText(text, 'accent', policy);
  const identity = (text: string) => text;
  const linePrefix = displayText(presentation.linePrefix ?? '');
  const choices = candidates.map(candidate => ({
    value: candidate.value,
    name: displayText(candidate.label),
    short: displayText(candidate.shortLabel ?? candidate.value),
    description: candidate.description ? displayText(candidate.description) : undefined,
    searchable: `${candidate.value} ${candidate.label} ${candidate.description ?? ''}`.normalize('NFKC').toLowerCase(),
  }));
  return search({
    message: displayText(question),
    pageSize: Math.max(1, Math.min(7, (process.stderr.rows || 24) - 6)),
    source: term => {
      const words = (term ?? '').normalize('NFKC').toLowerCase().trim().split(/\s+/);
      return choices.filter(choice => words.every(word => choice.searchable.includes(word)));
    },
    theme: {
      prefix: { idle: linePrefix + accent('?'), done: linePrefix + styleText('✓', 'success', policy) },
      spinner: { frames: [linePrefix + '?'], interval: 1000 },
      icon: { cursor: '>' },
      style: {
        answer: (text: string) => styleText(text, 'success', policy),
        message: (text: string, status: string) => status === 'done' ? displayText(presentation.completedQuestion ?? question) : text,
        error: (text: string) => styleText(text === 'No results found' ? '没有匹配的候选项' : text, 'warning', policy),
        defaultAnswer: identity, help: identity, highlight: accent, key: identity, disabled: identity,
        searchTerm: accent, description: identity,
        keysHelpTip: () => '↑↓ 移动 · 输入筛选 · 回车确认 · Ctrl+C 取消',
      },
    },
  }, { input, output: process.stderr, signal });
}

function chooseLine(
  candidates: readonly SelectionCandidate[],
  question: string,
  input: PassThrough,
  signal: AbortSignal,
  presentation: SelectionPresentation,
): Promise<string> {
  const linePrefix = displayText(presentation.linePrefix ?? '');
  return new Promise((resolve, reject) => {
    const reader = createInterface({ input, terminal: false });
    let settled = false;

    function finish(value?: string, error?: unknown): void {
      if (settled) return;
      settled = true;
      reader.removeListener('line', onLine);
      reader.removeListener('close', onClose);
      signal.removeEventListener('abort', onAbort);
      reader.close();
      if (value === undefined) reject(error ?? new SelectionCancelledError());
      else resolve(value);
    }

    function onLine(line: string): void {
      if (line.includes('\x03') || line.includes('\x04')) {
        finish();
        return;
      }
      const answer = line.trim();
      const index = /^[1-9]\d*$/.test(answer) ? Number(answer) - 1 : -1;
      if (Number.isSafeInteger(index) && index >= 0 && index < candidates.length) {
        finish(candidates[index]!.value);
        return;
      }
      process.stderr.write(`${linePrefix}请输入 1 到 ${candidates.length} 之间的序号\n`);
      prompt();
    }

    function onClose(): void {
      finish();
    }

    function onAbort(): void {
      finish(undefined, signal.reason);
    }

    function prompt(): void {
      process.stderr.write(`${linePrefix}选择 [1-${candidates.length}]：`);
    }

    reader.on('line', onLine);
    reader.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    process.stderr.write(`${linePrefix}${displayText(question)}\n`);
    candidates.forEach((candidate, index) => process.stderr.write(`${linePrefix}  ${index + 1}. ${displayText(candidate.label)}${candidate.description ? ` — ${displayText(candidate.description)}` : ''}\n`));
    prompt();
  });
}
