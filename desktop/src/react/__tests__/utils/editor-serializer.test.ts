import { describe, expect, it } from 'vitest';
import { serializeEditor } from '../../utils/editor-serializer';

describe('serializeEditor', () => {
  it('extracts file badges as file refs without leaking their visual label into prompt text', () => {
    const result = serializeEditor({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'fileBadge',
          attrs: {
            fileId: 'sf_voice',
            path: '/tmp/voice.wav',
            name: '录音 1.wav',
            mimeType: 'audio/wav',
          },
        }],
      }],
    });

    expect(result.text).toBe('');
    expect(result.fileRefs).toEqual([{
      fileId: 'sf_voice',
      path: '/tmp/voice.wav',
      name: '录音 1.wav',
      isDirectory: false,
      mimeType: 'audio/wav',
    }]);
  });

  it('serializes TipTap ordered and unordered lists as markdown markers', () => {
    const result = serializeEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [
            {
              type: 'listItem',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'third' }],
              }],
            },
            {
              type: 'listItem',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'fourth' }],
              }],
            },
          ],
        },
        {
          type: 'bulletList',
          content: [{
            type: 'listItem',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: 'plain bullet' }],
            }],
          }],
        },
      ],
    });

    expect(result.text).toBe('3. third\n4. fourth\n- plain bullet');
  });

  it('serializes Session and Agent badges as structured references', () => {
    const result = serializeEditor({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Compare ' },
          { type: 'sessionBadge', attrs: { sessionId: 'sess_source', label: 'Earlier plan' } },
          { type: 'text', text: ' with ' },
          { type: 'agentBadge', attrs: { agentId: 'reviewer', label: 'Reviewer' } },
        ],
      }],
    });

    expect(result.text).toBe('Compare @Earlier plan with @Reviewer');
    expect(result.sessionRefs).toEqual([{ sessionId: 'sess_source', label: 'Earlier plan' }]);
    expect(result.agentMentions).toEqual([{ agentId: 'reviewer', label: 'Reviewer' }]);
  });
});
