import type { TerminalPolicy } from './policy';

const styles = { accent: [36, 39], success: [32, 39], warning: [33, 39], error: [31, 39], dim: [2, 22], bold: [1, 22] } as const;

/** 按终端策略为工具自身的文字添加样式，结束后复位对应属性 */
export function styleText(value: string, tone: keyof typeof styles, policy: Pick<TerminalPolicy, 'color'>): string {
  const [start, end] = styles[tone];
  return policy.color ? `\x1b[${start}m${value}\x1b[${end}m` : value;
}
