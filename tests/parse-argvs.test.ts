import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from '../src/cli/args';
import { toProjectConfig } from '../src/cli/config';
import { getHelpText, helpLog } from '../src/cli/help';

let projectDirectory: string;

beforeEach(() => {
  projectDirectory = mkdtempSync(join(tmpdir(), 'java-run-cli-'));
});

afterEach(() => {
  rmSync(projectDirectory, { recursive: true, force: true });
});

function parse(argv: string[]) {
  return parseArgs(argv, projectDirectory);
}

function saveConfig(data: unknown, directory = projectDirectory): void {
  writeFileSync(join(directory, '.java-run.json'), JSON.stringify(data));
}

describe('框架中立的启动参数', () => {
  test('终端偏好独立于启动配置，严格验证值和重复选项', () => {
    const config = parse(['--log=full', '--plain', '--no-animation', '--no-interactive']);
    expect(config.terminal).toEqual({ logMode: 'full', plain: true, animation: false, interactive: false });
    expect(toProjectConfig(config, 'maven', 'example.App')).toEqual({ buildTool: 'maven', mainClass: 'example.App' });
    for (const args of [['--log=other'], ['--log'], ['--log=full', '--log=summary'],
      ['--plain=true'], ['--plain', '--plain'], ['--no-animation=false'], ['--no-interactive', '--no-interactive']]) {
      expect(() => parse(args)).toThrow();
    }
    expect(parse(['--', '--log=full', '--plain']).applicationArgs).toEqual(['--log=full', '--plain']);
  });

  test('无参数默认运行，构建工具与构建策略默认自动选择', () => {
    const config = parse([]);
    expect(config.action).toBe('run');
    expect(config.force).toBe(false);
    expect(config.cwd).toBe(projectDirectory);
    expect(config.buildTool).toBe('auto');
    expect(config.build).toBe('auto');
    expect(config.mainClass).toBeUndefined();
    expect(config.module).toBeUndefined();
    expect(config.includeTests).toBe(false);
    expect(config.jvmArgs).toEqual([]);
    expect(config.applicationArgs).toEqual([]);
    expect(config.buildArgs).toEqual([]);
  });

  test('支持启动、规划、初始化、帮助和版本命令', () => {
    for (const action of ['run', 'plan', 'init', 'help', 'version'] as const) {
      expect(parse([action]).action).toBe(action);
    }
    for (const alias of ['--help', '-h']) {
      expect(parse(['run', alias]).action).toBe('help');
    }
    expect(parse(['--version']).action).toBe('version');
    expect(parse(['run', '--version']).action).toBe('version');
    expect(parse(['--version', '--help']).action).toBe('help');
    expect(() => parse(['plan', 'run'])).toThrow('命令');
  });

  test('参数名精确匹配，不接受旧入口或框架专用选项', () => {
    for (const argument of [
      'start', '-c', 'compile', 'local', 'active=dev', 'main=example.App',
      '--backend=boot', '--profile=dev', '--property=a=b', '--dry-run', '--refresh',
      '--module-extra=app', '--tool-extra=maven', 'running',
    ]) {
      expect(() => parse([argument])).toThrow('未知参数');
      expect(() => parse(['--help', argument])).toThrow('未知参数');
    }
  });

  test('标量重复和重复布尔开关报错', () => {
    for (const args of [
      ['--main=a.App', '--main=b.App'], ['--module=app', '--module=:app'],
      ['--tool=maven', '--tool=gradle'], ['--cwd=one', '--cwd=two'],
      ['--java=java', '--java=other'], ['--build-command=mvn', '--build-command=other'],
      ['--build=auto', '--build=none'], ['--include-tests', '--include-tests'],
    ]) {
      expect(() => parse(args)).toThrow('不能重复指定');
    }
  });

  test('模块原样保留构建工具选择器，只允许单个目标', () => {
    for (const module of ['app', ':app', ':apps:admin-server', ':', 'apps/my app']) {
      expect(parse([`--module=${module}`]).module).toBe(module);
    }
    for (const selector of ['app,lib', '!app', '-app', '?app']) {
      expect(() => parse([`--module=${selector}`])).toThrow('单个模块');
    }
  });

  test('验证主类语法并允许 Java 内部类和中文标识符', () => {
    expect(parse(['--main=com.example.Outer$Inner']).mainClass).toBe('com.example.Outer$Inner');
    expect(parse(['--main=示例.应用']).mainClass).toBe('示例.应用');
    for (const name of ['1App', 'com..App', 'com.App;exit', 'com.App-name', 'com/App']) {
      expect(() => parse([`--main=${name}`])).toThrow('Java 类全名');
    }
  });

  test('工具和构建策略仅接受枚举值', () => {
    expect(parse(['--tool=maven', '--build=none']).buildTool).toBe('maven');
    expect(parse(['--tool=gradle', '--build=none']).build).toBe('none');
    expect(() => parse(['--tool=ant'])).toThrow('auto、maven 或 gradle');
    expect(() => parse(['--build=install'])).toThrow('auto 或 none');
    expect(() => parse(['--build=compile'])).toThrow('auto 或 none');
  });

  test('按第一个等号分割值，保留重复数组参数的顺序和边界', () => {
    const config = parse([
      '--jvm-arg=-Dtoken=a=b', '--jvm-arg=-Xmx1g',
      '--arg=--message=hello world', '--arg', 'a=b',
      '--build-arg=-Pdevelopment', '--build-arg=-Dname=a=b',
    ]);
    expect(config.jvmArgs).toEqual(['-Dtoken=a=b', '-Xmx1g']);
    expect(config.applicationArgs).toEqual(['--message=hello world', 'a=b']);
    expect(config.buildArgs).toEqual(['-Pdevelopment', '-Dname=a=b']);
  });

  test('-- 后全部透传应用，不再解释 CLI 选项', () => {
    const config = parse(['--arg=first', '--', '--help', 'main=anything', '', '--unknown=value']);
    expect(config.action).toBe('run');
    expect(config.applicationArgs).toEqual(['first', '--help', 'main=anything', '', '--unknown=value']);
    expect(config.mainClass).toBeUndefined();
  });

  test('负号值要求用等号，空值和缺失值直接报错', () => {
    for (const args of [['--jvm-arg', '-Xmx1g'], ['--build-arg', '-Pdev'], ['--main', '--help']]) {
      expect(() => parse(args)).toThrow('负号开头');
    }
    for (const args of [
      ['--main='], ['--cwd= '], ['--module='], ['--arg='], ['--jvm-arg='],
      ['--build-arg='], ['--tool'], ['--build-command='], ['--java'],
    ]) {
      expect(() => parse(args)).toThrow();
    }
  });

  test('命令和布尔开关不接受值，工具路径可包含空格和特殊字符', () => {
    for (const argument of ['--help=true', 'run=true', '--include-tests=false', '--version=yes']) {
      expect(() => parse([argument])).toThrow('不接受参数值');
    }
    const config = parse([
      '--include-tests', '--java', '/tools/java home #/bin/java', '--build-command=/tools/build tool',
    ]);
    expect(config.includeTests).toBe(true);
    expect(config.javaCommand).toBe('/tools/java home #/bin/java');
    expect(config.buildCommand).toBe('/tools/build tool');
  });
});

