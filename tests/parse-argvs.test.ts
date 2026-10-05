import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from '../src/cli/args';
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
  test('无参数默认运行，构建工具与构建策略默认自动选择', () => {
    const config = parse([]);
    expect(config.action).toBe('run');
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

  test('支持四个命令和帮助版本选项', () => {
    for (const action of ['run', 'plan', 'help', 'version'] as const) {
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
    for (const key of ['backend', 'springProfiles', 'properties', 'cwd', 'javaCommand', 'buildCommand', 'action', 'extra']) {
      saveConfig({ [key]: 'x' });
      expect(() => parse([])).toThrow(`未知配置项：${key}`);
    }
  });

  test('配置对象、字段类型与枚举严格验证', () => {
    for (const config of [
      null, [], 'value', 12, { buildTool: null }, { buildTool: 'ant' }, { module: 42 },
      { module: 'a,b' }, { mainClass: false }, { mainClass: 'invalid-name' },
      { jvmArgs: '-Xmx1g' }, { jvmArgs: [12] }, { applicationArgs: [''] },
      { buildArgs: [null] }, { build: 'install' }, { includeTests: 'true' },
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
    for (const args of [['help'], ['version'], ['--help'], ['-h'], ['--version'], ['run', '--help']]) {
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
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const exit = spyOn(process, 'exit').mockImplementation(() => { throw new Error('不应退出'); });
    try {
      helpLog();
      expect(log).toHaveBeenCalledWith(getHelpText());
      expect(exit).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }
  });
});
