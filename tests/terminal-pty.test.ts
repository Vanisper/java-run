import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTerminalPty, terminalPtyUnavailable, type TerminalPtyResult, type TerminalPtyStep } from './helpers/terminal-pty';

const selectionModule = new URL('../src/cli/selection.ts', import.meta.url).href;
const activityModule = new URL('../src/terminal/activity.ts', import.meta.url).href;
const policyModule = new URL('../src/terminal/policy.ts', import.meta.url).href;
const execModule = new URL('../src/process/exec.ts', import.meta.url).href;
const sourceCli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const directories: string[] = [];
const candidates = Array.from({ length: 22 }, (_, index) => ({
  value: `:apps:${index === 18 ? 'worker' : 'module'}-${String(index).padStart(2, '0')}`,
  label: index === 18 ? 'worker-18' : `module-${String(index).padStart(2, '0')}`,
}));

function selectionSource() {
  return `
    import { chooseCandidate } from ${JSON.stringify(selectionModule)};
    const before = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
    let result;
    try {
      result = { value: await chooseCandidate(${JSON.stringify(candidates)}, '选择启动项目') };
    } catch (error) {
      result = { error: error.name, exitCode: error.exitCode };
      process.exitCode = error.exitCode || 1;
    }
    console.log('PTY_RESULT=' + JSON.stringify({ ...result, raw: process.stdin.isRaw,
      listeners: ['SIGINT', 'SIGTERM'].map((signal, index) => process.listenerCount(signal) - before[index]) }));
  `;
}

async function select(steps: TerminalPtyStep[], options: { columns?: number; rows?: number; env?: Record<string, string> } = {}) {
  const terminal = await runTerminalPty({
    command: [process.execPath, '-e', selectionSource()],
    steps: [{ waitFor: 'module-00' }, ...steps],
    ...options,
  });
  const value = /PTY_RESULT=([^\r\n]+)/.exec(terminal.transcript)?.[1];
  if (!value) throw new Error(`交互未返回结果\n${terminal.transcript}`);
  return { terminal, result: JSON.parse(value) };
}

function expectRestored(terminal: TerminalPtyResult) {
  expect(terminal.after).toEqual(terminal.before);
  const hidden = terminal.transcript.lastIndexOf('\x1b[?25l');
  if (hidden !== -1) expect(terminal.transcript.lastIndexOf('\x1b[?25h')).toBeGreaterThan(hidden);
}

