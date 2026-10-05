import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseCompileOptions } from '../scripts/compile';
import { version } from '../package.json';

const compileScript = resolve(import.meta.dir, '../scripts/compile.ts');

describe('独立二进制构建', () => {
  test('本机输出与五个平台选项使用同一入口，拒绝未知、重复和无效选项', () => {
    const root = resolve('compile-workspace');
    expect(parseCompileOptions([], root)).toEqual({ outfile: join(root, 'dist/java-run') });
    for (const target of [
      'bun-windows-x64-baseline', 'bun-linux-x64-baseline', 'bun-linux-arm64', 'bun-darwin-arm64', 'bun-darwin-x64',
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

  test('实际二进制忽略 cwd 的 dotenv 和 bunfig，保留显式继承的环境及完整版本', () => {
    const root = mkdtempSync(join(tmpdir(), 'java-run-compile-'));
    try {
      const executable = join(root, process.platform === 'win32' ? 'java-run.exe' : 'java-run');
      const compiled = spawnSync(process.execPath, [compileScript, `--outfile=${executable}`], { encoding: 'utf8' });
      expect(compiled.status).toBe(0);
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
});
