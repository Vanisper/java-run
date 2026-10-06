import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const python = process.env.JAVA_RUN_TEST_PYTHON || 'python3';
const driver = fileURLToPath(new URL('./terminal-pty.py', import.meta.url));

/** 当前环境无法运行真实 PTY 时给出明确原因 */
export const terminalPtyUnavailable = process.platform === 'win32'
  ? 'Windows ConPTY 尚未纳入验收'
  : spawnSync(python, ['-c', 'import pty, termios'], { stdio: 'ignore' }).status !== 0
    ? '需要 Python 3 的 pty / termios 标准库'
    : undefined;

/** 按转录内容驱动输入，所有等待共用一次验收的截止时间 */
export interface TerminalPtyStep {
  waitFor?: string;
  send?: string;
  signal?: 'SIGINT' | 'SIGTERM';
  columns?: number;
  rows?: number;
  observeMs?: number;
  absent?: string;
}

/** PTY 的原始输出与运行前后的终端模式 */
export interface TerminalPtyResult {
  exitCode: number;
  transcript: string;
  before: unknown[];
  after: unknown[];
}

/**
 * 在真实控制终端中执行命令并等待退出
 *
 * @description 超时或步骤不满足时终止受控进程组，错误保留完整转录
 */
export function runTerminalPty(options: {
  command: string[];
  steps: TerminalPtyStep[];
  cwd?: string;
  env?: Record<string, string>;
  columns?: number;
  rows?: number;
  timeoutMs?: number;
}): Promise<TerminalPtyResult> {
  const timeoutMs = options.timeoutMs ?? 10000;
  return new Promise((resolve, reject) => {
    const child = spawn(python, [driver], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const deadline = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 4000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('close', code => {
      clearTimeout(deadline);
      if (code !== 0) { reject(new Error(`PTY 驱动退出 ${code}：${stderr}\n${stdout}`)); return; }
      try {
        const result = JSON.parse(stdout) as TerminalPtyResult & { error?: string };
        if (result.error) throw new Error(`${result.error}\n${result.transcript}`);
        resolve(result);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ cwd: process.cwd(), ...options, timeoutMs }));
  });
}
