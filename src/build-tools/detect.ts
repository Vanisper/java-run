import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RunConfig } from '../core/types';

/** 根据构建文件选择适配器，双工具工作区必须显式选择 */
export function detectBuildTool(config: RunConfig): 'maven' | 'gradle' {
  const hasMaven = existsSync(join(config.cwd, 'pom.xml'));
  const hasGradle = ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'].some(name => existsSync(join(config.cwd, name)));
  if (config.buildTool === 'maven' && !hasMaven) throw new Error(`目录中没有 pom.xml：${config.cwd}`);
  if (config.buildTool === 'gradle' && !hasGradle) throw new Error(`目录中没有 Gradle 构建文件：${config.cwd}`);
  if (config.buildTool !== 'auto') return config.buildTool;
  if (hasMaven && hasGradle) throw new Error('目录同时包含 Maven 和 Gradle 构建，请通过 --tool 指定使用的工具');
  if (hasMaven) return 'maven';
  if (hasGradle) return 'gradle';
  throw new Error(`没有发现 Maven 或 Gradle 项目：${config.cwd}，请使用 --cwd 指定源码工作区`);
}
