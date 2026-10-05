import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { CommandError, runCommand } from '../process/exec';
import { assertJavaArguments } from '../process/java-arguments';
import type { BuildPlan, CommandSpec, PreparedProject, RunConfig } from '../core/types';

const projectFiles = ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'];
const simpleBuildArguments = new Set([
  '--offline', '--refresh-dependencies', '--stacktrace', '--full-stacktrace',
  '--info', '--debug', '--quiet', '-q', '-i', '-d', '-s', '-S',
  '--build-cache', '--no-build-cache', '--parallel', '--no-parallel',
  '--no-watch-fs', '--watch-fs',
]);

function targetPath(module: string | undefined): string {
  if (!module || module === ':') return ':';
  const value = module.replace(/^\.\//, '').replace(/\\/g, '/').replace(/^:/, '');
  const segments = value.split(/[/:]/);
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[,\r\n\0]/.test(segment))) {
    throw new Error('--module 必须是单个 Gradle 项目路径，例如 :apps:admin-server 或 app/sub');
  }
  return `:${segments.join(':')}`;
}

function validateBuildArguments(args: string[]): void {
  for (const argument of args) {
    const property = /^(?:-D|-P|--system-prop=|--project-prop=)(.+)$/.exec(argument)?.[1];
    if (property && !property.startsWith('javaRun.')) continue;
    if (simpleBuildArguments.has(argument)) continue;
    if (/^--(?:warning-mode=(?:all|fail|summary|none)|max-workers=\d+|priority=(?:normal|low))$/.test(argument)) continue;
    throw new Error(`不支持的 Gradle --build-arg：${argument}；只接受构建属性和日志、依赖选项，不能改变项目、init script 或任务列表`);
  }
}

