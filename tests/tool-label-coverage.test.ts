import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  BUILTIN_TOOL_NAMES, TOOL_LABEL_ALIASES as RUNTIME_ALIASES, SESSION_ACTION_LABEL_KEYS,
  isExternalTool, phaseForStatus, sessionToolTargetName, sessionToolTargetPath,
} from '../desktop/src/react/utils/tool-label';

/**
 * 工具行文案对账。
 *
 * 进程区每条工具调用的文案只有一个取值点（ToolGroupBlock 的 getToolLabel），
 * 键形如 `tool.<工具名>.<相位>`。工具名对不上就静默掉进 `tool._fallback`，
 * 用户看到的是"正在忙碌中…"。这类漏配在运行时不报错，只能靠对账守住。
 *
 * 两个方向都要查：
 *   1. 已登记的工具在五个语言包里三相位齐全；
 *   2. 源码里新冒出来的工具必须显式登记或显式豁免，防止清单本身过期。
 */

const localesDir = path.join(process.cwd(), 'desktop/src/locales');
const locales = ['en', 'zh', 'zh-TW', 'ja', 'ko'];
const phases = ['running', 'done', 'failed'];

/** UI 侧把这两个工具名映射到别的文案键上，对账要跟着映射走。 */
const TOOL_LABEL_ALIASES: Record<string, string> = {
  exec_command: 'bash',
  write_stdin: 'terminal',
};

/** 需要文案的工具名（含插件工具的 `<pluginId>_<tool>` 全名）。 */
const LABELED_TOOL_NAMES = [
  // Pi SDK 沙盒工具
  'read', 'write', 'edit', 'grep', 'find', 'ls', 'bash', 'terminal', 'materialize',
  // Agent 自带
  'search_memory', 'pin_memory', 'unpin_memory', 'recall_experience', 'record_experience',
  'web_search', 'web_fetch', 'todo_write', 'automation', 'stage_files', 'file', 'channel',
  'browser', 'computer', 'install_skill', 'notify', 'stop_task', 'update_settings',
  'session_folders', 'subagent', 'subagent_reply', 'subagent_close', 'workflow',
  'check_pending_tasks', 'loop_control', 'current_status', 'session',
  'hana_card_guide', 'show_card',
  // Hub 频道
  'channel_read_context', 'channel_reply', 'channel_pass',
  // 内置插件（PluginManager 注册时统一加 `<pluginId>_` 前缀）
  'beautify_create-cover', 'beautify_apply-cover-candidate', 'beautify_get-cover-style-guide',
  'beautify_get-html-style-guide', 'beautify_list-capabilities',
  'office_read-document', 'office_html-to-pdf', 'office_list-capabilities',
  // 已下线但历史 JSONL 里仍有调用记录，回看旧会话时要能正常渲染
  'create_artifact', 'dm',
];

/**
 * 文案键但不是工具名：同一个工具按 action 分出来的档位。
 * 它们要有完整三相位，但不进内置工具名单（那张表是拿工具名判断内外部用的）。
 */
const ACTION_LABEL_KEYS = ['session_send', 'session_create'];

/**
 * 不进进程区、因而不需要文案的工具。
 * 加新条目前先确认它真的不会出现在会话时间线里。
 */
const UNLABELED_TOOL_NAMES = new Set([
  'structured_output',              // workflow 内部结构化输出
  'jian_update_status',             // desk 心跳
  'patrol_update_log',              // desk 巡检
  'hana',                           // MCP client 自我标识，非 agent 工具
  'stop', 'new', 'reset', 'rc', 'exitrc', 'apply', 'confirm', 'reject', 'compact', 'loop',
  'fd', 'ripgrep',                  // 搜索二进制下载配置，非 agent 工具
  'todo',                           // todo_write 的历史别名
]);

function loadLocale(name: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(localesDir, `${name}.json`), 'utf8'));
}

