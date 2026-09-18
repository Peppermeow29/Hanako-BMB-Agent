/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openPreview: vi.fn(),
  showError: vi.fn(),
  openMediaViewerFromContext: vi.fn(),
}));

vi.mock('../../stores/preview-actions', () => ({
  openPreview: mocks.openPreview,
}));

vi.mock('../../utils/ui-helpers', () => ({
  showError: mocks.showError,
}));

vi.mock('../../utils/open-media-viewer', () => ({
  openMediaViewerFromContext: mocks.openMediaViewerFromContext,
}));

import { openFilePreview, openSkillPreview } from '../../utils/file-preview';

describe('file-preview IPC error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).platform = {
      readFile: vi.fn(),
      readDocxHtml: vi.fn(),
      readXlsxHtml: vi.fn(),
      readFileBase64: vi.fn(),
      getFileUrl: vi.fn((filePath: string) => `file://${filePath}`),
      openSkillViewer: vi.fn(),
    };
  });

  afterEach(() => {
    delete (window as any).platform;
  });

  it('预览读取异常时向用户报错，并且不再把 Promise 泄漏到全局', async () => {
    (window as any).platform.readFile.mockRejectedValue(new Error('preview exploded'));

    await expect(openFilePreview('/tmp/demo.md', 'demo.md', 'md', { origin: 'desk' })).resolves.toBeUndefined();

    expect(mocks.showError).toHaveBeenCalledWith('preview exploded');
    expect(mocks.openPreview).not.toHaveBeenCalled();
    expect(mocks.openMediaViewerFromContext).not.toHaveBeenCalled();
  });

  it('技能预览使用既有 Skill Viewer overlay，而不是 markdown Preview 面板', async () => {
    (window as any).platform.readFile.mockResolvedValue('---\nname: demo-skill\n---\n# Demo');

    await expect(openSkillPreview('demo-skill', '/tmp/demo-skill/SKILL.md')).resolves.toBeUndefined();

    expect((window as any).platform.openSkillViewer).toHaveBeenCalledWith({
      name: 'demo-skill',
      baseDir: '/tmp/demo-skill',
      filePath: '/tmp/demo-skill/SKILL.md',
      installed: true,
    });
    expect((window as any).platform.readFile).not.toHaveBeenCalled();
    expect(mocks.openPreview).not.toHaveBeenCalled();
  });

  it('技能预览优先使用已登记的 installedSkillSource.baseDir', async () => {
    const openSkillPreviewWithSource = openSkillPreview as unknown as (
      skillName: string,
      skillFilePath: string,
      source: { skillName: string; baseDir: string; filePath: string },
    ) => Promise<void>;

    await expect(openSkillPreviewWithSource('demo-skill', '/stale/path/SKILL.md', {
      skillName: 'source-skill',
      baseDir: '/installed/source-skill',
      filePath: '/installed/source-skill/SKILL.md',
    })).resolves.toBeUndefined();

    expect((window as any).platform.openSkillViewer).toHaveBeenCalledWith({
      name: 'source-skill',
      baseDir: '/installed/source-skill',
      filePath: '/installed/source-skill/SKILL.md',
      installed: true,
    });
    expect(mocks.openPreview).not.toHaveBeenCalled();
  });

  it('技能预览缺少可用路径时显式报错', async () => {
    await expect(openSkillPreview('demo-skill', '')).resolves.toBeUndefined();

    expect(mocks.showError).toHaveBeenCalledWith('skill preview path missing');
    expect(mocks.openPreview).not.toHaveBeenCalled();
    expect((window as any).platform.openSkillViewer).not.toHaveBeenCalled();
  });

  it('PDF 预览使用本地 file URL，不因 base64 读取失败回退成文件信息卡', async () => {
    (window as any).platform.readFileBase64.mockResolvedValue(null);

    await expect(openFilePreview('/tmp/Report.PDF', 'Report.PDF', 'PDF', { origin: 'desk' })).resolves.toBeUndefined();

    expect((window as any).platform.getFileUrl).toHaveBeenCalledWith('/tmp/Report.PDF');
    expect((window as any).platform.readFileBase64).not.toHaveBeenCalled();
    expect(mocks.openPreview).toHaveBeenCalledWith(expect.objectContaining({
      id: 'file-/tmp/Report.PDF',
      type: 'pdf',
      title: 'Report.PDF',
      content: '',
      filePath: '/tmp/Report.PDF',
      ext: 'pdf',
      sourceUrl: 'file:///tmp/Report.PDF',
    }));
  });

  it('HTML 预览保留调用方提供的安全资源根', async () => {
    (window as any).platform.readFile.mockResolvedValue('<img src="../assets/pic.png">');

    await expect(openFilePreview(
      '/workspace/pages/demo.html',
      'demo.html',
      'HTML',
      { origin: 'desk', sourceRootPath: '/workspace' } as Parameters<typeof openFilePreview>[3] & { sourceRootPath: string },
    )).resolves.toBeUndefined();

    expect(mocks.openPreview).toHaveBeenCalledWith(expect.objectContaining({
      id: 'file-/workspace/pages/demo.html',
      type: 'html',
      title: 'demo.html',
      content: '<img src="../assets/pic.png">',
      filePath: '/workspace/pages/demo.html',
      ext: 'html',
      sourceRootPath: '/workspace',
    }));
  });
});
