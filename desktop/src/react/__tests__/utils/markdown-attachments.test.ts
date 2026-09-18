import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_DIR_NAME,
  buildMarkdownAttachmentPlan,
} from '../../utils/markdown-attachments';

describe('markdown attachments', () => {
  it('stores pasted or dropped images in the fixed attachment folder and inserts image markdown', () => {
    const plan = buildMarkdownAttachmentPlan({
      markdownFilePath: '/vault/notes/day.md',
      originalName: 'Cover Image.png',
      mimeType: 'image/png',
      uniqueSuffix: '20260522-010203',
    });

    expect(ATTACHMENT_DIR_NAME).toBe('文本附件');
    expect(plan.attachmentPath).toBe('/vault/notes/文本附件/Cover Image-20260522-010203.png');
    expect(plan.markdown).toBe('![Cover Image](<文本附件/Cover Image-20260522-010203.png>)');
  });

  it('keeps a future file attachment path open by inserting non-image files as links', () => {
    const plan = buildMarkdownAttachmentPlan({
      markdownFilePath: '/vault/notes/day.md',
      originalName: 'report.final.pdf',
      mimeType: 'application/pdf',
      uniqueSuffix: '20260522-010203',
    });

    expect(plan.attachmentPath).toBe('/vault/notes/文本附件/report.final-20260522-010203.pdf');
    expect(plan.markdown).toBe('[report.final.pdf](<文本附件/report.final-20260522-010203.pdf>)');
  });

  it('normalizes Windows markdown file paths without hard-coding POSIX separators', () => {
    const plan = buildMarkdownAttachmentPlan({
      markdownFilePath: 'C:\\vault\\notes\\day.md',
      originalName: 'diagram.png',
      mimeType: 'image/png',
      uniqueSuffix: '20260522-010203',
    });

    expect(plan.attachmentPath).toBe('C:/vault/notes/文本附件/diagram-20260522-010203.png');
    expect(plan.markdown).toBe('![diagram](<文本附件/diagram-20260522-010203.png>)');
  });

  it('sanitizes path separators and empty names before writing into the attachment folder', () => {
    const unsafe = buildMarkdownAttachmentPlan({
      markdownFilePath: '/vault/note.md',
      originalName: '../bad/name?.png',
      mimeType: 'image/png',
      uniqueSuffix: '20260522-010203',
    });
    const unnamed = buildMarkdownAttachmentPlan({
      markdownFilePath: '/vault/note.md',
      originalName: '',
      mimeType: 'image/png',
      uniqueSuffix: '20260522-010203',
    });

    expect(unsafe.attachmentPath).toBe('/vault/文本附件/name-20260522-010203.png');
    expect(unsafe.markdown).toBe('![name](<文本附件/name-20260522-010203.png>)');
    expect(unnamed.attachmentPath).toBe('/vault/文本附件/attachment-20260522-010203.png');
    expect(unnamed.markdown).toBe('![attachment](<文本附件/attachment-20260522-010203.png>)');
  });

  it('escapes markdown control characters in labels without changing the stored path', () => {
    const plan = buildMarkdownAttachmentPlan({
      markdownFilePath: '/vault/note.md',
      originalName: 'look [here].png',
      mimeType: 'image/png',
      uniqueSuffix: '20260522-010203',
    });

    expect(plan.attachmentPath).toBe('/vault/文本附件/look [here]-20260522-010203.png');
    expect(plan.markdown).toBe('![look \\[here\\]](<文本附件/look [here]-20260522-010203.png>)');
  });
});
