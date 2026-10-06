import { dirname, isAbsolute, join, relative } from 'node:path';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { createManifest } from './classpath';
import { discoverMainClass, type MainClassSelector } from './main-class';
import { isJavaClassName } from './java-class';
import { CommandError, runCommand } from '../process/exec';
import { assertJavaArguments } from '../process/java-arguments';
import type { CommandSpec, PreparedProject, RunConfig } from './types';

function resolveJar(java: string): string {
  const name = process.platform === 'win32' ? 'jar.exe' : 'jar';
  if (isAbsolute(java)) return join(dirname(java), name);
  const candidate = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', name) : undefined;
  return candidate && existsSync(candidate) ? candidate : name;
}

/**
 * 检查准备产物并确定启动主类
 *
 * @description 显式主类优先于项目声明；两者都缺失且有多个入口时才调用 selectMainClass，显式或声明的主类只检查名称格式
 */
export async function resolveMainClass(config: RunConfig, project: PreparedProject, selectMainClass?: MainClassSelector): Promise<string> {
  for (const path of project.classpath) {
    if (!existsSync(path)) throw new Error(`运行类路径缺少产物：${path}，请使用默认自动构建模式准备项目`);
  }
  const classes = project.classesDirectories.filter(path => existsSync(path) && statSync(path).isDirectory());
  if (!classes.length) throw new Error('目标项目没有已编译的类目录，请使用默认自动构建模式');
  let main = config.mainClass || project.mainClass;
  if (!main) main = await discoverMainClass(classes, selectMainClass);
  if (!isJavaClassName(main)) throw new Error(`无效的 Java 主类：${main}`);
  return main;
}

/**
 * 生成独立 Java 进程的启动命令并返回实际主类
 *
 * @description
 * - 缺少产物、无法确定主类或生成类路径失败时抛出错误
 * - execute 只执行生成类路径的捕获命令；返回的 Java 启动命令由调用方执行
 */
export async function createLaunchCommand(config: RunConfig, project: PreparedProject, workspace: string, selectMainClass?: MainClassSelector, execute: typeof runCommand = runCommand): Promise<CommandSpec & { mainClass: string }> {
  const main = await resolveMainClass(config, project, selectMainClass);
  const java = config.javaCommand || project.javaCommand || (process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java');
  const manifest = join(workspace, 'MANIFEST.MF');
  const classpathJar = join(workspace, 'classpath.jar');
  const args = ['-Dfile.encoding=UTF-8', ...project.jvmArgs, ...config.jvmArgs, '-classpath', relative(project.directory, classpathJar), main, ...config.applicationArgs];
  await assertJavaArguments(java, args, project.directory);
  writeFileSync(manifest, createManifest(project.classpath));
  const spec = { command: resolveJar(java), args: ['cfm', 'classpath.jar', 'MANIFEST.MF'], cwd: workspace, stage: '生成运行类路径' };
  const result = await execute(spec, { capture: true });
  if (result.exitCode !== 0) throw new CommandError(spec, result);
  return { command: java, args, cwd: project.directory, stage: '运行 Java 应用', mainClass: main };
}
