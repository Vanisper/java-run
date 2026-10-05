import { createInterface } from 'node:readline';

/** 用户取消交互选择，调用方应以退出码 130 结束请求 */
export class SelectionCancelledError extends Error {
  readonly exitCode = 130;

  constructor() {
    super('已取消选择');
    this.name = 'SelectionCancelledError';
  }
}

/** 交互选项的稳定标识和展示文字 */
export interface SelectionCandidate {
  value: string;
  label: string;
}

/**
 * 在终端中用序号选择候选项
 *
 * @description
 * - 仅在 stdin 和 stderr 都连接终端时提示，菜单输出到 stderr
 * - 非交互环境要求调用方通过参数或项目配置指定目标
 * - EOF、Ctrl+C 或 SIGINT 抛出 SelectionCancelledError，保留取消退出码
 * - 调用方只应在目标缺失且确实需要用户选择时调用
 */
export function chooseCandidate(candidates: SelectionCandidate[], question: string): Promise<string> {
  if (!candidates.length) return Promise.reject(new Error('没有可供选择的候选项，请使用 --module / --main 或 .java-run.json 指定目标'));
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return Promise.reject(new Error('当前为非交互环境，请使用 --module / --main 或 .java-run.json 明确指定目标'));
  }
  if (process.stdin.readableEnded || process.stdin.destroyed) return Promise.reject(new SelectionCancelledError());

  return new Promise((resolve, reject) => {
    const reader = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let settled = false;

    function finish(value?: string): void {
      if (settled) return;
      settled = true;
      reader.removeListener('line', onLine);
      reader.removeListener('close', onClose);
      reader.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGINT', onInterrupt);
      reader.close();
      if (value === undefined) reject(new SelectionCancelledError());
      else resolve(value);
    }

    function onLine(line: string): void {
      const answer = line.trim();
      const index = /^[1-9]\d*$/.test(answer) ? Number(answer) - 1 : -1;
      if (Number.isSafeInteger(index) && index >= 0 && index < candidates.length) {
        finish(candidates[index]!.value);
        return;
      }
      process.stderr.write(`请输入 1 到 ${candidates.length} 之间的序号\n`);
      reader.prompt();
    }

    function onClose(): void {
      finish();
    }

    function onInterrupt(): void {
      process.stderr.write('\n');
      finish();
    }

    reader.on('line', onLine);
    reader.once('close', onClose);
    reader.on('SIGINT', onInterrupt);
    process.once('SIGINT', onInterrupt);
    process.stderr.write(`${question}\n`);
    candidates.forEach((candidate, index) => process.stderr.write(`  ${index + 1}. ${candidate.label}\n`));
    reader.setPrompt(`选择 [1-${candidates.length}]：`);
    reader.prompt();
  });
}
