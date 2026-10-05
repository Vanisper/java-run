import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { buildClasspath, createManifest } from '../src/core/classpath';
import { discoverMainClass, hasMainMethod } from '../src/core/main-class';
import { createLaunchCommand } from '../src/core/launch';
import { runCommand } from '../src/process/exec';
import { parseArgs } from '../src/cli/args';
import { detectBuildTool } from '../src/build-tools/detect';
import { planMaven, readEffectiveProject } from '../src/build-tools/maven';
import type { MavenProject } from '../src/core/types';

const directories: string[] = [];
function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'java-run launch 中文 # % '));
  directories.push(directory);
  return directory;
}
function compile(directory: string, name: string, source: string): string {
  const output = join(directory, 'classes');
  mkdirSync(output, { recursive: true });
  const file = join(directory, `${name}.java`);
  writeFileSync(file, source);
  const result = spawnSync('javac', ['-encoding', 'UTF-8', '-d', output, file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message);
  return output;
}
function project(directory: string): MavenProject {
  return { directory, pomFile: join(directory, 'pom.xml'), groupId: 'fixture', artifactId: 'app', version: '1', packaging: 'jar',
    outputDirectory: join(directory, 'classes'), testOutputDirectory: join(directory, 'test-classes') };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('目标类路径', () => {
  test('空依赖不添加工作目录，测试输出仅显式启用时加入', () => {
    const directory = temporary();
    const p = project(directory);
    mkdirSync(p.outputDirectory); mkdirSync(p.testOutputDirectory);
    expect(buildClasspath(p, '')).toEqual([p.outputDirectory]);
    expect(buildClasspath(p, '', true)).toEqual([p.testOutputDirectory, p.outputDirectory]);
    const dep = join(directory, 'dependency.jar'); writeFileSync(dep, '');
    expect(buildClasspath(p, [dep, dep].join(delimiter))).toEqual([p.outputDirectory, dep]);
    expect(() => buildClasspath(p, join(directory, 'missing.jar'))).toThrow('依赖文件不存在');
  });
  test('空测试源集不要求生成测试目录', () => {
    const directory = temporary(); const p = project(directory); mkdirSync(p.outputDirectory);
    expect(buildClasspath(p, '', true)).toEqual([p.outputDirectory]);
  });
  test('真实 JDK 可加载含空格、中文、#、% 的目录并保留应用参数', async () => {
    const directory = temporary();
    const classes = compile(directory, 'Hello', 'public class Hello { public static void main(String[] args) { System.out.print(String.join("|", args)); } }');
    const manifest = createManifest([classes]);
    expect(manifest).toContain('%23'); expect(manifest).toContain('%25'); expect(manifest).toContain('%20');
    for (const line of manifest.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(70);
    const config = parseArgs(['--cwd', directory, '--', '空格 值', 'a=b', 'quote\'"']);
    const launch = await createLaunchCommand(config, { directory, classesDirectories: [classes], classpath: [classes], jvmArgs: [] }, directory);
    const result = await runCommand(launch, { capture: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('空格 值|a=b|quote\'"');
  }, 20000);
  test('应用 JVM 默认使用 UTF-8，项目声明和 CLI 可按顺序覆盖', async () => {
    const directory = temporary();
    const classes = compile(directory, 'Charset', 'public class Charset { public static void main(String[] args) { System.out.print(System.getProperty("file.encoding")); } }');
    const config = parseArgs(['--cwd', directory, '--jvm-arg=-Dfile.encoding=US-ASCII']);
    const launch = await createLaunchCommand(config, { directory, classesDirectories: [classes], classpath: [classes], jvmArgs: ['-Dfile.encoding=ISO-8859-1'] }, directory);
    expect(launch.args.slice(0, 3)).toEqual(['-Dfile.encoding=UTF-8', '-Dfile.encoding=ISO-8859-1', '-Dfile.encoding=US-ASCII']);
    expect((await runCommand(launch, { capture: true })).stdout).toBe('US-ASCII');
  }, 20000);
});

describe('主类选择', () => {
  test('组合字符构成的合法 Unicode 标识符可以发现并启动', async () => {
    const directory = temporary();
    const name = 'Cafe\u0301';
    const classes = compile(directory, name, `public class ${name} { public static void main(String[] args) { System.out.print("UNICODE_MAIN_OK"); } }`);
    const config = parseArgs(['--cwd', directory, `--main=${name}`]);
    const launch = await createLaunchCommand(config, { directory, classesDirectories: [classes], classpath: [classes], jvmArgs: [] }, directory);
    expect(discoverMainClass([classes])).toBe(name);
    expect((await runCommand(launch, { capture: true })).stdout).toBe('UNICODE_MAIN_OK');
    expect(() => parseArgs(['--main=Invalid³'])).toThrow('Java 类全名');
  }, 20000);
  test('通过 class 方法表发现唯一入口，注释与非 public/static 方法不会被当成入口', () => {
    const directory = temporary();
    const classes = compile(directory, 'Entry', 'public class Entry { private static void main(int x) {} public static void main(String[] args) {} }');
    compile(directory, 'Other', 'public class Other { public void main(String[] args) {} }');
    expect(discoverMainClass([classes])).toBe('Entry');
    expect(hasMainMethod(readFileSync(join(classes, 'Other.class')))).toBe(false);
    expect(hasMainMethod(Buffer.from('invalid'))).toBe(false);
  }, 20000);
  test('多个主类要求明确选择并列出候选', () => {
    const directory = temporary();
    const classes = compile(directory, 'First', 'public class First { public static void main(String[] args) {} }');
    compile(directory, 'Second', 'public class Second { public static void main(String[] args) {} }');
    expect(() => discoverMainClass([classes])).toThrow('First\n  Second');
  }, 20000);
});

describe('构建工具模型', () => {
  test('存在两种工具时要求显式选择，计划不创建文件', () => {
    const directory = temporary(); writeFileSync(join(directory, 'pom.xml'), '<project/>'); writeFileSync(join(directory, 'build.gradle.kts'), '');
    const config = parseArgs(['plan', '--cwd', directory]);
    expect(() => detectBuildTool(config)).toThrow('同时包含');
    expect(detectBuildTool({ ...config, buildTool: 'gradle' })).toBe('gradle');
    const plan = planMaven({ ...config, buildTool: 'maven', module: 'app' }, join(directory, 'not-created'));
    expect(plan.commands[0]?.args).toContain('-am'); expect(plan.commands[0]?.args).toContain('install');
    for (const spec of plan.commands.slice(1)) expect(spec.args).not.toContain('-am');
    expect(existsSync(join(directory, 'not-created'))).toBe(false);
  });
  test('有效模型中的自定义输出与主类使用 Maven 已裁决值', async () => {
    const directory = temporary();
    const p = await readEffectiveProject(`<project><groupId>fixture</groupId><artifactId>app</artifactId><version>2</version><properties><exec.mainClass>example.Main</exec.mainClass></properties><build><outputDirectory>${directory}/custom/classes</outputDirectory><testOutputDirectory>${directory}/custom/tests</testOutputDirectory></build></project>`, join(directory, 'pom.xml'));
    expect(p.outputDirectory).toBe(join(directory, 'custom/classes')); expect(p.mainClass).toBe('example.Main'); expect(p.version).toBe('2');
    await expect(readEffectiveProject('<projects><project/><project/></projects>', join(directory, 'pom.xml'))).rejects.toThrow('一个 Maven 项目');
  });
});