describe('初始化参数', () => {
  test('init 只保留显式启动参数，不读取或合并原配置', () => {
    saveConfig({
      buildTool: 'maven', module: ':old', mainClass: 'example.Old',
      jvmArgs: ['-Xms256m'], applicationArgs: ['old'], buildArgs: ['--offline'],
      build: 'none', includeTests: true,
    });
    const config = parse([
      'init', '--cwd=.', '--tool=gradle', '--module=:new', '--main=example.New',
      '--jvm-arg=-Xmx1g', '--build-arg=--info', '--arg=first', '--', 'second', '', ' ',
    ]);
    expect(config.action).toBe('init');
    expect(config.buildTool).toBe('gradle');
    expect(config.module).toBe(':new');
    expect(config.mainClass).toBe('example.New');
    expect(config.jvmArgs).toEqual(['-Xmx1g']);
    expect(config.applicationArgs).toEqual(['first', 'second', '', ' ']);
    expect(config.buildArgs).toEqual(['--info']);
    expect(config.build).toBe('auto');
    expect(config.includeTests).toBe(false);
    expect(parse(['init']).mainClass).toBeUndefined();
    expect(parse([]).mainClass).toBe('example.Old');
  });

  test('init 与 force 不解析无效旧配置，也不修改文件', () => {
    const path = join(projectDirectory, '.java-run.json');
    writeFileSync(path, '{invalid');
    for (const argv of [['init'], ['init', '--force'], ['--force', 'init']]) {
      const config = parse(argv);
      expect(config.action).toBe('init');
      expect(config.force).toBe(argv.includes('--force'));
      expect(config.mainClass).toBeUndefined();
      expect(readFileSync(path, 'utf8')).toBe('{invalid');
    }
    expect(() => parse(['init', '--unknown'])).toThrow('未知参数');
  });

  test('force 只属于 init，重复或带值时拒绝', () => {
    for (const argv of [['--force'], ['run', '--force'], ['plan', '--force'], ['help', '--force'], ['version', '--force']]) {
      expect(() => parse(argv)).toThrow('--force 仅允许用于 init');
    }
    expect(() => parse(['init', '--force', '--force'])).toThrow('不能重复指定');
    expect(() => parse(['init', '--force=true'])).toThrow('不接受参数值');
    expect(() => parse(['init', 'run'])).toThrow('命令');
    expect(parse(['init', '--', '--force']).force).toBe(false);
    expect(parse(['init', '--', '--force']).applicationArgs).toEqual(['--force']);
  });

  test('生成配置保存实际工具和主类，省略默认值与 CLI 专属字段', () => {
    const config = parse([
      'init', '--force', '--java=/tools/java', '--build-command=/tools/gradle',
    ]);
    const projectConfig = toProjectConfig(config, 'gradle', 'example.Resolved');
    expect(projectConfig).toEqual({ buildTool: 'gradle', mainClass: 'example.Resolved' });
    saveConfig(projectConfig);
    expect(parse([]).buildTool).toBe('gradle');
    expect(parse([]).mainClass).toBe('example.Resolved');
    expect(parse([]).javaCommand).toBeUndefined();
    expect(parse([]).buildCommand).toBeUndefined();
    expect(parse([]).force).toBe(false);
  });

  test('生成的完整配置可往返读取，保留应用参数的空白及边界', () => {
    const config = parse([
      'init', '--module=:app', '--build=none', '--include-tests',
      '--jvm-arg=-Dmessage=a=b', '--build-arg=--offline',
      '--arg=hello world', '--', '', ' ', '--arg=literal', 'a=b',
    ]);
    const projectConfig = toProjectConfig(config, 'maven', 'example.App');
    expect(projectConfig).toEqual({
      buildTool: 'maven', module: ':app', mainClass: 'example.App',
      jvmArgs: ['-Dmessage=a=b'], applicationArgs: ['hello world', '', ' ', '--arg=literal', 'a=b'],
      buildArgs: ['--offline'], build: 'none', includeTests: true,
    });
    saveConfig(projectConfig);
    const reloaded = parse([]);
    expect(reloaded.action).toBe('run');
    expect(reloaded.module).toBe(':app');
    expect(reloaded.build).toBe('none');
    expect(reloaded.includeTests).toBe(true);
    expect(reloaded.jvmArgs).toEqual(config.jvmArgs);
    expect(reloaded.applicationArgs).toEqual(config.applicationArgs);
    expect(reloaded.buildArgs).toEqual(config.buildArgs);
    projectConfig.jvmArgs!.push('-Xmx1g');
    projectConfig.applicationArgs!.push('changed');
    projectConfig.buildArgs!.push('--info');
    expect(config.jvmArgs).toEqual(['-Dmessage=a=b']);
    expect(config.applicationArgs).toEqual(['hello world', '', ' ', '--arg=literal', 'a=b']);
    expect(config.buildArgs).toEqual(['--offline']);
  });
});

