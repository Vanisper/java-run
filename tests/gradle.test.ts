import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandError } from '../src/process/exec';
import { discoverGradleProjects, planGradle, prepareGradle } from '../src/build-tools/gradle';
import type { RunConfig } from '../src/core/types';

const temporaryDirectories: string[] = [];
const availableGradle = process.env.JAVA_RUN_TEST_GRADLE ?? Bun.which('gradle');

function directory(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'java-run Gradle # 中文 % ')));
  temporaryDirectories.push(value);
  return value;
}

function config(cwd: string, options: Partial<RunConfig> = {}): RunConfig {
  return {
    action: 'run', cwd, buildTool: 'gradle', jvmArgs: [], applicationArgs: [],
    buildArgs: [], build: 'auto', includeTests: false, ...options,
  };
}

function file(root: string, name: string, contents: string | Buffer): void {
  const location = join(root, name);
  mkdirSync(join(location, '..'), { recursive: true });
  writeFileSync(location, contents);
}

function reactor(): string {
  const root = directory();
  file(root, 'settings.gradle', "rootProject.name = 'runner-fixture'\ninclude 'app', 'lib', 'other'\n");
  file(root, 'app/build.gradle', `
plugins { id 'application' }
dependencies {
    implementation project(':lib')
    runtimeOnly files('runtime-marker.jar')
    testRuntimeOnly files('test-marker.jar')
}
application {
    mainClass = 'example.Main'
    applicationDefaultJvmArgs = ['-Dmessage=hello world', '-Xmx128m']
}
tasks.named('test') { doFirst { throw new GradleException('不应执行测试') } }
`);
  file(root, 'lib/build.gradle', "plugins { id 'java-library' }\n");
  file(root, 'other/build.gradle', "plugins { id 'java' }\ntasks.named('compileJava') { doFirst { throw new GradleException('不应编译无关项目') } }\n");
  file(root, 'app/src/main/java/example/Main.java', 'package example; public class Main { public static void main(String[] args) { System.out.println(Lib.value()); } }');
  file(root, 'lib/src/main/java/example/Lib.java', 'package example; public class Lib { public static String value() { return "fixture"; } }');
  file(root, 'app/src/test/java/example/TestMain.java', 'package example; public class TestMain { public static void main(String[] args) { System.out.println("test"); } }');
  file(root, 'other/src/main/java/example/Other.java', 'package example; public class Other {}');
  const emptyJar = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
  file(root, 'app/runtime-marker.jar', emptyJar);
  file(root, 'app/test-marker.jar', emptyJar);
  return root;
}

