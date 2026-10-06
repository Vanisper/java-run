/** 本次调用的终端呈现偏好 */
export interface TerminalPreferences {
  /** 使用纯文本菜单和追加输出 */
  plain?: boolean;
  /** false 禁止询问，不能覆盖 CI 或缺少终端输入的限制 */
  interactive?: boolean;
  /** false 停止动画，保留键盘选择和筛选 */
  animation?: boolean;
  /** summary 展示阶段和最近输出预览，full 实时展示构建日志 */
  logMode?: 'summary' | 'full';
}

/** 根据终端能力和本次偏好确定的呈现策略 */
export interface TerminalPolicy {
  /** none 不等待输入，line 使用序号输入，keys 支持方向键和筛选 */
  input: 'none' | 'line' | 'keys';
  rewrite: boolean;
  /** 仅控制工具自身的样式，不改写构建日志或 Java 应用输出 */
  color: boolean;
  animation: boolean;
  logMode: 'summary' | 'full';
}

/**
 * 分别判断输入、重绘、颜色和动画能力
 *
 * @description CI 禁止询问；非空 NO_COLOR 或 FORCE_COLOR=0 只禁用颜色；纯文本模式仍允许有效终端中的序号选择
 */
export function resolveTerminalPolicy(
  preferences: TerminalPreferences,
  input: { isTTY?: boolean; setRawMode?: unknown } = process.stdin,
  output: { isTTY?: boolean } = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
): TerminalPolicy {
  const ci = Boolean(env.CI && !['false', '0'].includes(env.CI.toLowerCase()));
  const plain = preferences.plain || env.TERM === 'dumb';
  const interactive = preferences.interactive !== false && !ci && input.isTTY === true && output.isTTY === true;
  const rewrite = output.isTTY === true && !plain;
  return {
    input: !interactive ? 'none' : !plain && typeof input.setRawMode === 'function' ? 'keys' : 'line',
    rewrite,
    color: rewrite && !env.NO_COLOR && env.FORCE_COLOR !== '0',
    animation: rewrite && preferences.animation !== false,
    logMode: preferences.logMode ?? 'summary',
  };
}
