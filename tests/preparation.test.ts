import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

const modulePath = new URL('../src/cli/presentation.ts', import.meta.url).href;
const execPath = new URL('../src/process/exec.ts', import.meta.url).href;
const selectionPath = new URL('../src/cli/selection.ts', import.meta.url).href;

function run(logMode: 'summary' | 'full', failure: 'command' | 'metadata' | 'main' | 'cancel' | 'terminate' = 'command') {
  const spec = {
    command: process.execPath,
    args: ['-e', `process.stdout.write("BUILD-DIAGNOSTIC\\n"); process.stderr.write("STDERR-DIAGNOSTIC\\n"); process.exit(${failure === 'command' ? 7 : 0})`],
    cwd: process.cwd(), stage: '构建',
  };
  const precedingSpec = { ...spec, stage: '读取项目模型', args: ['-e', 'process.stdout.write("EARLIER-DIAGNOSTIC\\n")'] };
  return spawnSync(process.execPath, ['-e', `
    import { createCliPresentation } from ${JSON.stringify(modulePath)};
    import { CommandError } from ${JSON.stringify(execPath)};
    import { SelectionCancelledError } from ${JSON.stringify(selectionPath)};
    const ui = createCliPresentation({ input: 'none', rewrite: false, color: false, animation: false, logMode: '${logMode}' });
    const validationError = ${failure === 'cancel' || failure === 'terminate' ? `new SelectionCancelledError('${failure === 'terminate' ? 'SIGTERM' : 'SIGINT'}')` : `new Error('${failure === 'main' ? '入口校验失败' : '元数据校验失败'}')`};
    let commandExitCode;
    const spec = ${JSON.stringify(spec)};
    try {
      await ui.run('项目准备', async execute => {
        ${failure === 'command' ? '' : `await execute(${JSON.stringify(precedingSpec)});`}
        const result = await execute(spec);
        commandExitCode = result.exitCode;
        if (result.exitCode) throw new CommandError(spec, result);
        throw validationError;
      });
    } catch (error) {
      if (error instanceof CommandError && !ui.hasDisplayed(error)) process.stderr.write(error.stdout);
      console.error(error.message);
      if (${failure !== 'command'}) process.stdout.write(JSON.stringify({ commandExitCode, sameError: error === validationError }));
      process.exitCode = error.exitCode || 1;
    }
  `], { encoding: 'utf8', timeout: 10000 });
}

describe('准备过程日志接入', () => {
  test.each(['summary', 'full'] as const)('%s 模式保留退出码且失败日志仅展示一次', mode => {
    const result = run(mode);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
    expect(result.stdout).toBe('');
    expect(result.stderr.match(/BUILD-DIAGNOSTIC/g)).toHaveLength(1);
  });

  for (const failure of ['metadata', 'main'] as const) {
    test.each(['summary', 'full'] as const)(`%s 模式在${failure === 'metadata' ? '元数据' : '入口'}校验失败时保留此前诊断且不重复`, mode => {
      const result = run(mode, failure);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({ commandExitCode: 0, sameError: true });
      for (const diagnostic of ['EARLIER-DIAGNOSTIC', 'BUILD-DIAGNOSTIC', 'STDERR-DIAGNOSTIC']) {
        expect(result.stderr.match(new RegExp(diagnostic, 'g'))).toHaveLength(1);
      }
      expect(result.stderr.indexOf('EARLIER-DIAGNOSTIC')).toBeLessThan(result.stderr.indexOf('BUILD-DIAGNOSTIC'));
    });
  }

  test.each([['cancel', 130], ['terminate', 143]] as const)('summary 模式在选择 %s 后不回放成功命令的诊断', (failure, exitCode) => {
    const result = run('summary', failure);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(exitCode);
    expect(JSON.parse(result.stdout)).toEqual({ commandExitCode: 0, sameError: true });
    expect(result.stderr).not.toContain('DIAGNOSTIC');
  });

  test('阶段诊断超过字符预算时淘汰早期命令并提示，仅回放最近成功命令', () => {
    const result = spawnSync(process.execPath, ['-e', `
      import { mock } from 'bun:test';
      import { CommandError } from ${JSON.stringify(execPath)};
      let commandCount = 0;
      mock.module(${JSON.stringify(execPath)}, () => ({
        CommandError,
        runCommand: async () => ({ exitCode: 0, signal: null, stderr: '',
          stdout: (++commandCount === 1 ? 'OLD-DIAGNOSTIC' : 'RECENT-DIAGNOSTIC') + 'x'.repeat(9 * 1024 * 1024) }),
      }));
      const { createCliPresentation } = await import(${JSON.stringify(modulePath)});
      const ui = createCliPresentation({ input: 'none', rewrite: false, color: false, animation: false, logMode: 'summary' });
      const observation = { old: false, recent: false, truncated: false, outputBytes: 0, sameError: false };
      const write = process.stderr.write;
      process.stderr.write = (chunk, encoding, done) => {
        const text = chunk.toString();
        observation.old ||= text.includes('OLD-DIAGNOSTIC');
        observation.recent ||= text.includes('RECENT-DIAGNOSTIC');
        observation.truncated ||= text.includes('超出诊断保留上限');
        observation.outputBytes += Buffer.byteLength(text);
        (typeof encoding === 'function' ? encoding : done)?.();
        return true;
      };
      const failure = new Error('元数据校验失败');
      try {
        await ui.run('项目准备', async execute => {
          const spec = { command: 'build', args: [], cwd: process.cwd(), stage: '构建' };
          await execute(spec);
          await execute(spec);
          throw failure;
        });
      } catch (error) { observation.sameError = error === failure; }
      finally { process.stderr.write = write; }
      process.stdout.write(JSON.stringify(observation));
    `], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    const { outputBytes, ...observation } = JSON.parse(result.stdout);
    expect(observation).toEqual({ old: false, recent: true, truncated: true, sameError: true });
    expect(outputBytes).toBeGreaterThan(9 * 1024 * 1024);
    expect(outputBytes).toBeLessThan(10 * 1024 * 1024);
  });
});
