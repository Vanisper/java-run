import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
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

describe('终端日志输出契约', () => {
  test('外部文字中的控制序列被清理，正文和合法换行保留', () => {
    const output = formatTerminalLog({
      context: ['source\r\n\x1b[2J'], type: 'info', message: '\x1b[31mfirst\x1b[0m\nsecond\x00\x07',
    }, { color: false });
    expect(output).toContain('source');
    expect(output).toContain('first');
    expect(output).toContain('second');
    expect(output).toContain('\n');
    expect(output).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    const layout = createTerminalLayout({ color: false });
    for (const value of [
      layout.heading('\x1b[2Jheading\r\n', ['source\r\n\x07']),
      layout.details('label\r\n', '\x1b[31mvalue\x1b[0m'),
      layout.line('info', 'body', { indicator: '\x1b[2J/\r\n\x00' }),
    ]) expect(value).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  test('结构化字段不会隐式写入终端正文', async () => {
    const captured = captureOutput();
    const logger = createLogger({ context: 'java-run', reporter: createTerminalReporter({ color: true }, captured.output) })
      .withContext('maven', { stage: 'hidden-stage' });
    logger.info('visible-message', { module: 'hidden-module', durationMs: 987654321, secret: { token: 'hidden-token' } });
    await logger.flush();
    expect(captured.text()).toContain('visible-message');
    for (const hidden of ['hidden-stage', 'hidden-module', '987654321', 'hidden-token']) expect(captured.text()).not.toContain(hidden);
    expect(captured.output.listenerCount('error')).toBe(0);
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
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('第一条');
    expect(chunks.join('')).not.toContain('第二条');
    callbacks.shift()!();
    await turn();
    expect(flushed).toBe(false);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toContain('第二条');
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
    expect(chunks.at(-1)).toContain('下一轮');
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
      for (const message of ['信息', '完成', '警告', '错误', '诊断正文']) expect(result.stderr).toContain(message);
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
