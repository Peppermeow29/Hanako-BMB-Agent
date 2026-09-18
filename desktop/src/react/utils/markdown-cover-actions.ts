import {
  dispatchCoverNotice,
} from './markdown-cover-generation';

export function isExternalCoverImagePath(imagePath: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(imagePath);
}

function localBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || 'cover.png';
}

function joinLocalPath(dirPath: string, fileName: string): string {
  const sep = dirPath.includes('\\') && !dirPath.includes('/') ? '\\' : '/';
  return `${dirPath.replace(/[\\/]+$/, '')}${sep}${fileName}`;
}

export async function saveMarkdownCoverImage(imagePath: string | null | undefined): Promise<void> {
  if (!imagePath || isExternalCoverImagePath(imagePath)) {
    dispatchCoverNotice('当前 cover 不是本地图片，无法直接保存。', 'error');
    return;
  }
  const folder = await window.platform?.selectFolder?.();
  if (!folder || !window.platform?.copyFile) return;
  const ok = await window.platform.copyFile(imagePath, joinLocalPath(folder, localBasename(imagePath)));
  dispatchCoverNotice(ok ? 'Cover 图片已保存。' : 'Cover 图片保存失败。', ok ? 'success' : 'error');
}
