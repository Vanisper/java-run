import type { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import type { LogRecord, LogReporter } from '../logging/logger';
import type { TerminalPolicy } from './policy';
import { styleText } from './style';

const icons = { debug: '·', info: 'ℹ', success: '✓', warn: '!', error: '×' } as const;

function visibleText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ');
}

/** 按来源上下文和日志类型渲染提示，返回不含末尾换行的文字 */
export function formatTerminalLog(
  record: Pick<LogRecord, 'context' | 'type' | 'message'>,
  policy: Pick<TerminalPolicy, 'color'>,
): string {
  const context = record.context.map(value => visibleText(value).replace(/[\n\t]/g, ' ')).join(':');
  const tone = record.type === 'success' ? 'success' : record.type === 'warn' ? 'warning' : record.type === 'error' ? 'error' : 'accent';
  const prefix = `${context ? `[${context}] ` : ''}${styleText(icons[record.type], tone, policy)} `;
  return prefix + visibleText(record.message).replace(/\n/g, '\n  ');
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

/** 将日志渲染为终端提示，默认写入 stderr；颜色只应用于级别符号 */
export function createTerminalReporter(policy: Pick<TerminalPolicy, 'color'>, output: Writable = process.stderr): LogReporter {
  const writer = streamWriter(output);
  return {
    log(record) { return writer.write(formatTerminalLog(record, policy) + '\n'); },
    flush: writer.flush,
  };
}

/** 原样写入构建诊断，仅补齐缺失的末尾换行，完成前等待写入并释放监听 */
export async function writeDiagnostic(value: string, output: Writable = process.stderr): Promise<void> {
  const writer = streamWriter(output);
  try { await writer.write(value.endsWith('\n') ? value : value + '\n'); }
  finally { await writer.flush(); }
}
