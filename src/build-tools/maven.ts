import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseStringPromise } from 'xml2js';
import { CommandError, runCommand } from '../process/exec';
import { assertJavaArguments } from '../process/java-arguments';
import { buildClasspath } from '../core/classpath';
import type { BuildPlan, CommandSpec, MavenProject, PreparedProject, RunConfig } from '../core/types';

const HELP_PLUGIN = 'org.apache.maven.plugins:maven-help-plugin:3.5.1';
const DEPENDENCY_PLUGIN = 'org.apache.maven.plugins:maven-dependency-plugin:3.8.1';

/** 优先采用项目 Wrapper，存在时不回退到其他 Maven 版本 */
function resolveMaven(config: RunConfig): string {
  if (config.buildCommand) return config.buildCommand;
  const wrapper = join(config.cwd, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
  return existsSync(wrapper) ? wrapper : process.platform === 'win32' ? 'mvn.cmd' : 'mvn';
}

function validateBuildArgs(args: string[]): void {
  const flags = new Set(['-o', '--offline', '-U', '--update-snapshots', '-nsu', '--no-snapshot-updates',
    '-e', '--errors', '-X', '--debug', '-q', '--quiet', '-C', '--strict-checksums', '-c', '--lax-checksums']);
  const valueOptions = new Set(['-s', '--settings', '-gs', '--global-settings', '-t', '--toolchains', '-T', '--threads', '-P', '--activate-profiles']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (flags.has(arg)) continue;
    if (arg.startsWith('-D') && arg.length > 2) {
      const name = arg.slice(2).split('=', 1)[0]!;
      if (!['output', 'outputEncoding', 'expression', 'includeScope', 'excludeScope', 'skipTests', 'maven.test.skip', 'maven.main.skip', 'maven.install.skip'].includes(name)
        && !name.startsWith('mdep.') && !name.startsWith('exec.')) continue;
      throw new Error(`构建属性 ${name} 由 java-run 管理，请使用对应的启动配置`);
    }
    const equal = arg.indexOf('=');
    if (equal > 0 && valueOptions.has(arg.slice(0, equal)) && arg.slice(equal + 1)) continue;
    if (/^-(?:P|T).+/.test(arg)) continue;
    if (valueOptions.has(arg) && args[index + 1] && !args[index + 1]!.startsWith('-')) {
      index++;
      continue;
    }
    throw new Error(`不支持的 Maven --build-arg：${arg}；只接受属性、profile、settings、toolchains 和构建选项，不能改变项目或目标列表`);
  }
}

function command(config: RunConfig, goals: string[], stage: string, alsoMake = false): CommandSpec {
  validateBuildArgs(config.buildArgs);
  const args = ['-B', '-ntp', ...config.buildArgs, '-f', 'pom.xml'];
  if (config.module) args.push('-pl', config.module);
  if (alsoMake && config.module) args.push('-am');
  args.push(...goals);
  return { command: resolveMaven(config), args, cwd: config.cwd, stage };
}

/** 预览 Maven 的单目标准备与解析命令，不执行 Maven */
export function planMaven(config: RunConfig, workspace: string): BuildPlan {
  const commands: CommandSpec[] = [];
  if (config.build === 'auto') {
    const goal = config.module ? 'install' : config.includeTests ? 'test-compile' : 'compile';
    commands.push(command(config, [goal, '-DskipTests'], config.module ? '安装目标模块及上游依赖到本地仓库' : '编译目标项目', true));
  }
  commands.push(command(config, [`${HELP_PLUGIN}:evaluate`, '-Dexpression=project.file', `-Doutput=${join(workspace, 'project-file.txt')}`, '-q'], '解析目标 POM'));
  commands.push(command(config, [`${HELP_PLUGIN}:effective-pom`, `-Doutput=${join(workspace, 'effective-pom.xml')}`, '-q'], '读取 Maven 有效模型'));
  commands.push(command(config, [`${DEPENDENCY_PLUGIN}:build-classpath`, `-DincludeScope=${config.includeTests ? 'test' : 'runtime'}`,
    `-Dmdep.outputFile=${join(workspace, 'dependencies.txt')}`, '-DoutputEncoding=UTF-8', '-Dmdep.regenerateFile=true', '-q'], '解析目标运行依赖'));
  return {
    tool: 'maven', commands,
    notes: [config.module && config.build === 'auto' ? '自动准备使用 Maven install，仅写本地仓库，不执行 deploy' : '构建与依赖模型由 Maven 处理',
      '仅解析选定项目，不合并其他模块的类路径；不复用 java-run 的历史依赖缓存'],
  };
}

async function validateRoot(config: RunConfig): Promise<void> {
  const file = join(config.cwd, 'pom.xml');
  if (!existsSync(file)) throw new Error(`找不到 Maven POM：${file}`);
  const document = await parseStringPromise(readFileSync(file, 'utf8'), { explicitArray: false });
  if (!document.project) throw new Error(`无效的 Maven POM：${file}`);
  if (!config.module && (document.project.packaging === 'pom' || document.project.modules)) {
    throw new Error('聚合项目需要选择一个启动模块：请使用 --module=app 或在 .java-run.json 中配置 module');
  }
}

/** 从 Maven 输出提取单个有效项目，不自行展开属性或继承 */
export async function readEffectiveProject(xml: string, pomFile: string): Promise<MavenProject> {
  const document = await parseStringPromise(xml, { explicitArray: false });
  const projects = document.projects?.project;
  if (Array.isArray(projects) && projects.length !== 1) throw new Error('启动请求必须只选择一个 Maven 项目');
  const project = document.project ?? (Array.isArray(projects) ? projects[0] : projects);
  if (!project) throw new Error('Maven 未输出有效项目模型');
  const directory = dirname(pomFile);
  const scalar = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !value || value.includes('${')) throw new Error(`Maven 有效模型中的 ${name} 无效或未展开`);
    return value;
  };
  const outputPath = (value: unknown, name: string): string => {
    const text = scalar(value, name);
    return resolve(directory, text);
  };
  const plugins = project.build?.plugins?.plugin;
  const pluginList = !plugins ? [] : Array.isArray(plugins) ? plugins : [plugins];
  const configuredMain = project.properties?.['exec.mainClass'] ?? pluginList.find((plugin: { artifactId?: string }) =>
    plugin.artifactId === 'exec-maven-plugin')?.configuration?.mainClass;
  return {
    pomFile, directory,
    groupId: scalar(project.groupId, 'groupId'),
    artifactId: scalar(project.artifactId, 'artifactId'),
    version: scalar(project.version, 'version'),
    packaging: project.packaging || 'jar',
    outputDirectory: outputPath(project.build?.outputDirectory, 'build.outputDirectory'),
    testOutputDirectory: outputPath(project.build?.testOutputDirectory, 'build.testOutputDirectory'),
    mainClass: typeof configuredMain === 'string' && !configuredMain.includes('${') ? configuredMain : undefined,
  };
}

