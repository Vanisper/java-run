import { CommandError, runCommand, type CommandResult } from '../process/exec';
import type { CommandSpec } from '../core/types';
import { activity, type ActivityFeedback } from '../terminal/activity';
import type { TerminalPolicy } from '../terminal/policy';
import type { Logger } from '../logging/logger';
import { createTerminalLayout, type TerminalLayout } from '../terminal/layout';
import { writeTerminalText } from '../terminal/log-reporter';

/** 按完整阶段组织命令、交互和诊断，阶段结束后交还终端 */
export function createCliPresentation(
  policy: TerminalPolicy,
  logger?: Logger,
  layout: TerminalLayout = createTerminalLayout(policy),
) {
  const displayed = new WeakSet<CommandError>();
  const reported = new WeakSet<object>();
  const tool = logger?.context.at(-1);
  const stagePrefix = tool === 'maven' ? 'Maven ' : tool === 'gradle' ? 'Gradle ' : undefined;
  const interruptedApplication = (error: unknown) => error instanceof CommandError && (error.signal === 'SIGINT' || error.signal === 'SIGTERM');

  async function writeDiagnostics(result: Pick<CommandResult, 'stdout' | 'stderr'>, feedback: ActivityFeedback): Promise<void> {
    if (result.stdout) await feedback.output({ stream: 'stdout', data: Buffer.from(result.stdout) }, 'full');
    if (result.stderr) await feedback.output({ stream: 'stderr', data: Buffer.from(result.stderr) }, 'full');
  }

  async function report(error: unknown, feedback: ActivityFeedback, application = false, diagnostics?: {
    results: readonly CommandResult[];
    truncated: boolean;
  }): Promise<void> {
    const exitCode = error && typeof error === 'object' && 'exitCode' in error ? error.exitCode : undefined;
    const cancelled = application ? interruptedApplication(error) : exitCode === 130 || exitCode === 143;
    if (!cancelled) {
      if (error instanceof CommandError) {
        if (!application || error.cause) {
          await feedback.log('error', error.message);
          await feedback.detail('工作目录', error.cwd);
        }
        if (!displayed.has(error)) {
          await writeDiagnostics(error, feedback);
          displayed.add(error);
        }
        if (error.cause instanceof Error) await feedback.log('error', error.cause.message);
      } else {
        await feedback.log('error', error instanceof Error ? error.message : String(error));
        if (diagnostics?.truncated) await feedback.log('warn', '较早的构建输出超出诊断保留上限，仅显示最近命令的输出');
        for (const result of diagnostics?.results ?? []) await writeDiagnostics(result, feedback);
      }
    }
    if (error && typeof error === 'object') reported.add(error);
  }

  return {
    /** 在模型读取和校验完成后结束活动，命令的非零结果仍由适配器解释 */
    async run<T>(label: string, work: (execute: typeof runCommand, feedback: ActivityFeedback) => Promise<T>): Promise<T> {
      await logger?.flush();
      let previous: { spec: CommandSpec; result: CommandResult } | undefined;
      const diagnostics = { results: [] as CommandResult[], truncated: false };
      let diagnosticLength = 0;
      return activity(label, async feedback => {
        try {
          return await work(async (spec, options) => {
            feedback.stage(stagePrefix && spec.stage.startsWith(stagePrefix) ? spec.stage.slice(stagePrefix.length) : spec.stage);
            let outputFailed = false;
            try {
              const result = await runCommand(spec, { ...options, capture: true, onOutput: async chunk => {
                try { await feedback.output(chunk); } catch (error) { outputFailed = true; throw error; }
              } });
              previous = { spec, result };
              if (policy.logMode === 'summary' && result.exitCode === 0 && (result.stdout || result.stderr)) {
                diagnostics.results.push(result);
                diagnosticLength += result.stdout.length + result.stderr.length;
                // 按完整命令淘汰旧诊断，最新命令仍保留执行器限额内的完整结果
                while (diagnosticLength > 16 * 1024 * 1024 && diagnostics.results.length > 1) {
                  const removed = diagnostics.results.shift()!;
                  diagnosticLength -= removed.stdout.length + removed.stderr.length;
                  diagnostics.truncated = true;
                }
              }
              return result;
            } catch (error) {
              if (error instanceof CommandError && policy.logMode === 'full' && !outputFailed) displayed.add(error);
              throw error;
            }
          }, feedback);
        } catch (error) {
          if (error instanceof CommandError && policy.logMode === 'full' && previous
            && error.command === previous.spec.command && error.cwd === previous.spec.cwd
            && error.stdout === previous.result.stdout && error.stderr === previous.result.stderr) displayed.add(error);
          throw error;
        }
      }, policy, process.stderr, {
        context: logger?.context, layout,
        onFailure: (error, feedback) => report(error, feedback, false, diagnostics),
      });
    },
    /** 应用输出实时转发；纯文本和重定向场景保留原始标准流 */
    async launch(spec: CommandSpec & { mainClass: string }): Promise<number> {
      logger?.info('启动应用', { event: 'application.start', mainClass: spec.mainClass, command: spec.command, cwd: spec.cwd });
      await logger?.flush();
      const framed = policy.rewrite && process.stdout.isTTY && process.stderr.isTTY;
      return activity('启动应用', async feedback => {
        await feedback.detail('入口', spec.mainClass);
        let result: CommandResult;
        try {
          result = await runCommand(spec, framed ? { onOutput: feedback.output } : {});
        } finally {
          // 继承输出可能没有末尾换行，补齐组尾边界且保留应用的原始结果
          if (!framed) try { await writeTerminalText(''); } catch {}
        }
        if (result.exitCode !== 0) throw new CommandError(spec, result);
        return result.exitCode;
      }, { ...policy, logMode: 'full' }, process.stderr, {
        context: logger?.context, layout, expanded: true,
        isCancelled: interruptedApplication,
        onFailure: (error, feedback) => report(error, feedback, true),
      });
    },
    /** 完整日志已写入终端时，失败处理只需追加错误上下文 */
    hasDisplayed(error: CommandError): boolean { return displayed.has(error); },
    /** 当前阶段已经给出完整诊断，顶层无需再次输出 */
    hasReported(error: unknown): boolean { return !!error && typeof error === 'object' && reported.has(error); },
  };
}
