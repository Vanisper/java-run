import { stripVTControlCharacters } from 'node:util';
import type { LogRecord } from '../logging/logger';
import type { TerminalPolicy } from './policy';
import { styleText } from './style';

/** 无状态的终端文字排版，调用方负责按顺序写入返回值 */
export interface TerminalLayout {
  /** 返回任务标题和可选来源标签，不含末尾换行；控制字符和换行会被清理 */
  heading(label: string, context?: readonly string[]): string;
  /** 返回带来源标签的正文，不含末尾换行；indicator 可替换状态符号，false 隐藏符号 */
  line(type: LogRecord['type'], message: string, options?: {
    context?: readonly string[];
    /** 活动已用时间，单位为毫秒 */
    durationMs?: number;
    indicator?: string | false;
  }): string;
  /** 返回标签和高亮值，不截断路径等完整内容 */
  details(label: string, value: string, context?: readonly string[]): string;
}

const icons = { debug: '·', info: 'ℹ', success: '✓', warn: '!', error: '×' } as const;

function visibleText(value: string): string {
  return stripVTControlCharacters(value.replace(/\r\n/g, '\n')).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, ' ');
}

function singleLine(value: string): string {
  return visibleText(value).replace(/\n/g, ' ');
}

/** 将毫秒耗时转换为紧凑的可读文字 */
export function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1).replace(/\.0$/, '')}s`;
}

/**
 * 创建任务标题、状态行、来源标签和详情的统一排版
 *
 * @description
 * - 只处理呈现，不修改原始上下文
 * - 正文保留换行和完整内容，清理输入中的终端控制序列
 */
export function createTerminalLayout(
  policy: Pick<TerminalPolicy, 'color'>,
): TerminalLayout {
  function contextPrefix(context: readonly string[]): string {
    const label = singleLine(context.join(':'));
    return label ? styleText(`[${label}]`, 'dim', policy) + ' ' : '';
  }

  function withDuration(line: string, durationMs?: number): string {
    if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return line;
    return line + '  ' + styleText(formatDuration(durationMs), 'dim', policy);
  }

  return {
    heading: (label, context = []) => contextPrefix(context) + styleText(singleLine(label), 'bold', policy),
    line(type, message, { context = [], durationMs, indicator } = {}) {
      const tone = type === 'success' ? 'success' : type === 'warn' ? 'warning' : type === 'error' ? 'error' : 'accent';
      const [first = '', ...rest] = visibleText(message).split('\n');
      const body = indicator === false ? styleText(first, tone, policy)
        : `${styleText(singleLine(indicator ?? icons[type]).trim() || icons[type], tone, policy)} ${first}`;
      const line = withDuration(contextPrefix(context) + body, durationMs);
      return [line, ...rest.map(value => `  ${value}`)].join('\n');
    },
    details: (label, value, context = []) => contextPrefix(context) + `${styleText(singleLine(label), 'bold', policy)}  ${styleText(singleLine(value), 'accent', policy)}`,
  };
}
