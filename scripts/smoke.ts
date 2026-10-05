import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertJavaArguments, readJavaNativeEncoding } from '../src/process/java-arguments';

type Fixture = 'boot-single' | 'boot-reactor' | 'plain' | 'gradle-reactor';
type Suite = 'quick' | 'full';

interface SmokeOptions {
  executable: string;
  suite: Suite;
  fixture?: Fixture;
  keep: boolean;
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface Expectations {
  code?: number;
  stdout?: string[];
  stderr?: string[];
  absent?: string[];
}

const projectRoot = path.resolve(import.meta.dir, '..');
const fixtureNames: Fixture[] = ['boot-single', 'boot-reactor', 'plain', 'gradle-reactor'];

function parseOptions(): SmokeOptions {
  let executable = path.join(projectRoot, 'dist', process.platform === 'win32' ? 'java-run.exe' : 'java-run');
  let suite = process.env.JAVA_RUN_SMOKE_SUITE ?? 'full';
  let fixture = process.env.JAVA_RUN_SMOKE_FIXTURE;
  let keep = process.env.JAVA_RUN_SMOKE_KEEP === '1';
  let positional = false;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--cli=')) executable = path.resolve(arg.slice('--cli='.length));
    else if (arg.startsWith('--suite=')) suite = arg.slice('--suite='.length);
    else if (arg.startsWith('--fixture=')) fixture = arg.slice('--fixture='.length);
    else if (arg === '--keep') keep = true;
    else if (!arg.startsWith('-') && !positional) {
      executable = path.resolve(arg);
      positional = true;
    } else throw new Error(`未知 smoke 参数: ${arg}`);
  }
  if (suite !== 'quick' && suite !== 'full') throw new Error('--suite 只支持 quick 或 full');
  if (fixture && !fixtureNames.includes(fixture as Fixture)) {
    throw new Error(`--fixture 只支持 ${fixtureNames.join('、')}`);
  }
  return { executable, suite, fixture: fixture as Fixture | undefined, keep };
}

/** 从二进制的环境中移除当前 Bun 安装目录，验证其可独立运行 */
function binaryEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const bunDirectory = path.dirname(process.execPath);
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  env[pathKey] = (env[pathKey] ?? '').split(path.delimiter)
    .filter(value => value && normalize(value) !== normalize(bunDirectory)).join(path.delimiter);
  return env;
}

async function invoke(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGINT');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, 600_000);
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', error => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut });
    });
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** 检查静态预览没有生成构建工具输出或旧版缓存 */
async function assertUnbuilt(directory: string): Promise<void> {
  for (const name of ['target', 'build', '.gradle', '.cache']) {
    if (await exists(path.join(directory, name))) throw new Error(`静态预览生成了 ${name}`);
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await assertUnbuilt(path.join(directory, entry.name));
  }
}

