import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../src/process/exec';
import type { CommandSpec } from '../src/core/types';

const temporaryDirectories: string[] = [];
const processChild = fileURLToPath(new URL('./helpers/process-child.ts', import.meta.url));

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'java-run exec # '));
  temporaryDirectories.push(directory);
  return directory;
}

function command(source: string, cwd = process.cwd(), args: string[] = []): CommandSpec {
  return { command: process.execPath, args: ['-e', source, '--', ...args], cwd, stage: '进程测试' };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等待真实进程状态超时');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('异步执行', () => {
  test('捕获 stdout 与 stderr 并保留原始空白', async () => {
    const result = await runCommand(command('process.stdout.write(" out \\n"); process.stderr.write(" err \\n")'), { capture: true });
    expect(result).toEqual({ exitCode: 0, signal: null, stdout: ' out \n', stderr: ' err \n' });
  });

  test('非零退出返回完整结果，默认继承终端返回空输出', async () => {
    expect(await runCommand(command('process.exit(5)'))).toEqual({ exitCode: 5, signal: null, stdout: '', stderr: '' });
  });

  test('非零退出的 stderr 可用于 Maven 或 Java 诊断', async () => {
    const result = await runCommand(command('process.stdout.write("前置输出\\n"); process.stderr.write("编译失败\\n"); process.exit(7)'), { capture: true });
    expect(result).toEqual({ exitCode: 7, signal: null, stdout: '前置输出\n', stderr: '编译失败\n' });
  });

  test('参数中的空格、中文和 shell 字符保持原边界', async () => {
    const args = ['hello world', '中文#目录', '-Dkey=a=b', '%JAVA_RUN%&echo bad', '"quoted"', 'C:\\trailing\\', ''];
    const result = await runCommand(command('console.log(JSON.stringify(process.argv.slice(1)))', temporaryDirectory(), args), { capture: true });
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  test('子环境覆盖保留未指定变量且不修改父环境', async () => {
    const pathName = Object.keys(process.env).find(name => name.toLowerCase() === 'path')!;
    const originalPath = process.env[pathName];
    const originalValue = process.env.JAVA_RUN_CHILD_OPTION;
    const value = 'child value 中文 # %';
    const source = 'console.log(JSON.stringify({value:process.env.JAVA_RUN_CHILD_OPTION,path:process.env[Object.keys(process.env).find(name=>name.toLowerCase()==="path")]}))';
    const result = await runCommand(command(source), { capture: true, env: { JAVA_RUN_CHILD_OPTION: value } });
    expect(JSON.parse(result.stdout)).toEqual({ value, path: originalPath });
    expect({ path: process.env[pathName], value: process.env.JAVA_RUN_CHILD_OPTION })
      .toEqual({ path: originalPath, value: originalValue });
  });

  test('undefined 仅从子环境移除变量，Windows 覆盖按名称忽略大小写', async () => {
    const pathName = Object.keys(process.env).find(name => name.toLowerCase() === 'path')!;
    const originalPath = process.env[pathName];
    const overrideName = process.platform === 'win32' ? pathName.toLowerCase() : pathName;
    const source = 'console.log(JSON.stringify({path:process.env[Object.keys(process.env).find(name=>name.toLowerCase()==="path")]}))';
    const removed = await runCommand(command(source), { capture: true, env: { [overrideName]: undefined } });
    expect(JSON.parse(removed.stdout)).toEqual({});
    const overwritten = await runCommand(command(source), { capture: true, env: { [overrideName]: 'child-only-path' } });
    expect(JSON.parse(overwritten.stdout)).toEqual({ path: 'child-only-path' });
    expect({ path: process.env[pathName] }).toEqual({ path: originalPath });
  });

  test('不存在的命令拒绝 Promise 并保留阶段', async () => {
    const spec = { command: path.join(temporaryDirectory(), 'missing-command'), args: [], cwd: process.cwd(), stage: '依赖解析' };
    await expect(runCommand(spec, { capture: true })).rejects.toMatchObject({ name: 'CommandError', exitCode: 127, stage: '依赖解析' });
  });

  test('执行完毕及启动失败都移除当前调用的信号监听', async () => {
    const signals = ['SIGINT', 'SIGTERM', 'exit'] as const;
    const original = signals.map(signal => process.listenerCount(signal));
    await runCommand(command('process.exit(0)'));
    expect(signals.map(signal => process.listenerCount(signal))).toEqual(original);
    await runCommand({ command: path.join(temporaryDirectory(), 'missing'), args: [], cwd: process.cwd(), stage: '启动失败' }).catch(() => {});
    expect(signals.map(signal => process.listenerCount(signal))).toEqual(original);
  });

  test('捕获输出超限时终止命令，保留有界诊断输出', async () => {
    await expect(runCommand(command('process.stdout.write("x".repeat(10000)); setInterval(() => {}, 1000)'), {
      capture: true,
      maxBuffer: 128,
    })).rejects.toMatchObject({ name: 'CommandError', stdout: 'x'.repeat(128) });
  });
});

describe.skipIf(process.platform === 'win32')('Unix 进程树清理', () => {
  test.each(['SIGTERM', 'SIGINT'] as const)('%s 转发到独立子进程组且不遗留 JVM 式后代', async signal => {
    const directory = temporaryDirectory();
    const runner = spawn(process.execPath, [processChild, 'runner', directory], { stdio: 'ignore' });
    const completed = new Promise<void>((resolve, reject) => {
      runner.once('error', reject);
      runner.once('exit', () => resolve());
    });
    const childPidPath = path.join(directory, 'child.pid');
    const leafPidPath = path.join(directory, 'leaf.pid');
    let childPid: number | undefined;
    let leafPid: number | undefined;
    try {
      await waitUntil(() => existsSync(childPidPath) && existsSync(leafPidPath));
      childPid = Number(readFileSync(childPidPath, 'utf8'));
      leafPid = Number(readFileSync(leafPidPath, 'utf8'));
      runner.kill(signal);
      await completed;
      await waitUntil(() => !isAlive(childPid!) && !isAlive(leafPid!));
      const result = JSON.parse(readFileSync(path.join(directory, 'result.json'), 'utf8'));
      expect(result).toMatchObject({ signal, exitCode: signal === 'SIGINT' ? 130 : 143 });
    } finally {
      runner.kill('SIGKILL');
      if (childPid && isAlive(childPid)) process.kill(-childPid, 'SIGKILL');
      if (leafPid && isAlive(leafPid)) process.kill(leafPid, 'SIGKILL');
    }
  }, 10000);

  test('主进程正常结束也清理继续运行的后代', async () => {
    const directory = temporaryDirectory();
    const result = await runCommand({ command: process.execPath, args: [processChild, 'orphan', directory], cwd: directory, stage: '正常退出清理' }, { capture: true });
    const leafPid = Number(readFileSync(path.join(directory, 'leaf.pid'), 'utf8'));
    expect(result.exitCode).toBe(0);
    await waitUntil(() => !isAlive(leafPid));
  }, 10000);

  test('执行器所在父进程退出时清理整个子进程组', async () => {
    const directory = temporaryDirectory();
    const runner = spawn(process.execPath, [processChild, 'exiting-runner', directory], { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      runner.once('error', reject);
      runner.once('exit', () => resolve());
    });
    const childPid = Number(readFileSync(path.join(directory, 'child.pid'), 'utf8'));
    const leafPid = Number(readFileSync(path.join(directory, 'leaf.pid'), 'utf8'));
    await waitUntil(() => !isAlive(childPid) && !isAlive(leafPid));
  }, 10000);
});

describe.skipIf(process.platform !== 'win32')('Windows 批处理入口', () => {
  test('空格路径及特殊参数经 cmd 转发到原生命令', async () => {
    const directory = temporaryDirectory();
    const batch = path.join(directory, 'Maven entry.cmd');
    writeFileSync(batch, `@echo off\r\n"${process.execPath}" "${processChild}" args %*\r\n`);
    const args = ['hello world', '中文#路径', '-Dkey=a=b', 'a&echo bad', '%PATH%', '%UNDEFINED_JAVA_RUN_VAR%', 'bang!', ''];
    const result = await runCommand({ command: batch, args, cwd: directory, stage: 'Windows 参数转发' }, { capture: true });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  test('批处理参数包含换行时拒绝执行', async () => {
    const directory = temporaryDirectory();
    const batch = path.join(directory, 'entry.cmd');
    writeFileSync(batch, '@echo off\r\nexit /b 0\r\n');
    await expect(runCommand({ command: batch, args: ['value\r\necho injected'], cwd: directory, stage: '批处理参数检查' }))
      .rejects.toMatchObject({ name: 'CommandError', exitCode: 1 });
  });

  test('转发入口清理批处理及全部后代，并保留终止状态', async () => {
    const directory = temporaryDirectory();
    const runner = spawn(process.execPath, [processChild, 'windows-runner', directory], { stdio: 'ignore' });
    const completed = new Promise<void>((resolve, reject) => {
      runner.once('error', reject);
      runner.once('exit', () => resolve());
    });
    let childPid: number | undefined;
    let leafPid: number | undefined;
    try {
      await waitUntil(() => existsSync(path.join(directory, 'result.json')), 10000);
      await completed;
      childPid = Number(readFileSync(path.join(directory, 'child.pid'), 'utf8'));
      leafPid = Number(readFileSync(path.join(directory, 'leaf.pid'), 'utf8'));
      expect(JSON.parse(readFileSync(path.join(directory, 'result.json'), 'utf8')))
        .toMatchObject({ signal: 'SIGTERM', exitCode: 143 });
      await waitUntil(() => !isAlive(childPid!) && !isAlive(leafPid!));
    } finally {
      for (const pid of [runner.pid, childPid, leafPid]) {
        if (pid && isAlive(pid)) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      }
    }
  }, 15000);
});
