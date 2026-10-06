import { describe, expect, test } from 'bun:test';
import { resolveTerminalPolicy } from '../src/terminal/policy';

const input = { isTTY: true, setRawMode() {} };
const output = { isTTY: true };

describe('终端能力与呈现偏好', () => {
  test('完整终端分别启用键盘、重绘、颜色与动画', () => {
    expect(resolveTerminalPolicy({}, input, output, {})).toEqual({
      input: 'keys', rewrite: true, color: true, animation: true, logMode: 'summary',
    });
  });

  test('缺少 raw mode 支持时使用行输入', () => {
    expect(resolveTerminalPolicy({}, { isTTY: true }, output, {}).input).toBe('line');
  });

  test('管道输入禁止询问，输出终端仍可展示活动状态', () => {
    expect(resolveTerminalPolicy({ interactive: true }, {}, output, {})).toEqual({
      input: 'none', rewrite: true, color: true, animation: true, logMode: 'summary',
    });
  });

  test('重定向 stderr 后不等待输入或输出控制序列', () => {
    expect(resolveTerminalPolicy({}, input, {}, {})).toEqual({
      input: 'none', rewrite: false, color: false, animation: false, logMode: 'summary',
    });
  });

  test('CI 禁止询问，保留输出能力判断', () => {
    for (const ci of ['true', '1', 'TRUE']) {
      expect(resolveTerminalPolicy({ interactive: true }, input, output, { CI: ci })).toEqual({
        input: 'none', rewrite: true, color: true, animation: true, logMode: 'summary',
      });
    }
    for (const ci of ['', 'false', '0']) {
      expect(resolveTerminalPolicy({}, input, output, { CI: ci }).input).toBe('keys');
    }
  });

  test('NO_COLOR 只限制颜色，不关闭筛选或动画', () => {
    expect(resolveTerminalPolicy({}, input, output, { NO_COLOR: '1' })).toEqual({
      input: 'keys', rewrite: true, color: false, animation: true, logMode: 'summary',
    });
    expect(resolveTerminalPolicy({}, input, output, { NO_COLOR: '' }).color).toBe(true);
  });

  test('FORCE_COLOR=0 只禁用颜色，强制颜色不能覆盖无色约束', () => {
    expect(resolveTerminalPolicy({}, input, output, { FORCE_COLOR: '0' })).toEqual({
      input: 'keys', rewrite: true, color: false, animation: true, logMode: 'summary',
    });
    expect(resolveTerminalPolicy({}, input, output, { FORCE_COLOR: '1' }).color).toBe(true);
    expect(resolveTerminalPolicy({}, input, output, { NO_COLOR: '1', FORCE_COLOR: '1' }).color).toBe(false);
    expect(resolveTerminalPolicy({}, input, output, { TERM: 'dumb', FORCE_COLOR: '1' }).color).toBe(false);
    expect(resolveTerminalPolicy({ plain: true }, input, output, { FORCE_COLOR: '1' }).color).toBe(false);
    expect(resolveTerminalPolicy({}, input, {}, { FORCE_COLOR: '1' }).color).toBe(false);
  });

  test('纯文本偏好和 dumb 终端仍可通过序号选择', () => {
    const plain = { input: 'line', rewrite: false, color: false, animation: false, logMode: 'summary' } as const;
    expect(resolveTerminalPolicy({ plain: true }, input, output, {})).toEqual(plain);
    expect(resolveTerminalPolicy({}, input, output, { TERM: 'dumb' })).toEqual(plain);
  });

  test('禁用动画与交互互不影响，日志模式独立保留', () => {
    expect(resolveTerminalPolicy({ animation: false, logMode: 'full' }, input, output, {})).toEqual({
      input: 'keys', rewrite: true, color: true, animation: false, logMode: 'full',
    });
    expect(resolveTerminalPolicy({ interactive: false }, input, output, {}).input).toBe('none');
    expect(resolveTerminalPolicy({ interactive: false }, input, output, {}).animation).toBe(true);
  });
});
