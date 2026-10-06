import { createConsola, LogLevels } from 'consola/core';

/** 日志严重级别，按 debug、info、warn、error 逐级提高 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 日志语义类型，success 使用 info 严重级别 */
export type LogType = LogLevel | 'success';

/** 日志结构化字段，嵌套值由调用方保持只读 */
export type LogFields = Readonly<Record<string, unknown>>;

/** 一次日志调用形成的不可变记录 */
export interface LogRecord {
  /** Unix 时间戳，单位为毫秒 */
  readonly timestamp: number;
  readonly level: LogLevel;
  readonly type: LogType;
  /** 从根到当前来源的上下文层级 */
  readonly context: readonly string[];
  readonly message: string;
  /** 创建、子上下文和本条字段依次浅合并，后者覆盖同名字段 */
  readonly fields: LogFields;
}

/** 接收按调用顺序串行交付的日志记录 */
export interface LogReporter {
  /** 返回的 Promise 表示该条记录已经交付完成 */
  log(record: LogRecord): void | Promise<void>;
  /** 等待底层缓冲写完或释放本轮资源，随后仍可接收新记录 */
  flush?(): void | Promise<void>;
}

/** 共享记录交付与失败状态的日志上下文 */
export interface Logger {
  readonly context: readonly string[];
  /** 创建追加来源层级的子上下文，不修改父上下文及兄弟上下文 */
  withContext(name: string, fields?: LogFields): Logger;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  success(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /**
   * 等待此前由根或任意子上下文提交的记录，并调用 reporter.flush
   *
   * @description 不关闭实例；交付失败时抛出首次错误，后续调用仍按顺序交付
   */
  flush(): Promise<void>;
}

/**
 * 创建按级别过滤、按上下文组织记录的日志实例
 *
 * @description
 * - 默认级别为 info，不从环境变量读取日志级别
 * - 字段和上下文在提交时复制并冻结顶层，嵌套字段不作深拷贝
 * - 日志调用只提交记录，异步交付失败通过 flush 报告
 */
export function createLogger(options: {
  context?: string;
  fields?: LogFields;
  level?: LogLevel;
  reporter: LogReporter;
}): Logger {
  let queue = Promise.resolve();
  let failed = false;
  let failure: unknown;

  function rememberFailure(error: unknown): void {
    if (failed) return;
    failed = true;
    failure = error;
  }

  const engine = createConsola({
    level: LogLevels[options.level ?? 'info'],
    throttle: 0,
    reporters: [{
      log(event) {
        const type = event.type as LogType;
        const record: LogRecord = Object.freeze({
          timestamp: event.date.getTime(),
          level: type === 'success' ? 'info' : type,
          type,
          context: event.context as readonly string[],
          message: event.args[0] as string,
          fields: event.fields as LogFields,
        });
        queue = queue.then(() => options.reporter.log(record)).catch(rememberFailure);
      },
    }],
  });

  function flush(): Promise<void> {
    const flushed = queue.then(async () => {
      try {
        await options.reporter.flush?.();
      } catch (error) {
        rememberFailure(error);
      }
      if (failed) throw failure;
    });
    // flush 与新记录共用队列，失败不能留下未处理拒绝或打断后续交付
    queue = flushed.catch(rememberFailure);
    return flushed;
  }

  function createContext(context: readonly string[], inherited: LogFields): Logger {
    function log(type: LogType, message: string, fields?: LogFields): void {
      engine[type]({ args: [message], context, fields: Object.freeze({ ...inherited, ...fields }) });
    }

    return {
      context,
      withContext: (name, fields) => createContext(
        Object.freeze([...context, name]), Object.freeze({ ...inherited, ...fields }),
      ),
      debug: (message, fields) => log('debug', message, fields),
      info: (message, fields) => log('info', message, fields),
      success: (message, fields) => log('success', message, fields),
      warn: (message, fields) => log('warn', message, fields),
      error: (message, fields) => log('error', message, fields),
      flush,
    };
  }

  return createContext(
    Object.freeze(options.context === undefined ? [] : [options.context]),
    Object.freeze({ ...options.fields }),
  );
}