describe('项目配置', () => {
  test('读取完整中立配置，标量覆盖，数组依次追加', () => {
    saveConfig({
      buildTool: 'gradle', module: ':configured', mainClass: 'example.Configured',
      jvmArgs: ['-Xms256m'], applicationArgs: ['configured'], buildArgs: ['--offline'],
      build: 'none', includeTests: false,
    });
    const config = parse([
      '--tool=maven', '--module=:cli', '--main=example.Cli', '--build=auto', '--include-tests',
      '--jvm-arg=-Xmx1g', '--arg=cli', '--build-arg=-Pdev', '--', 'trailing',
    ]);
    expect(config.buildTool).toBe('maven');
    expect(config.module).toBe(':cli');
    expect(config.mainClass).toBe('example.Cli');
    expect(config.build).toBe('auto');
    expect(config.includeTests).toBe(true);
    expect(config.jvmArgs).toEqual(['-Xms256m', '-Xmx1g']);
    expect(config.applicationArgs).toEqual(['configured', 'cli', 'trailing']);
    expect(config.buildArgs).toEqual(['--offline', '-Pdev']);
  });

  test('plan 与 run 都读取配置，没有 CLI 覆盖时保留文件值', () => {
    saveConfig({ buildTool: 'gradle', module: ':app', build: 'none', includeTests: true });
    for (const command of ['run', 'plan'] as const) {
      const config = parse([command]);
      expect(config.action).toBe(command);
      expect(config.buildTool).toBe('gradle');
      expect(config.module).toBe(':app');
      expect(config.build).toBe('none');
      expect(config.includeTests).toBe(true);
    }
  });

  test('先解析最终 cwd 再读配置，且不向父目录查找', () => {
    saveConfig({ mainClass: 'example.Parent' });
    const child = join(projectDirectory, 'child');
    mkdirSync(child);
    expect(parseArgs([], child).mainClass).toBeUndefined();
    saveConfig({ mainClass: 'example.Child' }, child);
    for (const args of [['--cwd=child', '--arg=x'], ['--arg=x', '--cwd=child']]) {
      const config = parse(args);
      expect(config.cwd).toBe(child);
      expect(config.mainClass).toBe('example.Child');
      expect(config.applicationArgs).toEqual(['x']);
    }
    expect(parseArgs(['--cwd', child], resolve('unrelated cwd')).cwd).toBe(child);
  });

  test('配置未知字段拒绝，包括旧框架字段和只允许 CLI 的工具路径', () => {
    for (const key of ['backend', 'springProfiles', 'properties', 'cwd', 'javaCommand', 'buildCommand', 'action', 'force', 'extra']) {
      saveConfig({ [key]: 'x' });
      expect(() => parse([])).toThrow(`未知配置项：${key}`);
    }
  });

  test('配置对象、字段类型与枚举严格验证', () => {
    for (const config of [
      null, [], 'value', 12, { buildTool: null }, { buildTool: 'ant' }, { module: 42 },
      { module: 'a,b' }, { mainClass: false }, { mainClass: 'invalid-name' },
      { jvmArgs: '-Xmx1g' }, { jvmArgs: [12] }, { jvmArgs: [' '] }, { applicationArgs: [null] },
      { buildArgs: [null] }, { buildArgs: [''] }, { build: 'install' }, { includeTests: 'true' },
    ]) {
      saveConfig(config);
      expect(() => parse([])).toThrow('配置无效');
    }
    writeFileSync(join(projectDirectory, '.java-run.json'), '{not JSON');
    expect(() => parse([])).toThrow(join(projectDirectory, '.java-run.json'));
  });

  test('不做环境变量插值，读取后不修改文件或缓存配置', () => {
    const literal = '-Dname=${JAVA_RUN_UNEXPANDED_VALUE}';
    saveConfig({ jvmArgs: [literal] });
    const first = parse([]);
    expect(first.jvmArgs).toEqual([literal]);
    first.jvmArgs.push('mutated');
    expect(parse([]).jvmArgs).toEqual([literal]);
    saveConfig({ jvmArgs: ['changed'] });
    expect(parse([]).jvmArgs).toEqual(['changed']);
  });

  test('CLI 无效时先报告参数错误，不读取项目配置', () => {
    writeFileSync(join(projectDirectory, '.java-run.json'), '{invalid');
    expect(() => parse(['--unknown'])).toThrow('未知参数');
  });
});

