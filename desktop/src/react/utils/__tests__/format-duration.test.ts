import { describe, it, expect } from 'vitest';
import { formatElapsed } from '../format-duration';

describe('formatElapsed', () => {
  it('秒级', () => expect(formatElapsed(5000)).toBe('5s'));
  it('零', () => expect(formatElapsed(0)).toBe('0s'));
  it('不足一秒向下到 0', () => expect(formatElapsed(400)).toBe('0s'));
  it('分秒', () => expect(formatElapsed(65000)).toBe('1m5s'));
  it('整分', () => expect(formatElapsed(120000)).toBe('2m0s'));
  it('负数 clamp 到 0（时钟偏差兜底）', () => expect(formatElapsed(-3000)).toBe('0s'));
});
