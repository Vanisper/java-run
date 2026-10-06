import { stripVTControlCharacters } from 'node:util';
import type { LogRecord } from '../logging/logger';
import type { TerminalPolicy } from './policy';
import { styleText } from './style';

/** 共享分组状态的终端文字排版，调用方负责按顺序写入返回值 */
export interface TerminalLayout {
  /** 上下文或标题变化时返回标题和空行，连续相同分组返回空字符串 */
  section(context: readonly string[]): string;
  /** 返回带状态符号的正文，不含末尾换行；耗时不足一秒时使用毫秒 */
  line(type: LogRecord['type'], message: string, durationMs?: number): string;
  /** 返回标签和高亮值，不截断路径等完整内容 */
  details(label: string, value: string): string;
}

const icons = { debug: '·', info: 'ℹ', success: '✓', warn: '!', error: '×' } as const;

function visibleText(value: string): string {
  return stripVTControlCharacters(value.replace(/\r\n/g, '\n')).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, ' ');
}

function singleLine(value: string): string {
  return visibleText(value).replace(/\n/g, ' ');
}

/**
 * 创建分组标题、状态行和详情的统一排版
 *
 * @description
 * - 上下文按完整层级比较，标题变化也会开启新分组；空上下文不显示标题
 * - 正文保留换行和完整内容，耗时最多对齐到第 60 列，窄屏不足时另起一行
 * - columns 在每次排版时读取，未提供时按 80 列计算
 */
export function createTerminalLayout(
  policy: Pick<TerminalPolicy, 'color'>,
  options: { columns?: () => number | undefined; contextTitle?: (context: readonly string[]) => string } = {},
): TerminalLayout {
  let previousContext: string | undefined;
  let previousTitle: string | undefined;

  function withDuration(line: string, durationMs?: number): string {
    if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return line;
    const duration = durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1).replace(/\.0$/, '')}s`;
    const available = options.columns?.();
    const width = Math.min(60, Math.max(1, Number.isFinite(available) ? Math.floor(available!) - 1 : 79));
    const padding = width - Bun.stringWidth(line) - Bun.stringWidth(duration);
    const time = styleText(duration, 'dim', policy);
    if (padding >= 2) return line + ' '.repeat(padding) + time;
    return line + '\n' + ' '.repeat(Math.max(2, width - Bun.stringWidth(duration))) + time;
  }

  return {
    section(context) {
      const key = JSON.stringify(context);
      const title = context.length ? singleLine(options.contextTitle?.(context) ?? context.join(' · ')) : '';
      if (key === previousContext && title === previousTitle) return '';
      const separator = previousContext === undefined ? '' : '\n';
      previousContext = key;
      previousTitle = title;
      return title ? `${separator}${styleText(title, 'bold', policy)}\n\n` : '';
    },
    line(type, message, durationMs) {
      const tone = type === 'success' ? 'success' : type === 'warn' ? 'warning' : type === 'error' ? 'error' : 'accent';
      const [first, ...rest] = visibleText(message).split('\n');
      const line = withDuration(`  ${styleText(icons[type], tone, policy)} ${first}`, durationMs);
      return [line, ...rest.map(value => `    ${value}`)].join('\n');
    },
    details: (label, value) => `  ${singleLine(label)}  ${styleText(singleLine(value), 'accent', policy)}`,
  };
}
