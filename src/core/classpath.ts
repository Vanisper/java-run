import { statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

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