function gradleCommand(config: RunConfig): string {
  if (config.buildCommand) return config.buildCommand;
  const wrapper = join(config.cwd, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  return existsSync(wrapper) ? wrapper : 'gradle';
}

function metadataPaths(workspace: string) {
  const directory = resolve(workspace);
  return {
    script: join(directory, 'gradle-init.gradle'),
    output: join(directory, 'gradle-project.json'),
    task: `javaRunMetadata_${createHash('sha256').update(directory).digest('hex').slice(0, 16)}`,
  };
}

function commandSpecification(config: RunConfig, workspace: string, discovery = false): CommandSpec {
  if (!projectFiles.some(file => existsSync(join(config.cwd, file)))) {
    throw new Error(`找不到 Gradle settings 或 build 文件：${config.cwd}`);
  }
  validateBuildArguments(config.buildArgs);
  if (!discovery) targetPath(config.module);
  const paths = metadataPaths(workspace);
  const task = discovery ? `${paths.task}_discover` : paths.task;
  const build = discovery ? 'none' : config.build;
  const args = [
    '--no-daemon', '--console=plain', '--no-configuration-cache', '-I', relative(config.cwd, paths.script),
    ...config.buildArgs,
    `-DjavaRun.metadataTask=${task}`,
    `-DjavaRun.build=${build}`,
    `-DjavaRun.includeTests=${discovery ? false : config.includeTests}`,
    `-DjavaRun.discover=${discovery}`,
  ];
  if (build === 'none') args.push('-Porg.gradle.java.installations.auto-download=false');
  args.push(`:${task}`);
  return { command: gradleCommand(config), args, cwd: config.cwd, stage: discovery ? 'Gradle 项目选择' : 'Gradle 项目准备' };
}

/**
 * 预览单个 Gradle 项目的准备命令
 *
 * @description 只读取本地文件，workspace 是临时元数据目录；不执行 Gradle 或创建文件
 */
export function planGradle(config: RunConfig, workspace: string): BuildPlan {
  return {
    tool: 'gradle',
    commands: [commandSpecification(config, workspace)],
    notes: [
      `目标 Gradle 项目：${targetPath(config.module)}`,
      config.build === 'auto'
        ? 'Gradle 任务图准备目标项目和运行依赖，不执行测试'
        : '不构建源码，要求目标项目和运行依赖已有可用产物',
      '主类、运行类路径和 Java 工具链将在执行 Gradle 后解析',
    ],
  };
}

const initScript = String.raw`
import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import org.gradle.api.GradleException
import org.gradle.api.plugins.JavaApplication
import org.gradle.api.plugins.JavaPluginExtension
import org.gradle.api.tasks.SourceSetContainer
import org.gradle.jvm.toolchain.JavaToolchainService

def javaRunRequest = new JsonSlurper().parseText(new String('@JAVA_RUN_REQUEST@'.decodeBase64(), 'UTF-8'))

gradle.projectsEvaluated {
    // init script 也会进入辅助构建，元数据任务只注册到请求的主构建
    def requestedRoot = new File(javaRunRequest.root).canonicalFile
    if (gradle.rootProject.projectDir.canonicalFile != requestedRoot) {
        return
    }
    def taskName = System.getProperty('javaRun.metadataTask')
    if (Boolean.parseBoolean(System.getProperty('javaRun.discover'))) {
        gradle.rootProject.tasks.register(taskName) {
            doLast {
                def candidates = gradle.rootProject.allprojects.findAll {
                    it.extensions.findByType(JavaPluginExtension) != null
                }.sort { a, b -> a.path <=> b.path }.collect {
                    [value: it.path, label: it.path + '（入口待解析）']
                }
                def output = new File(javaRunRequest.output)
                output.parentFile.mkdirs()
                output.setText(JsonOutput.toJson(candidates), 'UTF-8')
            }
        }
        return
    }
    def requestedPath = javaRunRequest.target
    def target = gradle.rootProject.findProject(requestedPath)
    if (target == null) {
        throw new GradleException("[JAVA_RUN:NO_PROJECT] Project not found; select an existing project with --module")
    }
    def javaExtension = target.extensions.findByType(JavaPluginExtension)
    if (javaExtension == null) {
        throw new GradleException("[JAVA_RUN:NO_JAVA_PLUGIN] Selected project has no Java plugin; select a Java project with --module")
    }
    def sourceSets = target.extensions.getByType(SourceSetContainer)
    def includeTests = Boolean.parseBoolean(System.getProperty('javaRun.includeTests'))
    def selected = sourceSets.getByName(includeTests ? 'test' : 'main')
    def included = includeTests ? [sourceSets.getByName('test'), sourceSets.getByName('main')] : [selected]
    def metadataTask = target.tasks.register(taskName) {
        if (System.getProperty('javaRun.build') == 'auto') {
            dependsOn selected.classesTaskName
            dependsOn selected.runtimeClasspath.buildDependencies
        }
        doLast {
            def allOutputs = included.collectMany { it.output.files as List }.toSet()
            def classes = included.collectMany { it.output.classesDirs.files as List }
                .findAll { it.isDirectory() }.collect { it.absolutePath }.unique()
            if (classes.isEmpty()) {
                throw new GradleException("[JAVA_RUN:NO_CLASSES] No compiled classes; prepare outputs or use --build=auto")
            }
            def runtime = selected.runtimeClasspath.files.findAll { it.exists() || !allOutputs.contains(it) }
                .collect { it.absolutePath }.unique()
            def toolchains = target.extensions.getByType(JavaToolchainService)
            def launcher = toolchains.launcherFor(javaExtension.toolchain).get()
            def application = target.extensions.findByType(JavaApplication)
            if (application != null && application.mainModule.isPresent()) {
                throw new GradleException("[JAVA_RUN:UNSUPPORTED_JPMS] JPMS mainModule is unsupported; use the project's native run task")
            }
            def mainClass = application == null ? null : application.mainClass.orNull
            def jvmArgs = application == null ? [] : application.applicationDefaultJvmArgs.collect { it.toString() }
            def output = new File(javaRunRequest.output)
            output.parentFile.mkdirs()
            output.setText(JsonOutput.toJson([
                directory: target.projectDir.absolutePath,
                classesDirectories: classes,
                runtimeClasspath: runtime,
                javaCommand: launcher.executablePath.asFile.absolutePath,
                mainClass: mainClass,
                jvmArgs: jvmArgs
            ]), 'UTF-8')
        }
    }
    if (target != gradle.rootProject) {
        // 根任务固定为 ASCII，目标模块的名称只从 UTF-8 请求读取
        gradle.rootProject.tasks.register(taskName) {
            dependsOn metadataTask
        }
    }
}
`.trimStart();

function initializationScript(config: RunConfig, workspace: string, discovery = false): string {
  const request = {
    root: resolve(config.cwd),
    target: discovery ? ':' : targetPath(config.module),
    output: discovery ? join(resolve(workspace), 'gradle-projects.json') : metadataPaths(workspace).output,
  };
  const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  return initScript.replace('@JAVA_RUN_REQUEST@', encoded);
}

async function executeGradle(spec: CommandSpec, config: RunConfig): Promise<void> {
  const java = process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    : 'java';
  await assertJavaArguments(java, spec.args, spec.cwd);
  console.error(`java-run：${spec.stage}`);
  const result = await runCommand(spec, { capture: true });
  if (result.exitCode !== 0) {
    // JDK 17 的控制台编码可能丢失中文，受控失败只跨进程传递 ASCII 错误码
    const code = /\[JAVA_RUN:(NO_PROJECT|NO_JAVA_PLUGIN|NO_CLASSES|UNSUPPORTED_JPMS)\]/
      .exec(result.stderr + result.stdout)?.[1];
    const diagnostics: Record<string, string> = {
      NO_PROJECT: `找不到 Gradle 项目：${targetPath(config.module)}，请用 --module 指定实际项目路径`,
      NO_JAVA_PLUGIN: `选定项目 ${targetPath(config.module)} 没有 Java 插件，请用 --module 指定 Java 应用项目`,
      NO_CLASSES: '选定项目没有已编译类；请准备产物或使用 --build=auto',
      UNSUPPORTED_JPMS: '本版本不支持 JPMS mainModule；请使用项目的原生运行任务',
    };
    throw new CommandError(spec, result, code ? new Error(diagnostics[code]) : undefined);
  }
}

function readProject(output: string): PreparedProject {
  let metadata: unknown;
  try {
    metadata = JSON.parse(readFileSync(output, 'utf8'));
  } catch (error) {
    throw new Error('Gradle 未输出有效的项目元数据', { cause: error });
  }
  if (!metadata || typeof metadata !== 'object') throw new Error('Gradle 项目元数据必须是对象');
  const values = metadata as Record<string, unknown>;
  const file = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`Gradle 元数据 ${name} 必须是绝对路径`);
    return value;
  };
  const files = (value: unknown, name: string): string[] => {
    if (!Array.isArray(value)) throw new Error(`Gradle 元数据 ${name} 必须是路径数组`);
    return [...new Set(value.map(item => file(item, name)))];
  };
  if (values.mainClass != null && typeof values.mainClass !== 'string') throw new Error('Gradle 元数据 mainClass 无效');
  if (!Array.isArray(values.jvmArgs) || values.jvmArgs.some(argument => typeof argument !== 'string')) {
    throw new Error('Gradle 元数据 jvmArgs 必须是字符串数组');
  }
  return {
    directory: file(values.directory, 'directory'),
    classesDirectories: files(values.classesDirectories, 'classesDirectories'),
    classpath: files(values.runtimeClasspath, 'runtimeClasspath'),
    javaCommand: file(values.javaCommand, 'javaCommand'),
    mainClass: typeof values.mainClass === 'string' ? values.mainClass : undefined,
    jvmArgs: values.jvmArgs as string[],
  };
}

