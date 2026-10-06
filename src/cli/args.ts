import { resolve } from 'node:path';
import type { RunConfig } from '../core/types';
import type { TerminalPreferences } from '../terminal/policy';
import { buildStrategy, buildTool, mainClass, moduleSelector, readProjectConfig } from './config';

/** CLI 解析结果，包含不写入项目配置的终端偏好与覆盖确认开关 */
export interface CliConfig extends RunConfig {
  force: boolean;
  terminal: TerminalPreferences;
}

function requireValue(value: unknown, option: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${option} 必须是非空字符串`);
  return value;
}

/**
 * 解析启动参数并合并项目根目录下的 .java-run.json
 *
 * @description
 * - argv 不包含运行时和脚本路径，通常由 process.argv.slice(2) 提供
 * - 默认执行 run；init、help 和 version 只解析参数，不读取项目配置
 * - CLI 标量覆盖配置，数组在配置之后追加，-- 后的参数全部传给应用
 * - --cwd 相对 cwd 解析，只读取最终目录中的配置，不向父目录查找
 * - 未知选项、重复标量、无效值或配置抛出 Error，不执行外部命令
 */
export function parseArgs(argv: string[], cwd = process.cwd()): CliConfig {
  const config: CliConfig = {
    action: 'run',
    force: false,
    terminal: {},
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
      case 'init':
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
      case '--force':
        flag();
        once(key);
        config.force = true;
        break;
      case '--log': {
        const mode = scalar();
        if (mode !== 'summary' && mode !== 'full') throw new Error('--log 仅支持 summary 或 full');
        config.terminal.logMode = mode;
        break;
      }
      case '--plain':
      case '--no-interactive':
      case '--no-animation':
        flag();
        once(key);
        if (key === '--plain') config.terminal.plain = true;
        else if (key === '--no-interactive') config.terminal.interactive = false;
        else config.terminal.animation = false;
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

  if (config.force && config.action !== 'init') throw new Error('--force 仅允许用于 init 命令');
  if (requestedCwd !== undefined) config.cwd = resolve(cwd, requestedCwd);
  if (hasHelp) config.action = 'help';
  else if (hasVersion) config.action = 'version';
  if (config.action === 'init' || config.action === 'help' || config.action === 'version') return config;

  const projectConfig = readProjectConfig(config.cwd);
  const result: CliConfig = { ...config, ...projectConfig };
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
