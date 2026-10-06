import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

const modulePath = new URL('../src/cli/preparation.ts', import.meta.url).href;
const execPath = new URL('../src/process/exec.ts', import.meta.url).href;

function run(logMode: 'summary' | 'full', invalidMetadata = false) {
  return spawnSync(process.execPath, ['-e', `
    import { createPreparationPresentation } from ${JSON.stringify(modulePath)};
    import { CommandError } from ${JSON.stringify(execPath)};
    const ui = createPreparationPresentation({ input: 'none', rewrite: false, color: false, animation: false, logMode: '${logMode}' });
    const validationError = new Error('元数据校验失败');
    let commandExitCode;
    const spec = { command: process.execPath, args: ['-e', 'process.stdout.write("BUILD-DIAGNOSTIC\\\\n"); process.exit(${invalidMetadata ? 0 : 7})'], cwd: process.cwd(), stage: '构建' };
    try {
      await ui.run('项目准备', async execute => {
        const result = await execute(spec);
        commandExitCode = result.exitCode;
        if (result.exitCode) throw new CommandError(spec, result);
        throw validationError;
      });
    } catch (error) {
      if (error instanceof CommandError && !ui.hasDisplayed(error)) process.stderr.write(error.stdout);
      console.error(error.message);
      if (${invalidMetadata}) process.stdout.write(JSON.stringify({ commandExitCode, sameError: error === validationError }));
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

  test('命令成功后的元数据校验异常原样传递并使准备失败', () => {
    const result = run('summary', true);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ commandExitCode: 0, sameError: true });
  });
});
