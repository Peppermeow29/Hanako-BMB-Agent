import { describe, expect, it } from 'vitest';
import { getFileIcon } from '../../components/desk/desk-types';

describe('desk file icons', () => {
  it('maps audio files to the audio icon instead of the generic file icon', () => {
    expect(getFileIcon('recording.wav')).toContain('data-file-kind="audio"');
    expect(getFileIcon('recording.m4a')).toContain('data-file-kind="audio"');
  });

  it('keeps other common file kinds distinct', () => {
    expect(getFileIcon('photo.png')).toContain('data-file-kind="image"');
    expect(getFileIcon('clip.mp4')).toContain('data-file-kind="video"');
    expect(getFileIcon('notes.md')).toContain('data-file-kind="markdown"');
    expect(getFileIcon('script.ts')).toContain('data-file-kind="code"');
  });
});
