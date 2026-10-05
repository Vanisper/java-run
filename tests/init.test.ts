import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli/args';
import { createProjectConfigWriter } from '../src/cli/init';

const directories: string[] = [];
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'java-run-init-'));
  directories.push(root);
  return root;
}

function file(root: string, name: string, source: string): string {
  const location = join(root, name);
  mkdirSync(dirname(location), { recursive: true });
  writeFileSync(location, source);
  return location;
}

function compileClasses(root: string, names: string[]): string {
  const classes = join(root, 'classes');
  mkdirSync(classes);
  const sources = names.length ? names : ['Library'];
  for (const name of sources) {
    file(root, `${name}.java`, `public class ${name} { ${names.length
      ? 'public static void main(String[] args) throws Exception { new java.io.File("application-started").createNewFile(); }'
      : 'public static String value() { return "library"; }'} }`);
  }
  const result = spawnSync('javac', ['-encoding', 'UTF-8', '-d', classes, ...sources.map(name => `${name}.java`)], {
    cwd: root, encoding: 'utf8', timeout: 20000,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'javac 未成功完成');
  return classes;
}

function wrapper(root: string, source: string): string {
  const runner = file(root, 'fake-build.js', source);
  const location = join(root, process.platform === 'win32' ? 'fake-build.cmd' : 'fake-build');
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  writeFileSync(location, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${runner}" %*\r\nexit /b %errorlevel%\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runner)} "$@"\n`);
  if (process.platform !== 'win32') chmodSync(location, 0o755);
  return location;
}

interface GradleFixtureOptions {
  entries?: string[];
  candidates?: { value: string; label: string }[];
  declaredMain?: string;
  failureCode?: number;
}

function gradleFixture(options: GradleFixtureOptions = {}) {
  const root = directory();
  file(root, 'settings.gradle', "rootProject.name = 'init-fixture'\n");
  const classes = compileClasses(root, options.entries ?? ['Entry']);
  const candidates = options.candidates ?? [{ value: ':', label: '根项目' }];
  const command = wrapper(root, `
    import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    appendFileSync('build-invocations.jsonl', JSON.stringify(args) + '\\n');
    if (${options.failureCode ?? 0}) process.exit(${options.failureCode ?? 0});
    const script = readFileSync(args[args.indexOf('-I') + 1], 'utf8');
    const encoded = /new String\\('([^']+)'\\.decodeBase64\\(\\)/.exec(script)?.[1];
    if (!encoded) throw new Error('Missing build request');
    const request = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (args.includes('-DjavaRun.discover=true')) {
      writeFileSync(request.output, JSON.stringify(${JSON.stringify(candidates)}));
    } else {
      writeFileSync(request.output, JSON.stringify({
        directory: ${JSON.stringify(root)}, classesDirectories: [${JSON.stringify(classes)}],
        runtimeClasspath: [${JSON.stringify(classes)}], javaCommand: ${JSON.stringify(process.execPath)},
        mainClass: ${JSON.stringify(options.declaredMain ?? null)}, jvmArgs: ['-Dproject.default=keep-in-build']
      }));
    }
  `);
  return { root, command, config: join(root, '.java-run.json'), log: join(root, 'build-invocations.jsonl') };
}

function mavenFixture(aggregate = false) {
  const root = directory();
  file(root, 'pom.xml', `<project><modelVersion>4.0.0</modelVersion><groupId>fixture</groupId><artifactId>init</artifactId><version>1</version>${aggregate
    ? '<packaging>pom</packaging><modules><module>app</module></modules>' : ''}</project>`);
  const classes = compileClasses(root, ['MavenEntry']);
  const command = wrapper(root, `
    import { appendFileSync, writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    appendFileSync('build-invocations.jsonl', JSON.stringify(args) + '\\n');
    const output = args.find(value => value.startsWith('-Doutput='))?.slice(9);
    if (args.includes('-Dexpression=project.file')) writeFileSync(output, ${JSON.stringify(join(root, 'pom.xml'))});
    else if (args.some(value => value.endsWith(':effective-pom'))) {
      const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const project = '<project><groupId>fixture</groupId><artifactId>init</artifactId><version>1</version><build><outputDirectory>' +
        escape(${JSON.stringify(classes)}) + '</outputDirectory><testOutputDirectory>' + escape(${JSON.stringify(join(root, 'test-classes'))}) + '</testOutputDirectory></build></project>';
      writeFileSync(output, ${aggregate} && !args.includes('-pl')
        ? '<projects><project><groupId>fixture</groupId><artifactId>root</artifactId><packaging>pom</packaging></project>' + project + '</projects>'
        : project);
    } else {
      const dependencies = args.find(value => value.startsWith('-Dmdep.outputFile='))?.slice('-Dmdep.outputFile='.length);
      if (dependencies) writeFileSync(dependencies, '');
    }
  `);
  return { root, command, config: join(root, '.java-run.json'), log: join(root, 'build-invocations.jsonl') };
}

function init(fixture: { root: string; command: string }, args: string[] = []) {
  const result = spawnSync(process.execPath, [cli, 'init', '--cwd', fixture.root, '--build-command', fixture.command, ...args], {
    encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function configuration(fixture: { config: string }) {
  return JSON.parse(readFileSync(fixture.config, 'utf8'));
}

afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('生成项目启动配置', () => {
  test('唯一 Gradle 项目与入口自动保存，参数可再次读取且不执行应用', () => {
    const fixture = gradleFixture();
    const result = init(fixture, ['--java=unused-java-command', '--jvm-arg=-Xmx128m', '--build-arg=--offline', '--', 'a b', '', '--mode=demo']);
    expect(result.code).toBe(0);
    expect(configuration(fixture)).toEqual({
      buildTool: 'gradle', module: ':', mainClass: 'Entry', jvmArgs: ['-Xmx128m'],
      buildArgs: ['--offline'], applicationArgs: ['a b', '', '--mode=demo'],
    });
    const next = parseArgs(['--cwd', fixture.root]);
    expect(next.mainClass).toBe('Entry');
    expect(next.applicationArgs).toEqual(['a b', '', '--mode=demo']);
    expect(next.jvmArgs).toEqual(['-Xmx128m']);
    expect(next.javaCommand).toBeUndefined();
    expect(next.buildCommand).toBeUndefined();
    expect(existsSync(join(fixture.root, 'application-started'))).toBe(false);
    expect(result.stderr).not.toContain('java-run：运行');
  }, 30000);

  test('Maven 单项目保存自动发现的主类，默认配置保持简洁', () => {
    const fixture = mavenFixture();
    expect(init(fixture).code).toBe(0);
    expect(configuration(fixture)).toEqual({ buildTool: 'maven', mainClass: 'MavenEntry' });
    expect(parseArgs(['--cwd', fixture.root]).buildTool).toBe('maven');
    expect(existsSync(join(fixture.root, 'application-started'))).toBe(false);
  }, 30000);

  test('Maven reactor 唯一 jar 项目保存有效模块选择器并用于后续准备', () => {
    const fixture = mavenFixture(true);
    expect(init(fixture).code).toBe(0);
    expect(configuration(fixture)).toEqual({ buildTool: 'maven', module: 'fixture:init', mainClass: 'MavenEntry' });
    expect(parseArgs(['--cwd', fixture.root]).module).toBe('fixture:init');
    const calls: string[][] = readFileSync(fixture.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.slice(1).every(args => args[args.indexOf('-pl') + 1] === 'fixture:init')).toBe(true);
    expect(calls.some(args => args.includes('install') && args.includes('-am'))).toBe(true);
  }, 30000);

  test('唯一子项目自动选择，保留显式构建策略和测试输出设置', () => {
    const fixture = gradleFixture({ candidates: [{ value: ':apps:server', label: '服务项目' }] });
    expect(init(fixture, ['--build=none', '--include-tests']).code).toBe(0);
    expect(configuration(fixture)).toEqual({
      buildTool: 'gradle', module: ':apps:server', mainClass: 'Entry', build: 'none', includeTests: true,
    });
  }, 30000);

  test('非交互多模块要求显式选择，尚未准备目标或保存文件', () => {
    const fixture = gradleFixture({ candidates: [{ value: ':app', label: '应用' }, { value: ':lib', label: '库' }] });
    const result = init(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--module');
    expect(existsSync(fixture.config)).toBe(false);
    const calls: string[][] = readFileSync(fixture.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('-DjavaRun.discover=true');
    expect(init(fixture, ['--module=:app']).code).toBe(0);
    expect(configuration(fixture).module).toBe(':app');
  }, 30000);

  test('未声明的多个主类在非交互环境失败，显式入口可以完成初始化', () => {
    const fixture = gradleFixture({ entries: ['First', 'Second'] });
    const result = init(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--main');
    expect(result.stderr).toContain('First');
    expect(result.stderr).toContain('Second');
    expect(existsSync(fixture.config)).toBe(false);
    expect(init(fixture, ['--main=Second']).code).toBe(0);
    expect(configuration(fixture).mainClass).toBe('Second');
  }, 30000);

  test('构建声明消除入口歧义，显式主类优先于声明', () => {
    const fixture = gradleFixture({ entries: ['First', 'Second'], declaredMain: 'First' });
    expect(init(fixture).code).toBe(0);
    expect(configuration(fixture).mainClass).toBe('First');
    expect(init(fixture, ['--force', '--main=Second']).code).toBe(0);
    expect(configuration(fixture).mainClass).toBe('Second');
  }, 30000);

  test('库模块没有 main 时不生成配置', () => {
    const fixture = gradleFixture({ entries: [] });
    const result = init(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('未找到 public static main');
    expect(existsSync(fixture.config)).toBe(false);
  }, 30000);

  test.each(['{"mainClass":"Old","jvmArgs":["-Dold=true"]}', '{invalid-json'])('已有配置在任何构建之前拒绝覆盖：%s', existing => {
    const fixture = gradleFixture();
    writeFileSync(fixture.config, existing);
    const result = init(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--force');
    expect(readFileSync(fixture.config, 'utf8')).toBe(existing);
    expect(existsSync(fixture.log)).toBe(false);
  }, 30000);

  test('force 重新生成而不合并原有数组或模块，亦可修复无效 JSON', () => {
    const fixture = gradleFixture();
    writeFileSync(fixture.config, JSON.stringify({ module: ':old', mainClass: 'Old', jvmArgs: ['-Dold=true'], applicationArgs: ['old'], build: 'none' }));
    expect(init(fixture, ['--force', '--arg=new']).code).toBe(0);
    expect(configuration(fixture)).toEqual({ buildTool: 'gradle', module: ':', mainClass: 'Entry', applicationArgs: ['new'] });
    writeFileSync(fixture.config, '{invalid-json');
    expect(init(fixture, ['--force']).code).toBe(0);
    expect(configuration(fixture)).toEqual({ buildTool: 'gradle', module: ':', mainClass: 'Entry' });
  }, 30000);

  test('force 遇到构建失败时保留原文件并保留失败退出码', () => {
    const fixture = gradleFixture({ failureCode: 7 });
    const original = '{invalid-json';
    writeFileSync(fixture.config, original);
    expect(init(fixture, ['--force']).code).toBe(7);
    expect(readFileSync(fixture.config, 'utf8')).toBe(original);
  }, 30000);
});

describe('CLI 启动入口', () => {
  test('前置 classpath JVM 参数不影响受控类路径或入口日志', () => {
    const fixture = mavenFixture();
    const result = spawnSync(process.execPath, [
      cli, '--cwd', fixture.root, '--build-command', fixture.command,
      '--jvm-arg=-classpath', '--jvm-arg=unused-classpath',
    ], { encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('java-run：运行 MavenEntry（maven）');
    expect(existsSync(join(fixture.root, 'application-started'))).toBe(true);
  }, 30000);
});

describe('项目配置写入保护', () => {
  test('准备期间另一进程创建配置时不覆盖，并清理暂存文件', () => {
    const root = directory();
    const writer = createProjectConfigWriter(root);
    writeFileSync(writer.path, '{"mainClass":"Other"}');
    expect(() => writer.save({ buildTool: 'maven', mainClass: 'Entry' })).toThrow();
    expect(readFileSync(writer.path, 'utf8')).toBe('{"mainClass":"Other"}');
    expect(readdirSync(root)).toEqual(['.java-run.json']);
  });

  test.each([false, true])('目录目标始终受保护（force=%s）', force => {
    const root = directory();
    mkdirSync(join(root, '.java-run.json'));
    expect(() => createProjectConfigWriter(root, force)).toThrow();
    expect(readdirSync(root)).toEqual(['.java-run.json']);
  });

  test('force 保存前重新检查突然出现的目录', () => {
    const root = directory();
    const writer = createProjectConfigWriter(root, true);
    mkdirSync(writer.path);
    expect(() => writer.save({ mainClass: 'Entry' })).toThrow();
    expect(readdirSync(root)).toEqual(['.java-run.json']);
  });

  for (const force of [false, true]) {
    test.skipIf(process.platform === 'win32')(`拒绝普通及悬空符号链接（force=${force}）`, () => {
      const root = directory();
      const target = file(root, 'target.json', '{"mainClass":"Protected"}');
      const path = join(root, '.java-run.json');
      symlinkSync(target, path);
      expect(() => createProjectConfigWriter(root, force)).toThrow();
      expect(readFileSync(target, 'utf8')).toBe('{"mainClass":"Protected"}');
      rmSync(path);
      symlinkSync(join(root, 'missing.json'), path);
      expect(() => createProjectConfigWriter(root, force)).toThrow();
      expect(existsSync(join(root, 'missing.json'))).toBe(false);
      expect(readdirSync(root).sort()).toEqual(['.java-run.json', 'target.json']);
    });
  }

  test('正常保存和显式覆盖不留下暂存文件', () => {
    const root = directory();
    createProjectConfigWriter(root).save({ buildTool: 'maven', mainClass: 'First' });
    createProjectConfigWriter(root, true).save({ buildTool: 'gradle', mainClass: 'Second' });
    expect(JSON.parse(readFileSync(join(root, '.java-run.json'), 'utf8'))).toEqual({ buildTool: 'gradle', mainClass: 'Second' });
    expect(readdirSync(root)).toEqual(['.java-run.json']);
  });
});
