import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import iconv from 'iconv-lite';
import { assertJavaArguments, assertRepresentableArguments } from '../src/process/java-arguments';
import { runCommand } from '../src/process/exec';

describe('Java 原生命令行编码', () => {
  test('Windows 单字节编码拒绝中文和组合字符，诊断不泄漏参数', () => {
    const secret = 'token-secret-中文';
    for (const argument of [secret, 'Cafe\u0305']) {
      let error: Error | undefined;
      try {
        assertRepresentableArguments([argument], 'windows1252');
      } catch (caught) {
        error = caught as Error;
      }
      expect(error?.message).toContain('windows1252');
      expect(error?.message).toContain('系统区域设置');
      expect(error?.message).not.toContain(argument);
    }
  });

  test('编码校验接受原生可表示的参数，UTF-8 保留 Unicode', () => {
    expect(() => assertRepresentableArguments(['space # % \' "', '', 'Café'], 'windows1252')).not.toThrow();
    expect(() => assertRepresentableArguments(['中文'], 'gbk')).not.toThrow();
    expect(() => assertRepresentableArguments(['中文', 'Cafe\u0305', '😀'], 'UTF-8')).not.toThrow();
    expect(() => assertRepresentableArguments(['😀'], 'gbk')).toThrow('无法完整表示');
    expect(() => assertRepresentableArguments(['中文'], 'unknown-charset')).toThrow('无法验证');
  });

  test('ASCII 参数和非 Windows 平台不调用 Java 探针', async () => {
    await assertJavaArguments('missing-java-argument-probe', ['plain # %'], process.cwd());
    if (process.platform !== 'win32') {
      await assertJavaArguments('missing-java-argument-probe', ['中文'], process.cwd());
    }
  });

  test('真实 Windows JDK 按原生编码接受参数或提前明确拒绝', async () => {
    if (process.platform !== 'win32') {
      await assertJavaArguments('java', ['token-secret-中文😀'], process.cwd());
      return;
    }
    const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java.exe') : 'java';
    const result = await runCommand({ command: java, args: ['-XshowSettings:properties', '-version'], cwd: process.cwd(), stage: 'Windows JDK 实测' }, { capture: true });
    expect(result.exitCode).toBe(0);
    const properties = `${result.stdout}\n${result.stderr}`;
    const encoding = /^\s*native\.encoding\s*=\s*(\S+)\s*$/m.exec(properties)?.[1]
      ?? /^\s*sun\.jnu\.encoding\s*=\s*(\S+)\s*$/m.exec(properties)?.[1];
    expect(encoding).toBeDefined();
    const argument = 'token-secret-中文😀';
    if (iconv.decode(iconv.encode(argument, encoding!), encoding!) === argument) {
      await assertJavaArguments(java, [argument], process.cwd());
    } else {
      await expect(assertJavaArguments(java, [argument], process.cwd())).rejects.toThrow('无法完整表示');
    }
    await expect(assertJavaArguments('missing-java-argument-probe', [argument], process.cwd()))
      .rejects.toMatchObject({ name: 'CommandError', stage: '检测 Java 原生命令行编码', exitCode: 127 });
  });
});
