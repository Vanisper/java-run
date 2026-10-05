import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { sha256, verifyBinaryChecksum, writeBinaryChecksum } from '../scripts/checksum';
import { parseCompileOptions } from '../scripts/compile';
import { version } from '../package.json';

const compileScript = resolve(import.meta.dir, '../scripts/compile.ts');

describe('独立二进制构建', () => {
  test('本机输出与五个平台选项使用同一入口，拒绝未知、重复和无效选项', () => {
    const root = resolve('compile-workspace');
    expect(parseCompileOptions([], root)).toEqual({ outfile: join(root, 'dist/java-run') });
    for (const target of [
      'bun-windows-x64', 'bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-arm64', 'bun-darwin-x64',
    ] as const) {
      expect(parseCompileOptions([`--target=${target}`, '--outfile=dist/custom app=a'], root))
        .toEqual({ target, outfile: join(root, 'dist/custom app=a') });
    }
    for (const args of [
      ['--minify'], ['--target'], ['--target=unknown'], ['--target= bun-linux-arm64'],
      ['--target=bun-linux-arm64', '--target=bun-darwin-arm64'],
      ['--outfile='], ['--outfile= '], ['--outfile=a', '--outfile=b'], ['--outfile=a\0b'], ['--outfile=a\nb'],
    ]) expect(() => parseCompileOptions(args, root)).toThrow();
  });

  test('实际构建生成并更新文件名对应的校验和，二进制保留环境与版本契约', async () => {
    const root = mkdtempSync(join(tmpdir(), 'java-run-compile-'));
    try {
      const outfile = join(root, 'custom app=a');
      const executable = process.platform === 'win32' ? `${outfile}.exe` : outfile;
      const compiled = spawnSync(process.execPath, [compileScript, `--outfile=${outfile}`], { encoding: 'utf8' });
      expect(compiled.status).toBe(0);
      const sidecar = `${executable}.sha256`;
      const digest = createHash('sha256').update(readFileSync(executable)).digest('hex');
      expect(readFileSync(sidecar, 'utf8')).toBe(`${digest}  ${basename(executable)}\n`);
      expect(await verifyBinaryChecksum(executable)).toBe(sidecar);
      writeFileSync(sidecar, `${'0'.repeat(64)}  old-filename\n`);
      const recompiled = spawnSync(process.execPath, [compileScript, `--outfile=${outfile}`], { encoding: 'utf8' });
      expect(recompiled.status).toBe(0);
      expect(await verifyBinaryChecksum(executable)).toBe(sidecar);
      const dotenvRoot = 'JAVA_RUN_UNEXPECTED_DOTENV_ROOT';
      writeFileSync(join(root, '.env'), `TMPDIR=${dotenvRoot}\nTEMP=${dotenvRoot}\nTMP=${dotenvRoot}\n`);
      writeFileSync(join(root, 'bunfig.toml'), 'this is not valid TOML = [');
      writeFileSync(join(root, 'pom.xml'), '<project/>');
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (['tmpdir', 'temp', 'tmp'].includes(key.toLowerCase())) delete env[key];
      }
      const binaryVersion = spawnSync(executable, ['version'], { cwd: root, env, encoding: 'utf8' });
      expect(binaryVersion.status).toBe(0);
      expect(binaryVersion.stdout).toBe(`java-run ${version}\n`);
      expect(binaryVersion.stderr).toBe('');
      const preview = spawnSync(executable, ['plan'], { cwd: root, env, encoding: 'utf8' });
      expect(preview.status).toBe(0);
      expect(preview.stdout).not.toContain(dotenvRoot);
      const inheritedRoot = join(root, 'inherited-temporary-directory');
      mkdirSync(inheritedRoot);
      const inherited = spawnSync(executable, ['plan'], {
        cwd: root, env: { ...env, TMPDIR: inheritedRoot, TEMP: inheritedRoot, TMP: inheritedRoot }, encoding: 'utf8',
      });
      expect(inherited.status).toBe(0);
      const metadata = JSON.parse(inherited.stdout);
      expect(metadata.commands[1].args).toContain(`-Doutput=${join(inheritedRoot, '<java-run-workspace>', 'project-file.txt')}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test('参数错误保留已有输出，编译失败清除旧校验和并保留原输出', () => {
    const root = mkdtempSync(join(tmpdir(), 'java-run-compile-failure-'));
    try {
      const outfile = join(root, 'blocked');
      const executable = process.platform === 'win32' ? `${outfile}.exe` : outfile;
      const sidecar = `${executable}.sha256`;
      const scripts = join(root, 'scripts');
      mkdirSync(scripts);
      for (const name of ['compile.ts', 'checksum.ts', 'platforms.ts']) {
        copyFileSync(resolve(import.meta.dir, `../scripts/${name}`), join(scripts, name));
      }
      const brokenCompile = join(scripts, 'compile.ts');
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/cli.ts'), 'export const = invalid source');
      writeFileSync(executable, 'previous binary');
      writeFileSync(sidecar, 'previous checksum\n');
      const invalid = spawnSync(process.execPath, [brokenCompile, `--outfile=${outfile}`, '--unknown'], { encoding: 'utf8' });
      expect(invalid.status).not.toBe(0);
      expect(readFileSync(sidecar, 'utf8')).toBe('previous checksum\n');
      const failed = spawnSync(process.execPath, [brokenCompile, `--outfile=${outfile}`], { encoding: 'utf8' });
      expect(failed.status).not.toBe(0);
      expect(existsSync(sidecar)).toBe(false);
      expect(readFileSync(executable, 'utf8')).toBe('previous binary');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30000);

  test('校验拒绝过期摘要、其他文件名、格式错误及无效文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'java-run-checksum-'));
    try {
      const executable = join(root, 'custom app=a');
      const sidecar = `${executable}.sha256`;
      writeFileSync(executable, 'binary version one');
      await expect(verifyBinaryChecksum(executable)).rejects.toThrow();
      expect(await writeBinaryChecksum(executable)).toBe(sidecar);
      expect(await verifyBinaryChecksum(executable)).toBe(sidecar);
      const content = readFileSync(sidecar, 'utf8');
      writeFileSync(executable, 'binary version two');
      await expect(verifyBinaryChecksum(executable)).rejects.toThrow();
      writeFileSync(executable, 'binary version one');
      for (const invalid of [content.replace('custom app=a', 'another-file'), content.trimEnd(), `${content}extra\n`, '']) {
        writeFileSync(sidecar, invalid);
        await expect(verifyBinaryChecksum(executable)).rejects.toThrow();
      }
      rmSync(sidecar);
      mkdirSync(sidecar);
      await expect(verifyBinaryChecksum(executable)).rejects.toThrow();
      rmSync(sidecar, { recursive: true });
      writeFileSync(executable, '');
      await expect(writeBinaryChecksum(executable)).rejects.toThrow();
      await expect(sha256(root)).rejects.toThrow();
      if (process.platform !== 'win32') {
        const linked = join(root, 'linked');
        writeFileSync(executable, 'valid binary');
        symlinkSync(executable, linked);
        await expect(sha256(linked)).rejects.toThrow();
        symlinkSync(executable, sidecar);
        await expect(verifyBinaryChecksum(executable)).rejects.toThrow();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test.skipIf(process.platform === 'win32')('反斜杠文件名使用 GNU 校验和转义格式', async () => {
    const root = mkdtempSync(join(tmpdir(), 'java-run-checksum-escape-'));
    try {
      const executable = join(root, 'custom\\app');
      writeFileSync(executable, 'binary');
      const sidecar = await writeBinaryChecksum(executable);
      const digest = createHash('sha256').update('binary').digest('hex');
      expect(readFileSync(sidecar, 'utf8')).toBe(`\\${digest}  custom\\\\app\n`);
      expect(await verifyBinaryChecksum(executable)).toBe(sidecar);
      const verified = process.platform === 'darwin'
        ? spawnSync('shasum', ['-a', '256', '-c', basename(sidecar)], { cwd: root, encoding: 'utf8' })
        : spawnSync('sha256sum', ['-c', basename(sidecar)], { cwd: root, encoding: 'utf8' });
      expect(verified.status).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
