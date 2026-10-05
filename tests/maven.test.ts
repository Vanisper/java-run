import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { planMaven, prepareMaven, resolveMavenBaseDirectory } from '../src/build-tools/maven';
import { parseArgs } from '../src/cli/args';
import { assertJavaArguments, JavaArgumentEncodingError } from '../src/process/java-arguments';

const config = parseArgs(['plan']);
const temporaryDirectories: string[] = [];

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'java-run-maven-base-'));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Maven 配置根', () => {
  test('无 .mvn 时保留当前项目目录，使用纯 ASCII 相对路径', () => {
    const root = directory();
    const project = join(root, '中文项目 # %');
    mkdirSync(project);
    expect(resolveMavenBaseDirectory(project)).toBe('.');
  });

  test('嵌套模块采用最近 .mvn 祖先，不固定为当前目录', () => {
    const root = directory();
    const nearest = join(root, '聚合项目');
    const project = join(nearest, '模块', 'child');
    mkdirSync(project, { recursive: true });
    mkdirSync(join(root, '.mvn'));
    mkdirSync(join(nearest, '.mvn'));
    expect(resolveMavenBaseDirectory(project)).toBe(join('..', '..'));
    mkdirSync(join(project, '.mvn'));
    expect(resolveMavenBaseDirectory(project)).toBe('.');
  });

  test('显式绝对配置根优先于最近 .mvn，转换后仍指向原目标', () => {
    const root = directory();
    const project = join(root, 'workspace', 'app');
    const configured = join(root, 'shared');
    mkdirSync(join(project, '.mvn'), { recursive: true });
    mkdirSync(configured);
    expect(resolveMavenBaseDirectory(project, configured)).toBe(relative(project, configured));
  });

  test('显式相对配置根和空配置遵循 Maven 的选择语义', () => {
    const root = directory();
    const project = join(root, 'workspace', 'app');
    mkdirSync(join(root, 'workspace', '.mvn'), { recursive: true });
    mkdirSync(project);
    expect(resolveMavenBaseDirectory(project, '../..')).toBe(join('..', '..'));
    expect(resolveMavenBaseDirectory(project, '')).toBe('..');
  });

  test.skipIf(process.platform !== 'win32')('跨盘显式配置根保留绝对路径，交由原生编码检查', () => {
    expect(resolveMavenBaseDirectory('C:\\project', 'D:\\shared 中文')).toBe('D:\\shared 中文');
  });

  test.skipIf(process.platform !== 'win32')('旧版 Maven 仅在需要 Unicode 环境插值时明确拒绝', async () => {
    const root = directory();
    const project = join(root, '中文项目');
    const workspace = join(root, 'metadata');
    const batch = join(root, 'old-maven.cmd');
    mkdirSync(project);
    mkdirSync(workspace);
    writeFileSync(join(project, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion></project>');
    writeFileSync(batch, '@echo off\r\nif "%~3"=="-version" (\r\n echo Apache Maven 3.8.8\r\n exit /b 0\r\n)\r\necho EXPECTED_OLD_MAVEN_BUILD 1>&2\r\nexit /b 7\r\n');
    const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java.exe') : 'java';
    let requiresBridge = false;
    try {
      await assertJavaArguments(java, [`-Dmaven.multiModuleProjectDirectory=${project}`], project);
    } catch (error) {
      if (!(error instanceof JavaArgumentEncodingError)) throw error;
      requiresBridge = true;
    }
    const prepared = prepareMaven(parseArgs(['--cwd', project, '--build-command', batch]), workspace);
    if (requiresBridge) {
      await expect(prepared).rejects.toThrow('Maven 3.9.2');
    } else {
      await expect(prepared).rejects.toMatchObject({ name: 'CommandError', exitCode: 7, stderr: expect.stringContaining('EXPECTED_OLD_MAVEN_BUILD') });
    }
  });
});

describe('Maven 构建参数边界', () => {
  test('允许独立的属性、profile 和 settings 路径，不把路径当成目标', () => {
    const buildArgs = ['-Dcustom.value=a=b', '-Dmaven.repo.local=/tmp/repository', '-Pci', '-s', '/tmp/settings with spaces.xml', '--threads=2', '--offline'];
    expect(planMaven({ ...config, buildArgs }, '/tmp/metadata').commands[0]!.args).toContain('/tmp/settings with spaces.xml');
  });
  test.each(['deploy', 'clean', '-plapp', '--projects=other', '-fother.xml', '-am', '-N', '--fail-never', '-s', '-P', '-Doutput=other', '-DoutputEncoding=GBK', '-Dexpression=other', '-DskipTests=false', '-Dmdep.outputFile=other', '-Dexec.mainClass=Other', '-Dmaven.multiModuleProjectDirectory=other'])('拒绝覆盖计划或执行额外目标的参数 %s', argument => {
    expect(() => planMaven({ ...config, buildArgs: [argument] }, '/tmp/metadata')).toThrow();
  });
});
