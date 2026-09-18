import { describe, expect, it } from 'vitest';
import { selectDeskFiles, selectSessionFiles, invalidateSessionCache } from '../../../stores/selectors/file-refs';
import type { DeskFile } from '../../../types';
import type { ChatListItem } from '../../../stores/chat-types';

function makeState(deskFiles: DeskFile[], basePath = '/home/u', currentPath = '') {
  return {
    deskFiles,
    deskBasePath: basePath,
    deskCurrentPath: currentPath,
    chatSessions: {},
  } as any;
}

describe('selectDeskFiles', () => {
  it('过滤掉目录', () => {
    const state = makeState([
      { name: 'a.png', isDir: false },
      { name: 'sub', isDir: true },
      { name: 'b.mp4', isDir: false },
    ]);
    const refs = selectDeskFiles(state);
    expect(refs.map(r => r.name)).toEqual(['a.png', 'b.mp4']);
  });

  it('按扩展名推断 kind', () => {
    const state = makeState([
      { name: 'pic.jpg', isDir: false },
      { name: 'note.md', isDir: false },
      { name: 'clip.mp4', isDir: false },
      { name: 'mystery', isDir: false },
    ]);
    const refs = selectDeskFiles(state);
    expect(refs.find(r => r.name === 'pic.jpg')?.kind).toBe('image');
    expect(refs.find(r => r.name === 'note.md')?.kind).toBe('markdown');
    expect(refs.find(r => r.name === 'clip.mp4')?.kind).toBe('video');
    expect(refs.find(r => r.name === 'mystery')?.kind).toBe('other');
  });

  it('路径拼接只消费 CWD 根目录，忽略旧的 currentPath 导航字段', () => {
    const state = makeState(
      [{ name: 'a.png', isDir: false }],
      '/root',
      'sub/dir',
    );
    expect(selectDeskFiles(state)[0].path).toBe('/root/a.png');
  });

  it('currentPath 为空时路径 = basePath + name', () => {
    const state = makeState(
      [{ name: 'a.png', isDir: false }],
      '/root',
      '',
    );
    expect(selectDeskFiles(state)[0].path).toBe('/root/a.png');
  });

  it('UNC 前导 // 保留（Windows 网络盘）', () => {
    const state = makeState(
      [{ name: 'a.png', isDir: false }],
      '//server/share',
      'sub',
    );
    // 关键：前导 // 不能被折叠成 /，否则 pathToFileUrl 的 UNC 分支匹配不上
    expect(selectDeskFiles(state)[0].path).toBe('//server/share/a.png');
  });

  it('Windows 盘符风格 basePath（仅正斜杠）保留', () => {
    const state = makeState(
      [{ name: 'a.png', isDir: false }],
      'C:/Users/foo',
      '',
    );
    expect(selectDeskFiles(state)[0].path).toBe('C:/Users/foo/a.png');
  });

  it('多余斜杠被压扁（非 UNC 场景）', () => {
    const state = makeState(
      [{ name: 'a.png', isDir: false }],
      '/root/',
      '/sub/',
    );
    expect(selectDeskFiles(state)[0].path).toBe('/root/a.png');
  });

  it('does not emit path-backed desk refs for mounted Studio workspaces', () => {
    const state = {
      ...makeState([{ name: 'remote.md', isDir: false }], 'studio:mount_docs'),
      deskWorkspaceMountId: 'mount_docs',
    };
    expect(selectDeskFiles(state)).toEqual([]);
  });

  it('同一输入多次调用返回引用稳定（memoization）', () => {
    const files: DeskFile[] = [{ name: 'a.png', isDir: false }];
    const state = makeState(files);
    const r1 = selectDeskFiles(state);
    const r2 = selectDeskFiles(state);
    expect(r1).toBe(r2);
  });

  it('id 由 buildFileRefId 构造（desk:<path>）', () => {
    const state = makeState([{ name: 'a.png', isDir: false }], '/x');
    const [ref] = selectDeskFiles(state);
    expect(ref.id).toBe('desk:/x/a.png');
    expect(ref.source).toBe('desk');
  });

  it('把 DeskFile mtime/size 转成 FileRef version', () => {
    const state = makeState([{
      name: 'a.png',
      isDir: false,
      size: 42,
      mtime: '2026-05-23T08:00:00.000Z',
    }], '/x');
    const [ref] = selectDeskFiles(state);
    expect(ref.version).toEqual({
      mtimeMs: Date.parse('2026-05-23T08:00:00.000Z'),
      size: 42,
    });
  });
});

