/**
 * @vitest-environment jsdom
 */

import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __setMermaidLoaderForTests,
  renderMermaidDiagrams,
} from '../../utils/mermaid-renderer';

describe('renderMermaidDiagrams', () => {
  const initialize = vi.fn();
  const render = vi.fn(async (id: string, source: string) => ({
    svg: `<svg data-id="${id}"><text>${source}</text></svg>`,
  }));

  beforeEach(() => {
    document.body.innerHTML = '';
    initialize.mockClear();
    render.mockClear();
    __setMermaidLoaderForTests(async () => ({ initialize, render }));
  });

  afterEach(() => {
    __setMermaidLoaderForTests(null);
  });

  it('renders mermaid placeholders into SVG once per source', async () => {
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false,
      securityLevel: 'strict',
    }));
    expect(render).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.mermaid-rendered svg')).toBeInstanceOf(SVGElement);
    expect(container.querySelector('.mermaid-source')).toHaveAttribute('hidden');
    expect(container.querySelector('.mermaid-source-toggle')).toBeInstanceOf(HTMLButtonElement);
    expect(container.querySelector('.mermaid-source-copy')).toBeInstanceOf(HTMLButtonElement);

    await renderMermaidDiagrams(container);

    expect(render).toHaveBeenCalledTimes(1);
  });

  it('keeps the source toolbar stable when rendering the same source again', async () => {
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);
    const toolbar = container.querySelector('.mermaid-source-toolbar');
    await renderMermaidDiagrams(container);

    expect(container.querySelector('.mermaid-source-toolbar')).toBe(toolbar);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('lets rendered Mermaid diagrams reveal and copy their source', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    const source = container.querySelector('.mermaid-source');
    const toggle = container.querySelector<HTMLButtonElement>('.mermaid-source-toggle')!;
    const copy = container.querySelector<HTMLButtonElement>('.mermaid-source-copy')!;
    expect(source).toHaveAttribute('hidden');

    toggle.click();
    expect(source).not.toHaveAttribute('hidden');
    toggle.click();
    expect(source).toHaveAttribute('hidden');
    copy.click();

    expect(writeText).toHaveBeenCalledWith('graph TD\nA-->B');
  });

  it('rerenders a restored diagram when the SVG is missing for the same source', async () => {
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram" data-mermaid-status="rendered" data-mermaid-source="graph TD\nA-->B">',
      '<pre class="mermaid-source" hidden><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    expect(render).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.mermaid-rendered svg')).toBeInstanceOf(SVGElement);
  });

  it('rerenders when the source changes even if a previous SVG exists', async () => {
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram" data-mermaid-status="rendered" data-mermaid-source="graph TD\nA-->B">',
      '<pre class="mermaid-source" hidden><code>graph TD\nA-->C</code></pre>',
      '<div class="mermaid-rendered"><svg><text>old</text></svg></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    expect(render).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.mermaid-rendered text')?.textContent).toContain('A-->C');
  });

  it('does not let an older async render overwrite a newer source', async () => {
    let resolveFirst!: (value: { svg: string }) => void;
    render
      .mockImplementationOnce((_id: string, _source: string) => new Promise<{ svg: string }>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockImplementationOnce(async (_id: string, source: string) => ({
        svg: `<svg><text>${source}</text></svg>`,
      }));
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    const first = renderMermaidDiagrams(container);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    container.querySelector('.mermaid-source code')!.textContent = 'graph TD\nA-->C';
    await renderMermaidDiagrams(container);
    resolveFirst({ svg: '<svg><text>graph TD\nA-->B</text></svg>' });
    await first;

    expect(render).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.mermaid-rendered text')?.textContent).toContain('A-->C');
  });

  it('copies the latest source after rerendering a changed diagram', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);
    container.querySelector('.mermaid-source code')!.textContent = 'graph TD\nA-->C';
    await renderMermaidDiagrams(container);
    container.querySelector<HTMLButtonElement>('.mermaid-source-copy')!.click();

    expect(writeText).toHaveBeenCalledWith('graph TD\nA-->C');
  });

  it('keeps source visible and shows an error when mermaid rendering fails', async () => {
    render.mockRejectedValueOnce(new Error('bad diagram'));
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph Nope</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    expect(container.querySelector('.mermaid-source')).not.toHaveAttribute('hidden');
    expect(container.querySelector('.mermaid-rendered')?.textContent).toContain('bad diagram');
  });

  it('does not retry an unchanged failed diagram on observer-triggered rerenders', async () => {
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram" data-mermaid-status="error" data-mermaid-source="graph TD\nA-->B">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered">Mermaid diagram failed to render: bad diagram</div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    expect(render).not.toHaveBeenCalled();
  });
});
