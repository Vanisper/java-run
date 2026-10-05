import { createHash } from 'node:crypto';
import { createReadStream, appendFileSync, readFileSync } from 'node:fs';
import { lstat, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dir, '..');
const platforms = [
  { name: 'windows-x64-baseline', runner: 'windows-2025', target: 'bun-windows-x64-baseline', extension: '.exe' },
  { name: 'linux-x64-baseline', runner: 'ubuntu-24.04', target: 'bun-linux-x64-baseline', extension: '' },
  { name: 'linux-arm64', runner: 'ubuntu-24.04-arm', target: 'bun-linux-arm64', extension: '' },
  { name: 'darwin-arm64', runner: 'macos-15', target: 'bun-darwin-arm64', extension: '' },
  { name: 'darwin-x64', runner: 'macos-15-intel', target: 'bun-darwin-x64', extension: '' },
] as const;

/** 发布版本、预发布标识与需要原生验收的文件集合 */
export interface ReleaseMetadata {
  version: string;
  tag: string;
  prerelease: boolean;
  matrix: { include: { name: string; runner: string; target: string; file: string }[] };
}

/** 校验 SemVer 和可选标签，生成唯一的发布文件清单 */
export function releaseMetadata(version: string, requestedTag?: string): ReleaseMetadata {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match || match[0] !== version || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    throw new Error(`无效的发布版本：${version}`);
  }
  const tag = `v${version}`;
  if (requestedTag !== undefined && requestedTag !== tag) {
    throw new Error(`发布标签 ${requestedTag} 与 package.json 版本不一致，应为 ${tag}`);
  }
  return {
    version, tag, prerelease: match[4] !== undefined,
    matrix: { include: platforms.map(platform => ({
      name: platform.name, runner: platform.runner, target: platform.target,
      file: `java-run-${platform.name}-${tag}${platform.extension}`,
    })) },
  };
}

/** 公开前核对远端资产，确保草稿只包含已验收文件与校验和 */
export function assertReleaseAssets(assets: unknown, version: string): void {
  const expected = [...releaseMetadata(version).matrix.include.map(platform => platform.file), 'SHA256SUMS'].sort();
  if (!Array.isArray(assets) || !assets.every(asset => typeof asset === 'string')
    || JSON.stringify([...assets].sort()) !== JSON.stringify(expected)) {
    throw new Error('Release 资产集合与已验收文件不一致，请检查草稿中的缺失或额外资产');
  }
}

/**
 * 为完整的已验收产物集合生成 SHA256SUMS
 *
 * @description 缺失、多余、空文件或非普通文件均失败；允许重新生成已有清单，校验通过前不覆盖它
 */
export async function writeReleaseChecksums(directory: string, version: string): Promise<string> {
  const expected = releaseMetadata(version).matrix.include.map(platform => platform.file).sort();
  const actual = (await readdir(directory)).filter(file => file !== 'SHA256SUMS').sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`发布产物集合不完整或包含额外文件；应为：${expected.join('、')}`);
  }
  const lines: string[] = [];
  for (const file of expected) {
    const path = resolve(directory, file);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size === 0) throw new Error(`发布产物不是非空普通文件：${file}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    lines.push(`${hash.digest('hex')}  ${file}`);
  }
  const manifest = `${lines.join('\n')}\n`;
  await writeFile(resolve(directory, 'SHA256SUMS'), manifest);
  return manifest;
}

async function main(argv: string[]): Promise<void> {
  const version: unknown = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string') throw new Error('package.json 必须包含版本字符串');
  if (argv.length !== 1) throw new Error('用法：bun scripts/release.ts metadata | checksums | verify-assets');
  if (argv[0] === 'metadata') {
    const metadata = releaseMetadata(version, process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined);
    if (process.env.GITHUB_REF_TYPE === 'tag') {
      const licenses = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'];
      if (!licenses.some(file => {
        try { return readFileSync(resolve(projectRoot, file), 'utf8').trim().length > 0; } catch { return false; }
      })) throw new Error('正式发布需要先补齐 LICENSE 文件');
    }
    console.log(JSON.stringify(metadata, null, 2));
    if (process.env.GITHUB_OUTPUT) {
      const outputs = Object.entries(metadata).map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
      appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
    }
  } else if (argv[0] === 'checksums') {
    console.log(await writeReleaseChecksums(resolve(projectRoot, 'dist'), version));
  } else if (argv[0] === 'verify-assets') {
    assertReleaseAssets(await Bun.stdin.json(), version);
    console.log('Release 资产集合已核对');
  } else throw new Error(`未知发布步骤：${argv[0]}`);
}

if (import.meta.main) {
  try { await main(Bun.argv.slice(2)); }
  catch (error) {
    console.error(`java-run：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