/**
 * 由 Gradle 任务图准备目标项目并读取已裁决的运行元数据
 *
 * @description 临时 init script 只写入 workspace，不修改项目构建脚本；构建失败保留退出码和完整输出
 */
export async function prepareGradle(config: RunConfig, workspace: string): Promise<PreparedProject> {
  const plan = planGradle(config, workspace);
  const paths = metadataPaths(workspace);
  mkdirSync(resolve(workspace), { recursive: true });
  writeFileSync(paths.script, initializationScript(config, workspace));
  rmSync(paths.output, { force: true });
  const spec = plan.commands[0]!;
  await executeGradle(spec, config);
  return readProject(paths.output);
}

/**
 * 列出可供交互选择的 Gradle Java 项目
 *
 * @description 只执行项目配置和列表任务，不编译、解析运行依赖或读取主类 Provider；候选仍需准备后确认入口
 */
export async function discoverGradleProjects(config: RunConfig, workspace: string): Promise<{ value: string; label: string }[]> {
  const spec = commandSpecification(config, workspace, true);
  const paths = metadataPaths(workspace);
  const output = join(resolve(workspace), 'gradle-projects.json');
  mkdirSync(resolve(workspace), { recursive: true });
  writeFileSync(paths.script, initializationScript(config, workspace, true));
  rmSync(output, { force: true });
  await executeGradle(spec, config);
  const candidates: unknown = JSON.parse(readFileSync(output, 'utf8'));
  if (!Array.isArray(candidates) || candidates.some(candidate =>
    !candidate || typeof candidate.value !== 'string' || !candidate.value.startsWith(':') || typeof candidate.label !== 'string')) {
    throw new Error('Gradle 未输出有效的 Java 项目候选列表');
  }
  return candidates as { value: string; label: string }[];
}
