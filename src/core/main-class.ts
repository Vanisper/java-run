import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 读取 class 文件的方法表，只识别传统 public static main(String[]) */
export function hasMainMethod(data: Buffer): boolean {
  try {
    let offset = 0;
    const u1 = () => data.readUInt8(offset++);
    const u2 = () => { const value = data.readUInt16BE(offset); offset += 2; return value; };
    const u4 = () => { const value = data.readUInt32BE(offset); offset += 4; return value; };
    if (u4() !== 0xcafebabe) return false;
    offset += 4;
    const count = u2();
    const strings = new Map<number, string>();
    for (let index = 1; index < count; index++) {
      const tag = u1();
      switch (tag) {
        case 1: { const length = u2(); strings.set(index, data.toString('utf8', offset, offset + length)); offset += length; break; }
        case 3: case 4: case 9: case 10: case 11: case 12: case 17: case 18: offset += 4; break;
        case 5: case 6: offset += 8; index++; break;
        case 7: case 8: case 16: case 19: case 20: offset += 2; break;
        case 15: offset += 3; break;
        default: return false;
      }
    }
    offset += 6;
    const interfaces = u2();
    offset += interfaces * 2;
    const skipAttributes = () => {
      const length = u2();
      for (let index = 0; index < length; index++) { u2(); const size = u4(); offset += size; }
    };
    const fields = u2();
    for (let index = 0; index < fields; index++) { offset += 6; skipAttributes(); }
    const methods = u2();
    for (let index = 0; index < methods; index++) {
      const flags = u2();
      const name = strings.get(u2());
      const descriptor = strings.get(u2());
      if ((flags & 0x0009) === 0x0009 && name === 'main' && descriptor === '([Ljava/lang/String;)V') return true;
      skipAttributes();
    }
    return false;
  } catch {
    return false;
  }
}

/** 列出目标项目编译输出中的传统 Java 主类 */
export function findMainClasses(directories: string[]): string[] {
  const candidates = new Set<string>();
  const walk = (root: string, relative = '') => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) walk(root, path);
      else if (entry.isFile() && entry.name.endsWith('.class') && hasMainMethod(readFileSync(join(root, path)))) {
        candidates.add(path.slice(0, -6).replace(/[\\/]/g, '.'));
      }
    }
  };
  for (const directory of directories) walk(directory);
  return [...candidates].sort();
}

/**
 * 从多个已确认入口中选择一个主类
 *
 * @description candidates 至少包含两个按类名排序的入口；返回其中一个，选择失败时抛出的错误原样传递
 */
export type MainClassSelector = (candidates: readonly string[]) => Promise<string>;

/**
 * 在目标项目输出中解析主类
 *
 * @description 唯一入口直接采用；多个入口时调用 select，未提供时抛出含候选列表的错误
 */
export async function discoverMainClass(directories: string[], select?: MainClassSelector): Promise<string> {
  const choices = findMainClasses(directories);
  if (choices.length === 1) return choices[0]!;
  if (!choices.length) throw new Error('目标项目中未找到 public static main(String[])，请检查构建产物或用 --main 指定入口');
  if (select) return select(choices);
  throw new Error(`目标项目有多个主类，请使用 --main 指定：\n${choices.map(name => `  ${name}`).join('\n')}`);
}
