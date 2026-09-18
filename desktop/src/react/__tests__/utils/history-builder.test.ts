import { describe, expect, it } from 'vitest';
import { buildItemsFromHistory } from '../../utils/history-builder';

describe('buildItemsFromHistory user image restoration', () => {
  it('folds inline MiniCPM thinking and hides XML protocol residue in history', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'a-thinking',
        role: 'assistant',
        content: '<think>先确认工具结果</think>已完成。]]></param></function>',
      }],
    });

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.blocks).toEqual([
      { type: 'thinking', content: '先确认工具结果', sealed: true },
      expect.objectContaining({ type: 'text', html: expect.stringContaining('已完成。') }),
    ]);
  });

  it('restores tool outcomes by toolCallId instead of tool name', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call-ok', name: 'read', status: 'succeeded' },
          { id: 'call-fail', name: 'read', status: 'failed', error: 'file not found' },
          { id: 'call-missing', name: 'read', status: 'unknown' },
        ],
      }],
    });

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    const group = first.data.blocks?.find((block) => block.type === 'tool_group');
    expect(group).toMatchObject({
      tools: [
        { id: 'call-ok', status: 'succeeded', done: true, success: true },
        { id: 'call-fail', status: 'failed', done: true, success: false, error: 'file not found' },
        { id: 'call-missing', status: 'unknown', done: true, success: false },
      ],
    });
  });

  it('把服务端 ISO timestamp 归一成前端毫秒时间', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'u1',
        role: 'user',
        content: 'hello',
        timestamp: '2026-05-07T05:42:00.000Z',
      }],
    });

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.timestamp).toBe(Date.parse('2026-05-07T05:42:00.000Z'));
  });

  it('保留后端 session entry id 作为分支操作来源', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: '0',
        entryId: 'entry-user-1',
        role: 'user',
        content: 'hello',
      }],
    });

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.id).toBe('0');
    expect(first.data.sourceEntryId).toBe('entry-user-1');
  });

  it('隐藏后台输入时把真实 turn 边界保留在后续 Agent 消息上', () => {
    const items = buildItemsFromHistory({
      messages: [
        { id: '0', entryId: 'entry-visible-user', role: 'user', content: 'hello' },
        {
          id: '1',
          entryId: 'entry-visible-assistant',
          role: 'assistant',
          content: 'first reply',
          turnInputEntryId: 'entry-visible-user',
          turnInputVisible: true,
        },
        {
          id: '2',
          entryId: 'entry-hidden-input',
          role: 'user',
          content: '<hana-background-result task-id="task-1">done</hana-background-result>',
        },
        {
          id: '3',
          entryId: 'entry-background-assistant',
          role: 'assistant',
          content: 'background reply',
          turnInputEntryId: 'entry-hidden-input',
          turnInputVisible: false,
        },
      ],
    });

    expect(items).toHaveLength(3);
    const backgroundAssistant = items[2];
    expect(backgroundAssistant.type).toBe('message');
    if (backgroundAssistant.type !== 'message') throw new Error('expected assistant message');
    expect(backgroundAssistant.data).toMatchObject({
      role: 'assistant',
      sourceEntryId: 'entry-background-assistant',
      turnInputEntryId: 'entry-hidden-input',
      turnInputVisible: false,
    });
  });

  it('隐藏 bridge 写入用户消息里的内部时间标签', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'u1',
        role: 'user',
        content: '<t>05-13 05:03</t> hello from phone',
      }],
    });

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.text).toBe('hello from phone');
  });

  it('隐藏旧插话消息里的中英文内部前缀', () => {
    const items = buildItemsFromHistory({
      messages: [
        {
          id: 'u1',
          role: 'user',
          content: '（插话，无需 MOOD）\n先别展开',
        },
        {
          id: 'u2',
          role: 'user',
          content: '(Interjection, no MOOD needed)\njust answer directly',
        },
      ],
    });

    const first = items[0];
    const second = items[1];
    expect(first.type).toBe('message');
    expect(second.type).toBe('message');
    if (first.type !== 'message' || second.type !== 'message') throw new Error('expected messages');
    expect(first.data.text).toBe('先别展开');
    expect(second.data.text).toBe('just answer directly');
  });

  it('把 media-only attached_image 占位恢复成裸图片附件', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'u1',
        role: 'user',
        content: '[attached_image: /Users/test/.hanako/attachments/upload-abc.png]\n(看图)',
      }],
    });

    expect(items).toHaveLength(1);
    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.text).toBe('');
    expect(first.data.textHtml).toBeUndefined();
    expect(first.data.attachments).toEqual([{
      path: '/Users/test/.hanako/attachments/upload-abc.png',
      name: 'upload-abc.png',
      isDir: false,
    }]);
  });

  it('原生 image block 与 attached_image 路径合并为一个图片附件', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'u1',
        role: 'user',
        content: '[attached_image: /Users/test/.hanako/attachments/upload-native.png]\n看看这个',
        images: [{ data: 'BASE64', mimeType: 'image/png' }],
      }],
    });

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.text).toBe('看看这个');
    expect(first.data.attachments).toEqual([{
      path: '/Users/test/.hanako/attachments/upload-native.png',
      name: 'upload-native.png',
      isDir: false,
      mimeType: 'image/png',
    }]);
  });

  it('把 attached_audio 标记恢复成音频附件，并从正文隐藏', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'u1',
        role: 'user',
        content: '[attached_audio: /Users/test/.hanako/session-files/voice.wav]\n听一下',
      }],
    });

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.text).toBe('听一下');
    expect(first.data.textHtml).not.toContain('attached_audio');
    expect(first.data.attachments).toEqual([{
      path: '/Users/test/.hanako/session-files/voice.wav',
      name: 'voice.wav',
      isDir: false,
    }]);
  });

  it('把 media-only attached_audio 占位恢复成裸音频附件', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'u1',
        role: 'user',
        content: '[attached_audio: /Users/test/.hanako/session-files/voice.wav]\n（听音频）',
      }],
    });

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.text).toBe('');
    expect(first.data.textHtml).toBeUndefined();
    expect(first.data.attachments).toEqual([{
      path: '/Users/test/.hanako/session-files/voice.wav',
      name: 'voice.wav',
      isDir: false,
    }]);
  });

  it('从 SessionFile 账本恢复历史音频附件的展示名和元信息', () => {
    const filePath = '/Users/test/.hanako/session-files/hash/录音 1_mpykkdz7_35680467.wav';
    const items = buildItemsFromHistory({
      messages: [{
        id: 'u1',
        role: 'user',
        content: `[attached_audio: ${filePath}]`,
      }],
      sessionFiles: [{
        fileId: 'sf_voice_1',
        filePath,
        realPath: filePath,
        displayName: '录音 1.wav',
        label: '录音 1.wav',
        filename: '录音 1_mpykkdz7_35680467.wav',
        mime: 'audio/wav',
        kind: 'audio',
        status: 'available',
        missingAt: null,
      }],
    });

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.text).toBe('');
    expect(first.data.textHtml).toBeUndefined();
    expect(first.data.attachments).toEqual([{
      fileId: 'sf_voice_1',
      path: filePath,
      name: '录音 1.wav',
      isDir: false,
      mimeType: 'audio/wav',
      status: 'available',
      missingAt: null,
    }]);
  });

  it('用 Fork 文件的旧 id 和旧路径别名恢复未改写的历史附件', () => {
    const parentPath = '/Users/test/.hanako/session-files/parent/voice.wav';
    const childPath = '/Users/test/.hanako/session-files/child/voice.wav';
    const items = buildItemsFromHistory({
      messages: [{
        id: 'u-forked-file',
        role: 'user',
        content: `[SessionFile] ${JSON.stringify({ fileId: 'sf_parent', sessionPath: '/sessions/parent.jsonl', label: 'voice.wav', kind: 'attachment' })}\n[attached_audio: ${parentPath}]`,
      }],
      sessionFiles: [{
        fileId: 'sf_child',
        filePath: childPath,
        displayName: 'voice.wav',
        mime: 'audio/wav',
        kind: 'audio',
        status: 'available',
        legacyFileIds: ['sf_parent'],
        legacyFilePaths: [parentPath],
      }],
    });

    const first = items[0];
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.attachments).toEqual([{
      fileId: 'sf_child',
      path: childPath,
      name: 'voice.wav',
      isDir: false,
      mimeType: 'audio/wav',
      status: 'available',
    }]);
  });

  it('从 SessionFile 账本恢复 voice-input 音频附件的展示语义', () => {
    const filePath = '/Users/test/.hanako/session-files/hash/录音 1_mpykkdz7_35680467.wav';
    const items = buildItemsFromHistory({
      messages: [{
        id: 'u-voice-input',
        role: 'user',
        content: `[attached_audio: ${filePath}]\n（听音频）`,
      }],
      sessionFiles: [{
        fileId: 'sf_voice_1',
        filePath,
        displayName: '录音 1.wav',
        mime: 'audio/wav',
        kind: 'audio',
        presentation: 'voice-input',
        listed: false,
        status: 'available',
        missingAt: null,
      }],
    });

    const first = items[0];
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.text).toBe('');
    expect(first.data.attachments).toEqual([{
      fileId: 'sf_voice_1',
      path: filePath,
      name: '录音 1.wav',
      isDir: false,
      mimeType: 'audio/wav',
      presentation: 'voice-input',
      listed: false,
      status: 'available',
      missingAt: null,
    }]);
  });

  it('从 SessionFile 账本恢复 voice-input 转录展示元数据，但不把它写进消息正文', () => {
    const filePath = '/Users/test/.hanako/session-files/hash/录音 1_mpykkdz7_35680467.wav';
    const items = buildItemsFromHistory({
      messages: [{
        id: 'u-voice-transcript',
        role: 'user',
        content: `[attached_audio: ${filePath}]\n（听音频）`,
      }],
      sessionFiles: [{
        fileId: 'sf_voice_1',
        filePath,
        displayName: '录音 1.wav',
        mime: 'audio/wav',
        kind: 'audio',
        presentation: 'voice-input',
        listed: false,
        waveform: {
          version: 1,
          peaks: [0.1, 0.4, 0.8],
          durationMs: 1800,
          source: 'computed',
        },
        transcription: {
          status: 'ready',
          text: '今晚我们先把语音输入跑通。',
          providerId: 'mimo',
          modelId: 'mimo-v2.5-asr',
          protocolId: 'mimo-chat-completions-asr',
        },
      }],
    } as any);

    const first = items[0];
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.text).toBe('');
    expect(first.data.textHtml).toBeUndefined();
    expect(first.data.attachments?.[0]).toMatchObject({
      fileId: 'sf_voice_1',
      presentation: 'voice-input',
      waveform: {
        version: 1,
        peaks: [0.1, 0.4, 0.8],
        durationMs: 1800,
        source: 'computed',
      },
      transcription: {
        status: 'ready',
        text: '今晚我们先把语音输入跑通。',
        providerId: 'mimo',
        modelId: 'mimo-v2.5-asr',
      },
    });
  });

  it('从 SessionFile 账本恢复旧版图片附件，并把模型传输说明排除出可见正文', () => {
    const filePath = '/Users/test/.hanako/uploads/粘贴图片_mpyjx6zr_fc3d70a9.png';
    const items = buildItemsFromHistory({
      messages: [{
        id: 'u1',
        role: 'user',
        content: `[attached_image: ${filePath}]\n<file name="image-1">[Image: original 2236x1854, displayed at 2000x1658. Multiply coordinates by 1.12 to map to original image.]</file>\n（看图）`,
      }],
      sessionFiles: [{
        fileId: 'sf_image_1',
        filePath,
        realPath: filePath,
        displayName: '粘贴图片.png',
        label: '粘贴图片.png',
        filename: '粘贴图片_mpyjx6zr_fc3d70a9.png',
        mime: 'image/png',
        kind: 'image',
        status: 'available',
        missingAt: null,
      }],
    });

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.text).toBe('');
    expect(first.data.textHtml).toBeUndefined();
    expect(first.data.attachments).toEqual([{
      fileId: 'sf_image_1',
      path: filePath,
      name: '粘贴图片.png',
      isDir: false,
      mimeType: 'image/png',
      status: 'available',
      missingAt: null,
    }]);
  });

  it('从 SessionFile 机器上下文恢复展示名附件，并把机器行排除出可见正文', () => {
    const filePath = '/Users/test/.hanako/uploads/报告2026_mq6l.txt';
    const items = buildItemsFromHistory({
      messages: [{
        id: 'u-session-file',
        role: 'user',
        content: [
          '[SessionFile] {"fileId":"sf_report","sessionPath":"/sessions/main.jsonl","label":"报告2026.txt","kind":"attachment"}',
          '请分析这个报告',
          '',
          '[附件] 报告2026.txt',
        ].join('\n'),
      }],
      sessionFiles: [{
        fileId: 'sf_report',
        filePath,
        realPath: filePath,
        displayName: '报告2026.txt',
        label: '报告2026.txt',
        filename: '报告2026_mq6l.txt',
        mime: 'text/plain',
        kind: 'attachment',
        status: 'available',
        missingAt: null,
      }],
    });

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.text).toBe('请分析这个报告');
    expect(first.data.textHtml).not.toContain('SessionFile');
    expect(first.data.attachments).toEqual([{
      fileId: 'sf_report',
      path: filePath,
      name: '报告2026.txt',
      isDir: false,
      mimeType: 'text/plain',
      status: 'available',
      missingAt: null,
    }]);
  });

  it('丢弃字段残缺的历史 sideband block，保留同消息的可渲染内容', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'a1',
        role: 'assistant',
        content: '可见正文',
      }],
      blocks: [
        { type: 'file', afterIndex: 0, label: 'missing-path.png', ext: 'png' },
        { type: 'plugin_card', afterIndex: 0 },
        { type: 'cron_confirm', afterIndex: 0, status: 'approved' },
        { type: 'file', afterIndex: 0, filePath: '/tmp/report.pdf', label: 'report.pdf', ext: 'pdf' },
      ],
    });

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.blocks?.map(block => block.type)).toEqual(['text', 'file']);
    expect(first.data.blocks?.[1]).toMatchObject({
      type: 'file',
      filePath: '/tmp/report.pdf',
      label: 'report.pdf',
      ext: 'pdf',
    });
  });

  it('保留不依赖 iframe route 的 chat.surface 插件卡片', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'a-chat-surface',
        role: 'assistant',
        content: '已创建插件会话',
      }],
      blocks: [{
        type: 'plugin_card',
        afterIndex: 0,
        card: {
          type: 'chat.surface',
          pluginId: 'tavern',
          sessionRef: {
            sessionId: 'sess_tavern',
            sessionPath: '/sessions/tavern.jsonl',
          },
          title: 'Tavern run',
          description: 'Private transcript',
        },
      }],
    });

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.blocks?.at(-1)).toMatchObject({
      type: 'plugin_card',
      card: {
        type: 'chat.surface',
        pluginId: 'tavern',
        sessionId: 'sess_tavern',
        sessionPath: '/sessions/tavern.jsonl',
        sessionRef: {
          sessionId: 'sess_tavern',
          sessionPath: '/sessions/tavern.jsonl',
        },
      },
    });
  });

  it('保留空 thinking 为已完成思考块', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'a-empty-thinking',
        role: 'assistant',
        content: '',
        thinking: '',
      }],
    });

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.blocks).toEqual([{
      type: 'thinking',
      content: '',
      sealed: true,
    }]);
  });

  it('恢复 deferred 幕间消息为独立时间线条目', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'a1',
        role: 'assistant',
        content: '可见正文',
      }],
      blocks: [{
        type: 'interlude',
        afterIndex: 0,
        id: 'deferred:subagent-1:success',
        variant: 'deferred_result',
        taskId: 'subagent-1',
        status: 'success',
        sourceKind: 'subagent',
        sourceLabel: '明 · 大纲评估',
        text: '小花 收到了来自 明 · 大纲评估 的回复',
        detailMarkdown: '完成了',
      }],
    });

    const first = items[0];
    const second = items[1];
    expect(items).toHaveLength(2);
    expect(first.type).toBe('message');
    expect(second.type).toBe('interlude');
    if (first.type !== 'message' || second.type !== 'interlude') {
      throw new Error('expected assistant message followed by interlude item');
    }
    expect(first.data.blocks?.map(block => block.type)).toEqual(['text']);
    expect(second.data).toMatchObject({
      type: 'interlude',
      taskId: 'subagent-1',
      text: '小花 收到了来自 明 · 大纲评估 的回复',
    });
  });

  it('显式 after_anchor_message 幕间在恢复时不走旧媒体前置规则', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'a1',
        role: 'assistant',
        content: '提交图片任务',
      }],
      blocks: [
        {
          type: 'interlude',
          afterIndex: 0,
          id: 'deferred:task-img:success',
          variant: 'deferred_result',
          timelinePlacement: 'after_anchor_message',
          taskId: 'task-img',
          status: 'success',
          sourceKind: 'tool',
          sourceLabel: '图片生成',
          text: '图片结果已抵达',
        },
        {
          type: 'file',
          afterIndex: 0,
          replacesTaskId: 'task-img',
          filePath: '/tmp/image.png',
          label: 'image.png',
          ext: 'png',
        },
      ],
    });

    expect(items.map((item) => item.type)).toEqual(['message', 'interlude']);
    expect(items[0]?.type).toBe('message');
    if (items[0]?.type !== 'message') throw new Error('expected message');
    expect(items[0].data.blocks?.map((block) => block.type)).toEqual(['text', 'file']);
    expect(items[1]?.type).toBe('interlude');
    if (items[1]?.type !== 'interlude') throw new Error('expected interlude');
    expect(items[1].data.taskId).toBe('task-img');
  });

  it('有 sourceIndex 时按 JSONL 顺序恢复幕间，媒体结果仍原地替换占位消息', () => {
    const items = buildItemsFromHistory({
      messages: [
        {
          id: 'a-media',
          sourceIndex: 10,
          role: 'assistant',
          content: '生成图片',
        },
        {
          id: 'a-final',
          sourceIndex: 20,
          role: 'assistant',
          content: '最终报告',
        },
        {
          id: 'a-ack',
          sourceIndex: 22,
          role: 'assistant',
          content: '收到后台回复',
        },
      ],
      blocks: [
        {
          type: 'file',
          afterIndex: 0,
          sourceIndex: 12,
          replacesTaskId: 'task-img',
          filePath: '/tmp/generated.png',
          label: 'generated.png',
          ext: 'png',
        },
        {
          type: 'interlude',
          afterIndex: 0,
          sourceIndex: 21,
          id: 'deferred:subagent-1:success:delivery-1',
          deliveryId: 'delivery-1',
          variant: 'deferred_result',
          timelinePlacement: 'after_anchor_message',
          taskId: 'subagent-1',
          status: 'success',
          sourceKind: 'subagent',
          text: '小花 收到了来自 明 的回复',
        },
      ],
    });

    expect(items.map((item) => (item.type === 'message' ? item.data.id : item.id))).toEqual([
      'a-media',
      'a-final',
      'deferred:subagent-1:success:delivery-1',
      'a-ack',
    ]);
    const mediaMessage = items[0];
    expect(mediaMessage?.type).toBe('message');
    if (mediaMessage?.type !== 'message') throw new Error('expected message');
    expect(mediaMessage.data.blocks?.map((block) => block.type)).toEqual(['text', 'file']);
  });

  it('只有 deferred 幕间消息的历史行不会留下空 assistant 外壳', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'a1',
        role: 'assistant',
        content: '',
      }],
      blocks: [{
        type: 'interlude',
        afterIndex: 0,
        id: 'deferred:subagent-2:success',
        variant: 'deferred_result',
        taskId: 'subagent-2',
        status: 'success',
        sourceKind: 'subagent',
        text: '后台回复已抵达',
      }],
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe('interlude');
    if (items[0]?.type !== 'interlude') throw new Error('expected interlude item');
    expect(items[0].data.text).toBe('后台回复已抵达');
  });

  it('restores a clean user message plus the independent Agent review card', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'u-review',
        role: 'user',
        content: 'internal expanded prompt with review',
        displayText: 'Please inspect this @Critic',
        agentReview: {
          requestId: 'review-1',
          status: 'completed',
          reviewedSessionId: 'sess_parent',
          reviewerSessionId: 'sess_review',
          reviewerAgentId: 'critic',
          reviewerAgentName: 'Critic',
          text: 'Independent findings',
        },
      }],
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe('message');
    if (items[0]?.type !== 'message') throw new Error('expected message');
    expect(items[0].data.text).toBe('Please inspect this @Critic');
    expect(items[0].data.agentReview).toMatchObject({
      reviewerSessionId: 'sess_review',
      text: 'Independent findings',
    });
  });
});
