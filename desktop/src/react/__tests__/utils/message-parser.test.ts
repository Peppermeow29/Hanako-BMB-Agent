import { describe, it, expect } from 'vitest';
import {
  parseMoodFromContent,
  parseUserAttachments,
  cleanMoodText,
  truncatePath,
  extractHostname,
  truncateHead,
  extractToolDetail,
  moodLabel,
} from '../../utils/message-parser';

describe('parseMoodFromContent', () => {
  it('无 mood 标签返回原文', () => {
    const result = parseMoodFromContent('hello world');
    expect(result.mood).toBeNull();
    expect(result.yuan).toBeNull();
    expect(result.text).toBe('hello world');
  });

  it('空内容返回空', () => {
    const result = parseMoodFromContent('');
    expect(result.mood).toBeNull();
    expect(result.text).toBe('');
  });

  it('解析 <mood> 标签', () => {
    const input = '<mood>feeling good</mood>\n\nSome text here.';
    const result = parseMoodFromContent(input);
    expect(result.mood).toBe('feeling good');
    expect(result.yuan).toBe('hanako');
    expect(result.text).toBe('Some text here.');
  });

  it('解析 <pulse> 标签映射到 butter', () => {
    const input = '<pulse>energetic</pulse>\nContent.';
    const result = parseMoodFromContent(input);
    expect(result.mood).toBe('energetic');
    expect(result.yuan).toBe('butter');
  });

  it('解析 <reflect> 标签映射到 ming', () => {
    const input = '<reflect>pondering</reflect>\nContent.';
    const result = parseMoodFromContent(input);
    expect(result.mood).toBe('pondering');
    expect(result.yuan).toBe('ming');
  });

  it('mood 内容去除代码块包裹', () => {
    const input = '<mood>```\nline1\nline2\n```</mood>\nText.';
    const result = parseMoodFromContent(input);
    expect(result.mood).toBe('line1\nline2');
  });

  it('保留行内代码里的 mood 字面量及后文', () => {
    for (const tag of ['mood', 'pulse', 'reflect']) {
      const input = `\`<${tag}>\` 后半段不能消失`;
      expect(parseMoodFromContent(input)).toEqual({ mood: null, yuan: null, text: input });
    }
  });

  it('保留代码栅里成对的内部标签字面量', () => {
    const input = '```xml\n<mood>literal</mood>\n```\nafter';
    expect(parseMoodFromContent(input)).toEqual({ mood: null, yuan: null, text: input });
  });

  it('正文开始后不再把成对标签当作内部块', () => {
    const input = 'prefix <pulse>literal</pulse> suffix';
    expect(parseMoodFromContent(input)).toEqual({ mood: null, yuan: null, text: input });
  });

  it('允许 BOM 与空白后的完整开头块', () => {
    expect(parseMoodFromContent('\uFEFF \n<reflect>pondering</reflect>\nContent.')).toEqual({
      mood: 'pondering',
      yuan: 'ming',
      text: 'Content.',
    });
  });

  it('拒绝不匹配的闭合标签', () => {
    const input = '<mood>literal</pulse>\nContent.';
    expect(parseMoodFromContent(input)).toEqual({ mood: null, yuan: null, text: input });
  });

  it('只解析第一个合法开头块，后续标签保留为正文', () => {
    expect(parseMoodFromContent('<mood>inside</mood>\nafter <pulse>literal</pulse>')).toEqual({
      mood: 'inside',
      yuan: 'hanako',
      text: 'after <pulse>literal</pulse>',
    });
  });
});

describe('cleanMoodText', () => {
  it('去除代码块标记和首尾空行', () => {
    expect(cleanMoodText('```markdown\ncontent\n```')).toBe('content');
  });

  it('纯文本不变', () => {
    expect(cleanMoodText('just text')).toBe('just text');
  });
});

