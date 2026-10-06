import type { TerminalPolicy } from './policy';

const foreground = { accent: 36, success: 32, warning: 33, error: 31 } as const;

/** 按终端策略为工具自身的文字添加基础前景色，结束后恢复默认色 */
export function styleText(value: string, tone: keyof typeof foreground, policy: Pick<TerminalPolicy, 'color'>): string {
  return policy.color ? `\x1b[${foreground[tone]}m${value}\x1b[39m` : value;
}