function sessionState(items: ChatListItem[], path = '/s/1', sessionFiles: unknown[] = []) {
  return {
    deskFiles: [],
    deskBasePath: '',
    deskCurrentPath: '',
    chatSessions: { [path]: { items, hasMore: false, loadingMore: false } },
    sessionRegistryFilesByPath: sessionFiles.length ? { [path]: sessionFiles } : {},
  } as any;
}

function sessionIdState(items: ChatListItem[], sessionId = 'sess_files', path = '/s/moved', sessionFiles: unknown[] = []) {
  return {
    deskFiles: [],
    deskBasePath: '',
    deskCurrentPath: '',
    currentSessionId: sessionId,
    currentSessionPath: path,
    sessions: [{ sessionId, path }],
    sessionLocatorsById: { [sessionId]: { path } },
    chatSessions: { [sessionId]: { items, hasMore: false, loadingMore: false } },
    sessionRegistryFilesByPath: sessionFiles.length ? { [sessionId]: sessionFiles } : {},
  } as any;
}

describe('selectSessionFiles', () => {
  it('空 session 返回 []（引用稳定）', () => {
    const s = sessionState([]);
    const r1 = selectSessionFiles(s, '/s/1');
    const r2 = selectSessionFiles(s, '/s/1');
    expect(r1).toEqual([]);
    expect(r1).toBe(r2);
  });

  it('未知 sessionPath 返回 []（引用稳定）', () => {
    const r1 = selectSessionFiles(sessionState([]), '/never');
    const r2 = selectSessionFiles(sessionState([]), '/nowhere');
    expect(r1).toEqual([]);
    expect(r1).toBe(r2);
  });

  it('优先从 session registry 抽取相关文件', () => {
    const refs = selectSessionFiles(sessionState([], '/s/registry', [{
      fileId: 'sf_write',
      filePath: '/workspace/draft.md',
      label: 'draft.md',
      ext: 'md',
      mime: 'text/markdown',
      origin: 'agent_write',
      operations: ['created', 'modified'],
      createdAt: 1234,
      mtimeMs: 5678,
      size: 99,
      status: 'available',
    }]), '/s/registry');

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      fileId: 'sf_write',
      source: 'session-registry',
      name: 'draft.md',
      path: '/workspace/draft.md',
      kind: 'markdown',
      origin: 'agent_write',
      operations: ['created', 'modified'],
      timestamp: 1234,
      version: { mtimeMs: 5678, size: 99 },
    });
  });

  it('从 sessionId-keyed 消息和 registry 状态抽取移动后 session 的文件', () => {
    const refs = selectSessionFiles(sessionIdState([
      {
        type: 'message',
        data: {
          id: 'm1',
          role: 'user',
          content: 'with file',
          timestamp: 1,
          attachments: [{
            path: '/workspace/input.png',
            name: 'input.png',
            isDir: false,
            mimeType: 'image/png',
          }],
        },
      } as ChatListItem,
    ], 'sess_files', '/s/moved', [{
      fileId: 'sf_output',
      filePath: '/workspace/output.md',
      label: 'output.md',
      ext: 'md',
      mime: 'text/markdown',
    }]), '/s/moved');

    expect(refs.map(ref => ref.path)).toEqual([
      '/workspace/output.md',
      '/workspace/input.png',
    ]);
    expect(refs.map(ref => ref.id)).toEqual([
      'sess:sess_files:registry:/workspace/output.md',
      'sess:sess_files:m1:att:/workspace/input.png',
    ]);
  });

  it('把 session registry 的 resource envelope 带入 FileRef', () => {
    const refs = selectSessionFiles(sessionState([], '/s/resource', [{
      fileId: 'sf_image',
      filePath: '/workspace/image.png',
      label: 'image.png',
      ext: 'png',
      mime: 'image/png',
      status: 'available',
      resource: {
        schemaVersion: 1,
        resourceId: 'res_sf_image',
        name: 'studios/studio_local/resources/res_sf_image',
        studioId: 'studio_local',
        type: 'file',
        source: 'session_file',
        fileId: 'sf_image',
        displayName: 'image.png',
        lifecycle: { status: 'available', missingAt: null },
        storage: { provider: 'session_file', localOnly: true },
        links: {
          self: '/api/resources/res_sf_image',
          content: '/api/resources/res_sf_image/content',
        },
      },
    }]), '/s/resource');

    expect(refs[0].resource).toEqual({
      resourceId: 'res_sf_image',
      studioId: 'studio_local',
      links: {
        self: '/api/resources/res_sf_image',
        content: '/api/resources/res_sf_image/content',
      },
    });
  });

  it('registry 与旧 blocks 指向同一 SessionFile 时不重复', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'm-file', role: 'assistant',
        blocks: [
          { type: 'file', fileId: 'sf_same', filePath: '/workspace/out.md', label: 'out.md', ext: 'md' },
        ],
      },
    }];
    const refs = selectSessionFiles(sessionState(items, '/s/dedupe', [{
      fileId: 'sf_same',
      filePath: '/workspace/out.md',
      label: 'out.md',
      ext: 'md',
      origin: 'stage_files',
      operations: ['staged'],
    }]), '/s/dedupe');

    expect(refs).toHaveLength(1);
    expect(refs[0].source).toBe('session-registry');
  });

  it('registry 与 fork 前的旧 fileId / 旧路径指向同一 SessionFile 时不重复', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'm-file', role: 'assistant',
        blocks: [
          { type: 'file', fileId: 'sf_parent', filePath: '/parent/out.md', label: 'out.md', ext: 'md' },
        ],
      },
    }];
    const refs = selectSessionFiles(sessionState(items, '/s/fork-dedupe', [{
      fileId: 'sf_forked',
      legacyFileIds: ['sf_parent'],
      legacyFilePaths: ['/parent/out.md'],
      filePath: '/forked/out.md',
      label: 'out.md',
      ext: 'md',
      origin: 'stage_files',
    }]), '/s/fork-dedupe');

    expect(refs).toHaveLength(1);
    expect(refs[0].source).toBe('session-registry');
    expect(refs[0].path).toBe('/forked/out.md');
  });

  it('抽取 user attachments（过滤目录）', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'm1', role: 'user',
        attachments: [
          { path: '/a/pic.png', name: 'pic.png', isDir: false },
          { path: '/a/sub', name: 'sub', isDir: true },
          { fileId: 'sf_clip', path: '/a/clip.mp4', name: 'clip.mp4', isDir: false, mimeType: 'video/mp4' },
        ],
        timestamp: 1000,
      },
    }];
    const refs = selectSessionFiles(sessionState(items), '/s/1');
    expect(refs.map(r => r.name)).toEqual(['pic.png', 'clip.mp4']);
    expect(refs[0].source).toBe('session-attachment');
    expect(refs[0].sessionMessageId).toBe('m1');
    expect(refs[1].fileId).toBe('sf_clip');
    expect(refs[1].mime).toBe('video/mp4');
  });

  it('保留 attachment 的 session file lifecycle 状态', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'm-expired', role: 'user',
        attachments: [
          {
            fileId: 'sf_old',
            path: '/cache/old.png',
            name: 'old.png',
            isDir: false,
            mimeType: 'image/png',
            status: 'expired',
            missingAt: 1234,
          },
        ],
      },
    }];
    const refs = selectSessionFiles(sessionState(items), '/s/1');
    expect(refs[0]).toMatchObject({
      fileId: 'sf_old',
      status: 'expired',
      missingAt: 1234,
    });
  });

  it('抽取 blocks.file', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'm2', role: 'assistant',
        blocks: [
          { type: 'file', fileId: 'sf_diagram', filePath: '/out/diagram.svg', label: 'diagram.svg', ext: 'svg' },
        ],
        timestamp: 2000,
      },
    }];
    const refs = selectSessionFiles(sessionState(items), '/s/1');
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('svg');
    expect(refs[0].source).toBe('session-block-file');
    expect(refs[0].fileId).toBe('sf_diagram');
    expect(refs[0].path).toBe('/out/diagram.svg');
    expect(refs[0].sessionBlockIdx).toBe(0);
  });

  it('保留 blocks.file 的 session file lifecycle 状态', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'm2', role: 'assistant',
        blocks: [
          {
            type: 'file',
            fileId: 'sf_diagram',
            filePath: '/out/diagram.svg',
            label: 'diagram.svg',
            ext: 'svg',
            status: 'expired',
            missingAt: 5678,
          },
        ],
      },
    }];
    const refs = selectSessionFiles(sessionState(items), '/s/1');
    expect(refs[0]).toMatchObject({
      fileId: 'sf_diagram',
      source: 'session-block-file',
      status: 'expired',
      missingAt: 5678,
    });
  });

  it('把 blocks.file 的 resource envelope 带入 FileRef', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'm-resource',
        role: 'assistant',
        blocks: [
          {
            type: 'file',
            fileId: 'sf_generated',
            filePath: '/generated/image.png',
            label: 'image.png',
            ext: 'png',
            resource: {
              schemaVersion: 1,
              resourceId: 'res_sf_generated',
              name: 'studios/studio_1/resources/res_sf_generated',
              studioId: 'studio_1',
              type: 'file',
              source: 'session_file',
              fileId: 'sf_generated',
              lifecycle: { status: 'available', missingAt: null },
              storage: { provider: 'session_file', localOnly: true },
              links: {
                self: '/api/resources/res_sf_generated',
                content: '/api/resources/res_sf_generated/content',
              },
            },
          },
        ],
      },
    }];
    const refs = selectSessionFiles(sessionState(items), '/s/1');

    expect(refs[0].resource).toEqual({
      resourceId: 'res_sf_generated',
      studioId: 'studio_1',
      links: {
        self: '/api/resources/res_sf_generated',
        content: '/api/resources/res_sf_generated/content',
      },
    });
  });

  it('抽取 legacy artifact 对应的 session file', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'm-art', role: 'assistant',
        blocks: [
          {
            type: 'artifact',
            artifactId: 'art-1',
            artifactType: 'markdown',
            title: 'Plan',
            content: '# Plan',
            fileId: 'sf_art',
            filePath: '/cache/plan.md',
            ext: 'md',
            mime: 'text/markdown',
            kind: 'markdown',
            status: 'expired',
            missingAt: 9999,
          },
        ],
      },
    }];
    const refs = selectSessionFiles(sessionState(items), '/s/1');
    expect(refs[0]).toMatchObject({
      fileId: 'sf_art',
      kind: 'markdown',
      source: 'session-block-legacy-artifact',
      name: 'Plan',
      path: '/cache/plan.md',
      sessionBlockIdx: 0,
      status: 'expired',
      missingAt: 9999,
    });
  });

  it('抽取 blocks.screenshot（内嵌 base64，path 为空）', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'm3', role: 'assistant',
        blocks: [
          { type: 'screenshot', base64: 'iVBORw0...', mimeType: 'image/png' },
        ],
        timestamp: 3000,
      },
    }];
    const refs = selectSessionFiles(sessionState(items), '/s/1');
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('image');
    expect(refs[0].source).toBe('session-block-screenshot');
    expect(refs[0].path).toBe('');
    expect(refs[0].sessionBlockIdx).toBe(0);
    expect(refs[0].inlineData).toEqual({ base64: 'iVBORw0...', mimeType: 'image/png' });
  });

  it('同一消息 attachments 在前 blocks 在后', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'mx', role: 'user',
        attachments: [{ path: '/a.png', name: 'a.png', isDir: false }],
        blocks: [{ type: 'file', filePath: '/b.png', label: 'b.png', ext: 'png' }],
        timestamp: 4000,
      },
    }];
    const refs = selectSessionFiles(sessionState(items), '/s/1');
    expect(refs.map(r => r.name)).toEqual(['a.png', 'b.png']);
  });

  it('registry 文件和消息附件指向同一路径时只显示干净 display label', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'voice-msg',
        role: 'user',
        attachments: [{
          path: '/cache/录音 6_mpyhzdno_0ad8830b.wav',
          name: '录音 6_mpyhzdno_0ad8830b.wav',
          isDir: false,
        }],
      },
    }];
    const refs = selectSessionFiles(sessionState(items, '/s/voice', [{
      fileId: 'sf_voice',
      filePath: '/cache/录音 6_mpyhzdno_0ad8830b.wav',
      label: '录音 6.wav',
      filename: '录音 6_mpyhzdno_0ad8830b.wav',
      ext: 'wav',
      mime: 'audio/wav',
      kind: 'audio',
      status: 'available',
    }]), '/s/voice');

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      fileId: 'sf_voice',
      source: 'session-registry',
      name: '录音 6.wav',
      path: '/cache/录音 6_mpyhzdno_0ad8830b.wav',
      kind: 'audio',
    });
  });

  it('会话文件列表默认排除 voice-input，但仍保留普通音频附件', () => {
    const refs = selectSessionFiles(sessionState([], '/s/listed-voice', [{
      fileId: 'sf_voice_input',
      filePath: '/cache/voice-input.wav',
      label: '录音 1.wav',
      ext: 'wav',
      mime: 'audio/wav',
      kind: 'audio',
      presentation: 'voice-input',
      listed: false,
      status: 'available',
    }, {
      fileId: 'sf_uploaded_audio',
      filePath: '/cache/uploaded.wav',
      label: '会议录音.wav',
      ext: 'wav',
      mime: 'audio/wav',
      kind: 'audio',
      presentation: 'attachment',
      listed: true,
      status: 'available',
    }]), '/s/listed-voice');

    expect(refs.map(r => r.fileId)).toEqual(['sf_uploaded_audio']);
    expect(refs[0]).toMatchObject({
      name: '会议录音.wav',
      presentation: 'attachment',
      listed: true,
    });
  });

  it('聊天恢复用途会保留 voice-input 并携带展示语义', () => {
    const refs = selectSessionFiles(sessionState([], '/s/chat-voice', [{
      fileId: 'sf_voice_input',
      filePath: '/cache/voice-input.wav',
      label: '录音 1.wav',
      ext: 'wav',
      mime: 'audio/wav',
      kind: 'audio',
      presentation: 'voice-input',
      listed: false,
      status: 'available',
    }]), '/s/chat-voice', { includeUnlisted: true });

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      fileId: 'sf_voice_input',
      kind: 'audio',
      presentation: 'voice-input',
      listed: false,
    });
  });

  it('跨多消息按消息顺序', () => {
    const items: ChatListItem[] = [
      { type: 'message', data: { id: '1', role: 'user', attachments: [{ path: '/1.png', name: '1.png', isDir: false }] } },
      { type: 'compaction', id: 'c1', yuan: '' },
      { type: 'message', data: { id: '2', role: 'assistant', blocks: [{ type: 'file', filePath: '/2.png', label: '2.png', ext: 'png' }] } },
    ];
    const refs = selectSessionFiles(sessionState(items), '/s/1');
    expect(refs.map(r => r.name)).toEqual(['1.png', '2.png']);
  });

  it('memoization：同一输入返回引用稳定', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: { id: 'm', role: 'user', attachments: [{ path: '/a.png', name: 'a.png', isDir: false }] },
    }];
    const state = sessionState(items);
    const r1 = selectSessionFiles(state, '/s/1');
    const r2 = selectSessionFiles(state, '/s/1');
    expect(r1).toBe(r2);
  });
});