async function main(): Promise<void> {
  const options = parseOptions();
  if (!await exists(options.executable)) throw new Error(`二进制不存在: ${options.executable}，请先运行 bun run compile`);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'java-run-smoke-'));
  const repository = path.resolve(process.env.JAVA_RUN_MAVEN_REPOSITORY ?? path.join(workspace, 'repository'));
  const gradleHome = path.resolve(process.env.JAVA_RUN_GRADLE_HOME ?? path.join(workspace, 'gradle-home'));
  const settings = path.join(workspace, 'settings.xml');
  const logDirectory = path.join(workspace, 'logs');
  const env = binaryEnvironment();
  env.GRADLE_USER_HOME = gradleHome;
  const projects = new Map<Fixture, string>();
  let failed = true;
  let checks = 0;

  try {
    await mkdir(repository, { recursive: true });
    await mkdir(gradleHome, { recursive: true });
    await mkdir(logDirectory);
    const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
    const nativeEncoding = await readJavaNativeEncoding(java, workspace);
    let unicodeArguments = true;
    try {
      await assertJavaArguments(java, ['hello world #中文%'], workspace);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('无法完整表示')) throw error;
      unicodeArguments = false;
    }
    const specialValue = unicodeArguments ? 'hello world #中文%' : 'hello world #%';
    const configValue = unicodeArguments ? 'config value #中文%' : 'config value #%';
    console.log(`Java native encoding: ${nativeEncoding}; Unicode argv: ${unicodeArguments ? 'supported' : 'explicit rejection required'}`);
    await writeFile(settings, '<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"/>\n');
    for (const fixture of fixtureNames) {
      const destination = path.join(workspace, `${fixture} 空格#中文%`);
      await cp(path.join(projectRoot, 'tests', 'fixtures', fixture), destination, {
        recursive: true,
        filter: source => !['target', 'build', '.gradle', '.cache'].includes(path.basename(source)),
      });
      projects.set(fixture, destination);
    }

    const check = async (name: string, args: string[], expected: Expectations = {}, cwd = workspace) => {
      const started = Date.now();
      const result = await invoke(options.executable, args, cwd, env);
      await writeFile(path.join(logDirectory, `${name}.stdout.log`), result.stdout);
      await writeFile(path.join(logDirectory, `${name}.stderr.log`), result.stderr);
      const violations: string[] = [];
      if (result.timedOut) violations.push('执行超时');
      if (result.code !== (expected.code ?? 0)) violations.push(`退出码应为 ${expected.code ?? 0}，实际为 ${result.code} (${result.signal ?? 'no signal'})`);
      for (const marker of expected.stdout ?? []) {
        if (!result.stdout.includes(marker)) violations.push(`缺少 stdout 标记: ${marker}`);
      }
      for (const marker of expected.stderr ?? []) {
        if (!result.stderr.includes(marker)) violations.push(`缺少 stderr 标记: ${marker}`);
      }
      for (const marker of expected.absent ?? []) {
        if ((result.stdout + result.stderr).includes(marker)) violations.push(`出现禁止标记: ${marker}`);
      }
      if (violations.length) {
        console.error(`FAIL ${name}:\n${violations.join('\n')}`);
        console.error(`stdout:\n${result.stdout.slice(-16_000)}\nstderr:\n${result.stderr.slice(-16_000)}`);
        throw new Error(`${name} 未通过；完整输出: ${logDirectory}`);
      }
      checks++;
      console.log(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      return result;
    };
    const mavenBuildArguments = ['-s', settings, `-Dmaven.repo.local=${repository}`];
    const argumentsFor = (fixture: Fixture, ...extra: string[]) => [
      'run', `--cwd=${projects.get(fixture)!}`,
      ...(fixture === 'gradle-reactor'
        ? [`--build-command=${process.env.JAVA_RUN_GRADLE_COMMAND ?? 'gradle'}`]
        : mavenBuildArguments.map(arg => `--build-arg=${arg}`)),
      ...extra,
    ];
    const commonArguments = ['--jvm-arg=-Dspring.profiles.active=smoke', `--jvm-arg=-Dfixture.jvm=${specialValue}`, `--arg=--message=${specialValue}`, '--arg=second'];
    const commonMarkers = [`[fixture] jvm-value=${specialValue}`, `[fixture] arg=--message=${specialValue}`, '[fixture] arg=second'];
    const mavenMarkers = ['[fixture] spring-profile=smoke', '[fixture] maven-profile=ci', ...commonMarkers];
    const withoutTests = ['[fixture] test-dependency=absent', '[fixture] test-class=absent'];
    const withTests = ['[fixture] test-dependency=present', '[fixture] test-class=present'];
    const selected = (fixture: Fixture) => !options.fixture || options.fixture === fixture;

    await check('help', ['help'], { stdout: ['java-run'] });
    const packageVersion = (JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as { version: string }).version;
    await check('version', ['version'], { stdout: [packageVersion] });
    const previewFixture = options.fixture ?? 'boot-reactor';
    const previewArgs = argumentsFor(previewFixture, ...(['boot-reactor', 'gradle-reactor'].includes(previewFixture) ? ['--module=app'] : []))
      .filter(arg => !arg.startsWith('--build-command='));
    previewArgs.push(`--build-command=${path.join(workspace, 'missing-build-tool')}`);
    previewArgs[0] = 'plan';
    await check('plan', previewArgs, { stdout: ['missing-build-tool'], absent: ['[fixture]'] });
    for (const directory of projects.values()) await assertUnbuilt(directory);

    if (selected('boot-single')) {
      await check('boot-single', argumentsFor('boot-single', '--build-arg=-Pci', ...commonArguments), {
        stdout: ['[fixture] kind=boot-single', ...mavenMarkers, ...withoutTests],
      });
      if (options.suite === 'full') {
        await check('boot-single-tests', argumentsFor('boot-single', '--include-tests'), {
          stdout: ['[fixture] kind=boot-single', ...withTests],
        });
      }
    }

    if (selected('boot-reactor')) {
      await check('boot-reactor', argumentsFor('boot-reactor', '--module=app', '--build-arg=-Pci', ...commonArguments), {
        stdout: ['[fixture] kind=boot-reactor-app', '[fixture] library=library-v1', '[fixture] library-version=1.0.0', ...mavenMarkers, ...withoutTests],
        absent: ['FORBIDDEN_OTHER_APP'],
      });
      if (await exists(path.join(projects.get('boot-reactor')!, 'other-app', 'target'))) {
        throw new Error('Maven auto 准备构建了无关的 other-app');
      }
      if (options.suite === 'full') {
        await check('boot-reactor-tests', argumentsFor('boot-reactor', '--module=:app', '--include-tests'), {
          stdout: ['[fixture] kind=boot-reactor-app', ...withTests],
          absent: ['FORBIDDEN_OTHER_APP'],
        });
        const pom = path.join(projects.get('boot-reactor')!, 'pom.xml');
        await writeFile(pom, (await readFile(pom, 'utf8')).replace('<fixture.library.marker>library-v1</fixture.library.marker>', '<fixture.library.marker>library-v2</fixture.library.marker>'));
        await check('boot-reactor-pom-update', argumentsFor('boot-reactor', '--module=app'), {
          stdout: ['[fixture] library=library-v2', ...withoutTests],
          absent: ['FORBIDDEN_OTHER_APP'],
        });
      }
    }

    if (selected('plain')) {
      const directArguments = ['--main=org.javarun.fixture.PlainApplication'];
      await check('plain', argumentsFor('plain', ...directArguments, '--build-arg=-Pci', ...commonArguments), {
        stdout: ['[fixture] kind=plain', '[fixture] dependency-version=2.18.0', ...mavenMarkers, ...withoutTests],
      });
      if (!unicodeArguments) {
        const unsupportedValue = 'token-secret-中文';
        for (const [name, argument] of [
          ['plain-unrepresentable-application-argument', `--arg=${unsupportedValue}`],
          ['plain-unrepresentable-jvm-argument', `--jvm-arg=-Dfixture.jvm=${unsupportedValue}`],
        ]) {
          await check(name!, argumentsFor('plain', ...directArguments, '--build=none', argument!), {
            code: 1,
            stderr: ['无法完整表示', '系统区域设置'],
            absent: ['[fixture]', unsupportedValue],
          });
        }
      }
      if (options.suite === 'full') {
        const configPath = path.join(projects.get('plain')!, '.java-run.json');
        await writeFile(configPath, JSON.stringify({
          mainClass: 'org.javarun.fixture.PlainApplication',
          build: 'none',
          buildArgs: mavenBuildArguments,
          jvmArgs: [`-Dfixture.jvm=${configValue}`],
          applicationArgs: ['--from-config'],
        }, null, 2));
        await check('project-config-default', [], {
          stdout: ['[fixture] kind=plain', `[fixture] jvm-value=${configValue}`, '[fixture] arg=--from-config'],
        }, projects.get('plain')!);
        await check('project-config-override', ['--main=org.javarun.fixture.PlainApplication', '--jvm-arg=-Dfixture.jvm=cli value', '--arg=--from-cli'], {
          stdout: ['[fixture] jvm-value=cli value', '[fixture] arg=--from-config', '[fixture] arg=--from-cli'],
        }, projects.get('plain')!);
        await rm(configPath);
        await check('plain-tests', argumentsFor('plain', ...directArguments, '--include-tests'), {
          stdout: ['[fixture] kind=plain', ...withTests],
        });
        await check('plain-test-isolation', argumentsFor('plain', ...directArguments, '--build=none'), {
          stdout: ['[fixture] kind=plain', ...withoutTests],
        });
        await check('plain-exit', argumentsFor('plain', ...directArguments, '--build=none', '--arg=--exit=7'), {
          code: 7,
          stdout: ['[fixture] kind=plain', '[fixture] arg=--exit=7'],
        });
        const pom = path.join(projects.get('plain')!, 'pom.xml');
        await writeFile(pom, (await readFile(pom, 'utf8')).replace('<commons.io.version>2.18.0</commons.io.version>', '<commons.io.version>2.19.0</commons.io.version>'));
        await check('plain-pom-update', argumentsFor('plain', ...directArguments, '--build=none'), {
          stdout: ['[fixture] dependency-version=2.19.0', ...withoutTests],
        });
      }
    }

    if (selected('gradle-reactor')) {
      await check('gradle-reactor', argumentsFor('gradle-reactor', '--module=app', '--build-arg=-PfixtureProfile=ci', ...commonArguments), {
        stdout: ['[fixture] kind=gradle-reactor-app', '[fixture] library=gradle-library-v1', '[fixture] library-version=1.0.0', '[fixture] dependency-version=2.18.0', '[fixture] gradle-profile=ci', ...commonMarkers, ...withoutTests],
        absent: ['FORBIDDEN_OTHER_APP'],
      });
      if (await exists(path.join(projects.get('gradle-reactor')!, 'other-app', 'build'))) {
        throw new Error('Gradle auto 准备构建了无关的 other-app');
      }
      if (options.suite === 'full') {
        await check('gradle-reactor-tests', argumentsFor('gradle-reactor', '--module=:app', '--include-tests'), {
          stdout: ['[fixture] kind=gradle-reactor-app', ...withTests],
          absent: ['FORBIDDEN_OTHER_APP'],
        });
        await check('gradle-test-isolation', argumentsFor('gradle-reactor', '--module=app', '--build=none'), {
          stdout: ['[fixture] kind=gradle-reactor-app', ...withoutTests],
          absent: ['FORBIDDEN_OTHER_APP'],
        });
        const libraryBuild = path.join(projects.get('gradle-reactor')!, 'lib', 'build.gradle');
        await writeFile(libraryBuild, (await readFile(libraryBuild, 'utf8')).replaceAll('gradle-library-v1', 'gradle-library-v2'));
        await check('gradle-resource-update', argumentsFor('gradle-reactor', '--module=app'), {
          stdout: ['[fixture] library=gradle-library-v2', ...withoutTests],
          absent: ['FORBIDDEN_OTHER_APP'],
        });
        const applicationBuild = path.join(projects.get('gradle-reactor')!, 'app', 'build.gradle');
        await writeFile(applicationBuild, (await readFile(applicationBuild, 'utf8')).replace('commons-io:commons-io:2.18.0', 'commons-io:commons-io:2.19.0'));
        await check('gradle-dependency-update', argumentsFor('gradle-reactor', '--module=app', '--build=none'), {
          stdout: ['[fixture] dependency-version=2.19.0', ...withoutTests],
          absent: ['FORBIDDEN_OTHER_APP'],
        });
      }
    }
    failed = false;
    console.log(`已通过 ${checks} 项原生二进制 smoke (${options.suite}, ${process.platform}/${process.arch})`);
  } finally {
    if (failed || options.keep) console.log(`保留 smoke 临时目录: ${workspace}`);
    else await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
