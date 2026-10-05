import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isJavaClassName } from '../core/java-class';
import type { RunConfig } from '../core/types';

type ProjectConfig = Partial<Pick<RunConfig,
  'buildTool' | 'module' | 'mainClass' | 'jvmArgs' | 'applicationArgs'
  | 'buildArgs' | 'build' | 'includeTests'
>>;

const CONFIG_KEYS = new Set([
  'buildTool', 'module', 'mainClass', 'jvmArgs', 'applicationArgs',
  'buildArgs', 'build', 'includeTests',
]);

function requireValue(value: unknown, option: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${option} 必须是非空字符串`);
  return value;
}

function moduleSelector(value: unknown, option: string): string {
  const selector = requireValue(value, option).trim();
  if (selector.includes(',') || /^[!\-?]/.test(selector)) {
    throw new Error(`${option} 必须指定单个模块，不能多选、排除或使用可选选择器`);
  }
  return selector;
}

function mainClass(value: unknown, option: string): string {
  const name = requireValue(value, option);
  if (!isJavaClassName(name)) throw new Error(`${option} 必须是有效的 Java 类全名`);
  return name;
}

function buildTool(value: unknown, option: string): RunConfig['buildTool'] {
  if (value !== 'auto' && value !== 'maven' && value !== 'gradle') {
    throw new Error(`${option} 仅支持 auto、maven 或 gradle`);
  }
  return value;
}

function buildStrategy(value: unknown, option: string): RunConfig['build'] {
  if (value !== 'auto' && value !== 'none') throw new Error(`${option} 仅支持 auto 或 none`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组`);
  return value.map(item => requireValue(item, field));
}

function readProjectConfig(cwd: string): ProjectConfig {
  const path = resolve(cwd, '.java-run.json');
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
    throw new Error(`无法读取配置 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const data: unknown = JSON.parse(source);
    if (!isObject(data)) throw new Error('配置必须是 JSON 对象');
    const result: ProjectConfig = {};
    for (const [field, value] of Object.entries(data)) {
      if (!CONFIG_KEYS.has(field)) throw new Error(`未知配置项：${field}`);
      switch (field) {
        case 'buildTool':
          result.buildTool = buildTool(value, field);
          break;
        case 'module':
          result.module = moduleSelector(value, field);
          break;
        case 'mainClass':
          result.mainClass = mainClass(value, field);
          break;
        case 'jvmArgs':
          result.jvmArgs = stringArray(value, field);
          break;
        case 'applicationArgs':
          result.applicationArgs = stringArray(value, field);
          break;
        case 'buildArgs':
          result.buildArgs = stringArray(value, field);
          break;
        case 'build':
          result.build = buildStrategy(value, field);
          break;
        case 'includeTests':
          if (typeof value !== 'boolean') throw new Error('includeTests 必须是布尔值');
          result.includeTests = value;
          break;
      }
    }
    return result;
  } catch (error) {
    throw new Error(`配置无效 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 解析启动参数并合并项目根目录下的 .java-run.json
 *
 * @description
 * - argv 不包含运行时和脚本路径，通常由 process.argv.slice(2) 提供
 * - 默认执行 run；help 和 version 只解析参数，不读取项目配置
 * - CLI 标量覆盖配置，数组在配置之后追加，-- 后的参数全部传给应用
 * - --cwd 相对 cwd 解析，只读取最终目录中的配置，不向父目录查找
 * - 未知选项、重复标量、无效值或配置抛出 Error，不执行外部命令
 */
export function parseArgs(argv: string[], cwd = process.cwd()): RunConfig {
  const config: RunConfig = {
    action: 'run',
    cwd: resolve(cwd),
    buildTool: 'auto',
    jvmArgs: [],
    applicationArgs: [],
    buildArgs: [],
    build: 'auto',
    includeTests: false,
  };
  const scalarOptions = new Set<string>();
  let hasHelp = false;
  let hasVersion = false;
  let requestedCwd: string | undefined;

  function once(key: string): void {
    if (scalarOptions.has(key)) throw new Error(`${key} 不能重复指定`);
    scalarOptions.add(key);
  }

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '--') {
      config.applicationArgs.push(...argv.slice(index + 1));
      break;
    }
    const separatorIndex = argument.indexOf('=');
    const key = separatorIndex < 0 ? argument : argument.slice(0, separatorIndex);
    const inlineValue = separatorIndex < 0 ? undefined : argument.slice(separatorIndex + 1);

    function flag(): void {
      if (inlineValue !== undefined) throw new Error(`${key} 不接受参数值`);
    }

    function value(): string {
      if (inlineValue !== undefined) return requireValue(inlineValue, key);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error(`${key} 缺少参数值；负号开头的值请使用 ${key}=<value>`);
      }
      index++;
      return requireValue(next, key);
    }

    function scalar(): string {
      once(key);
      return value();
    }

    switch (key) {
      case 'run':
      case 'plan':
      case 'help':
      case 'version':
        flag();
        once('命令');
        config.action = key;
        break;
      case '--help':
      case '-h':
        flag();
        hasHelp = true;
        break;
      case '--version':
        flag();
        hasVersion = true;
        break;
      case '--cwd':
        requestedCwd = scalar();
        break;
      case '--tool':
        config.buildTool = buildTool(scalar(), key);
        break;
      case '--module':
        config.module = moduleSelector(scalar(), key);
        break;
      case '--main':
        config.mainClass = mainClass(scalar(), key);
        break;
      case '--jvm-arg':
        config.jvmArgs.push(value());
        break;
      case '--arg':
        config.applicationArgs.push(value());
        break;
      case '--build-arg':
        config.buildArgs.push(value());
        break;
      case '--build':
        config.build = buildStrategy(scalar(), key);
        break;
      case '--include-tests':
        flag();
        once(key);
        config.includeTests = true;
        break;
      case '--java':
        config.javaCommand = scalar();
        break;
      case '--build-command':
        config.buildCommand = scalar();
        break;
      default:
        throw new Error(`未知参数：${argument}；使用 --help 查看帮助`);
    }
  }

  if (requestedCwd !== undefined) config.cwd = resolve(cwd, requestedCwd);
  if (hasHelp) config.action = 'help';
  else if (hasVersion) config.action = 'version';
  if (config.action === 'help' || config.action === 'version') return config;

  const projectConfig = readProjectConfig(config.cwd);
  const result: RunConfig = { ...config, ...projectConfig };
  // 只用显式 CLI 选项覆盖文件配置，避免默认值遮盖用户保存的设置
  const scalarFields = [
    ['--tool', 'buildTool'], ['--module', 'module'], ['--main', 'mainClass'],
    ['--build', 'build'], ['--include-tests', 'includeTests'],
  ] as const;
  for (const [option, field] of scalarFields) {
    if (scalarOptions.has(option)) Object.assign(result, { [field]: config[field] });
  }
  result.jvmArgs = [...(projectConfig.jvmArgs ?? []), ...config.jvmArgs];
  result.applicationArgs = [...(projectConfig.applicationArgs ?? []), ...config.applicationArgs];
  result.buildArgs = [...(projectConfig.buildArgs ?? []), ...config.buildArgs];
  return result;
}
