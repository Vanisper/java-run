import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isJavaClassName } from '../core/java-class';
import type { RunConfig } from '../core/types';

/** 可以保存到项目根目录 .java-run.json 的启动设置 */
export type ProjectConfig = Partial<Pick<RunConfig,
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

/** 验证并去除单个构建模块选择器的首尾空白 */
export function moduleSelector(value: unknown, option: string): string {
  const selector = requireValue(value, option).trim();
  if (selector.includes(',') || /^[!\-?]/.test(selector)) {
    throw new Error(`${option} 必须指定单个模块，不能多选、排除或使用可选选择器`);
  }
  return selector;
}

/** 验证 Java 主类全名，无效时抛出包含选项名称的错误 */
export function mainClass(value: unknown, option: string): string {
  const name = requireValue(value, option);
  if (!isJavaClassName(name)) throw new Error(`${option} 必须是有效的 Java 类全名`);
  return name;
}

/** 验证构建工具选项，无效时抛出包含选项名称的错误 */
export function buildTool(value: unknown, option: string): RunConfig['buildTool'] {
  if (value !== 'auto' && value !== 'maven' && value !== 'gradle') {
    throw new Error(`${option} 仅支持 auto、maven 或 gradle`);
  }
  return value;
}

/** 验证构建策略选项，无效时抛出包含选项名称的错误 */
export function buildStrategy(value: unknown, option: string): RunConfig['build'] {
  if (value !== 'auto' && value !== 'none') throw new Error(`${option} 仅支持 auto 或 none`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组`);
  return value.map(item => {
    if (field === 'applicationArgs') {
      if (typeof item !== 'string') throw new Error(`${field} 必须是字符串数组`);
      return item;
    }
    return requireValue(item, field);
  });
}

/** 验证项目配置对象，拒绝未知字段和无效值并返回独立数组 */
export function parseProjectConfig(data: unknown): ProjectConfig {
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
}

/** 读取指定目录中的项目配置；文件不存在时返回空配置，其余读取或格式错误抛出 Error */
export function readProjectConfig(cwd: string): ProjectConfig {
  const path = resolve(cwd, '.java-run.json');
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
    throw new Error(`无法读取配置 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return parseProjectConfig(JSON.parse(source));
  } catch (error) {
    throw new Error(`配置无效 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 将已选定的启动设置转换为可保存的项目配置
 *
 * @description 始终保存实际构建工具和主类，省略空数组及默认构建策略，不保存 CLI 工具路径或命令状态
 */
export function toProjectConfig(
  config: RunConfig,
  tool: 'maven' | 'gradle',
  resolvedMain: string,
): ProjectConfig {
  const result: ProjectConfig = { buildTool: tool, mainClass: resolvedMain };
  if (config.module !== undefined) result.module = config.module;
  if (config.jvmArgs.length) result.jvmArgs = config.jvmArgs;
  if (config.applicationArgs.length) result.applicationArgs = config.applicationArgs;
  if (config.buildArgs.length) result.buildArgs = config.buildArgs;
  if (config.build !== 'auto') result.build = config.build;
  if (config.includeTests) result.includeTests = true;
  return parseProjectConfig(result);
}
