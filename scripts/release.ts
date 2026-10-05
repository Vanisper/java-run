import { createHash } from 'node:crypto';
import { createReadStream, appendFileSync, readFileSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { platforms, platformFor } from './platforms';

const projectRoot = resolve(import.meta.dir, '..');
const licenseNames = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'];
const repository = 'https://github.com/Vanisper/java-run';

/** 发布版本、预发布标识与需要原生验收的文件集合 */
export interface ReleaseMetadata {
  version: string;
  tag: string;
  prerelease: boolean;
  matrix: { include: { name: string; runner: string; target: string; binary: string; archive: string }[] };
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
      binary: platform.binary, archive: platform.archive,
    })) },
  };
}

/** 为当前版本生成固定下载链接、安装要求和升级说明 */
export function releaseNotes(version: string): string {
  const { tag } = releaseMetadata(version);
  const download = `${repository}/releases/download/${encodeURIComponent(tag)}`;
  const rows = platforms.map(platform => `| ${platform.label} | [${platform.archive}](${download}/${platform.archive}) |`);
  return `## 下载与安装

下载对应系统与处理器的 ZIP 后解压，无需安装 Bun。本机需要满足 Java 项目要求的 JDK；优先使用项目的 Maven / Gradle Wrapper，没有 Wrapper 时需安装对应构建工具。

| 平台 | 下载 |
| --- | --- |
${rows.join('\n')}

每个 ZIP 包含 \`java-run-<平台>/\` 目录，内含 \`java-run\`（Windows 为 \`java-run.exe\`）、\`INSTALL.md\` 和项目许可证。

[SHA256 校验和](${download}/SHA256SUMS) · [安装指南](${repository}/blob/${encodeURIComponent(tag)}/docs/installation.md)

解压后在该目录执行 \`./java-run --version\`，Windows PowerShell 执行 \`.\\java-run.exe --version\`，应输出 \`java-run ${version}\`。按安装指南加入 PATH 后，即可在 Java 项目目录使用 \`java-run\`。

升级时下载新版本的对应 ZIP，校验后用其中的可执行文件替换原文件，再执行 \`java-run --version\` 确认版本。
`;
}

async function assertFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size === 0) throw new Error(`文件不是非空普通文件：${path}`);
}

