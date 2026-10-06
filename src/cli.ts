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
import { CommandError, runCommand } from './process/exec';
import { resolveTerminalPolicy } from './terminal/policy';
import { createLogger } from './logging/logger';
import { createTerminalReporter, writeTerminalText } from './terminal/log-reporter';
import { createTerminalLayout } from './terminal/layout';
import { createPreparationPresentation } from './cli/preparation';
import { version } from '../package.json';

/** 执行一个 CLI 请求，保留 Java 或构建工具的失败退出码 */
export async function main(argv: string[]): Promise<number> {
  let workspace: string | undefined;
  let presentation: ReturnType<typeof createPreparationPresentation> | undefined;
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
    presentation = createPreparationPresentation(policy, logger, layout);
    workspace = mkdtempSync(join(tmpdir(), 'java-run-'));
    const workspacePath = workspace;
    if (!config.module && (config.action === 'init' || policy.input !== 'none')) {
      const discoverModules = tool === 'gradle' || await needsMavenModule(config);
      if (discoverModules) {
        const candidates = await presentation.run('读取模块候选', execute => tool === 'gradle'
          ? discoverGradleProjects(config, workspacePath, execute) : discoverMavenProjects(config, workspacePath, execute));
        config.module = candidates.length === 1 ? candidates[0]!.value
          : await chooseCandidate(candidates, '选择启动项目（库模块可能没有 main）', policy, { completedQuestion: '启动项目' });
      }
    }
    const project = await presentation.run('项目准备', execute => tool === 'maven'
      ? prepareMaven(config, workspacePath, execute) : prepareGradle(config, workspacePath, execute));
    const selectMainClass = policy.input !== 'none'
      ? (candidates: readonly string[]) => chooseCandidate(candidates.map(value => ({
        value, label: value.split('.').at(-1)!, shortLabel: value.split('.').at(-1)!, description: value,
      })), '选择启动主类', policy, { completedQuestion: '启动主类' })
      : undefined;
    const mainClass = await resolveMainClass(config, project, selectMainClass);
    if (configWriter) {
      configWriter.save(toProjectConfig(config, tool, mainClass));
      logger.success(`已保存 ${configWriter.path}\n在该工作区运行 java-run 即可启动 ${mainClass}`, { mainClass, configPath: configWriter.path });
      return 0;
    }
    const launch = await presentation.run('生成运行类路径', execute =>
      createLaunchCommand({ ...config, mainClass }, project, workspacePath, undefined, execute));
    await logger.flush();
    await writeTerminalText('\n' + layout.details('启动应用', launch.mainClass, logger.context));
    const result = await runCommand(launch);
    exitCode = result.exitCode;
    if (exitCode !== 0) {
      // 继承终端的应用可能未以换行结束，显示失败也不能覆盖其退出码
      try { await writeTerminalText(''); } catch {}
    }
    if (result.signal === 'SIGINT' || result.signal === 'SIGTERM') {
      logger.warn(`应用已中断（${result.signal}）`, { exitCode, signal: result.signal });
    } else if (exitCode !== 0) {
      logger.error(`应用退出，退出码 ${exitCode}`, { exitCode, signal: result.signal });
    }
    return exitCode;
  } catch (error) {
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
