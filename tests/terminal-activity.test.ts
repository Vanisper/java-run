import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { activity } from '../src/terminal/activity';
import type { TerminalPolicy } from '../src/terminal/policy';
import { createTerminalLayout, type TerminalLayout } from '../src/terminal/layout';
import type { LogType } from '../src/logging/logger';

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

function recordStatus() {
  const types: LogType[] = [];
  const layout: TerminalLayout = {
    ...createTerminalLayout(plain),
    line(type) { types.push(type); return type; },
  };
  return { types, layout };
}

describe('终端活动生命周期', () => {
  test('元数据校验失败不会提前显示准备完成，且异常保持原样', async () => {
    const output = new TerminalOutput();
    const failure = new Error('元数据无效');
    const status = recordStatus();
    await expect(activity('项目准备', async feedback => {
      feedback.stage('构建命令');
      await feedback.output({ stream: 'stdout', data: Buffer.from('BUILD SUCCESS\n') });
      expect(status.types).not.toContain('success');
      throw failure;
    }, plain, output, { layout: status.layout })).rejects.toBe(failure);
    expect(status.types.at(-1)).toBe('error');
    expect(status.types).not.toContain('success');
    expect(output.listenerCount('error')).toBe(0);
  });

  test('快速活动直接结束，不闪烁或改动输入监听', async () => {
    const output = new TerminalOutput();
    const listeners = process.stdin.listenerCount('data');
    expect(await activity('快速检查', async () => 42, rich, output)).toBe(42);
    expect(output.text).not.toContain('\x1b');
    expect(process.stdin.listenerCount('data')).toBe(listeners);
    expect(output.listenerCount('resize')).toBe(0);
  });

  test('长活动预览跨块中文，结束后不再绘制', async () => {
    const output = new TerminalOutput();
    await activity('长时间准备', async feedback => {
      const data = Buffer.from('中文进度\n');
      await feedback.output({ stream: 'stdout', data: data.subarray(0, 2) });
      await feedback.output({ stream: 'stdout', data: data.subarray(2) });
      await delay(650);
      expect(output.text).toContain('中文进度');
    }, rich, output);
    const finished = output.text;
    output.emit('resize');
    await delay(200);
    expect(output.text).toBe(finished);
    expect(output.listenerCount('resize')).toBe(0);
  });

  test('交互期间暂停 summary 重绘，返回后继续工作并恢复预览', async () => {
    const output = new TerminalOutput();
    const selected = { target: 'application' };
    const result = await activity('准备', async feedback => {
      await feedback.output({ stream: 'stdout', data: Buffer.from('BEFORE_INTERACTION\n') });
      await delay(400);
      expect(output.text).toContain('BEFORE_INTERACTION');
      const value = await feedback.interact(async () => {
        const before = output.text;
        output.emit('resize');
        await delay(400);
        expect(output.text).toBe(before);
        return selected;
      });
      expect(value).toBe(selected);
      const resumed = output.text.length;
      await feedback.output({ stream: 'stdout', data: Buffer.from('AFTER_INTERACTION\n') });
      output.emit('resize');
      await delay(200);
      expect(output.text.slice(resumed)).toContain('AFTER_INTERACTION');
      return value;
    }, rich, output);
    expect(result).toBe(selected);
    expect(output.listenerCount('resize')).toBe(0);
    expect(output.listenerCount('error')).toBe(0);
  });

  test('交互取消原样传递异常，清理活动监听且没有迟到输出', async () => {
    const output = new TerminalOutput();
    const onResize = () => {};
    const onError = () => {};
    output.on('resize', onResize);
    output.on('error', onError);
    const cancellation = Object.assign(new Error('取消交互'), { exitCode: 130 });
    const inputListeners = process.stdin.listenerCount('data');
    await expect(activity('准备', async feedback => {
      await feedback.interact(async () => {
        const before = output.text;
        output.emit('resize');
        await delay(400);
        expect(output.text).toBe(before);
        throw cancellation;
      });
    }, rich, output)).rejects.toBe(cancellation);
    expect(output.listeners('resize')).toEqual([onResize]);
    expect(output.listeners('error')).toEqual([onError]);
    expect(process.stdin.listenerCount('data')).toBe(inputListeners);
    const finished = output.text;
    output.emit('resize');
    await delay(200);
    expect(output.text).toBe(finished);
    expect(await activity('再次使用', async () => 42, rich, output)).toBe(42);
    expect(output.listeners('resize')).toEqual([onResize]);
    expect(output.listeners('error')).toEqual([onError]);
    output.removeListener('resize', onResize);
    output.removeListener('error', onError);
  });

  for (const color of [false, true]) test(`窄屏裁剪宽字符和日志控制序列（${color ? '有色' : '无色'}）`, async () => {
    const output = new TerminalOutput();
    output.columns = 12;
    await activity('非常长的中文准备阶段', async feedback => {
      await feedback.output({ stream: 'stderr', data: Buffer.from('\x1b[2J中文编译输出还有更多\n') });
      await delay(500);
      for (const chunk of output.chunks.slice(1)) {
        for (const line of chunk.toString().split('\n')) expect(Bun.stringWidth(stripVTControlCharacters(line))).toBeLessThan(12);
      }
      expect(output.text).not.toContain('\x1b[2J');
      if (!color) expect(output.text).not.toMatch(/\x1b\[[\d;]*m/);
    }, { ...rich, color }, output, { context: ['java-run', 'run', 'maven'] });
  });

  test('预览保留跨流观察顺序，未结束的中文字符等待后续字节', async () => {
    const output = new TerminalOutput();
    output.columns = 80;
    await activity('构建', async feedback => {
      await feedback.output({ stream: 'stdout', data: Buffer.from('old-A\n') });
      await feedback.output({ stream: 'stderr', data: Buffer.from('middle-B\n') });
      await feedback.output({ stream: 'stdout', data: Buffer.from('latest-C\n') });
      await delay(500);
      const preview = output.text;
      expect(preview.indexOf('old-A')).toBeGreaterThanOrEqual(0);
      expect(preview.indexOf('old-A')).toBeLessThan(preview.indexOf('middle-B'));
      expect(preview.indexOf('middle-B')).toBeLessThan(preview.indexOf('latest-C'));
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
      const before = Buffer.concat(output.chunks);
      await delay(10100);
      expect(Buffer.concat(output.chunks)).toEqual(before);
      await feedback.output({ stream: 'stdout', data: bytes.subarray(2) });
    }, { ...rich, color: true, logMode: 'full' }, output);
    expect(output.text).toContain('中文\n');
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
    expect(output.text).not.toContain('\x1b[2K');
  });

  test('成功、失败和取消使用对应语义，并保留原始异常', async () => {
    for (const [type, failure] of [
      ['success', undefined],
      ['error', new Error('校验失败')],
      ['warn', Object.assign(new Error('取消'), { exitCode: 130 })],
      ['warn', Object.assign(new Error('终止'), { exitCode: 143 })],
    ] as const) {
      const output = new TerminalOutput();
      const status = recordStatus();
      const work = activity('准备', async () => { if (failure) throw failure; }, plain, output, { layout: status.layout });
      if (failure) await expect(work).rejects.toBe(failure);
      else await work;
      expect(status.types.at(-1)).toBe(type);
    }
  });

  test('取消清理状态，输出故障不掩盖原始失败', async () => {
    const output = new TerminalOutput();
    const cancellation = Object.assign(new Error('取消'), { exitCode: 130 });
    await expect(activity('准备', async () => { throw cancellation; }, plain, output)).rejects.toBe(cancellation);
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
    expect(output.listenerCount('error')).toBe(0);
  });

});
