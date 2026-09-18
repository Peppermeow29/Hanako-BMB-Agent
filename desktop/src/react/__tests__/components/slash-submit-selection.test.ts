import { beforeAll, describe, expect, it, vi } from 'vitest';

const t = (key: string) => key;

let buildSlashCommands: typeof import('../../components/input/slash-commands').buildSlashCommands;
let resolveSlashSubmitSelection: typeof import('../../components/input/slash-commands').resolveSlashSubmitSelection;
let XING_PROMPT: typeof import('../../components/input/slash-commands').XING_PROMPT;

beforeAll(async () => {
  vi.stubGlobal('window', { i18n: { locale: 'zh' } });
  ({ buildSlashCommands, resolveSlashSubmitSelection, XING_PROMPT } = await import('../../components/input/slash-commands'));
});

function makeCommands() {
  return buildSlashCommands(
    t,
    async () => {},
    async () => {},
    async () => {},
  );
}

describe('resolveSlashSubmitSelection', () => {
  it('keeps skill extraction focused on workflows instead of user profile memory', () => {
    expect(XING_PROMPT).toContain('不要把用户的个人画像');
    expect(XING_PROMPT).toContain('只把“以后遇到类似任务应该怎么做”的内容写成通用技能');
    expect(XING_PROMPT).not.toContain('工作流程、偏好和纠正');
  });

  it('returns the matching slash command for an unfinished slash input', () => {
    const commands = makeCommands();

    const result = resolveSlashSubmitSelection({
      text: '/compa',
      skills: [],
      commands,
      selectedIndex: 0,
      dismissedText: null,
    });

    expect(result?.name).toBe('compact');
  });

  it('does not auto-select when the current slash text was explicitly dismissed', () => {
    const commands = makeCommands();

    const result = resolveSlashSubmitSelection({
      text: '/compa',
      skills: [],
      commands,
      selectedIndex: 0,
      dismissedText: '/compa',
    });

    expect(result).toBeNull();
  });

  it('allows server slash commands to keep arguments on submit', () => {
    const commands = [
      ...makeCommands(),
      {
        name: 'plugin_hello',
        aliases: ['hello'],
        label: '/plugin_hello',
        description: 'plugin command',
        busyLabel: '',
        icon: '',
        type: 'server-command' as const,
        execute: vi.fn(),
      },
    ];

    const result = resolveSlashSubmitSelection({
      text: '/hello world',
      skills: [],
      commands,
      selectedIndex: 0,
      dismissedText: null,
    });

    expect(result?.name).toBe('plugin_hello');
  });

  it('exposes the loop command as a server-dispatched entry', () => {
    const commands = makeCommands();
    const loop = commands.find(command => command.name === 'loop');

    expect(loop).toBeTruthy();
    expect(loop?.label).toBe('/loop');
    expect(loop?.type).toBe('server-command');
  });

  it('keeps the loop task text when submitting with arguments', () => {
    const commands = makeCommands();

    const result = resolveSlashSubmitSelection({
      text: '/loop 每轮检查一次构建状态',
      skills: [],
      commands,
      selectedIndex: 0,
      dismissedText: null,
    });

    expect(result?.name).toBe('loop');
  });

  it('does not treat builtin slash commands with arguments as local commands', () => {
    const commands = makeCommands();

    const result = resolveSlashSubmitSelection({
      text: '/compact now',
      skills: [],
      commands,
      selectedIndex: 0,
      dismissedText: null,
    });

    expect(result).toBeNull();
  });
});
