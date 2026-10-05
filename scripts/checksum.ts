import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

async function assertFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size === 0) throw new Error(`文件不是非空普通文件：${path}`);
}

/** 流式计算非空普通文件的 SHA-256，拒绝符号链接 */
export async function sha256(path: string): Promise<string> {
  await assertFile(path);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function checksumLine(binary: string, digest: string): string {
  const name = basename(binary);
  if (/[\r\n]/.test(name)) throw new Error('二进制文件名不能包含换行');
  // GNU 校验和对含反斜杠的文件名使用转义行前缀
  return name.includes('\\') ? `\\${digest}  ${name.replaceAll('\\', '\\\\')}\n` : `${digest}  ${name}\n`;
}

/** 原子写入二进制旁的 .sha256，清单只引用同目录文件名 */
export async function writeBinaryChecksum(binary: string): Promise<string> {
  const sidecar = `${binary}.sha256`;
  const content = checksumLine(binary, await sha256(binary));
  const temporary = `${sidecar}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    await rename(temporary, sidecar);
    return sidecar;
  } finally { await rm(temporary, { force: true }); }
}

/** 核对二进制、文件名与旁边的 .sha256；缺失、过期或格式不符时失败 */
export async function verifyBinaryChecksum(binary: string): Promise<string> {
  const sidecar = `${binary}.sha256`;
  await assertFile(sidecar);
  const content = await readFile(sidecar, 'utf8');
  if (content !== checksumLine(binary, await sha256(binary))) {
    throw new Error(`二进制校验和或文件名不一致：${basename(sidecar)}`);
  }
  return sidecar;
}
