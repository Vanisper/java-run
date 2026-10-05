import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from './cli/args';
import helpLog from './cli/help';
import { detectBuildTool } from './build-tools/detect';
import { discoverMavenProjects, needsMavenModule, planMaven, prepareMaven } from './build-tools/maven';
import { discoverGradleProjects, planGradle, prepareGradle } from './build-tools/gradle';
import { chooseCandidate, SelectionCancelledError } from './cli/selection';
import { createLaunchCommand } from './core/launch';
import { CommandError, runCommand } from './process/exec';
import { version } from '../package.json';

/** 执行一个 CLI 请求，保留 Java 或构建工具的失败退出码 */
export async function main(argv: string[]): Promise<number> {
  let workspace: string | undefined;
  try {
    const config = parseArgs(argv);
    if (config.action === 'help') { helpLog(); return 0; }
    if (config.action === 'version') { console.log(`java-run ${version}`); return 0; }
    const tool = detectBuildTool(config);
    const previewWorkspace = join(tmpdir(), '<java-run-workspace>');
    const plan = tool === 'maven' ? planMaven(config, previewWorkspace) : planGradle(config, previewWorkspace);
    if (config.action === 'plan') {
      console.log(JSON.stringify({ ...plan, launch: { java: config.javaCommand || '由工具链解析', main: config.mainClass || '由项目声明或唯一 main 方法确定',
        jvmArgs: config.jvmArgs, applicationArgs: config.applicationArgs },
        notes: [...plan.notes, '这是静态预览，未验证有效项目模型、主类和依赖文件'] }, null, 2));
      return 0;
    }
    workspace = mkdtempSync(join(tmpdir(), 'java-run-'));
    if (!config.module && process.stdin.isTTY && process.stderr.isTTY) {
      const candidates = tool === 'gradle' ? await discoverGradleProjects(config, workspace)
        : await needsMavenModule(config) ? await discoverMavenProjects(config, workspace) : [];
      if (candidates.length) {
        config.module = candidates.length === 1 ? candidates[0]!.value
          : await chooseCandidate(candidates, '选择启动项目（库模块可能没有 main）');
        console.error(`java-run：已选择 --module=${config.module}，可将 module 保存到 .java-run.json`);
      }
    }
    const project = tool === 'maven' ? await prepareMaven(config, workspace) : await prepareGradle(config, workspace);
    const selectMainClass = process.stdin.isTTY && process.stderr.isTTY
      ? (candidates: readonly string[]) => chooseCandidate(candidates.map(value => ({ value, label: value })), '选择启动主类')
      : undefined;
    const launch = await createLaunchCommand(config, project, workspace, selectMainClass);
    console.error(`java-run：运行 ${launch.args[launch.args.indexOf('-classpath') + 2]}（${tool}）`);
    return (await runCommand(launch)).exitCode;
  } catch (error) {
    if (error instanceof SelectionCancelledError) { console.error('java-run：已取消选择'); return error.exitCode; }
    if (error instanceof CommandError) {
      console.error(`java-run：${error.message}\n工作目录：${error.cwd}`);
      if (error.stdout.trim()) console.error(error.stdout.trim());
      if (error.stderr.trim()) console.error(error.stderr.trim());
      if (error.cause instanceof Error) console.error(error.cause.message);
      return error.exitCode || 1;
    }
    console.error(`java-run：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
