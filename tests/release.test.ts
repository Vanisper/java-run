import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertReleaseAssets, releaseMetadata, writeReleaseChecksums } from '../scripts/release';

describe('发布产物契约', () => {
  test('标签必须匹配包版本，稳定版与预发布生成五个独立产物', () => {
    const stable = releaseMetadata('1.2.3', 'v1.2.3');
    expect(stable.prerelease).toBe(false);
    expect(stable.matrix.include).toHaveLength(5);
    expect(new Set(stable.matrix.include.map(platform => platform.file)).size).toBe(5);
    expect(stable.matrix.include.find(platform => platform.name === 'windows-x64-baseline')?.file)
      .toBe('java-run-windows-x64-baseline-v1.2.3.exe');
    expect(releaseMetadata('1.2.3-rc.1+build.7').prerelease).toBe(true);
    expect(releaseMetadata('1.2.3+build.7').prerelease).toBe(false);
    expect(() => releaseMetadata('1.2.3', 'v1.2.4')).toThrow('版本不一致');
    for (const invalid of ['v1.2.3', '1.2', '01.2.3', '1.2.3-01', '1.2.3-rc..1', '1.2.3\n']) {
      expect(() => releaseMetadata(invalid)).toThrow('无效的发布版本');
    }
  });

  test('草稿只允许验收过的文件与校验和，旧资产或缺失文件阻止公开', () => {
    const assets = [...releaseMetadata('1.2.3').matrix.include.map(platform => platform.file), 'SHA256SUMS'];
    expect(() => assertReleaseAssets(assets.toReversed(), '1.2.3')).not.toThrow();
    expect(() => assertReleaseAssets(assets.slice(1), '1.2.3')).toThrow('资产集合');
    expect(() => assertReleaseAssets([...assets, 'old-binary'], '1.2.3')).toThrow('资产集合');
    expect(() => assertReleaseAssets([...assets, assets[0]], '1.2.3')).toThrow('资产集合');
    expect(() => assertReleaseAssets({ assets }, '1.2.3')).toThrow('资产集合');
  });

  test('清单覆盖实际五份文件，缺失、多余或空产物不能生成校验和', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'java-run-release-'));
    const files = releaseMetadata('1.2.3').matrix.include.map(platform => platform.file);
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
});