describe('帮助与解析副作用', () => {
  test('帮助和版本不会读取配置或要求项目存在', () => {
    writeFileSync(join(projectDirectory, '.java-run.json'), '{invalid');
    for (const args of [
      ['help'], ['version'], ['--help'], ['-h'], ['--version'], ['run', '--help'],
      ['init', '--help'], ['init', '--force', '--help'], ['init', '--force', '--version'],
    ]) {
      expect(() => parse(args)).not.toThrow();
      expect(() => parseArgs(args, join(projectDirectory, 'does-not-exist'))).not.toThrow();
    }
  });

  test('不会修改输入参数或当前工作目录', () => {
    const args = ['plan', '--cwd=child', '--arg=unchanged'];
    const original = [...args];
    const currentCwd = process.cwd();
    const first = parse(args);
    first.applicationArgs.push('mutated');
    expect(parse(args).applicationArgs).toEqual(['unchanged']);
    expect(args).toEqual(original);
    expect(process.cwd()).toBe(currentCwd);
  });

  test('帮助描述通用主类和构建适配，不出现旧业务或框架默认值', () => {
    const help = getHelpText();
    expect(help).toContain('Maven');
    expect(help).toContain('Gradle');
    expect(help).toContain('--tool');
    expect(help).toContain('--build-arg');
    expect(help).toContain('.java-run.json');
    expect(help).not.toContain('Jeecg');
    expect(help).not.toContain('Spring');
    expect(help).not.toContain('--profile');
  });

  test('帮助输出由调用方决定退出时机', () => {
    const log = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exit = spyOn(process, 'exit').mockImplementation(() => { throw new Error('不应退出'); });
    try {
      helpLog();
      expect(log).toHaveBeenCalledWith(getHelpText() + '\n');
      expect(exit).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }
  });
});