/** 从源码里抓工具注册名，粗粒度但足以发现"新工具没登记"。 */
function scanRegisteredToolNames(): Set<string> {
  const sources = [
    ...fs.readdirSync(path.join(process.cwd(), 'lib/tools'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join('lib/tools', f)),
    'lib/exec-command/tool.ts',
    'lib/memory/memory-search.ts',
    'lib/resource-io/materialize-tool.ts',
  ];
  const found = new Set<string>();
  for (const rel of sources) {
    const abs = path.join(process.cwd(), rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    for (const m of text.matchAll(/^\s{2,6}name: "([a-z][a-z0-9_]*)",$/gm)) {
      found.add(m[1]);
    }
  }
  return found;
}

describe('工具行文案对账', () => {
  for (const locale of locales) {
    it(`${locale}.json 为每个已登记工具提供三相位文案`, () => {
      const tool = loadLocale(locale).tool ?? {};
      const missing: string[] = [];
      for (const name of [...LABELED_TOOL_NAMES, ...ACTION_LABEL_KEYS]) {
        const key = TOOL_LABEL_ALIASES[name] ?? name;
        for (const phase of phases) {
          const value = tool[key]?.[phase];
          if (typeof value !== 'string' || !value.trim()) missing.push(`tool.${key}.${phase}`);
        }
      }
      expect(missing, `${locale}.json 缺工具文案`).toEqual([]);
    });
  }

  it('语言包里没有对不上任何工具的孤儿文案', () => {
    const tool = loadLocale('zh').tool ?? {};
    const known = new Set([
      ...LABELED_TOOL_NAMES.map((n) => TOOL_LABEL_ALIASES[n] ?? n),
      ...ACTION_LABEL_KEYS,
      '_fallback',
      '_plugin',
    ]);
    const orphans = Object.entries(tool)
      .filter(([key, value]) => (value as any)?.running && !known.has(key))
      .map(([key]) => `tool.${key}`);
    expect(orphans, '这些文案键匹配不到任何工具，会永远渲染不出来').toEqual([]);
  });

  it('源码里的工具要么已登记文案，要么显式豁免', () => {
    const registered = scanRegisteredToolNames();
    const labeled = new Set([...LABELED_TOOL_NAMES, ...Object.keys(TOOL_LABEL_ALIASES)]);
    const unregistered = [...registered]
      .filter((name) => !labeled.has(name) && !UNLABELED_TOOL_NAMES.has(name))
      .sort();
    expect(
      unregistered,
      '新工具需要补 tool.<name>.{running,done,failed}，或加进 UNLABELED_TOOL_NAMES 说明它不进进程区',
    ).toEqual([]);
  });

  it('渲染侧的内置名单跟已登记工具对得上', () => {
    // 内置插件的工具在运行时也带 pluginId 前缀，归外部工具那一侧，不进内置名单
    const bundledPluginTools = LABELED_TOOL_NAMES.filter((n) => /^(media|beautify|office)_/.test(n));
    const expected = new Set([
      ...LABELED_TOOL_NAMES.filter((n) => !bundledPluginTools.includes(n)),
      ...Object.keys(RUNTIME_ALIASES),
    ]);
    expect([...BUILTIN_TOOL_NAMES].sort()).toEqual([...expected].sort());
  });

  it('内置工具走通用兜底，外部插件与 MCP 工具走插件兜底', () => {
    expect(isExternalTool('check_pending_tasks')).toBe(false);
    expect(isExternalTool('web_search')).toBe(false);
    expect(isExternalTool('beautify_create-cover')).toBe(true);
    expect(isExternalTool('mcp_search_issues')).toBe(true);
    // 第三方插件里叫 read 的工具不能撞上内置 read 的文案
    expect(isExternalTool('acme_read')).toBe(true);
  });

  it('session 按 action 分档，send/create 不用查看那套说法', () => {
    // read/list 没有专属档位，落回 tool.session
    expect(SESSION_ACTION_LABEL_KEYS.read).toBeUndefined();
    expect(SESSION_ACTION_LABEL_KEYS.list).toBeUndefined();
    expect(SESSION_ACTION_LABEL_KEYS.send).toBe('session_send');
    expect(SESSION_ACTION_LABEL_KEYS.create).toBe('session_create');

    // send/create 那一刻只是拟了草稿卡，文案不能宣布消息已经发出去
    const zh = loadLocale('zh').tool;
    expect(zh.session_send.done).toContain('等你确认');
    expect(zh.session_create.done).toContain('等你确认');
  });

  it('session 工具的目标会话靠 sessionId 查，查不到就不猜', () => {
    const state = {
      sessions: [{ sessionId: 'sess_abc', title: '项目讨论', agentName: '小花' }],
      sessionLocatorsById: { sess_abc: { path: '/agents/hanako/sessions/abc.jsonl' } },
    };
    expect(sessionToolTargetName(state, { action: 'read', sessionId: 'sess_abc' })).toBe('小花 · 项目讨论');
    expect(sessionToolTargetPath(state, { action: 'read', sessionId: 'sess_abc' }))
      .toBe('/agents/hanako/sessions/abc.jsonl');
    // 已归档 / 不在列表里的会话查不到，退回 null 让调用方显示 id 短尾
    expect(sessionToolTargetName(state, { action: 'read', sessionId: 'sess_gone' })).toBeNull();
    expect(sessionToolTargetPath(state, { action: 'read', sessionId: 'sess_gone' })).toBeNull();
    // create 的目标会话还不存在，只给出要派给谁，也没有可跳转的路径
    expect(sessionToolTargetName(state, { action: 'create', agent: '小马' })).toBe('小马');
    expect(sessionToolTargetPath(state, { action: 'create', agent: '小马' })).toBeNull();
  });

  it('失败的工具调用取 failed 相位', () => {
    expect(phaseForStatus('running')).toBe('running');
    expect(phaseForStatus('failed')).toBe('failed');
    expect(phaseForStatus('succeeded')).toBe('done');
    expect(phaseForStatus('unknown')).toBe('done');
  });

  it('插件工具文案带 pluginId 前缀，无前缀键匹配不到任何调用', () => {
    const tool = loadLocale('zh').tool ?? {};
    const bareNames = [
      'generate-image', 'generate-video', 'create-cover',
      'apply-cover-candidate', 'get-cover-style-guide', 'list-capabilities',
    ];
    const stale = bareNames.filter((n) => tool[n]);
    expect(stale, '插件工具运行时名为 `<pluginId>_<tool>`，无前缀键是死键').toEqual([]);
  });
});