describe('parseUserAttachments', () => {
  // 历史 JSONL 里的旧格式块头，剥离端必须继续认
  const reminder = [
    '[hana_reminder at 2026-07-10 09:05]',
    '- Current time: 2026-07-10 09:05',
    '[/hana_reminder]',
  ].join('\n');
  // 当前渲染出的静态块头
  const staticReminder = [
    '[hana_reminder]',
    '- Current time: 2026-07-10 09:05',
    '[/hana_reminder]',
  ].join('\n');

  it('纯文本无附件', () => {
    const result = parseUserAttachments('hello');
    expect(result.text).toBe('hello');
    expect(result.files).toEqual([]);
    expect(result.deskContext).toBeNull();
  });

  it('空内容', () => {
    const result = parseUserAttachments('');
    expect(result.text).toBe('');
    expect(result.files).toEqual([]);
  });

  it('隐藏消息开头格式完整的内部 reminder block', () => {
    const result = parseUserAttachments(`${reminder}\n\nhello`);
    expect(result.text).toBe('hello');
  });

  it('隐藏静态块头的 reminder block', () => {
    const result = parseUserAttachments(`${staticReminder}\n\nhello`);
    expect(result.text).toBe('hello');
  });

  it('静态块头 reminder 后没有用户正文时返回空正文', () => {
    expect(parseUserAttachments(staticReminder).text).toBe('');
  });

  it('不剥离正文中间出现的静态块头伪 reminder block', () => {
    const content = `hello\n\n${staticReminder}\n\nworld`;
    expect(parseUserAttachments(content).text).toBe(content);
  });

  it('reminder 后没有用户正文时返回空正文', () => {
    const result = parseUserAttachments(reminder);
    expect(result.text).toBe('');
  });

  it('隐藏 reminder 后仍解析附件标记', () => {
    const result = parseUserAttachments(`${reminder}\n\n请看\n[attached_image: /tmp/example.png]`);
    expect(result.text).toBe('请看');
    expect(result.attachedImages).toEqual([{ path: '/tmp/example.png', name: 'example.png' }]);
  });

  it('未闭合或畸形 reminder 原样保留', () => {
    const unclosed = '[hana_reminder at 2026-07-10 09:05]\n- Current time: 2026-07-10 09:05\nhello';
    const unclosedStatic = '[hana_reminder]\n- Current time: 2026-07-10 09:05\nhello';
    const malformed = '[hana_reminder sometime]\nsecret\n[/hana_reminder]\nhello';
    expect(parseUserAttachments(unclosed).text).toBe(unclosed);
    expect(parseUserAttachments(unclosedStatic).text).toBe(unclosedStatic);
    expect(parseUserAttachments(malformed).text).toBe(malformed);
  });

  it('不剥离正文中间出现的伪 reminder block', () => {
    const content = `hello\n\n${reminder}\n\nworld`;
    expect(parseUserAttachments(content).text).toBe(content);
  });

  it('解析文件附件', () => {
    const input = 'Some text\n[附件] /path/to/file.txt';
    const result = parseUserAttachments(input);
    expect(result.text).toBe('Some text');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('/path/to/file.txt');
    expect(result.files[0].name).toBe('file.txt');
    expect(result.files[0].isDirectory).toBe(false);
  });

  it('解析目录附件', () => {
    const input = '[目录] /path/to/dir';
    const result = parseUserAttachments(input);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].isDirectory).toBe(true);
  });

  it('解析参考文档附件', () => {
    const input = '这个\n\n[参考文档] /Users/test/docs/note.md';
    const result = parseUserAttachments(input);
    expect(result.text).toBe('这个');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('/Users/test/docs/note.md');
    expect(result.files[0].name).toBe('note.md');
    expect(result.files[0].isDirectory).toBe(false);
  });

  it('解析 SessionFile 机器上下文，并从正文隐藏', () => {
    const input = [
      '[SessionFile] {"fileId":"sf_report","sessionPath":"/sessions/main.jsonl","label":"报告2026.txt","kind":"attachment"}',
      '请看这个',
      '',
      '[附件] 报告2026.txt',
    ].join('\n');
    const result = parseUserAttachments(input);

    expect(result.text).toBe('请看这个');
    expect(result.sessionFileRefs).toEqual([{
      fileId: 'sf_report',
      sessionPath: '/sessions/main.jsonl',
      label: '报告2026.txt',
      kind: 'attachment',
    }]);
    expect(result.files).toEqual([{
      path: '报告2026.txt',
      name: '报告2026.txt',
      isDirectory: false,
    }]);
  });

  it('解析内部 attached_image 标记为图片引用，并从正文隐藏', () => {
    const input = '[attached_image: /Users/test/.hanako/attachments/upload-abc.png]\n(看图)';
    const result = parseUserAttachments(input);

    expect(result.text).toBe('(看图)');
    expect(result.attachedImages).toEqual([
      {
        path: '/Users/test/.hanako/attachments/upload-abc.png',
        name: 'upload-abc.png',
      },
    ]);
  });

  it('解析旧版书桌上下文兼容格式', () => {
    const input = '[当前书桌目录] /home/user/desk\n  file1.txt\n  file2.txt\nSome text';
    const result = parseUserAttachments(input);
    expect(result.deskContext).not.toBeNull();
    expect(result.deskContext!.dir).toBe('/home/user/desk');
    expect(result.deskContext!.fileCount).toBe(2);
    expect(result.text).toBe('Some text');
  });
});

