import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chooseCandidate } from '../src/cli/selection';

const selectionModule = new URL('../src/cli/selection.ts', import.meta.url).href;
const candidates = [
  { value: ':app', label: '应用模块 app' },
  { value: ':apps:admin-server', label: '管理模块 admin-server' },
];

async function runSelection(input: string | undefined, tty: boolean, signal?: NodeJS.Signals) {
  const source = `
    import { chooseCandidate } from ${JSON.stringify(selectionModule)};
    Object.defineProperty(process.stdin, 'isTTY', { value: ${tty} });
    Object.defineProperty(process.stderr, 'isTTY', { value: ${tty} });
    const counts = process.listenerCount('SIGINT');
    try {
      const result = await chooseCandidate(${JSON.stringify(candidates)}, '选择启动模块');
      console.log(JSON.stringify({ value: result, remainingSignalListeners: process.listenerCount('SIGINT') - counts }));
    } catch (error) {
      console.log(JSON.stringify({ error: error.message, name: error.name, remainingSignalListeners: process.listenerCount('SIGINT') - counts }));
      process.exitCode = error.exitCode || 1;
    }
  `;
  const child = spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let signalled = false;
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  child.stdout.on('data', (value: Buffer) => { stdout += value.toString('utf8'); });
  child.stderr.on('data', (value: Buffer) => {
    stderr += value.toString('utf8');
    if (signal && !signalled && stderr.includes('选择 [1-2]')) {
      signalled = true;
      child.kill(signal);
    }
  });
  if (input !== undefined) child.stdin.end(input);
  const deadline = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
  try {
    const code = await completed;
    return { code, stdout, stderr, result: stdout ? JSON.parse(stdout) : undefined };
  } finally {
    clearTimeout(deadline);
    child.stdin.destroy();
  }
}

describe('终端候选选择', () => {
  test('无候选项明确提示参数路径', async () => {
    await expect(chooseCandidate([], '选择模块')).rejects.toThrow('--module / --main');
  });

  test('非交互环境立即失败，不提示或等待输入', async () => {
    const result = await runSelection(undefined, false);
    expect(result.code).toBe(1);
    expect(result.result.error).toContain('非交互环境');
    expect(result.result.error).toContain('.java-run.json');
    expect(result.stderr).toBe('');
  });

  test('数字选择返回原始标识，菜单在 stderr 且监听得到清理', async () => {
    const result = await runSelection('2\n', true);
    expect(result.code).toBe(0);
    expect(result.result).toEqual({ value: ':apps:admin-server', remainingSignalListeners: 0 });
    expect(result.stderr).toContain('1. 应用模块 app');
    expect(result.stderr).toContain('2. 管理模块 admin-server');
  });

  test('无效输入重新提示，只有有效序号才完成', async () => {
    const result = await runSelection('0\n3\nabc\n1.5\n1\n', true);
    expect(result.code).toBe(0);
    expect(result.result.value).toBe(':app');
    expect(result.stderr.match(/请输入 1 到 2 之间的序号/g)).toHaveLength(4);
  });

  test('EOF 取消以 130 退出且不保留监听', async () => {
    const result = await runSelection('', true);
    expect(result.code).toBe(130);
    expect(result.result).toMatchObject({ name: 'SelectionCancelledError', remainingSignalListeners: 0 });
  });

  test('终端 Ctrl+C 取消以 130 退出', async () => {
    const result = await runSelection('\u0003', true);
    expect(result.code).toBe(130);
    expect(result.result.name).toBe('SelectionCancelledError');
  });

  test.skipIf(process.platform === 'win32')('实际 SIGINT 取消以 130 退出', async () => {
    const result = await runSelection(undefined, true, 'SIGINT');
    expect(result.code).toBe(130);
    expect(result.result).toMatchObject({ name: 'SelectionCancelledError', remainingSignalListeners: 0 });
  });
});
