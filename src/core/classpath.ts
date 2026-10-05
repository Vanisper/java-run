import { existsSync, statSync } from 'node:fs';
import { delimiter, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MavenProject } from './types';

/** 保持 Maven 依赖顺序，只添加选定项目的编译输出 */
export function buildClasspath(project: MavenProject, dependencyText: string, includeTests = false): string[] {
  if (!existsSync(project.outputDirectory)) {
    throw new Error(`找不到编译输出：${project.outputDirectory}，请使用默认自动构建模式准备项目`);
  }
  const outputs = [project.outputDirectory];
  if (includeTests && existsSync(project.testOutputDirectory)) {
    outputs.unshift(project.testOutputDirectory);
  }
  const dependencies = dependencyText.trim().split(delimiter).map(value => value.trim()).filter(Boolean)
    .map(value => resolve(project.directory, value));
  for (const dependency of dependencies) {
    if (!existsSync(dependency)) throw new Error(`依赖文件不存在：${dependency}，请重新准备 Maven 依赖`);
  }
  return Array.from(new Set([...outputs, ...dependencies]));
}

/** 将文件系统路径编码为 Manifest 使用的 URL */
export function classpathUrl(file: string): string {
  const absolute = resolve(file);
  return pathToFileURL(statSync(absolute).isDirectory() && !absolute.endsWith(sep) ? absolute + sep : absolute).href;
}

/** 生成按 UTF-8 字节折行且带终止空行的 Manifest */
export function createManifest(classpath: string[]): string {
  const header = `Class-Path: ${classpath.map(classpathUrl).join(' ')}`;
  const lines: string[] = [];
  let line = '';
  for (const character of header) {
    if (Buffer.byteLength(line + character, 'utf8') > 70) {
      // CRLF 也占用两个字节，后续行的空格占用一个字节
      lines.push(line);
      line = ' ';
    }
    line += character;
  }
  lines.push(line);
  return ['Manifest-Version: 1.0', ...lines, '', ''].join('\r\n');
}