function expectColorResetBefore(transcript: string, marker: string) {
  const markerIndex = transcript.indexOf(marker);
  expect(markerIndex).toBeGreaterThan(-1);
  const styles = transcript.slice(0, markerIndex).match(/\x1b\[[\d;]*m/g);
  const active = new Set<number>();
  for (const style of styles ?? []) {
    for (const code of style.slice(2, -1).split(';').map(Number)) {
      if (code === 0) active.clear();
      else if ([1, 2, 3, 4, 7, 8, 9].includes(code)) active.add(code);
      else if (code === 22) { active.delete(1); active.delete(2); }
      else if ([23, 24, 27, 28, 29].includes(code)) active.delete(code - 20);
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) active.add(30);
      else if (code === 39) active.delete(30);
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) active.add(40);
      else if (code === 49) active.delete(40);
    }
  }
  expect([...active]).toEqual([]);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(Boolean(terminalPtyUnavailable))(`真实 PTY 交互${terminalPtyUnavailable ? `（跳过：${terminalPtyUnavailable}）` : ''}`, () => {
  test('方向键选择返回候选，返回前恢复终端', async () => {
    const { terminal, result } = await select([{ send: '\x1b[B\r' }]);
    expect(terminal.exitCode).toBe(0);
    expect(result).toEqual({ value: ':apps:module-01', raw: false, listeners: [0, 0] });
    expectColorResetBefore(terminal.transcript, 'PTY_RESULT=');
    expectRestored(terminal);
  }, 15000);

  test('输入筛选能定位当前页之外的候选', async () => {
    const { terminal, result } = await select([{ send: 'worker' }, { waitFor: 'worker-18', send: '\r' }]);
    expect(result.value).toBe(':apps:worker-18');
    expectRestored(terminal);
  }, 15000);

  test('无匹配时不确认，修改查询后可以继续选择', async () => {
    const { terminal, result } = await select([
      { send: 'zzzz' },
      { waitFor: '没有匹配的候选项', send: '\r' },
      { observeMs: 100, absent: 'PTY_RESULT=' },
      { send: '\x7f\x7f\x7f\x7fworker' },
      { waitFor: 'worker-18', send: '\r' },
    ]);
    expect(result.value).toBe(':apps:worker-18');
    expectRestored(terminal);
  }, 15000);

  test('方向键可滚动到首屏之外的候选', async () => {
    const { terminal, result } = await select([
      { send: '\x1b[B'.repeat(12) },
      { waitFor: 'module-12', send: '\r' },
    ]);
    expect(result.value).toBe(':apps:module-12');
    expectRestored(terminal);
  }, 15000);

  for (const [name, env] of [
    ['NO_COLOR', { NO_COLOR: '1' }],
    ['FORCE_COLOR=0', { FORCE_COLOR: '0' }],
    ['NO_COLOR 优先于 FORCE_COLOR=1', { NO_COLOR: '1', FORCE_COLOR: '1' }],
  ] satisfies [string, Record<string, string>][]) {
    test(`窄屏下 ${name} 禁用颜色并保留方向键与筛选`, async () => {
      const { terminal, result } = await select([
        { columns: 28, rows: 10 },
        { send: 'module-1' },
        { waitFor: 'module-10', send: '\x1b[B\r' },
      ], { columns: 36, rows: 12, env });
      expect(result.value).toBe(':apps:module-11');
      const menu = terminal.transcript.slice(terminal.transcript.lastIndexOf('\n', terminal.transcript.indexOf('选择启动项目')) + 1);
      expect(menu).not.toMatch(/\x1b\[[\d;]*m/);
      expectRestored(terminal);
    }, 15000);
  }

  test('TERM=dumb 使用无 ANSI 的序号菜单，FORCE_COLOR=1 不覆盖降级', async () => {
    const { terminal, result } = await select([{ send: '2\n' }], { env: { TERM: 'dumb', FORCE_COLOR: '1' } });
    expect(terminal.exitCode).toBe(0);
    expect(result.value).toBe(':apps:module-01');
    const menu = terminal.transcript.slice(terminal.transcript.lastIndexOf('\n', terminal.transcript.indexOf('选择启动项目')) + 1);
    expect(menu).not.toContain('\x1b');
    expectRestored(terminal);
  }, 15000);

  for (const [name, step, exitCode] of [
    ['Ctrl+C', { send: '\x03' }, 130],
    ['Ctrl+D / EOF', { send: '\x04' }, 130],
    ['实际 SIGINT', { signal: 'SIGINT' }, 130],
    ['实际 SIGTERM', { signal: 'SIGTERM' }, 143],
  ] as const) {
    test(`${name} 结束交互并恢复终端`, async () => {
      const { terminal, result } = await select([step]);
      expect(terminal.exitCode).toBe(exitCode);
      expect(result).toMatchObject({ exitCode, raw: false, listeners: [0, 0] });
      expectRestored(terminal);
    }, 15000);
  }

  for (const [name, interruption, exitCode] of [
    ['终端 Ctrl+C', { send: '\x03' }, 130],
    ['SIGINT', { signal: 'SIGINT' }, 130],
    ['SIGTERM', { signal: 'SIGTERM' }, 143],
  ] as const) {
    test(`活动保留构建 stdin，${name} 结束进程并停止终端重绘`, async () => {
      const buildSource = `
        console.log('BUILD_READY=' + process.pid);
        process.stdin.once('data', value => console.log('BUILD_INPUT=' + value.toString().trim()));
        setInterval(() => {}, 1000);
      `;
      const source = `
        import { activity } from ${JSON.stringify(activityModule)};
        import { CommandError, runCommand } from ${JSON.stringify(execModule)};
        const signals = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
        let captured = '';
        try {
          await activity('准备测试项目', async feedback => {
            feedback.stage('等待构建输入');
            const spec = { command: process.execPath, args: ['-e', ${JSON.stringify(buildSource)}], cwd: process.cwd(), stage: '测试构建' };
            const result = await runCommand(spec, { capture: true, onOutput: feedback.output });
            captured = result.stdout;
            if (result.exitCode !== 0) throw new CommandError(spec, result);
          });
        } catch (error) { process.exitCode = error.exitCode || 1; }
        console.log('ACTIVITY_DONE');
        await new Promise(resolve => setTimeout(resolve, 400));
        console.log('ACTIVITY_RESULT=' + JSON.stringify({ captured,
          listeners: ['SIGINT', 'SIGTERM'].map((signal, index) => process.listenerCount(signal) - signals[index]) }));
      `;
      const terminal = await runTerminalPty({
        command: [process.execPath, '-e', source],
        steps: [
          { waitFor: 'BUILD_READY=', send: 'kept-for-build\n' },
          { waitFor: 'BUILD_INPUT=kept-for-build', ...interruption },
          { waitFor: 'ACTIVITY_RESULT=' },
        ],
      });
      expect(terminal.exitCode).toBe(exitCode);
      const result = JSON.parse(/ACTIVITY_RESULT=([^\r\n]+)/.exec(terminal.transcript)![1]!);
      expect(result.listeners).toEqual([0, 0]);
      expect(result.captured).toContain('BUILD_INPUT=kept-for-build');
      const buildPid = Number(/BUILD_READY=(\d+)/.exec(result.captured)![1]);
      expect(() => process.kill(buildPid, 0)).toThrow();
      expectColorResetBefore(terminal.transcript, 'ACTIVITY_DONE');
      const afterActivity = terminal.transcript.split('ACTIVITY_DONE')[1]!.split('ACTIVITY_RESULT=')[0]!;
      expect(afterActivity).toBe('\r\n');
      expectRestored(terminal);
    }, 15000);
  }

  for (const failure of [false, true]) {
    test(`关闭动画时活动${failure ? '失败' : '成功'}不重绘并恢复终端`, async () => {
      const source = `
        import { activity } from ${JSON.stringify(activityModule)};
        import { resolveTerminalPolicy } from ${JSON.stringify(policyModule)};
        const failure = new Error('TEST_FAILURE');
        let result;
        try {
          const value = await activity('准备测试项目', async feedback => {
            feedback.stage('读取测试模型');
            if (${failure}) throw failure;
            return 'WORK_RESULT';
          }, resolveTerminalPolicy({ animation: false }));
          result = { value };
        } catch (error) { result = { sameError: error === failure }; }
        console.log('ACTIVITY_RESULT=' + JSON.stringify(result));
        console.log('NO_ANIMATION_DONE');
      `;
      const terminal = await runTerminalPty({ command: [process.execPath, '-e', source], steps: [{ waitFor: 'NO_ANIMATION_DONE' }] });
      expect(terminal.exitCode).toBe(0);
      const result = JSON.parse(/ACTIVITY_RESULT=([^\r\n]+)/.exec(terminal.transcript)![1]!);
      expect(result).toEqual(failure ? { sameError: true } : { value: 'WORK_RESULT' });
      expect(terminal.transcript).not.toContain('\x1b[2K');
      expectColorResetBefore(terminal.transcript, 'ACTIVITY_RESULT=');
      expectRestored(terminal);
    }, 15000);
  }

  test(`${process.env.JAVA_RUN_PTY_CLI ? '编译二进制' : '源码 CLI'} 主类选择后将规范输入和回显交给真实 Java 应用`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'java-run-pty-'));
    directories.push(root);
    mkdirSync(join(root, 'classes'));
    writeFileSync(join(root, 'Alpha.java'), 'public class Alpha { public static void main(String[] args) {} }');
    writeFileSync(join(root, 'StdinApplication.java'), `
      public class StdinApplication {
        public static void main(String[] args) throws Exception {
          System.out.println("JAVA_READY");
          String line = new java.io.BufferedReader(new java.io.InputStreamReader(System.in)).readLine();
          System.out.println("JAVA_READ=" + line);
        }
      }
    `);
    const compilation = spawnSync('javac', ['-encoding', 'UTF-8', '-d', 'classes', 'Alpha.java', 'StdinApplication.java'], {
      cwd: root, encoding: 'utf8', timeout: 20000,
    });
    expect(compilation.status, compilation.stderr || compilation.error?.message).toBe(0);
    writeFileSync(join(root, 'pom.xml'), `<project>
      <groupId>example</groupId><artifactId>pty</artifactId><version>1</version>
      <build><outputDirectory>classes</outputDirectory><testOutputDirectory>test-classes</testOutputDirectory></build>
    </project>`);
    const build = join(root, 'metadata-command');
    // 固定模型只隔离构建耗时；类发现、Jar 生成与最终 Java 进程均走实际 CLI
    writeFileSync(build, `#!/bin/sh
      for argument in "$@"; do
        case "$argument" in
          -Doutput=*) output="\${argument#-Doutput=}" ;;
          -Dmdep.outputFile=*) output="\${argument#-Dmdep.outputFile=}" ;;
        esac
      done
      case "$output" in
        */project-file.txt) printf '%s/pom.xml' "$PWD" > "$output" ;;
        */effective-pom.xml) cp pom.xml "$output" ;;
        */dependencies.txt) : > "$output" ;;
        *) exit 1 ;;
      esac
    `);
    chmodSync(build, 0o755);
    const command = process.env.JAVA_RUN_PTY_CLI
      ? [resolve(process.env.JAVA_RUN_PTY_CLI)]
      : [process.execPath, sourceCli];
    const terminal = await runTerminalPty({
      command: [...command, '--cwd', root, '--module', 'pty', '--build=none', '--build-command', build],
      steps: [
        { waitFor: 'StdinApplication', send: '\x1b[B\r' },
        { waitFor: 'JAVA_READY', send: 'terminal-input' },
        { observeMs: 100, absent: 'JAVA_READ=' },
        { send: '\n' },
        { waitFor: 'JAVA_READ=terminal-input' },
      ],
      timeoutMs: 20000,
    });
    expect(terminal.exitCode).toBe(0);
    expect(terminal.transcript.match(/启动应用/g)).toHaveLength(1);
    expectColorResetBefore(terminal.transcript, 'JAVA_READY');
    expect(terminal.transcript).toContain('terminal-input\r\n');
    expectRestored(terminal);
  }, 30000);
});
