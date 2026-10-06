import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from './cli/args';
import helpLog from './cli/help';
import { detectBuildTool } from './build-tools/detect';
import { discoverMavenProjects, needsMavenModule, planMaven, prepareMaven } from './build-tools/maven';
import { discoverGradleProjects, planGradle, prepareGradle } from './build-tools/gradle';
import { chooseCandidate, SelectionCancelledError } from './cli/selection';
import { toProjectConfig } from './cli/config';
import { createProjectConfigWriter } from './cli/init';
import { createLaunchCommand, resolveMainClass } from './core/launch';
import { CommandError } from './process/exec';
import { resolveTerminalPolicy } from './terminal/policy';
import { createLogger } from './logging/logger';
import { createTerminalReporter, writeTerminalText } from './terminal/log-reporter';
import { createTerminalLayout } from './terminal/layout';
import { createCliPresentation } from './cli/presentation';
import { version } from '../package.json';

/** 执行一个 CLI 请求，保留 Java 或构建工具的失败退出码 */
export async function main(argv: string[]): Promise<number> {
  let workspace: string | undefined;
  let presentation: ReturnType<typeof createCliPresentation> | undefined;
  let logger = createLogger({ context: 'java-run', reporter: createTerminalReporter({ color: false }) });
  let exitCode = 0;
  try {
    const config = parseArgs(argv);
    const policy = resolveTerminalPolicy(config.terminal);
    const layout = createTerminalLayout(policy);
    logger = createLogger({ context: 'java-run', reporter: createTerminalReporter(policy, process.stderr, layout) })
      .withContext(config.action, { cwd: config.cwd });
    if (config.action === 'help') { helpLog(); return 0; }
    if (config.action === 'version') { process.stdout.write(`java-run ${version}\n`); return 0; }
    const configWriter = config.action === 'init' ? createProjectConfigWriter(config.cwd, config.force) : undefined;
    const tool = detectBuildTool(config);
    logger = logger.withContext(tool);
    if (config.action === 'plan') {
      const previewWorkspace = join(tmpdir(), '<java-run-workspace>');
      const plan = tool === 'maven' ? planMaven(config, previewWorkspace) : planGradle(config, previewWorkspace);
      process.stdout.write(JSON.stringify({ ...plan, launch: { java: config.javaCommand || '由工具链解析', main: config.mainClass || '由项目声明或唯一 main 方法确定',
        jvmArgs: config.jvmArgs, applicationArgs: config.applicationArgs },
        notes: [...plan.notes, '这是静态预览，未验证有效项目模型、主类和依赖文件'] }, null, 2) + '\n');
      return 0;
    }
    presentation = createCliPresentation(policy, logger, layout);
    workspace = mkdtempSync(join(tmpdir(), 'java-run-'));
    const workspacePath = workspace;
    if (!config.module && (config.action === 'init' || policy.input !== 'none')) {
      const discoverModules = tool === 'gradle' || await needsMavenModule(config);
      if (discoverModules) {
        config.module = await presentation.run('选择启动项目', async (execute, feedback) => {
          const candidates = await (tool === 'gradle'
            ? discoverGradleProjects(config, workspacePath, execute) : discoverMavenProjects(config, workspacePath, execute));
          if (candidates.length === 1) {
            await feedback.detail('启动项目', candidates[0]!.value);
            return candidates[0]!.value;
          }
          return feedback.interact(linePrefix => chooseCandidate(candidates, '选择启动项目（库模块可能没有 main）', policy,
            { completedQuestion: '启动项目', linePrefix }));
        });
      }
    }
    const launch = await presentation.run('项目准备', async (execute, feedback) => {
      const project = await (tool === 'maven'
        ? prepareMaven(config, workspacePath, execute) : prepareGradle(config, workspacePath, execute));
      const selectMainClass = policy.input !== 'none'
        ? (candidates: readonly string[]) => feedback.interact(linePrefix => chooseCandidate(candidates.map(value => {
          const label = value.split('.').at(-1)!;
          return { value, label, shortLabel: label, description: value };
        }), '选择启动主类', policy, { completedQuestion: '启动主类', linePrefix }))
        : undefined;
      const mainClass = await resolveMainClass(config, project, selectMainClass);
      if (configWriter) {
        configWriter.save(toProjectConfig(config, tool, mainClass));
        await feedback.detail('已保存', configWriter.path);
        return;
      }
      return createLaunchCommand({ ...config, mainClass }, project, workspacePath, undefined, execute);
    });
    if (!launch) return 0;
    exitCode = await presentation.launch(launch);
    return exitCode;
  } catch (error) {
    if (presentation?.hasReported(error)) {
      exitCode = error instanceof CommandError || error instanceof SelectionCancelledError ? error.exitCode || 1 : 1;
      return exitCode;
    }
    if (error instanceof SelectionCancelledError) {
      logger.warn('已取消选择');
      exitCode = error.exitCode;
      return exitCode;
    }
    if (error instanceof CommandError) {
      exitCode = error.exitCode || 1;
      if (exitCode === 130 || exitCode === 143) {
        if (!presentation?.hasReported(error)) logger.warn('已取消');
        return exitCode;
      }
      logger.error(`${error.message}\n工作目录：${error.cwd}`, { cwd: error.cwd, command: error.command, exitCode: error.exitCode });
      if (!presentation?.hasDisplayed(error)) {
        try {
          await logger.flush();
          if (error.stdout.trim()) await writeTerminalText(error.stdout.trim());
          if (error.stderr.trim()) await writeTerminalText(error.stderr.trim());
        } catch { /* 诊断写入失败不覆盖原始命令结果 */ }
      }
      if (error.cause instanceof Error) logger.error(error.cause.message);
      return exitCode;
    }
    logger.error(error instanceof Error ? error.message : String(error));
    exitCode = 1;
    return exitCode;
  } finally {
    try {
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    } finally {
      // 诊断输出失败不能覆盖构建、应用或用户取消的退出码
      try { await logger.flush(); }
      catch { if (exitCode === 0) return 1; }
    }
  }
}

if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
