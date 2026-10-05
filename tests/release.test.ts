import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertReleaseAssets, packageRelease, releaseMetadata, releaseNotes, verifyReleasePackage, writeReleaseChecksums } from '../scripts/release';

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
      const archive = await packageRelease(directory, platform, documentation);
      expect(archive).toBe(join(directory, `java-run-${platform}.zip`));
      const unpacked = await verifyReleasePackage(directory, platform, documentation);
      try {
        expect(unpacked.binary).toEndWith(`/java-run-${platform}/${binaryName}`.replaceAll('/', process.platform === 'win32' ? '\\' : '/'));
        expect(readFileSync(unpacked.binary)).toEqual(Buffer.from(bytes));
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
});
