/**
 * @vitest-environment jsdom
 *
 * Toggle 第三态契约：on=undefined 表示"数据未加载"。
 *
 * 这条契约存在的根本原因：所有异步加载的开关在 fetch 完成前若用 false 兜底显示，
 * 会让用户在加载窗口期看到"假关"，点一下后才显示"开"。
 * 把"未加载"作为一等公民传给 Toggle，从根上断掉此类 bug。
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Toggle } from '../Toggle';

afterEach(cleanup);

describe('Toggle', () => {
  it('renders on state when on=true', () => {
    const { container } = render(<Toggle on={true} onChange={() => {}} />);
    const btn = container.querySelector('button.hana-toggle');
    expect(btn).not.toBeNull();
    expect(btn?.classList.contains('on')).toBe(true);
    expect(btn?.classList.contains('loading')).toBe(false);
    expect(btn?.getAttribute('aria-checked')).toBe('true');
    expect(btn?.getAttribute('aria-busy')).toBeNull();
    expect((btn as HTMLButtonElement)?.disabled).toBe(false);
  });

  it('renders off state when on=false', () => {
    const { container } = render(<Toggle on={false} onChange={() => {}} />);
    const btn = container.querySelector('button.hana-toggle');
    expect(btn?.classList.contains('on')).toBe(false);
    expect(btn?.classList.contains('loading')).toBe(false);
    expect(btn?.getAttribute('aria-checked')).toBe('false');
  });

  it('renders loading state when on=undefined', () => {
    const { container } = render(<Toggle on={undefined} onChange={() => {}} />);
    const btn = container.querySelector('button.hana-toggle');
    expect(btn?.classList.contains('loading')).toBe(true);
    expect(btn?.classList.contains('on')).toBe(false);
    expect(btn?.getAttribute('aria-busy')).toBe('true');
    expect(btn?.getAttribute('aria-checked')).toBe('mixed');
    expect((btn as HTMLButtonElement)?.disabled).toBe(true);
  });

  it('does not fire onChange when clicked in loading state', () => {
    const onChange = vi.fn();
    const { container } = render(<Toggle on={undefined} onChange={onChange} />);
    const btn = container.querySelector('button.hana-toggle') as HTMLButtonElement;
    fireEvent.click(btn);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('fires onChange with toggled value when on=true', () => {
    const onChange = vi.fn();
    const { container } = render(<Toggle on={true} onChange={onChange} />);
    fireEvent.click(container.querySelector('button.hana-toggle')!);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('fires onChange with toggled value when on=false', () => {
    const onChange = vi.fn();
    const { container } = render(<Toggle on={false} onChange={onChange} />);
    fireEvent.click(container.querySelector('button.hana-toggle')!);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('respects external disabled prop', () => {
    const onChange = vi.fn();
    const { container } = render(<Toggle on={true} onChange={onChange} disabled />);
    const btn = container.querySelector('button.hana-toggle') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onChange).not.toHaveBeenCalled();
  });
});
