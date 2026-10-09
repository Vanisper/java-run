import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

const presentationPath = new URL('../src/cli/presentation.ts', import.meta.url).href;
const loggerPath = new URL('../src/logging/logger.ts', import.meta.url).href;
const execPath = new URL('../src/process/exec.ts', import.meta.url).href;

describe('应用启动日志交接', () => {
  test.each([0, 7])('异步启动记录与 flush 完成后执行应用，保留退出码 %d', exitCode => {
    const spec = {
      command: process.execPath,
      args: ['-e', `process.stdout.write('CHILD_STARTED\\n'); process.exit(${exitCode})`],
      cwd: process.cwd(), stage: '运行 Java 应用', mainClass: 'example.Application',
    };
    const result = spawnSync(process.execPath, ['-e', `
      import { createCliPresentation } from ${JSON.stringify(presentationPath)};
      import { createLogger } from ${JSON.stringify(loggerPath)};
      import { CommandError } from ${JSON.stringify(execPath)};
      const records = [];
      const logger = createLogger({ context: 'java-run', reporter: {
        async log(record) {
          await Bun.sleep(20);
          records.push(record);
          process.stdout.write('LOG_DELIVERED\\n');
        },
        async flush() {
          await Bun.sleep(20);
          process.stdout.write('FLUSHED\\n');
        },
      }}).withContext('run').withContext('maven');
      const ui = createCliPresentation({ input: 'none', rewrite: false, color: false, animation: false, logMode: 'summary' }, logger);
      let exitCode;
      let reported = false;
      try { exitCode = await ui.launch(${JSON.stringify(spec)}); }
      catch (error) {
        if (!(error instanceof CommandError)) throw error;
        exitCode = error.exitCode;
        reported = ui.hasReported(error);
      }
      process.stdout.write('RESULT=' + JSON.stringify({ exitCode, reported, records }) + '\\n');
      process.exitCode = exitCode;
    `], { encoding: 'utf8', timeout: 10000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(exitCode);
    expect(result.stdout).toStartWith('LOG_DELIVERED\nFLUSHED\nCHILD_STARTED\n');
    const observation = JSON.parse(result.stdout.slice(result.stdout.indexOf('RESULT=') + 7));
    expect(observation.exitCode).toBe(exitCode);
    expect(observation.reported).toBe(exitCode !== 0);
    expect(observation.records).toHaveLength(1);
    expect(observation.records[0]).toMatchObject({
      level: 'info', type: 'info', message: '启动应用', context: ['java-run', 'run', 'maven'],
      fields: { event: 'application.start', mainClass: spec.mainClass, command: spec.command, cwd: spec.cwd },
    });
    expect(Object.keys(observation.records[0].fields).sort()).toEqual(['command', 'cwd', 'event', 'mainClass']);
    expect(result.stderr.match(/启动应用/g)).toHaveLength(1);
  });
});