describe('invalidateSessionCache（生命周期绑定）', () => {
  it('invalidateSessionCache(path) 后再调 selectSessionFiles 会重新计算（引用不等）', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: { id: 'm', role: 'user', attachments: [{ path: '/a.png', name: 'a.png', isDir: false }] },
    }];
    const state = sessionState(items, '/s/evict');
    const r1 = selectSessionFiles(state, '/s/evict');
    invalidateSessionCache('/s/evict');
    const r2 = selectSessionFiles(state, '/s/evict');
    expect(r1).not.toBe(r2);
    // 内容仍一致（只是重新构造了数组）
    expect(r1).toEqual(r2);
  });

  it('invalidateSessionCache() 无参清空整张 Map（跨 session）', () => {
    const itemsA: ChatListItem[] = [{
      type: 'message',
      data: { id: 'a', role: 'user', attachments: [{ path: '/a.png', name: 'a.png', isDir: false }] },
    }];
    const itemsB: ChatListItem[] = [{
      type: 'message',
      data: { id: 'b', role: 'user', attachments: [{ path: '/b.png', name: 'b.png', isDir: false }] },
    }];
    const stateA = {
      deskFiles: [], deskBasePath: '', deskCurrentPath: '',
      chatSessions: {
        '/s/a': { items: itemsA, hasMore: false, loadingMore: false },
        '/s/b': { items: itemsB, hasMore: false, loadingMore: false },
      },
    } as any;
    const a1 = selectSessionFiles(stateA, '/s/a');
    const b1 = selectSessionFiles(stateA, '/s/b');
    invalidateSessionCache();
    const a2 = selectSessionFiles(stateA, '/s/a');
    const b2 = selectSessionFiles(stateA, '/s/b');
    expect(a1).not.toBe(a2);
    expect(b1).not.toBe(b2);
  });

  it('invalidateSessionCache(unknown) 幂等，不影响其它 session', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: { id: 'x', role: 'user', attachments: [{ path: '/x.png', name: 'x.png', isDir: false }] },
    }];
    const state = sessionState(items, '/s/keep');
    const r1 = selectSessionFiles(state, '/s/keep');
    invalidateSessionCache('/s/does-not-exist');
    const r2 = selectSessionFiles(state, '/s/keep');
    expect(r1).toBe(r2);
  });
});
