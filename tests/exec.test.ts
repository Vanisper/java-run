import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import iconv from 'iconv-lite';
import { CommandError, decodeOutput, runCommand, type CommandOutput } from '../src/process/exec';
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

  test('输出回调在子进程结束前收到原始字节，跨块字符及旧编码保留完整诊断', async () => {
    const directory = temporaryDirectory();
    const acknowledgment = path.join(directory, 'observed');
    const stdout = Buffer.from('中文启动日志\n');
    const stderrText = '正在编译目标项目，解析运行依赖，准备完成。\n'.repeat(8);
    const stderr = Buffer.from(iconv.encode(stderrText, 'gb18030'));
    const parts: { stream: CommandOutput['stream']; data: number[] }[] = [
      { stream: 'stdout', data: [...stdout.subarray(0, 2)] },
      { stream: 'stdout', data: [...stdout.subarray(2)] },
      { stream: 'stderr', data: [...stderr.subarray(0, 1)] },
      { stream: 'stderr', data: [...stderr.subarray(1)] },
    ];
    const observed: CommandOutput[] = [];
    let observedBytes = 0;
    const source = `
      import { existsSync, readFileSync } from 'node:fs';
      const acknowledgment = ${JSON.stringify(acknowledgment)};
      setTimeout(() => process.exit(90), 3000).unref();
      let sentBytes = 0;
      for (const part of ${JSON.stringify(parts)}) {
        const data = Buffer.from(part.data);
        process[part.stream].write(data);
        sentBytes += data.length;
        while (!existsSync(acknowledgment) || Number(readFileSync(acknowledgment, 'utf8')) < sentBytes) {
          await Bun.sleep(5);
        }
      }
    `;
    const result = await runCommand(command(source), {
      capture: true,
      onOutput(output) {
        observed.push(output);
        observedBytes += output.data.length;
        writeFileSync(acknowledgment, String(observedBytes));
      },
    });
    expect(result.exitCode).toBe(0);
    expect(observed.map(output => output.stream)).toEqual(parts.map(part => part.stream));
    expect(Buffer.concat(observed.filter(output => output.stream === 'stdout').map(output => output.data))).toEqual(stdout);
    expect(Buffer.concat(observed.filter(output => output.stream === 'stderr').map(output => output.data))).toEqual(stderr);
    expect(result.stdout).toBe('中文启动日志\n');
    expect(result.stderr).toBe(stderrText);
    expect(decodeOutput(stderr)).toBe(result.stderr);
  });

  test('缓慢输出回调暂停管道并串行交付，子进程无法提前排空大输出', async () => {
    const directory = temporaryDirectory();
    const written = path.join(directory, 'written');
    const byteLength = 4 * 1024 * 1024;
    const observed: Buffer[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let active = 0;
    let maximumActive = 0;
    let firstObserved = false;
    const source = `
      import { writeFileSync } from 'node:fs';
      writeFileSync(1, Buffer.alloc(${byteLength}, 120));
      writeFileSync(${JSON.stringify(written)}, 'done');
    `;
    const running = runCommand(command(source), {
      capture: true,
      async onOutput(output) {
        active++;
        maximumActive = Math.max(maximumActive, active);
        if (!firstObserved) {
          firstObserved = true;
          await gate;
        }
        observed.push(output.data);
        active--;
      },
    });
    try {
      await waitUntil(() => firstObserved);
      await Bun.sleep(100);
      expect(existsSync(written)).toBe(false);
    } finally {
      release();
      await running;
    }
    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(maximumActive).toBe(1);
    expect(Buffer.concat(observed)).toEqual(Buffer.alloc(byteLength, 120));
    expect(result.stdout.length).toBe(byteLength);
    expect(existsSync(written)).toBe(true);
  });

  test('子进程退出后仍等待输出回调，回调修改副本不影响捕获诊断', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let observed = false;
    let completed = false;
    const running = runCommand(command('process.stdout.write("original")'), {
      capture: true,
      async onOutput(output) {
        output.data.fill(120);
        observed = true;
        await gate;
      },
    }).then(result => { completed = true; return result; });
    try {
      await waitUntil(() => observed);
      await Bun.sleep(30);
      expect(completed).toBe(false);
    } finally {
      release();
      await running;
    }
    expect((await running).stdout).toBe('original');
  });

  test.each(['throw', 'reject'] as const)('输出回调 %s 时清理进程并保留原始原因和诊断', async mode => {
    const directory = temporaryDirectory();
    const pidFile = path.join(directory, 'child.pid');
    const leafPidFile = path.join(directory, 'leaf.pid');
    const failure = new Error('呈现输出失败');
    const signals = ['SIGINT', 'SIGTERM', 'exit'] as const;
    const original = signals.map(signal => process.listenerCount(signal));
    const source = `
      import { spawn } from 'node:child_process';
      import { existsSync, writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      const leaf = spawn(process.execPath, [${JSON.stringify(processChild)}, 'leaf', ${JSON.stringify(directory)}], { stdio: 'inherit' });
      const ready = setInterval(() => {
        if (existsSync(${JSON.stringify(leafPidFile)})) {
          clearInterval(ready);
          process.stderr.write('original diagnostic\\n');
        }
      }, 5);
      setTimeout(() => { leaf.kill('SIGKILL'); process.exit(90); }, 3000).unref();
    `;
    let observed = 0;
    const result = await runCommand(command(source), {
      capture: true,
      onOutput() {
        observed++;
        if (mode === 'throw') throw failure;
        return Promise.reject(failure);
      },
    }).catch(error => error);
    expect(result).toBeInstanceOf(CommandError);
    expect(result.cause).toBe(failure);
    expect(result.stderr).toBe('original diagnostic\n');
    expect(observed).toBe(1);
    expect(signals.map(signal => process.listenerCount(signal))).toEqual(original);
    await waitUntil(() => !isAlive(Number(readFileSync(pidFile, 'utf8'))));
    await waitUntil(() => !isAlive(Number(readFileSync(leafPidFile, 'utf8'))));
  });

  test('没有捕获输出时拒绝注册输出回调且不启动命令', async () => {
    const marker = path.join(temporaryDirectory(), 'started');
    const source = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started');`;
    await expect(runCommand(command(source), { onOutput() {} })).rejects.toThrow('onOutput 仅可与 capture');
    expect(existsSync(marker)).toBe(false);
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
    const variableName = 'JAVA_RUN_CHILD_REMOVE';
    const originalValue = process.env[variableName];
    const removalName = process.platform === 'win32' ? variableName.toLowerCase() : variableName;
    process.env[variableName] = 'parent-only-value';
    try {
      const removed = await runCommand(command('console.log(JSON.stringify({value:process.env.JAVA_RUN_CHILD_REMOVE}))'), {
        capture: true, env: { [removalName]: undefined },
      });
      expect(JSON.parse(removed.stdout)).toEqual({});
      expect(process.env[variableName]).toBe('parent-only-value');
    } finally {
      if (originalValue === undefined) delete process.env[variableName];
      else process.env[variableName] = originalValue;
    }
    const pathName = Object.keys(process.env).find(name => name.toLowerCase() === 'path')!;
    const originalPath = process.env[pathName];
    const overrideName = process.platform === 'win32' ? pathName.toLowerCase() : pathName;
    const source = 'console.log(JSON.stringify({path:process.env[Object.keys(process.env).find(name=>name.toLowerCase()==="path")]}))';
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
    const observed: Buffer[] = [];
    await expect(runCommand(command('process.stdout.write("x".repeat(10000)); setInterval(() => {}, 1000)'), {
      capture: true,
      maxBuffer: 128,
      onOutput(output) { observed.push(output.data); },
    })).rejects.toMatchObject({ name: 'CommandError', stdout: 'x'.repeat(128) });
    expect(Buffer.concat(observed)).toEqual(Buffer.alloc(128, 120));
  });

  test('捕获上限为零时不向回调泄露输出', async () => {
    let called = false;
    await expect(runCommand(command('process.stdout.write("private")'), {
      capture: true,
      maxBuffer: 0,
      onOutput() { called = true; },
    })).rejects.toMatchObject({ name: 'CommandError', stdout: '', stderr: '' });
    expect(called).toBe(false);
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