/** 构建选定项目并获取 Maven 裁决后的运行类路径 */
export async function prepareMaven(config: RunConfig, workspace: string): Promise<PreparedProject> {
  await validateRoot(config);
  const plan = planMaven(config, workspace);
  for (const spec of plan.commands) {
    console.error(`java-run：${spec.stage}`);
    await assertJavaArguments(buildJava(), spec.args, config.cwd);
    const result = await runCommand(spec, { capture: true });
    if (result.exitCode !== 0) throw new CommandError(spec, result);
  }
  const pomFile = readFileSync(join(workspace, 'project-file.txt'), 'utf8').trim();
  if (!isAbsolute(pomFile) || !existsSync(pomFile)) throw new Error('Maven 未返回有效的目标 POM 路径');
  const project = await readEffectiveProject(readFileSync(join(workspace, 'effective-pom.xml'), 'utf8'), pomFile);
  if (project.packaging !== 'jar') throw new Error(`当前仅支持基于 classpath 的 jar 项目，目标 packaging=${project.packaging}`);
  const classpath = buildClasspath(project, readFileSync(join(workspace, 'dependencies.txt'), 'utf8'), config.includeTests);
  return {
    directory: project.directory,
    classesDirectories: config.includeTests ? [project.outputDirectory, project.testOutputDirectory] : [project.outputDirectory],
    classpath,
    mainClass: project.mainClass,
    jvmArgs: [],
  };
}

/** 判断 Maven 根是否需要选择启动项目，只读取本地 POM */
export async function needsMavenModule(config: RunConfig): Promise<boolean> {
  if (config.module) return false;
  const document = await parseStringPromise(readFileSync(join(config.cwd, 'pom.xml'), 'utf8'), { explicitArray: false });
  return document.project?.packaging === 'pom' || Boolean(document.project?.modules);
}

/** 列出有效 reactor 中的 jar 项目，候选不等同于已有可运行主类 */
export async function discoverMavenProjects(config: RunConfig, workspace: string): Promise<{ value: string; label: string }[]> {
  const output = join(workspace, 'module-list.xml');
  const spec = command({ ...config, module: undefined }, [`${HELP_PLUGIN}:effective-pom`, `-Doutput=${output}`, '-q'], '读取 Maven 模块候选');
  console.error(`java-run：${spec.stage}`);
  await assertJavaArguments(buildJava(), spec.args, config.cwd);
  const result = await runCommand(spec, { capture: true });
  if (result.exitCode !== 0) throw new CommandError(spec, result);
  const document = await parseStringPromise(readFileSync(output, 'utf8'), { explicitArray: false });
  const value = document.projects?.project ?? document.project;
  const projects = Array.isArray(value) ? value : value ? [value] : [];
  return projects.filter(project => (project.packaging || 'jar') === 'jar').map(project => {
    const selector = `${project.groupId}:${project.artifactId}`;
    const main = project.properties?.['exec.mainClass'];
    return { value: selector, label: `${selector}（${main || '主类待解析，可能是库模块'}）` };
  });
}

function buildJava(): string {
  return process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
}