async function packageDocuments(documentationRoot: string): Promise<{ name: string; source: string }[]> {
  const files = [{ name: 'INSTALL.md', source: resolve(documentationRoot, 'docs/installation.md') }];
  for (const name of licenseNames) {
    const source = resolve(documentationRoot, name);
    try { await lstat(source); files.push({ name, source }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  for (const file of files) await assertFile(file.source);
  return files;
}

function command(program: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync(program, args, { ...options, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`ZIP 操作失败：${result.error?.message ?? (result.stderr.trim() || program)}`);
  }
  return result.stdout;
}

function powershell(script: string, environment: NodeJS.ProcessEnv): string {
  return command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${script}`], {
    env: { ...process.env, ...environment },
  });
}

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** 打包当前平台文件，ZIP 内包含固定目录、安装指南及已有许可证 */
export async function packageRelease(directory: string, platformName: string, documentationRoot = projectRoot): Promise<string> {
  const platform = platformFor(platformName);
  const binary = resolve(directory, platform.binary);
  await assertFile(binary);
  const documents = await packageDocuments(documentationRoot);
  // 与产物共用文件系统，避免 Windows runner 的跨盘 rename 失败
  const temporary = await mkdtemp(resolve(directory, '.java-run-package-'));
  try {
    const folder = join(temporary, platform.folder);
    await mkdir(folder);
    const stagedBinary = join(folder, platform.binary);
    await copyFile(binary, stagedBinary);
    if (process.platform !== 'win32') await chmod(stagedBinary, 0o755);
    for (const file of documents) await copyFile(file.source, join(folder, file.name));
    const archive = join(temporary, platform.archive);
    if (process.platform === 'win32') {
      powershell('Compress-Archive -LiteralPath $env:JAVA_RUN_PACKAGE_SOURCE -DestinationPath $env:JAVA_RUN_PACKAGE_ARCHIVE -CompressionLevel Optimal', {
        JAVA_RUN_PACKAGE_SOURCE: folder, JAVA_RUN_PACKAGE_ARCHIVE: archive,
      });
    } else command('zip', ['-q', '-r', archive, platform.folder], { cwd: temporary });
    const output = resolve(directory, platform.archive);
    await rename(archive, output);
    return output;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** 解包并核对完整文件集合、内容与可执行权限，调用方用完后须 cleanup */
export async function verifyReleasePackage(directory: string, platformName: string, documentationRoot = projectRoot): Promise<{ binary: string; cleanup: () => Promise<void> }> {
  const platform = platformFor(platformName);
  const archive = resolve(directory, platform.archive);
  await assertFile(archive);
  const documents = await packageDocuments(documentationRoot);
  const expected = [platform.binary, ...documents.map(file => file.name)].map(name => `${platform.folder}/${name}`).sort();
  const entries: string[] = process.platform === 'win32'
    ? JSON.parse(powershell("Add-Type -AssemblyName System.IO.Compression.FileSystem; $packageZip = [System.IO.Compression.ZipFile]::OpenRead($env:JAVA_RUN_PACKAGE_ARCHIVE); try { ConvertTo-Json -InputObject @($packageZip.Entries | ForEach-Object { $_.FullName }) -Compress } finally { $packageZip.Dispose() }", { JAVA_RUN_PACKAGE_ARCHIVE: archive }))
    : command('unzip', ['-Z1', archive]).trimEnd().split('\n');
  const normalized = entries.map(entry => entry.replaceAll('\\', '/'));
  if (new Set(normalized).size !== normalized.length
    || JSON.stringify(normalized.filter(entry => entry !== `${platform.folder}/`).sort()) !== JSON.stringify(expected)) {
    throw new Error('ZIP 内容与发布目录契约不一致');
  }
  const temporary = await mkdtemp(join(tmpdir(), 'java-run-unpack-'));
  const cleanup = async () => { await rm(temporary, { recursive: true, force: true }); };
  try {
    if (process.platform === 'win32') {
      powershell('Expand-Archive -LiteralPath $env:JAVA_RUN_PACKAGE_ARCHIVE -DestinationPath $env:JAVA_RUN_PACKAGE_DESTINATION', {
        JAVA_RUN_PACKAGE_ARCHIVE: archive, JAVA_RUN_PACKAGE_DESTINATION: temporary,
      });
    } else command('unzip', ['-q', archive, '-d', temporary]);
    const folder = join(temporary, platform.folder);
    if (!(await lstat(folder)).isDirectory()) throw new Error('ZIP 顶层必须为发布目录');
    const binary = join(folder, platform.binary);
    for (const file of [{ name: platform.binary, source: resolve(directory, platform.binary) }, ...documents]) {
      const unpacked = join(folder, file.name);
      await assertFile(unpacked);
      await assertFile(file.source);
      if (await digest(unpacked) !== await digest(file.source)) throw new Error(`ZIP 文件内容不一致：${file.name}`);
    }
    if (process.platform !== 'win32' && ((await lstat(binary)).mode & 0o111) !== 0o111) {
      throw new Error('ZIP 中的 java-run 未保留可执行权限');
    }
    return { binary, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

/** 公开前核对远端资产，确保草稿只包含已验收文件与校验和 */
export function assertReleaseAssets(assets: unknown, version: string): void {
  const expected = [...releaseMetadata(version).matrix.include.map(platform => platform.archive), 'SHA256SUMS'].sort();
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
  const expected = releaseMetadata(version).matrix.include.map(platform => platform.archive).sort();
  const actual = (await readdir(directory)).filter(file => file !== 'SHA256SUMS').sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`发布产物集合不完整或包含额外文件；应为：${expected.join('、')}`);
  }
  const lines: string[] = [];
  for (const file of expected) {
    const path = resolve(directory, file);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size === 0) throw new Error(`发布产物不是非空普通文件：${file}`);
    lines.push(`${await digest(path)}  ${file}`);
  }
  const manifest = `${lines.join('\n')}\n`;
  await writeFile(resolve(directory, 'SHA256SUMS'), manifest);
  return manifest;
}

async function main(argv: string[]): Promise<void> {
  const version: unknown = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string') throw new Error('package.json 必须包含版本字符串');
  if (argv.length !== (argv[0] === 'package' ? 2 : 1)) throw new Error('用法：bun scripts/release.ts metadata | notes | checksums | verify-assets | package <平台>');
  if (argv[0] === 'metadata') {
    const metadata = releaseMetadata(version, process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined);
    if (process.env.GITHUB_REF_TYPE === 'tag') {
      if (!licenseNames.some(file => {
        try { return readFileSync(resolve(projectRoot, file), 'utf8').trim().length > 0; } catch { return false; }
      })) throw new Error('正式发布需要先补齐 LICENSE 文件');
    }
    console.log(JSON.stringify(metadata, null, 2));
    if (process.env.GITHUB_OUTPUT) {
      const outputs = Object.entries(metadata).map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
      appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
    }
  } else if (argv[0] === 'notes') {
    console.log(releaseNotes(version));
  } else if (argv[0] === 'package') {
    const directory = resolve(projectRoot, 'dist');
    await packageRelease(directory, argv[1]!);
    const unpacked = await verifyReleasePackage(directory, argv[1]!);
    try {
      const result = spawnSync(process.execPath, [resolve(projectRoot, 'scripts/smoke.ts'), `--cli=${unpacked.binary}`, '--suite=quick'], { stdio: 'inherit' });
      if (result.error || result.status !== 0) throw new Error(`解包后的启动验收失败：${result.error?.message ?? result.status}`);
    } finally { await unpacked.cleanup(); }
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
