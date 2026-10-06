import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { activity } from '../src/terminal/activity';
import type { TerminalPolicy } from '../src/terminal/policy';

class TerminalOutput extends Writable {
  columns = 32;
  rows = 8;
  chunks: Buffer[] = [];
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
  get text() { return Buffer.concat(this.chunks).toString('utf8'); }
}

const plain: TerminalPolicy = { input: 'none', rewrite: false, color: false, animation: false, logMode: 'summary' };
const rich: TerminalPolicy = { ...plain, rewrite: true, animation: true };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('终端活动生命周期', () => {
  test('元数据校验失败不会提前显示准备完成，且异常保持原样', async () => {
    const output = new TerminalOutput();
    const failure = new Error('元数据无效');
    await expect(activity('项目准备', async feedback => {
      feedback.stage('构建命令');
      await feedback.output({ stream: 'stdout', data: Buffer.from('BUILD SUCCESS\n') });
      expect(output.text).not.toContain('完成');
      throw failure;
    }, plain, output)).rejects.toBe(failure);
    expect(output.text).toContain('失败 项目准备');
    expect(output.text).not.toContain('完成 项目准备');
    expect(output.listenerCount('error')).toBe(0);
  });

  test('快速活动只留下完成记录，不闪烁或改动输入监听', async () => {
    const output = new TerminalOutput();
    const listeners = process.stdin.listenerCount('data');
    expect(await activity('快速检查', async () => 42, rich, output)).toBe(42);
    expect(output.text).toContain('完成 快速检查');
    expect(output.text).not.toContain('\x1b');
    expect(process.stdin.listenerCount('data')).toBe(listeners);
    expect(output.listenerCount('resize')).toBe(0);
  });

  test('长活动展示最近输出与耗时，跨块中文完整，结束后不再绘制', async () => {
    const output = new TerminalOutput();
    await activity('长时间准备', async feedback => {
      const data = Buffer.from('中文进度\n');
      await feedback.output({ stream: 'stdout', data: data.subarray(0, 2) });
      await feedback.output({ stream: 'stdout', data: data.subarray(2) });
      await delay(650);
      expect(output.text).toContain('中文进度');
      expect(output.text).toMatch(/\d+\.\ds/);
    }, rich, output);
    expect(output.text).toContain('完成 长时间准备');
    const finished = output.text;
    output.emit('resize');
    await delay(200);
    expect(output.text).toBe(finished);
    expect(output.listenerCount('resize')).toBe(0);
  });

  for (const color of [false, true]) test(`窄屏裁剪宽字符和日志控制序列（${color ? '有色' : '无色'}）`, async () => {
    const output = new TerminalOutput();
    output.columns = 12;
    await activity('非常长的中文准备阶段', async feedback => {
      await feedback.output({ stream: 'stderr', data: Buffer.from('\x1b[2J中文编译输出还有更多\n') });
      await delay(500);
      for (const chunk of output.chunks) {
        for (const line of chunk.toString().split('\n')) expect(Bun.stringWidth(stripVTControlCharacters(line))).toBeLessThan(12);
      }
      expect(output.text).not.toContain('\x1b[2J');
      if (color) expect(output.text).toContain('\x1b[36m');
      else expect(output.text).not.toMatch(/\x1b\[[\d;]*m/);
    }, { ...rich, color }, output);
  });

  test('预览保留跨流观察顺序，未结束的中文字符等待后续字节', async () => {
    const output = new TerminalOutput();
    output.columns = 80;
    await activity('构建', async feedback => {
      await feedback.output({ stream: 'stdout', data: Buffer.from('old-A\n') });
      await feedback.output({ stream: 'stderr', data: Buffer.from('middle-B\n') });
      await feedback.output({ stream: 'stdout', data: Buffer.from('latest-C\n') });
      await delay(500);
      expect(output.text).toContain('old-A\n  middle-B\n  latest-C');
      await feedback.output({ stream: 'stdout', data: Buffer.from('中').subarray(0, 2) });
      await delay(200);
      expect(output.text).not.toContain('ä¸');
      expect(output.text).not.toContain('�');
      await feedback.output({ stream: 'stdout', data: Buffer.from('中').subarray(2) });
      await delay(200);
      expect(output.text).toContain('中');
    }, rich, output);
  });

  test('完整日志长时间停在字符中间时不插入心跳', async () => {
    const output = new TerminalOutput();
    await activity('完整日志', async feedback => {
      const bytes = Buffer.from('中文\n');
      await feedback.output({ stream: 'stdout', data: bytes.subarray(0, 2) });
      await delay(10100);
      await feedback.output({ stream: 'stdout', data: bytes.subarray(2) });
    }, { ...rich, color: true, logMode: 'full' }, output);
    expect(output.text).toContain('中文\n');
    expect(output.text).not.toContain('进行中');
  }, 15000);

  test('完整日志等待写入并保留原始字节，且不重绘', async () => {
    const output = new TerminalOutput();
    const bytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    await activity('完整日志', async feedback => {
      await feedback.output({ stream: 'stdout', data: bytes.subarray(0, 1) });
      await feedback.output({ stream: 'stdout', data: bytes.subarray(1) });
      expect(Buffer.concat(output.chunks).includes(bytes)).toBe(true);
    }, { ...rich, logMode: 'full' }, output);
    expect(output.text).not.toContain('\x1b');
    expect(output.text).toContain('\n✓ 完成');
  });

  test('有色完整日志的状态及时复位，不改写原始编码或日志自带颜色', async () => {
    const output = new TerminalOutput();
    const bytes = Buffer.concat([Buffer.from('\x1b[35m'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('\x1b[0m')]);
    await activity('完整日志', async feedback => {
      await feedback.output({ stream: 'stdout', data: bytes.subarray(0, 7) });
      await feedback.output({ stream: 'stdout', data: bytes.subarray(7) });
    }, { ...rich, color: true, logMode: 'full' }, output);
    const result = Buffer.concat(output.chunks);
    const start = result.indexOf(bytes);
    expect(start).toBeGreaterThan(0);
    expect(result.subarray(0, start).toString()).toBe('\x1b[36mℹ\x1b[39m 完整日志\n');
    expect(result.subarray(start + bytes.length).toString()).toMatch(/^\n\x1b\[32m✓\x1b\[39m 完成 完整日志/);
    expect(output.text).not.toContain('\x1b[2K');
  });

  for (const color of [false, true]) test(`状态颜色保留完成、失败和取消的文字及异常（${color ? '有色' : '无色'}）`, async () => {
    for (const [outcome, code, icon, failure] of [
      ['完成', 32, '✓', undefined],
      ['失败', 31, '×', new Error('校验失败')],
      ['取消', 33, '!', Object.assign(new Error('取消'), { exitCode: 130 })],
      ['取消', 33, '!', Object.assign(new Error('终止'), { exitCode: 143 })],
    ] as const) {
      const output = new TerminalOutput();
      const work = activity('准备', async () => { if (failure) throw failure; }, { ...plain, color }, output);
      if (failure) await expect(work).rejects.toBe(failure);
      else await work;
      expect(stripVTControlCharacters(output.text)).toContain(`${icon} ${outcome} 准备`);
      if (color) expect(output.text).toContain(`\x1b[${code}m${icon}\x1b[39m ${outcome} 准备`);
      else expect(output.text).not.toContain('\x1b');
    }
  });

  test('取消清理状态，输出故障不掩盖原始失败', async () => {
    const output = new TerminalOutput();
    const cancellation = Object.assign(new Error('取消'), { exitCode: 130 });
    await expect(activity('准备', async () => { throw cancellation; }, plain, output)).rejects.toBe(cancellation);
    expect(output.text).toContain('取消 准备');
    const broken = new TerminalOutput();
    await expect(activity('准备', async () => {
      broken.emit('error', new Error('显示失败'));
      throw cancellation;
    }, rich, broken)).rejects.toBe(cancellation);
    expect(broken.listenerCount('error')).toBe(0);
  });

  test('同一输出不允许嵌套活动，结束后可以再次使用', async () => {
    const output = new TerminalOutput();
    await activity('外层', async () => {
      await expect(activity('内层', async () => {}, plain, output)).rejects.toThrow('同时');
    }, plain, output);
    await activity('下一次', async () => {}, plain, output);
    expect(output.text).toContain('完成 下一次');
  });
});
