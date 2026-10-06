import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { constants } from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import jschardet from 'jschardet';
import type { CommandSpec } from '../core/types';

/** 外部命令的退出状态和捕获输出 */
export interface CommandResult {
  /** 信号终止时使用 128 加信号编号 */
  exitCode: number;
  /** 正常退出时为空，Windows 信号终止保留父进程收到的信号 */
  signal: NodeJS.Signals | null;
  /** 未启用 capture 时为空字符串 */
  stdout: string;
  /** 未启用 capture 时为空字符串 */
  stderr: string;
}

/** 命令执行失败时保留调用位置、退出状态和诊断输出 */
export class CommandError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly stage: string;
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(spec: CommandSpec, result: CommandResult, cause?: unknown) {
    super(`${spec.stage}失败：${spec.command}（退出码 ${result.exitCode}）`, { cause });
    this.name = 'CommandError';
    this.command = spec.command;
    this.args = [...spec.args];
    this.cwd = spec.cwd;
    this.stage = spec.stage;
    this.exitCode = result.exitCode;
    this.signal = result.signal;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

/** 异步命令的输出交付和信号转发选项 */
export interface RunCommandOptions {
  /**
   * 本次子进程的环境覆盖，未指定的变量继承父环境
   *
   * @description undefined 删除变量；Windows 运行时可补回 PATH 等必需系统变量
   */
  env?: NodeJS.ProcessEnv;
  /** 累计 stdout 和 stderr 作为命令结果；默认不累计 */
  capture?: boolean;
  /**
   * 接收 stdout 和 stderr 的原始输出块，stdin 仍继承当前终端
   *
   * @description
   * - 未启用 capture 时只转交输出，不累计诊断或应用 maxBuffer 上限
   * - 启用 capture 时只转交捕获上限内保留的字节
   * - 按两个管道被读取的顺序串行调用，不保证还原子进程跨流写入的先后
   * - 等待回调期间暂停管道读取，命令结果等待所有回调完成
   * - 回调抛错或拒绝时终止进程树，以 CommandError 保留原因和已捕获输出
   * - 输出块是独立副本，字符可能跨块，调用方应按流保留解码状态
   */
  onOutput?: (output: CommandOutput) => void | Promise<void>;
  /** 转发 SIGINT、SIGTERM 并在父进程退出时清理子进程；默认启用 */
  forwardSignals?: boolean;
  /** 捕获输出的总字节上限，仅对 capture 生效，默认 16 MiB */
  maxBuffer?: number;
}

/** 从子进程管道读取的原始输出块，不包含字符编码假设 */
export interface CommandOutput {
  stream: 'stdout' | 'stderr';
  data: Buffer;
}

/** 检测完整输出的编码并解码，无法识别时按 UTF-8 读取 */
export function decodeOutput(output: Buffer): string {
  if (output.length === 0) return '';
  const detected = jschardet.detect(output);
  return detected.encoding && iconv.encodingExists(detected.encoding)
    ? iconv.decode(output, detected.encoding)
    : output.toString('utf8');
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  return signal ? 128 + (constants.signals[signal] ?? 0) : 1;
}

function spawnExitCode(error: unknown): number {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? 127 : 1;
}

function windowsEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function childEnvironment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const [name, value] of Object.entries(overrides ?? {})) {
    const names = process.platform === 'win32'
      ? Object.keys(env).filter(key => key.toLowerCase() === name.toLowerCase())
      : [name];
    for (const key of names) delete env[key];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function resolveWindowsCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const extensions = path.extname(command)
    ? ['']
    : ['', ...(windowsEnvironmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')];
  const directories = command.includes('/') || command.includes('\\')
    ? [cwd]
    : [cwd, ...(windowsEnvironmentValue(env, 'PATH') ?? '').split(';')];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory.replace(/^"|"$/g, ''), `${command}${extension}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // PATH 中不存在的目录不影响后续候选项
      }
    }
  }
  return command;
}

const cmdMetaCharacters = /([()\][%!^"`<>&|;, *?])/g;

function escapeWindowsArgument(argument: string, doubleEscape: boolean): string {
  // 参照 cross-spawn 的两层解析策略，保留引号前及末尾的反斜杠
  let escaped = `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
    .replace(cmdMetaCharacters, '^$1');
  if (doubleEscape) escaped = escaped.replace(cmdMetaCharacters, '^$1');
  return escaped;
}

function prepareCommand(command: string, args: string[], cwd: string, env = process.env) {
  if (process.platform !== 'win32') return { command, args, env, windowsVerbatimArguments: false };
  const resolved = resolveWindowsCommand(command, cwd, env);
  if (!/\.(?:cmd|bat)$/i.test(resolved)) return { command, args, env, windowsVerbatimArguments: false };
  if ([resolved, ...args].some(value => /[\r\n\0]/.test(value))) {
    throw new Error('Windows 批处理入口不支持包含换行或空字符的命令和参数');
  }
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
  const words = [
    path.normalize(resolved).replace(cmdMetaCharacters, '^$1'),
    ...args.map(argument => escapeWindowsArgument(argument, doubleEscape)),
  ];
  const childEnv = { ...env };
  const prefix = `JAVA_RUN_EXEC_${randomUUID().replace(/-/g, '')}`;
  // cmd 变量替换不递归，先放入环境变量可阻止参数中的 %NAME% 被展开
  const commandLine = words.map((word, index) => {
    const name = `${prefix}_${index}`;
    childEnv[name] = word;
    return `%${name}%`;
  }).join(' ');
  return {
    command: windowsEnvironmentValue(env, 'COMSPEC') ?? 'cmd.exe',
    args: ['/d', '/v:off', '/s', '/c', `"${commandLine}"`],
    env: childEnv,
    windowsVerbatimArguments: true,
  };
}

/**
 * 执行外部命令并等待完整退出
 *
 * @description
 * - 正常退出及非零退出均返回结果，启动失败、输出超限或回调失败抛出 CommandError
 * - 未指定 capture 和 onOutput 时继承终端；所有模式都继承 stdin
 * - capture 保留输出中的换行和首尾空白，仅使用 onOutput 时不累计输出
 * - Unix 子进程使用独立进程组，转发信号及退出清理只作用于该命令的进程树
 */
export function runCommand(spec: CommandSpec, options: RunCommandOptions = {}): Promise<CommandResult> {
  const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 0) {
    return Promise.reject(new RangeError('maxBuffer 必须是非负安全整数'));
  }
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32';
    let child: ReturnType<typeof spawn>;
    try {
      const prepared = prepareCommand(spec.command, spec.args, spec.cwd, childEnvironment(options.env));
      child = spawn(prepared.command, prepared.args, {
        cwd: spec.cwd,
        env: prepared.env,
        stdio: options.capture || options.onOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit',
        detached,
        shell: false,
        windowsVerbatimArguments: prepared.windowsVerbatimArguments,
      });
    } catch (error) {
      reject(new CommandError(spec, { exitCode: spawnExitCode(error), signal: null, stdout: '', stderr: '' }, error));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let outputExceeded = false;
    let spawnError: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let receivedSignal: NodeJS.Signals | null = null;
    const pendingOutput: CommandOutput[] = [];
    let outputWork = Promise.resolve();
    let deliveringOutput = false;
    let outputFailed = false;
    let outputError: unknown;

    function killTree(signal: NodeJS.Signals): void {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        // Windows 没有 POSIX 进程组，taskkill /T 覆盖批处理启动的 JVM
        const taskkill = path.join(windowsEnvironmentValue(process.env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
      }
    }

    function forwardSignal(signal: NodeJS.Signals): void {
      killTree(receivedSignal ? 'SIGKILL' : signal);
      receivedSignal ??= signal;
      escalation ??= setTimeout(() => killTree('SIGKILL'), 3000);
      escalation.unref();
    }

    const onSigint = () => forwardSignal('SIGINT');
    const onSigterm = () => forwardSignal('SIGTERM');
    const onParentExit = () => killTree('SIGKILL');
    if (options.forwardSignals !== false) {
      process.on('SIGINT', onSigint);
      process.on('SIGTERM', onSigterm);
      process.on('exit', onParentExit);
    }

    async function deliverOutput(): Promise<void> {
      while (pendingOutput.length && !outputFailed) {
        const output = pendingOutput.shift()!;
        try {
          await options.onOutput!(output);
        } catch (error) {
          outputFailed = true;
          outputError = error;
          killTree('SIGKILL');
        }
      }
      pendingOutput.length = 0;
      deliveringOutput = false;
      child.stdout?.resume();
      child.stderr?.resume();
    }

    function receiveOutput(stream: CommandOutput['stream'], chunks: Buffer[], data: Buffer): void {
      let retained: Buffer | undefined = data;
      if (options.capture) {
        const remaining = Math.max(0, maxBuffer - capturedBytes);
        retained = remaining > 0 ? Buffer.from(data.subarray(0, remaining)) : undefined;
        if (retained) chunks.push(retained);
        capturedBytes += data.length;
        if (capturedBytes > maxBuffer && !outputExceeded) {
          outputExceeded = true;
          killTree('SIGKILL');
        }
      }
      if (retained && options.onOutput && !outputFailed) {
        // 两个管道共用一个有界队列，异步回调不能让另一个流继续积压
        child.stdout?.pause();
        child.stderr?.pause();
        pendingOutput.push({ stream, data: Buffer.from(retained) });
        if (!deliveringOutput) {
          deliveringOutput = true;
          outputWork = deliverOutput();
        }
      }
    }

    child.stdout?.on('data', (data: Buffer) => receiveOutput('stdout', stdout, data));
    child.stderr?.on('data', (data: Buffer) => receiveOutput('stderr', stderr, data));
    child.once('error', error => { spawnError = error; });
    child.once('exit', () => {
      // 组长退出后清理仍持有终端或输出管道的后代进程
      killTree('SIGKILL');
    });
    async function finish(exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> {
      if (escalation) clearTimeout(escalation);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('exit', onParentExit);
      await outputWork;
      const effectiveSignal = signal ?? (process.platform === 'win32' ? receivedSignal : null);
      const result: CommandResult = {
        exitCode: spawnError ? spawnExitCode(spawnError)
          : process.platform === 'win32' && receivedSignal ? signalExitCode(receivedSignal)
          : exitCode ?? signalExitCode(effectiveSignal),
        signal: effectiveSignal,
        stdout: decodeOutput(Buffer.concat(stdout)),
        stderr: decodeOutput(Buffer.concat(stderr)),
      };
      if (spawnError || outputExceeded || outputFailed) {
        reject(new CommandError(spec, result,
          spawnError ?? (outputFailed ? outputError : new Error(`命令输出超过 ${maxBuffer} 字节`))));
      } else {
        resolve(result);
      }
    }

    child.once('close', (exitCode, signal) => {
      void finish(exitCode, signal).catch(reject);
    });
  });
}