afterEach(() => {
  for (const value of temporaryDirectories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('Gradle 计划契约', () => {
  test('预览不创建 workspace 或修改项目，支持 Kotlin settings 和模块路径转换', () => {
    const root = directory();
    file(root, 'settings.gradle.kts', 'rootProject.name = "kotlin-settings"');
    const workspace = join(root, 'metadata');
    const plan = planGradle(config(root, { module: 'apps/admin-server', buildArgs: ['-Pfeature=a b', '--offline'] }), workspace);
    expect(plan.commands[0]?.args).toContain(`-DjavaRun.root=${root}`);
    expect(plan.commands[0]?.args).toContain('-DjavaRun.target=:apps:admin-server');
    expect(plan.commands[0]?.args).toContain('-Pfeature=a b');
    expect(plan.commands[0]?.args.at(-1)).toMatch(/^:apps:admin-server:javaRunMetadata_/);
    expect(existsSync(workspace)).toBe(false);
    expect(readFileSync(join(root, 'settings.gradle.kts'), 'utf8')).toBe('rootProject.name = "kotlin-settings"');
  });

  test('项目 Wrapper 优先，显式命令覆盖 Wrapper', () => {
    const root = directory();
    file(root, 'build.gradle', "plugins { id 'java' }");
    const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
    file(root, wrapper, '');
    expect(planGradle(config(root), join(root, 'metadata')).commands[0]?.command).toBe(join(root, wrapper));
    expect(planGradle(config(root, { buildCommand: 'custom-gradle' }), join(root, 'metadata')).commands[0]?.command).toBe('custom-gradle');
  });

  test.each([':app,:lib', ':app::sub', '../app'])('拒绝多个或无效目标 %s', module => {
    const root = directory();
    file(root, 'build.gradle', '');
    expect(() => planGradle(config(root, { module }), join(root, 'metadata'))).toThrow('--module');
  });

  test.each(['test', '--project-dir=elsewhere', '-Iother.gradle', '-xcompileJava', '--configuration-cache', '-DjavaRun.output=elsewhere', '-DjavaRun.root=elsewhere'])('拒绝改变准备结构的参数 %s', argument => {
    const root = directory();
    file(root, 'settings.gradle', '');
    expect(() => planGradle(config(root, { buildArgs: [argument] }), join(root, 'metadata'))).toThrow('--build-arg');
  });

  test('Wrapper 启动失败保留错误，不回退系统 Gradle', async () => {
    const root = directory();
    file(root, 'build.gradle', '');
    file(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew', 'not executable');
    await expect(prepareGradle(config(root), join(root, 'metadata'))).rejects.toBeInstanceOf(CommandError);
  });
});

describe.skipIf(!availableGradle)('真实 Gradle 项目', () => {
  test('buildSrc 约定插件与 included build 只参与必要任务，不接收主构建目标', async () => {
    const root = reactor();
    file(root, 'buildSrc/build.gradle', `
plugins { id 'java-gradle-plugin' }
gradlePlugin {
    plugins {
        runnerConventions {
            id = 'runner.java-conventions'
            implementationClass = 'RunnerConventions'
        }
    }
}
`);
    file(root, 'buildSrc/src/main/java/RunnerConventions.java', `
import org.gradle.api.Plugin;
import org.gradle.api.Project;
public class RunnerConventions implements Plugin<Project> {
    public void apply(Project project) { project.getPluginManager().apply("java"); }
}
`);
    file(root, 'settings.gradle', "rootProject.name = 'runner-fixture'\ninclude 'app', 'lib', 'other'\nincludeBuild 'included-lib'\n");
    file(root, 'included-lib/settings.gradle', "rootProject.name = 'included-lib'");
    file(root, 'included-lib/build.gradle', "plugins { id 'java-library' }\ngroup = 'fixture'\nversion = '1.0'\n");
    file(root, 'included-lib/src/main/java/example/Lib.java', 'package example; public class Lib { public static String value() { return "included"; } }');
    const appBuild = join(root, 'app/build.gradle');
    writeFileSync(appBuild, readFileSync(appBuild, 'utf8')
      .replace("plugins { id 'application' }", "plugins { id 'application'; id 'runner.java-conventions' }")
      .replace("implementation project(':lib')", "implementation 'fixture:included-lib:1.0'"));
    const prepared = await prepareGradle(config(root, { module: ':app', buildCommand: availableGradle! }), join(root, 'metadata'));
    expect(prepared.directory).toBe(join(root, 'app'));
    expect(prepared.classpath.some(value => value.endsWith('included-lib-1.0.jar'))).toBe(true);
    expect(prepared.classpath.every(value => existsSync(value))).toBe(true);
    expect(existsSync(join(root, 'other/build'))).toBe(false);
    const candidates = await discoverGradleProjects(config(root, { buildCommand: availableGradle! }), join(root, 'metadata-discovery'));
    expect(candidates.map(candidate => candidate.value)).toEqual([':app', ':lib', ':other']);
  }, 120000);

  test('发现 app 与 library 候选时不编译且不读取主类 Provider', async () => {
    const root = reactor();
    const buildFile = join(root, 'app/build.gradle');
    writeFileSync(buildFile, readFileSync(buildFile, 'utf8').replace("mainClass = 'example.Main'",
      "mainClass = providers.provider { throw new GradleException('不应读取主类 Provider') }"));
    const candidates = await discoverGradleProjects(config(root, { buildCommand: availableGradle! }), join(root, 'metadata-discovery'));
    expect(candidates).toEqual([
      { value: ':app', label: ':app（入口待解析）' },
      { value: ':lib', label: ':lib（入口待解析）' },
      { value: ':other', label: ':other（入口待解析）' },
    ]);
    for (const project of ['app', 'lib', 'other']) expect(existsSync(join(root, project, 'build'))).toBe(false);
  }, 60000);

  test('普通 Java 项目保留主类自动发现职责且忽略空测试输出', async () => {
    const root = directory();
    file(root, 'settings.gradle', "rootProject.name = 'plain-java'");
    file(root, 'build.gradle', "plugins { id 'java' }");
    file(root, 'src/main/java/example/Main.java', 'package example; public class Main { public static void main(String[] args) {} }');
    const prepared = await prepareGradle(config(root, { includeTests: true, buildCommand: availableGradle! }), join(root, 'metadata'));
    expect(prepared.mainClass).toBeUndefined();
    expect(prepared.jvmArgs).toEqual([]);
    expect(prepared.classesDirectories.some(value => value.endsWith(join('java', 'main')))).toBe(true);
    expect(prepared.classesDirectories.some(value => value.endsWith(join('java', 'test')))).toBe(false);
    expect(prepared.classpath.every(value => existsSync(value))).toBe(true);
  }, 60000);

  test('准备目标和上游 Jar，默认类路径隔离测试及无关项目', async () => {
    const root = reactor();
    const prepared = await prepareGradle(config(root, { module: ':app', buildCommand: availableGradle! }), join(root, 'metadata'));
    expect(prepared.mainClass).toBe('example.Main');
    expect(prepared.jvmArgs).toEqual(['-Dmessage=hello world', '-Xmx128m']);
    expect(prepared.directory).toBe(join(root, 'app'));
    expect(prepared.javaCommand && existsSync(prepared.javaCommand)).toBe(true);
    expect(prepared.classpath.some(value => value.endsWith('lib.jar'))).toBe(true);
    expect(prepared.classpath.some(value => value.endsWith('runtime-marker.jar'))).toBe(true);
    expect(prepared.classpath.some(value => value.endsWith('test-marker.jar') || value.endsWith(join('java', 'test')))).toBe(false);
    expect(prepared.classpath.every(value => existsSync(value))).toBe(true);
    expect(existsSync(join(root, 'other', 'build'))).toBe(false);
    expect(existsSync(join(root, 'app', 'build/classes/java/test'))).toBe(false);
  }, 60000);

  test('include-tests 准备测试输出及依赖，后续 none 不触发编译', async () => {
    const root = reactor();
    const options = { module: 'app', includeTests: true, buildCommand: availableGradle! };
    const prepared = await prepareGradle(config(root, options), join(root, 'metadata-first'));
    expect(prepared.classesDirectories.some(value => value.endsWith(join('java', 'test')))).toBe(true);
    expect(prepared.classesDirectories.some(value => value.endsWith(join('java', 'main')))).toBe(true);
    expect(prepared.classpath.some(value => value.endsWith('test-marker.jar'))).toBe(true);
    file(root, 'app/src/main/java/example/Main.java', 'invalid Java source that must not be compiled');
    const existing = await prepareGradle(config(root, { ...options, build: 'none' }), join(root, 'metadata-existing'));
    expect(existing.classesDirectories).toEqual(prepared.classesDirectories);
    expect(existing.classpath).toEqual(prepared.classpath);
  }, 60000);

  test('聚合根没有 Java 插件时明确要求 module', async () => {
    const root = reactor();
    try {
      await prepareGradle(config(root, { buildCommand: availableGradle! }), join(root, 'metadata'));
      throw new Error('预期聚合根准备失败');
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      expect((error as CommandError).stderr + (error as CommandError).stdout).toContain('没有 Java 插件');
      expect((error as CommandError).stderr + (error as CommandError).stdout).toContain('--module');
    }
  }, 60000);

  test('none 在源码存在但产物缺失时失败且不编译源码', async () => {
    const root = reactor();
    try {
      await prepareGradle(config(root, { module: ':app', build: 'none', buildCommand: availableGradle! }), join(root, 'metadata'));
      throw new Error('预期缺少已编译产物时失败');
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      expect((error as CommandError).stderr + (error as CommandError).stdout).toContain('没有已编译类');
      expect(existsSync(join(root, 'app/build/classes/java/main'))).toBe(false);
      expect(existsSync(join(root, 'lib/build/libs/lib.jar'))).toBe(false);
    }
  }, 60000);
});
