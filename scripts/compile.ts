import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeBinaryChecksum } from './checksum';
import { platforms, type BuildTarget } from './platforms';

const projectRoot = resolve(import.meta.dir, '..');

/** 本机或指定平台的独立二进制构建配置 */
export interface CompileOptions {
  target?: BuildTarget;
  outfile: string;
}

/**
 * 解析编译入口的选项
 *
 * @description 仅接受 --target 和 --outfile 的等号形式；相对输出路径以 cwd 为基准，默认为 dist/java-run
 */
export function parseCompileOptions(argv: readonly string[], cwd = projectRoot): CompileOptions {
  const options: CompileOptions = { outfile: resolve(cwd, 'dist/java-run') };
  const specified = new Set<string>();
  for (const argument of argv) {
    const separator = argument.indexOf('=');
    const name = separator < 0 ? argument : argument.slice(0, separator);
    if (name !== '--target' && name !== '--outfile') throw new Error(`未知编译参数：${argument}`);
    if (specified.has(name)) throw new Error(`${name} 不能重复指定`);
    specified.add(name);
    const value = separator < 0 ? '' : argument.slice(separator + 1);
    if (!value.trim() || /[\r\n\0]/.test(value)) throw new Error(`${name} 必须使用 ${name}=<value> 指定有效值`);
    if (name === '--target') {
      const platform = platforms.find(platform => platform.target === value);
      if (!platform) throw new Error(`--target 仅支持 ${platforms.map(platform => platform.target).join('、')}`);
      options.target = platform.target;
    } else {
      options.outfile = resolve(cwd, value);
    }
  }
  return options;
}

/** 编译独立二进制及校验和，构建失败保留 Bun 的退出码 */
async function main(argv: string[]): Promise<number> {
  const options = parseCompileOptions(argv);
  const windows = options.target ? options.target.startsWith('bun-windows-') : process.platform === 'win32';
  const binary = windows && !options.outfile.endsWith('.exe') ? `${options.outfile}.exe` : options.outfile;
  await rm(`${binary}.sha256`, { force: true });
  const args = [
    'build', resolve(projectRoot, 'src/cli.ts'), '--compile', '--minify', '--sourcemap',
    '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
    `--outfile=${options.outfile}`,
  ];
  if (options.target) args.push(`--target=${options.target}`);
  const result = spawnSync(process.execPath, args, { cwd: projectRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (status === 0) await writeBinaryChecksum(binary);
  return status;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(`java-run：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
