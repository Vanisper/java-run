import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { createLogger } from '../src/logging/logger';
import { createTerminalReporter, formatTerminalLog, writeTerminalText } from '../src/terminal/log-reporter';
import { createTerminalLayout } from '../src/terminal/layout';

const loggerModule = new URL('../src/logging/logger.ts', import.meta.url).href;
const reporterModule = new URL('../src/terminal/log-reporter.ts', import.meta.url).href;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function captureOutput() {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { output, text: () => chunks.join('') };
}

describe('终端日志呈现契约', () => {
  for (const [type, icon, color] of [
    ['debug', '·', 36], ['info', 'ℹ', 36], ['success', '✓', 32], ['warn', '!', 33], ['error', '×', 31],
  ] as const) {
    test(`${type} 标题独立分组，仅为状态符号着色`, () => {
      const record = { context: ['java-run', 'maven'], type, message: '完成' };
      expect(formatTerminalLog(record, { color: true })).toBe(`\x1b[1mjava-run · maven\x1b[22m\n\n  \x1b[${color}m${icon}\x1b[39m 完成`);
      expect(formatTerminalLog(record, { color: false })).toBe(`java-run · maven\n\n  ${icon} 完成`);
    });
  }

  test('无 context 时省略标题，正文换行缩进，控制序列不能覆盖来源或正文', () => {
    expect(formatTerminalLog({ context: [], type: 'info', message: '第一行\n第二行' }, { color: false }))
      .toBe('  ℹ 第一行\n    第二行');
    expect(formatTerminalLog({ context: ['java\nrun', '\x1b[31mmaven\x1b[39m'], type: 'warn', message: '\x1b[2J保留正文' }, { color: false }))
      .toBe('java run · maven\n\n  ! 保留正文');
    expect(formatTerminalLog({ context: [], type: 'info', message: '第一行\r\n\t第二行\x00\x07' }, { color: false }))
      .toBe('  ℹ 第一行\n     第二行  ');
  });

  test('连续上下文只打印一次标题，所有结构化字段不混入正文或排版', async () => {
    const captured = captureOutput();
    const logger = createLogger({ context: 'java-run', reporter: createTerminalReporter({ color: true }, captured.output) })
      .withContext('maven', { stage: 'compile' });
    logger.info('准备', { module: ':app', durationMs: 999, secret: { token: '不可展示' } });
    logger.success('完成\n启动目标：Example');
    await logger.flush();
    expect(captured.text()).toBe(
      '\x1b[1mjava-run · maven\x1b[22m\n\n  \x1b[36mℹ\x1b[39m 准备\n'
      + '  \x1b[32m✓\x1b[39m 完成\n    启动目标：Example\n',
    );
    expect(captured.output.listenerCount('error')).toBe(0);
  });

  test('上下文切换后重印标题，flush 不重置连续分组', async () => {
    const captured = captureOutput();
    const logger = createLogger({ context: 'java-run', reporter: createTerminalReporter({ color: false }, captured.output) });
    const maven = logger.withContext('maven');
    maven.info('第一步');
    await logger.flush();
    maven.success('第二步');
    logger.withContext('launch').info('启动');
    maven.warn('重新准备');
    await logger.flush();
    expect(captured.text()).toBe('java-run · maven\n\n  ℹ 第一步\n  ✓ 第二步\n\njava-run · launch\n\n  ℹ 启动\n\njava-run · maven\n\n  ! 重新准备\n');
  });

  test('完整上下文和呈现标题分别参与分组，空上下文不显示标题', () => {
    let title = 'Maven';
    const layout = createTerminalLayout({ color: false }, { contextTitle: () => title });
    expect(layout.section(['run', 'maven'])).toBe('Maven\n\n');
    expect(layout.section(['run', 'maven'])).toBe('');
    title = 'Maven · :app';
    expect(layout.section(['run', 'maven'])).toBe('\nMaven · :app\n\n');
    expect(layout.section(['init', 'maven'])).toBe('\nMaven · :app\n\n');
    expect(layout.section([])).toBe('');
    expect(layout.section(['init', 'maven'])).toBe('\nMaven · :app\n\n');
  });

  test('共享 layout 让直接排版与 logger 沿用同一标题', async () => {
    const captured = captureOutput();
    const layout = createTerminalLayout({ color: false }, { contextTitle: () => 'Maven · :app' });
    const logger = createLogger({ context: 'run', reporter: createTerminalReporter({ color: false }, captured.output, layout) });
    const scope = logger.withContext('maven');
    captured.output.write(layout.section(scope.context) + layout.details('模块', ':app') + '\n');
    scope.success('准备完成');
    await logger.flush();
    expect(captured.text()).toBe('Maven · :app\n\n  模块  :app\n  ✓ 准备完成\n');
  });

  test('耗时按可见宽度对齐，窄屏另起一行且不截断正文', () => {
    let columns = 80;
    const layout = createTerminalLayout({ color: true }, { columns: () => columns });
    const short = stripVTControlCharacters(layout.line('success', '准备中文项目', 456));
    expect(Bun.stringWidth(short)).toBe(60);
    expect(short.endsWith('456ms')).toBe(true);
    const seconds = stripVTControlCharacters(layout.line('success', '完成', 2345));
    expect(Bun.stringWidth(seconds)).toBe(60);
    expect(seconds.endsWith('2.3s')).toBe(true);
    columns = 14;
    const long = '完整保留非常长的中文项目名称';
    const narrow = stripVTControlCharacters(layout.line('success', long, 2345)).split('\n');
    expect(narrow[0]).toBe(`  ✓ ${long}`);
    expect(narrow[1]!.trim()).toBe('2.3s');
    expect(Bun.stringWidth(narrow[1]!)).toBe(13);
  });

  test('详情高亮完整值，所有样式及时复位', () => {
    const layout = createTerminalLayout({ color: true }, { columns: () => 8 });
    const path = '/Users/example/包含空格的完整项目路径/target/classes';
    expect(layout.details('目录', path)).toBe(`  目录  \x1b[36m${path}\x1b[39m`);
    expect(layout.line('info', '阶段\n\x1b[2J补充信息')).toBe('  \x1b[36mℹ\x1b[39m 阶段\n    补充信息');
  });

  test('原始诊断保留正文、空白与 ANSI，只补缺失的尾换行', async () => {
    const captured = captureOutput();
    await writeTerminalText('  首行\n末行  ', captured.output);
    await writeTerminalText('\t已有 CRLF\r\n', captured.output);
    await writeTerminalText('\x1b[35m原始诊断\x1b[0m\n\n', captured.output);
    await writeTerminalText('', captured.output);
    expect(captured.text()).toBe('  首行\n末行  \n\t已有 CRLF\r\n\x1b[35m原始诊断\x1b[0m\n\n\n');
    expect(captured.output.listenerCount('error')).toBe(0);
  });

  test('flush 等待每次写入回调，再释放自身监听并允许下一轮日志', async () => {
    const chunks: string[] = [];
    const callbacks: (() => void)[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callbacks.push(callback);
      },
    });
    const existingListener = () => {};
    output.on('error', existingListener);
    const logger = createLogger({ context: 'java-run', reporter: createTerminalReporter({ color: false }, output) });
    logger.info('第一条');
    logger.success('第二条');
    let flushed = false;
    const pending = logger.flush().then(() => { flushed = true; });
    await turn();
    expect(flushed).toBe(false);
    expect(output.listenerCount('error')).toBe(2);
    expect(chunks).toEqual(['java-run\n\n  ℹ 第一条\n']);
    callbacks.shift()!();
    await turn();
    expect(flushed).toBe(false);
    expect(chunks).toEqual(['java-run\n\n  ℹ 第一条\n', '  ✓ 第二条\n']);
    callbacks.shift()!();
    await pending;
    expect(flushed).toBe(true);
    expect(output.listeners('error')).toEqual([existingListener]);

    logger.warn('下一轮');
    const next = logger.flush();
    await turn();
    expect(output.listenerCount('error')).toBe(2);
    callbacks.shift()!();
    await next;
    expect(chunks.at(-1)).toBe('  ! 下一轮\n');
    expect(output.listeners('error')).toEqual([existingListener]);
    output.removeListener('error', existingListener);
  });

  test('写入回调失败在 flush 中抛出原始错误并清理监听', async () => {
    const failure = new Error('写入回调失败');
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(failure); } });
    const logger = createLogger({ reporter: createTerminalReporter({ color: false }, output) });
    expect(() => logger.error('无法写入')).not.toThrow();
    await expect(logger.flush()).rejects.toBe(failure);
    expect(output.listenerCount('error')).toBe(0);
  });

  test('输出流 error 事件由 flush 抛出，保留首次错误', async () => {
    const failure = new Error('输出流关闭');
    const later = new Error('后续错误');
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        this.emit('error', failure);
        this.emit('error', later);
        callback();
      },
    });
    const logger = createLogger({ reporter: createTerminalReporter({ color: false }, output) });
    expect(() => logger.info('无法写入')).not.toThrow();
    await expect(logger.flush()).rejects.toBe(failure);
    await expect(logger.flush()).rejects.toBe(failure);
    expect(output.listenerCount('error')).toBe(0);
  });

  test('同步写入异常也由 flush 抛出原始错误', async () => {
    const failure = new Error('同步写入失败');
    const output = new Writable();
    output.write = () => { throw failure; };
    const logger = createLogger({ reporter: createTerminalReporter({ color: false }, output) });
    expect(() => logger.warn('无法写入')).not.toThrow();
    await expect(logger.flush()).rejects.toBe(failure);
    expect(output.listenerCount('error')).toBe(0);
  });

  test('原始诊断等待回调，失败时抛出原始错误并释放监听', async () => {
    const failure = new Error('诊断写入失败');
    let callback!: (error?: Error) => void;
    const output = new Writable({ write(_chunk, _encoding, done) { callback = done; } });
    let completed = false;
    const pending = writeTerminalText('诊断', output).then(
      () => { completed = true; return undefined; },
      error => { completed = true; return error; },
    );
    await turn();
    expect(completed).toBe(false);
    callback(failure);
    expect(await pending).toBe(failure);
    await turn();
    expect(output.listenerCount('error')).toBe(0);
  });

  for (const level of ['0', '-999']) {
    test(`默认四类提示与详情只写 stderr，CONSOLA_LEVEL=${level} 不隐藏正常日志`, () => {
      const source = `
        import { createLogger } from ${JSON.stringify(loggerModule)};
        import { createTerminalReporter, writeTerminalText } from ${JSON.stringify(reporterModule)};
        const logger = createLogger({ context: 'java-run', reporter: createTerminalReporter({ color: false }) });
        logger.info('信息');
        logger.success('完成');
        logger.warn('警告');
        logger.error('错误');
        await logger.flush();
        await writeTerminalText('诊断正文');
        process.stdout.write('RESULT\\n');
      `;
      const result = spawnSync(process.execPath, ['-e', source], {
        encoding: 'utf8', timeout: 5000, env: { ...process.env, CONSOLA_LEVEL: level },
      });
      expect(result.status, result.error?.message).toBe(0);
      expect(result.stdout).toBe('RESULT\n');
      expect(result.stderr).toBe('java-run\n\n  ℹ 信息\n  ✓ 完成\n  ! 警告\n  × 错误\n诊断正文\n');
    });
  }

  for (const [name, exitCode, failure] of [
    ['构建失败', 7, `new CommandError({ command: 'build', args: [], cwd: directory, stage: '构建项目' },
      { exitCode: 7, signal: null, stdout: '构建上下文', stderr: '编译失败' })`],
    ['SIGINT 取消', 130, "new SelectionCancelledError('SIGINT')"],
    ['SIGTERM 取消', 143, "new SelectionCancelledError('SIGTERM')"],
  ] as const) {
    test(`诊断输出 EPIPE 不覆盖${name}的退出码 ${exitCode}`, () => {
      const source = `
        import { mock } from 'bun:test';
        import { mkdtempSync, rmSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        import { CommandError } from ${JSON.stringify(new URL('../src/process/exec.ts', import.meta.url).href)};
        import { SelectionCancelledError } from ${JSON.stringify(new URL('../src/cli/selection.ts', import.meta.url).href)};
        const directory = mkdtempSync(join(tmpdir(), 'java-run-logger-exit-'));
        const failure = ${failure};
        mock.module(${JSON.stringify(new URL('../src/build-tools/detect.ts', import.meta.url).href)}, () => ({
          detectBuildTool() { throw failure; },
        }));
        const { main } = await import(${JSON.stringify(new URL('../src/cli.ts', import.meta.url).href)});
        const write = process.stderr.write;
        const listeners = process.stderr.listenerCount('error');
        process.stderr.write = (_chunk, encoding, done) => {
          const callback = typeof encoding === 'function' ? encoding : done;
          const failure = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
          callback?.(failure);
          process.stderr.emit('error', failure);
          return false;
        };
        try {
          const exitCode = await main(['--cwd', directory, '--no-interactive']);
          process.stdout.write(JSON.stringify({ exitCode, listeners: process.stderr.listenerCount('error') - listeners }) + '\\n');
        } catch (error) {
          process.stdout.write(JSON.stringify({ rejected: error.message }) + '\\n');
        } finally {
          process.stderr.write = write;
          rmSync(directory, { recursive: true, force: true });
        }
      `;
      const result = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 5000 });
      expect(result.status, result.error?.message || result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ exitCode, listeners: 0 });
      expect(result.stderr).toBe('');
    });
  }
});
