import { dirname, isAbsolute, join, relative } from 'node:path';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { createManifest } from './classpath';
import { discoverMainClass, findMainClasses } from './main-class';
import { chooseCandidate } from '../cli/selection';
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

/** 检查适配器输出并生成独立 Java 进程的启动命令 */
export async function createLaunchCommand(config: RunConfig, project: PreparedProject, workspace: string): Promise<CommandSpec> {
  for (const path of project.classpath) {
    if (!existsSync(path)) throw new Error(`运行类路径缺少产物：${path}，请使用默认自动构建模式准备项目`);
  }
  const classes = project.classesDirectories.filter(path => existsSync(path) && statSync(path).isDirectory());
  if (!classes.length) throw new Error('目标项目没有已编译的类目录，请使用默认自动构建模式');
  let main = config.mainClass || project.mainClass;
  if (!main) {
    const candidates = findMainClasses(classes);
    main = candidates.length > 1 && process.stdin.isTTY && process.stderr.isTTY
      ? await chooseCandidate(candidates.map(value => ({ value, label: value })), '选择启动主类')
      : discoverMainClass(classes);
  }
  if (!isJavaClassName(main)) throw new Error(`无效的 Java 主类：${main}`);
  const java = config.javaCommand || project.javaCommand || (process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java');
  const manifest = join(workspace, 'MANIFEST.MF');
  const classpathJar = join(workspace, 'classpath.jar');
  const args = ['-Dfile.encoding=UTF-8', ...project.jvmArgs, ...config.jvmArgs, '-classpath', relative(project.directory, classpathJar), main, ...config.applicationArgs];
  await assertJavaArguments(java, args, project.directory);
  writeFileSync(manifest, createManifest(project.classpath));
  const spec = { command: resolveJar(java), args: ['cfm', 'classpath.jar', 'MANIFEST.MF'], cwd: workspace, stage: '生成运行类路径' };
  const result = await runCommand(spec, { capture: true });
  if (result.exitCode !== 0) throw new CommandError(spec, result);
  return { command: java, args, cwd: project.directory, stage: '运行 Java 应用' };
}