describe('truncatePath', () => {
  it('短路径不截断', () => {
    expect(truncatePath('/short')).toBe('/short');
  });

  it('长路径截断带省略号', () => {
    const long = '/very/long/path/that/exceeds/thirty/five/chars/file.txt';
    const result = truncatePath(long);
    expect(result.startsWith('…')).toBe(true);
    expect(result.length).toBe(35);
  });

  it('空字符串返回空', () => {
    expect(truncatePath('')).toBe('');
  });
});

describe('extractHostname', () => {
  it('提取域名', () => {
    expect(extractHostname('https://example.com/path')).toBe('example.com');
  });

  it('无效 URL 返回原文', () => {
    expect(extractHostname('not-a-url')).toBe('not-a-url');
  });

  it('空字符串返回空', () => {
    expect(extractHostname('')).toBe('');
  });
});

describe('truncateHead', () => {
  it('短文本不截断', () => {
    expect(truncateHead('short', 10)).toBe('short');
  });

  it('长文本截断带省略号', () => {
    expect(truncateHead('this is long text', 10)).toBe('this is l…');
  });
});

describe('extractToolDetail', () => {
  it('read 工具提取文件路径并附带 href', () => {
    const d = extractToolDetail('read', { file_path: '/a/b.txt' });
    expect(d.text).toContain('b.txt');
    expect(d.href).toBe('/a/b.txt');
    expect(d.hrefType).toBe('file');
  });

  it('bash 工具提取命令，无 href', () => {
    const d = extractToolDetail('bash', { command: 'ls -la' });
    expect(d.text).toBe('ls -la');
    expect(d.title).toBe('ls -la');
    expect(d.href).toBeUndefined();
  });

  it('exec_command 沿用 bash 命令详情文案', () => {
    const d = extractToolDetail('exec_command', { cmd: 'npm test -- --runInBand' });
    expect(d.text).toBe('npm test -- --runInBand');
    expect(d.title).toBe('npm test -- --runInBand');
    expect(d.href).toBeUndefined();
  });

  it('bash 工具长命令保留完整 title 供 hover 审计', () => {
    const command = 'rm -rf /Users/jason/.claude/plugins/marketplaces/temp_*';
    const d = extractToolDetail('bash', { command });

    expect(d.text).toBe('rm -rf /Users/jason/.claude/plugins/mar…');
    expect(d.title).toBe(command);
  });

  it('write_stdin 沿用 terminal 输入详情文案', () => {
    const d = extractToolDetail('write_stdin', { process_id: 'term_1', chars: 'q\n' });
    expect(d.text).toBe('q\n');
    expect(d.title).toBe('q\n');
  });

  it('web_search 提取查询，无 href', () => {
    const d = extractToolDetail('web_search', { query: 'test query' });
    expect(d.text).toBe('test query');
    expect(d.href).toBeUndefined();
  });

  it('web_fetch 提取 hostname 并附带 url href', () => {
    const d = extractToolDetail('web_fetch', { url: 'https://example.com/path' });
    expect(d.text).toBe('example.com');
    expect(d.href).toBe('https://example.com/path');
    expect(d.hrefType).toBe('url');
  });

  it('未知工具取第一个字符串参数作详情', () => {
    expect(extractToolDetail('unknown_tool', { foo: 'bar' }).text).toBe('bar');
  });

  it('未知工具无字符串参数返回空', () => {
    expect(extractToolDetail('unknown_tool', { n: 42 }).text).toBe('');
  });

  it('无 args 返回空', () => {
    expect(extractToolDetail('read', undefined).text).toBe('');
  });
});

describe('moodLabel', () => {
  it('hanako 返回 MOOD', () => {
    expect(moodLabel('hanako')).toContain('MOOD');
  });

  it('butter 返回 PULSE', () => {
    expect(moodLabel('butter')).toContain('PULSE');
  });

  it('未知 yuan 降级为 MOOD', () => {
    expect(moodLabel('unknown')).toContain('MOOD');
  });
});
