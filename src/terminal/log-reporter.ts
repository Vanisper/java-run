import type { Writable } from 'node:stream';
import type { LogRecord, LogReporter } from '../logging/logger';
import type { TerminalPolicy } from './policy';
import { createTerminalLayout, type TerminalLayout } from './layout';

/** 将单条日志渲染为独立完整分组，返回不含末尾换行的文字 */
export function formatTerminalLog(
  record: Pick<LogRecord, 'context' | 'type' | 'message'>,
  policy: Pick<TerminalPolicy, 'color'>,
): string {
  const layout = createTerminalLayout(policy);
  return layout.section(record.context) + layout.line(record.type, record.message);
}

function streamWriter(output: Writable) {
  let failure: Error | undefined;
  let listening = false;
  const pending = new Set<(error: Error) => void>();
  const onError = (error: Error) => {
    failure ??= error;
    for (const reject of pending) reject(failure);
    pending.clear();
  };
  return {
    write(value: string): Promise<void> {
      if (failure) return Promise.reject(failure);
      if (!listening) { output.on('error', onError); listening = true; }
      return new Promise((resolve, reject) => {
        pending.add(reject);
        try {
          output.write(value, error => {
            pending.delete(reject);
            if (error) { onError(error); reject(failure); }
            else resolve();
          });
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    async flush(): Promise<void> {
      // Writable 的失败回调可能先于 error 事件，等本轮事件排空后再释放监听
      if (failure) await new Promise<void>(resolve => setImmediate(resolve));
      if (listening) { output.removeListener('error', onError); listening = false; }
      if (failure) throw failure;
    },
  };
}

/** 将连续上下文的日志合并为同一终端分组，默认写入 stderr */
export function createTerminalReporter(
  policy: Pick<TerminalPolicy, 'color'>,
  output: Writable = process.stderr,
  layout: TerminalLayout = createTerminalLayout(policy, { columns: () => (output as Writable & { columns?: number }).columns }),
): LogReporter {
  const writer = streamWriter(output);
  return {
    log(record) {
      return writer.write(layout.section(record.context) + layout.line(record.type, record.message) + '\n');
    },
    flush: writer.flush,
  };
}

/** 原样写入终端文字，仅补齐缺失的末尾换行，完成前等待写入并释放监听 */
export async function writeTerminalText(value: string, output: Writable = process.stderr): Promise<void> {
  const writer = streamWriter(output);
  try { await writer.write(value.endsWith('\n') ? value : value + '\n'); }
  finally { await writer.flush(); }
}
