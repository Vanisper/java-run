import { CommandError, runCommand, type CommandResult } from '../process/exec';
import type { CommandSpec } from '../core/types';
import { activity } from '../terminal/activity';
import type { TerminalPolicy } from '../terminal/policy';
import type { Logger } from '../logging/logger';
import { createTerminalLayout, type TerminalLayout } from '../terminal/layout';

/** 将准备过程的命令输出接入终端活动，并记录已展示的失败日志 */
export function createPreparationPresentation(
  policy: TerminalPolicy,
  logger?: Logger,
  layout: TerminalLayout = createTerminalLayout(policy, { columns: () => process.stderr.columns }),
) {
  const displayed = new WeakSet<CommandError>();
  const reported = new WeakSet<CommandError>();
  return {
    /** 在模型读取和校验完成后结束活动，命令的非零结果仍由适配器解释 */
    async run<T>(label: string, work: (execute: typeof runCommand) => Promise<T>): Promise<T> {
      await logger?.flush();
      let previous: { spec: CommandSpec; result: CommandResult } | undefined;
      return activity(label, async feedback => {
        try {
          return await work(async (spec, options) => {
            feedback.stage(spec.stage);
            let outputFailed = false;
            try {
              const result = await runCommand(spec, { ...options, capture: true, onOutput: async chunk => {
                try { await feedback.output(chunk); } catch (error) { outputFailed = true; throw error; }
              } });
              previous = { spec, result };
              return result;
            } catch (error) {
              if (error instanceof CommandError && policy.logMode === 'full' && !outputFailed) displayed.add(error);
              throw error;
            }
          });
        } catch (error) {
          if (error instanceof CommandError && policy.logMode === 'full' && previous
            && error.command === previous.spec.command && error.cwd === previous.spec.cwd
            && error.stdout === previous.result.stdout && error.stderr === previous.result.stderr) displayed.add(error);
          throw error;
        }
      }, policy, process.stderr, { context: logger?.context, layout }).catch(error => {
        if (error instanceof CommandError) reported.add(error);
        throw error;
      });
    },
    /** 完整日志已写入终端时，失败处理只需追加错误上下文 */
    hasDisplayed(error: CommandError): boolean { return displayed.has(error); },
    /** 活动已经给出结果提示，取消处理可据此避免重复展示 */
    hasReported(error: CommandError): boolean { return reported.has(error); },
  };
}
