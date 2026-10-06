import { describe, expect, test } from 'bun:test';
import { createLinePrefixer } from '../src/terminal/line-prefix';

describe('终端原始字节行前缀', () => {
  test('UTF-8 逐字节到达时保持字符及原始字节', () => {
    const prefixer = createLinePrefixer('│ ');
    const source = Buffer.from('中文🙂\n下一行🚀');
    const output = Buffer.concat([...source].map(byte => prefixer.push(Buffer.from([byte]))));
    expect(output).toEqual(Buffer.from('│ 中文🙂\n│ 下一行🚀'));
    expect(source).toEqual(Buffer.from('中文🙂\n下一行🚀'));
  });

  test('交错的 stdout 和 stderr 片段共用行状态', () => {
    const prefixer = createLinePrefixer('│ ');
    const chunks = [
      { stream: 'stdout', data: 'out' },
      { stream: 'stderr', data: '-error\n' },
      { stream: 'stderr', data: 'next' },
      { stream: 'stdout', data: '-out\n' },
    ];
    const output = Buffer.concat(chunks.map(chunk => prefixer.push(Buffer.from(chunk.data))));
    expect(output).toEqual(Buffer.from('│ out-error\n│ next-out\n'));
  });

  test('跨块 CRLF 不插入前缀，独立 CR 后恢复前缀', () => {
    const prefixer = createLinePrefixer('│ ');
    const chunks = ['first\r', '\nsecond\r', 'rewrite\r', '\n', '\n'];
    const output = Buffer.concat(chunks.map(chunk => prefixer.push(Buffer.from(chunk))));
    expect(output).toEqual(Buffer.from('│ first\r\n│ second\r│ rewrite\r\n│ \n'));
  });

  test('跨块和跨行的 SGR 保持原样，不注入样式重置', () => {
    const prefixer = createLinePrefixer('│ ');
    const chunks = ['\x1b[', '31mred\n', 'still red\x1b[39', 'm\n'];
    const output = Buffer.concat(chunks.map(chunk => prefixer.push(Buffer.from(chunk))));
    expect(output).toEqual(Buffer.from('│ \x1b[31mred\n│ still red\x1b[39m\n'));
  });

  test('空块与行尾不产生悬空前缀，末尾无换行可继续写入', () => {
    const prefixer = createLinePrefixer('│ ');
    expect(prefixer.push(Buffer.alloc(0))).toEqual(Buffer.alloc(0));
    expect(prefixer.push(Buffer.from('partial'))).toEqual(Buffer.from('│ partial'));
    expect(prefixer.push(Buffer.alloc(0))).toEqual(Buffer.alloc(0));
    expect(prefixer.push(Buffer.from('-tail\n'))).toEqual(Buffer.from('-tail\n'));
    expect(prefixer.push(Buffer.alloc(0))).toEqual(Buffer.alloc(0));
    expect(prefixer.push(Buffer.from('\n'))).toEqual(Buffer.from('│ \n'));
  });

  test('reset 清除半行和 CR 状态，下一块重新添加前缀', () => {
    const prefixer = createLinePrefixer('│ ');
    expect(prefixer.push(Buffer.from('partial'))).toEqual(Buffer.from('│ partial'));
    prefixer.reset();
    expect(prefixer.push(Buffer.from('next\r'))).toEqual(Buffer.from('│ next\r'));
    prefixer.reset();
    expect(prefixer.push(Buffer.from('\n'))).toEqual(Buffer.from('│ \n'));
  });
});
