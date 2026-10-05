import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertReleaseAssets, packageRelease, releaseMetadata, releaseNotes, verifyReleasePackage, writeReleaseChecksums } from '../scripts/release';
import { writeBinaryChecksum } from '../scripts/checksum';

function updateArchive(archive: string, entry: string, content?: string): void {
  const temporary = mkdtempSync(join(tmpdir(), 'java-run-zip-update-'));
  try {
    let result;
    if (process.platform === 'win32') {
      const script = "Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive = [System.IO.Compression.ZipFile]::Open($env:JAVA_RUN_TEST_ARCHIVE, [System.IO.Compression.ZipArchiveMode]::Update); try { $previous = $archive.Entries | Where-Object { $_.FullName.Replace('\\', '/') -eq $env:JAVA_RUN_TEST_ENTRY }; $previous.Delete(); if ($env:JAVA_RUN_TEST_CONTENT) { $entry = $archive.CreateEntry($env:JAVA_RUN_TEST_ENTRY); $stream = $entry.Open(); try { $bytes = [System.Text.Encoding]::UTF8.GetBytes($env:JAVA_RUN_TEST_CONTENT); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() } } } finally { $archive.Dispose() }";
      result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${script}`], {
        env: { ...process.env, JAVA_RUN_TEST_ARCHIVE: archive, JAVA_RUN_TEST_ENTRY: entry, JAVA_RUN_TEST_CONTENT: content ?? '' },
        encoding: 'utf8',
      });
    } else if (content === undefined) {
      result = spawnSync('zip', ['-q', '-d', archive, entry], { encoding: 'utf8' });
    } else {
      mkdirSync(join(temporary, entry, '..'), { recursive: true });
      writeFileSync(join(temporary, entry), content);
      result = spawnSync('zip', ['-q', archive, entry], { cwd: temporary, encoding: 'utf8' });
    }
    if (result.error || result.status !== 0) throw new Error(`修改测试 ZIP 失败：${result.error?.message ?? result.stderr}`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

describe('发布产物契约', () => {
  test('标签必须匹配包版本，稳定版与预发布生成五个独立产物', () => {
    const stable = releaseMetadata('1.2.3', 'v1.2.3');
    expect(stable.prerelease).toBe(false);
    expect(stable.matrix.include).toHaveLength(5);
    expect(new Set(stable.matrix.include.map(platform => platform.archive)).size).toBe(5);
    expect(stable.matrix.include.find(platform => platform.name === 'windows-x64')).toEqual({
      name: 'windows-x64', runner: 'windows-2025', target: 'bun-windows-x64',
      binary: 'java-run.exe', archive: 'java-run-windows-x64.zip',
    });
    expect(releaseMetadata('2.0.0').matrix).toEqual(stable.matrix);
    expect(releaseMetadata('1.2.3-rc.1+build.7').prerelease).toBe(true);
    expect(releaseMetadata('1.2.3+build.7').prerelease).toBe(false);
    expect(() => releaseMetadata('1.2.3', 'v1.2.4')).toThrow('版本不一致');
    for (const invalid of ['v1.2.3', '1.2', '01.2.3', '1.2.3-01', '1.2.3-rc..1', '1.2.3\n']) {
      expect(() => releaseMetadata(invalid)).toThrow('无效的发布版本');
    }
  });

  test('草稿只允许验收过的文件与校验和，旧资产或缺失文件阻止公开', () => {
    const assets = [...releaseMetadata('1.2.3').matrix.include.map(platform => platform.archive), 'SHA256SUMS'];
    expect(() => assertReleaseAssets(assets.toReversed(), '1.2.3')).not.toThrow();
    expect(() => assertReleaseAssets(assets.slice(1), '1.2.3')).toThrow('资产集合');
    expect(() => assertReleaseAssets([...assets, 'java-run'], '1.2.3')).toThrow('资产集合');
    expect(() => assertReleaseAssets([...assets, assets[0]], '1.2.3')).toThrow('资产集合');
    expect(() => assertReleaseAssets({ assets }, '1.2.3')).toThrow('资产集合');
  });

  test('清单覆盖实际五份文件，缺失、多余或空产物不能生成校验和', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'java-run-release-'));
    const files = releaseMetadata('1.2.3').matrix.include.map(platform => platform.archive);
    try {
      writeFileSync(join(directory, 'SHA256SUMS'), 'previous-checksums\n');
      await expect(writeReleaseChecksums(directory, '1.2.3')).rejects.toThrow('产物集合');
      expect(readFileSync(join(directory, 'SHA256SUMS'), 'utf8')).toBe('previous-checksums\n');
      for (const file of files) writeFileSync(join(directory, file), `binary:${file}`);
      writeFileSync(join(directory, 'unexpected-file'), 'extra');
      await expect(writeReleaseChecksums(directory, '1.2.3')).rejects.toThrow('额外文件');
      rmSync(join(directory, 'unexpected-file'));
      writeFileSync(join(directory, files[0]!), '');
      await expect(writeReleaseChecksums(directory, '1.2.3')).rejects.toThrow('非空普通文件');
      writeFileSync(join(directory, files[0]!), `binary:${files[0]}`);
      const manifest = await writeReleaseChecksums(directory, '1.2.3');
      const lines = manifest.trimEnd().split('\n');
      expect(lines).toHaveLength(5);
      for (const file of files) {
        const digest = createHash('sha256').update(readFileSync(join(directory, file))).digest('hex');
        expect(lines).toContain(`${digest}  ${file}`);
      }
      expect(readFileSync(join(directory, 'SHA256SUMS'), 'utf8')).toBe(manifest);
      expect(await writeReleaseChecksums(directory, '1.2.3')).toBe(manifest);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('正文下载链接与固定 ZIP 资产一致，并说明依赖、版本验证和替换升级', () => {
    const notes = releaseNotes('1.2.3-rc.1');
    for (const platform of releaseMetadata('1.2.3-rc.1').matrix.include) {
      expect(notes).toContain(`https://github.com/Vanisper/java-run/releases/download/v1.2.3-rc.1/${platform.archive}`);
    }
    expect(notes).toContain('https://github.com/Vanisper/java-run/releases/download/v1.2.3-rc.1/SHA256SUMS');
    expect(notes).toContain('https://github.com/Vanisper/java-run/blob/v1.2.3-rc.1/docs/installation.md');
    expect(notes).toContain('无需安装 Bun');
    expect(notes).toContain('JDK');
    expect(notes).toContain('Wrapper');
    expect(notes).toContain('java-run 1.2.3-rc.1');
    expect(notes).toContain('替换原文件');
    expect(notes).toContain('包外的 `SHA256SUMS` 用于校验 ZIP');
    expect(notes).toContain('包内的 `.sha256` 文件用于校验解压后的二进制');
    expect(releaseNotes('1.2.3+build.7')).toContain('/download/v1.2.3%2Bbuild.7/');
  });

  test('原生 ZIP 保留完整目录、字节与权限，重打包移除旧文件', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'java-run-release-zip-'));
    const documentation = join(directory, 'project');
    const platform = process.platform === 'win32' ? 'windows-x64' : 'linux-x64';
    const binaryName = process.platform === 'win32' ? 'java-run.exe' : 'java-run';
    const binary = join(directory, binaryName);
    const bytes = '#!/bin/sh\nprintf "release-archive-test\\n"\n';
    mkdirSync(join(documentation, 'docs'), { recursive: true });
    writeFileSync(join(documentation, 'docs/installation.md'), '# 安装指南\n');
    writeFileSync(join(documentation, 'LICENSE'), 'Release package license\n');
    writeFileSync(binary, bytes);
    chmodSync(binary, 0o755);
    try {
      await writeBinaryChecksum(binary);
      const archive = await packageRelease(directory, platform, documentation);
      expect(archive).toBe(join(directory, `java-run-${platform}.zip`));
      const unpacked = await verifyReleasePackage(directory, platform, documentation);
      try {
        expect(unpacked.binary).toEndWith(`/java-run-${platform}/${binaryName}`.replaceAll('/', process.platform === 'win32' ? '\\' : '/'));
        expect(readFileSync(unpacked.binary)).toEqual(Buffer.from(bytes));
        const digest = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
        expect(readFileSync(`${unpacked.binary}.sha256`, 'utf8')).toBe(`${digest}  ${binaryName}\n`);
        expect(readFileSync(`${unpacked.binary}.sha256`)).toEqual(readFileSync(`${binary}.sha256`));
        expect(readFileSync(join(unpacked.binary, '..', 'INSTALL.md'), 'utf8')).toBe('# 安装指南\n');
        expect(readFileSync(join(unpacked.binary, '..', 'LICENSE'), 'utf8')).toBe('Release package license\n');
        if (process.platform !== 'win32') {
          expect(statSync(unpacked.binary).mode & 0o111).toBe(0o111);
          const execution = spawnSync(unpacked.binary, [], { encoding: 'utf8' });
          expect(execution.status).toBe(0);
          expect(execution.stdout).toBe('release-archive-test\n');
        }
      } finally { await unpacked.cleanup(); }
      expect(existsSync(unpacked.binary)).toBe(false);
      rmSync(join(documentation, 'LICENSE'));
      await expect(verifyReleasePackage(directory, platform, documentation)).rejects.toThrow('ZIP 内容');
      writeFileSync(binary, `${bytes}# replacement\n`);
      await expect(packageRelease(directory, platform, documentation)).rejects.toThrow();
      await writeBinaryChecksum(binary);
      await packageRelease(directory, platform, documentation);
      const replacement = await verifyReleasePackage(directory, platform, documentation);
      try {
        expect(readFileSync(replacement.binary, 'utf8')).toBe(`${bytes}# replacement\n`);
        expect(existsSync(join(replacement.binary, '..', 'LICENSE'))).toBe(false);
      } finally { await replacement.cleanup(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30000);

  test('缺少安装指南、ZIP 损坏或打包后字节发生变化时验收失败', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'java-run-release-invalid-'));
    const documentation = join(directory, 'project');
    const platform = process.platform === 'win32' ? 'windows-x64' : 'linux-x64';
    const binaryName = process.platform === 'win32' ? 'java-run.exe' : 'java-run';
    mkdirSync(join(documentation, 'docs'), { recursive: true });
    writeFileSync(join(directory, binaryName), 'binary');
    try {
      await writeBinaryChecksum(join(directory, binaryName));
      await expect(packageRelease(directory, platform, documentation)).rejects.toThrow();
      expect(existsSync(join(directory, `java-run-${platform}.zip`))).toBe(false);
      writeFileSync(join(documentation, 'docs/installation.md'), 'Installation instructions\n');
      await expect(packageRelease(directory, 'unknown-platform', documentation)).rejects.toThrow('不支持的发布平台');
      await packageRelease(directory, platform, documentation);
      writeFileSync(join(directory, binaryName), 'changed binary');
      await expect(verifyReleasePackage(directory, platform, documentation)).rejects.toThrow('文件内容不一致');
      writeFileSync(join(directory, `java-run-${platform}.zip`), 'not a ZIP');
      await expect(verifyReleasePackage(directory, platform, documentation)).rejects.toThrow('ZIP 操作失败');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30000);

  test('二进制校验文件必须存在且有效，ZIP 缺失或替换校验文件时拒绝验收', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'java-run-release-checksum-'));
    const documentation = join(directory, 'project');
    const platform = process.platform === 'win32' ? 'windows-x64' : 'linux-x64';
    const binaryName = process.platform === 'win32' ? 'java-run.exe' : 'java-run';
    const binary = join(directory, binaryName);
    const checksum = `${binary}.sha256`;
    const entry = `java-run-${platform}/${binaryName}.sha256`;
    mkdirSync(join(documentation, 'docs'), { recursive: true });
    writeFileSync(join(documentation, 'docs/installation.md'), 'Installation instructions\n');
    writeFileSync(binary, 'binary');
    try {
      await expect(packageRelease(directory, platform, documentation)).rejects.toThrow();
      expect(existsSync(join(directory, `java-run-${platform}.zip`))).toBe(false);
      writeFileSync(checksum, `${'0'.repeat(64)}  ${binaryName}\n`);
      await expect(packageRelease(directory, platform, documentation)).rejects.toThrow();
      await writeBinaryChecksum(binary);
      const archive = await packageRelease(directory, platform, documentation);
      updateArchive(archive, entry);
      await expect(verifyReleasePackage(directory, platform, documentation)).rejects.toThrow('ZIP 内容');
      await packageRelease(directory, platform, documentation);
      const changed = `${'0'.repeat(64)}  ${binaryName}\n`;
      updateArchive(archive, entry, changed);
      await expect(verifyReleasePackage(directory, platform, documentation)).rejects.toThrow('文件内容不一致');
      writeFileSync(checksum, changed);
      await expect(verifyReleasePackage(directory, platform, documentation)).rejects.toThrow();
      await writeBinaryChecksum(binary);
      await expect(verifyReleasePackage(directory, platform, documentation)).rejects.toThrow('文件内容不一致');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30000);
});
