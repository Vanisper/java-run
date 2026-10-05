import { isAbsolute } from 'node:path';
import iconv from 'iconv-lite';
import { CommandError, runCommand } from './exec';

const javaEncodings = new Map<string, string>();

/** 读取真实 JDK 的原生编码，检测失败时保留命令诊断 */
export async function readJavaNativeEncoding(javaCommand: string, cwd: string): Promise<string> {
  const cached = isAbsolute(javaCommand) ? javaEncodings.get(javaCommand) : undefined;
  if (cached) return cached;
  const spec = { command: javaCommand, args: ['-XshowSettings:properties', '-version'], cwd, stage: '检测 Java 原生命令行编码' };
  const result = await runCommand(spec, { capture: true });
  if (result.exitCode !== 0) throw new CommandError(spec, result);
  const properties = `${result.stdout}\n${result.stderr}`;
  const encoding = /^\s*native\.encoding\s*=\s*(\S+)\s*$/m.exec(properties)?.[1]
    ?? /^\s*sun\.jnu\.encoding\s*=\s*(\S+)\s*$/m.exec(properties)?.[1];
  if (!encoding) throw new Error('JDK 未报告 native.encoding 或 sun.jnu.encoding，无法安全传递非 ASCII 参数');
  if (isAbsolute(javaCommand)) javaEncodings.set(javaCommand, encoding);
  return encoding;
}

/** 检查参数能否完整经过指定的 Java 原生命令行编码 */
export function assertRepresentableArguments(args: readonly string[], encoding: string): void {
  if (!iconv.encodingExists(encoding)) {
    throw new Error(`无法验证 Windows JDK 的命令行编码 ${encoding}；请使用支持 UTF-8 的系统区域设置或 ASCII 参数`);
  }
  if (args.some(argument => iconv.decode(iconv.encode(argument, encoding), encoding) !== argument)) {
    throw new Error(`Windows JDK 的命令行编码 ${encoding} 无法完整表示部分参数；请在系统区域设置中启用“使用 Unicode UTF-8 提供全球语言支持”并按系统要求重启，或改用 ASCII 参数。-Dfile.encoding=UTF-8 不能改变命令行编码`);
  }
}

/**
 * 在 Windows 调用 Java 工具前检查参数，避免原生启动器静默替换字符
 *
 * @description 其他平台及纯 ASCII 参数不执行探针；编码检测失败保留命令诊断，参数校验错误不包含原始参数
 */
export async function assertJavaArguments(javaCommand: string, args: readonly string[], cwd: string): Promise<void> {
  if (process.platform !== 'win32' || args.every(argument => /^[\x00-\x7f]*$/.test(argument))) return;
  assertRepresentableArguments(args, await readJavaNativeEncoding(javaCommand, cwd));
}
