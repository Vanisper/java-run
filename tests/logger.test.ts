import { describe, expect, test } from 'bun:test';
import { createLogger, type LogRecord, type LogReporter } from '../src/logging/logger';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function captureRecords() {
  const records: LogRecord[] = [];
  const reporter: LogReporter = { log(record) { records.push(record); } };
  return { records, reporter };
}

describe('日志核心契约', () => {
  test('context 逐级追加，父级与兄弟独立，fields 按根、子级、单条浅合并', async () => {
    const { records, reporter } = captureRecords();
    const root = createLogger({ context: 'java-run', fields: { request: 7, tool: 'auto', nested: { root: true } }, reporter });
    const maven = root.withContext('maven', { tool: 'maven', module: ':app', nested: { child: true } });
    const compile = maven.withContext('compile', { stage: 'compile' });
    const gradle = root.withContext('gradle', { tool: 'gradle' });
    const before = Date.now();
    compile.info('开始', { module: ':server', nested: { record: true } });
    maven.success('完成');
    gradle.warn('重试');
    root.error('失败');
    await root.flush();
    expect(root.context).toEqual(['java-run']);
    expect(maven.context).toEqual(['java-run', 'maven']);
    expect(compile.context).toEqual(['java-run', 'maven', 'compile']);
    expect(gradle.context).toEqual(['java-run', 'gradle']);
    expect(records.map(record => ({ context: record.context, fields: record.fields }))).toEqual([
      { context: ['java-run', 'maven', 'compile'], fields: { request: 7, tool: 'maven', module: ':server', nested: { record: true }, stage: 'compile' } },
      { context: ['java-run', 'maven'], fields: { request: 7, tool: 'maven', module: ':app', nested: { child: true } } },
      { context: ['java-run', 'gradle'], fields: { request: 7, tool: 'gradle', nested: { root: true } } },
      { context: ['java-run'], fields: { request: 7, tool: 'auto', nested: { root: true } } },
    ]);
    expect(records[1]).toMatchObject({ message: '完成', type: 'success', level: 'info' });
    for (const record of records) {
      expect(record.timestamp).toBeGreaterThanOrEqual(before);
      expect(record.timestamp).toBeLessThanOrEqual(Date.now());
    }
  });

  test('根、子级和单条 fields 保留冻结的顶层快照，flush 后可以继续记录', async () => {
    const { records, reporter } = captureRecords();
    const inherited = { module: ':app' };
    const childFields = { tool: 'maven' };
    const fields = { attempt: 1 };
    const root = createLogger({ fields: inherited, reporter });
    const logger = root.withContext('maven', childFields);
    inherited.module = ':other';
    childFields.tool = 'gradle';
    logger.info('准备', fields);
    fields.attempt = 2;
    await logger.flush();
    expect(records[0]?.fields).toEqual({ module: ':app', tool: 'maven', attempt: 1 });
    expect(Object.isFrozen(records[0])).toBe(true);
    expect(Object.isFrozen(records[0]?.context)).toBe(true);
    expect(Object.isFrozen(records[0]?.fields)).toBe(true);
    logger.success('下一轮', fields);
    fields.attempt = 3;
    await root.flush();
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ type: 'success', context: ['maven'], fields: { module: ':app', tool: 'maven', attempt: 2 } });
  });

  for (const [level, expected] of [
    [undefined, ['info', 'success', 'warn', 'error']],
    ['debug', ['debug', 'info', 'success', 'warn', 'error']],
    ['info', ['info', 'success', 'warn', 'error']],
    ['warn', ['warn', 'error']],
    ['error', ['error']],
  ] as const) {
    test(`${level ?? '默认'} 级别按严重程度过滤，success 与 info 同级`, async () => {
      const { records, reporter } = captureRecords();
      const logger = createLogger({ level, reporter });
      logger.debug('debug');
      logger.info('info');
      logger.success('success');
      logger.warn('warn');
      logger.error('error');
      await logger.flush();
      expect(records.map(record => record.type)).toEqual([...expected]);
      expect(records.every(record => record.context.length === 0)).toBe(true);
    });
  }

  test('父子日志串行提交，任一子级 flush 等待全树队列与 reporter 清理', async () => {
    const started: string[] = [];
    let releaseFirst!: () => void;
    let releaseCleanup!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
    const root = createLogger({ context: 'java-run', reporter: {
      log(record) { started.push(record.message); if (record.message === 'first') return first; },
      async flush() { started.push('flush'); await cleanup; },
    } });
    const child = root.withContext('maven');
    root.info('first');
    child.info('second');
    root.withContext('gradle').info('third');
    let completed = false;
    const pending = child.flush().then(() => { completed = true; });
    await turn();
    expect(started).toEqual(['first']);
    expect(completed).toBe(false);
    releaseFirst();
    await turn();
    expect(started).toEqual(['first', 'second', 'third', 'flush']);
    expect(completed).toBe(false);
    releaseCleanup();
    await pending;
    expect(completed).toBe(true);
  });

  test('重复消息不合并，flush 不留下延迟日志', async () => {
    const { records, reporter } = captureRecords();
    const logger = createLogger({ reporter });
    for (let index = 0; index < 20; index++) logger.info('仍在准备');
    await logger.flush();
    expect(records).toHaveLength(20);
    expect(records.map(record => record.message)).toEqual(Array(20).fill('仍在准备'));
    await turn();
    expect(records).toHaveLength(20);
  });

  test('首次异步写入错误在父子 flush 中保留，并仍执行 reporter 清理', async () => {
    const failure = new Error('reporter 写入失败');
    let cleaned = 0;
    const root = createLogger({ reporter: {
      async log() { throw failure; },
      flush() { cleaned++; },
    } });
    const child = root.withContext('maven');
    expect(() => child.error('失败')).not.toThrow();
    await expect(root.flush()).rejects.toBe(failure);
    expect(cleaned).toBeGreaterThan(0);
    await expect(child.flush()).rejects.toBe(failure);
  });

  test('同步 reporter 异常与 flush 异常均保留原始错误', async () => {
    const failure = new Error('同步写入失败');
    const later = new Error('清理失败');
    const logger = createLogger({ reporter: { log() { throw failure; }, flush() { throw later; } } });
    expect(() => logger.info('失败')).not.toThrow();
    await expect(logger.flush()).rejects.toBe(failure);
    const cleanup = createLogger({ reporter: { log() {}, flush() { throw later; } } });
    cleanup.info('成功写入');
    await expect(cleanup.flush()).rejects.toBe(later);
  });
});
