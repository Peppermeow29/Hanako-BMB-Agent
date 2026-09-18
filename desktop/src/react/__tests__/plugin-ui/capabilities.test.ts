/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_UI_CAPABILITY } from '@hana/plugin-protocol';
import { useStore } from '../../stores';
import { DEFAULT_PLUGIN_UI_CAPABILITIES } from '../../plugin-ui/capabilities';
import type { PluginUiRequestContext } from '../../plugin-ui/plugin-ui-host-controller';

function resourceOpenHandler() {
  const capability = DEFAULT_PLUGIN_UI_CAPABILITIES.find(entry => entry.name === PLUGIN_UI_CAPABILITY.RESOURCE_OPEN);
  if (!capability) throw new Error('resource.open capability missing');
  return capability.handle;
}

const ctx = {} as PluginUiRequestContext;

describe('resource.open session file lookup', () => {
  let showInFinder: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    showInFinder = vi.fn();
    window.platform = { showInFinder } as unknown as typeof window.platform;
    useStore.setState({
      currentSessionPath: '/s/fork',
      chatSessions: {},
      sessionRegistryFilesByPath: {
        '/s/fork': [{
          fileId: 'sf_forked',
          legacyFileIds: ['sf_parent'],
          legacyFilePaths: ['/parent/report.md'],
          filePath: '/forked/report.md',
          label: 'report.md',
          ext: 'md',
        }],
      },
    } as any);
  });

  it('通过 fork 前的旧 fileId 找到当前 session 文件', async () => {
    await resourceOpenHandler()(ctx, {
      resource: { kind: 'session-file', fileId: 'sf_parent', sessionPath: '/s/fork' },
      mode: 'reveal',
    });
    expect(showInFinder).toHaveBeenCalledWith('/forked/report.md');
  });

  it('通过 fork 前的旧路径找到当前 session 文件', async () => {
    await resourceOpenHandler()(ctx, {
      resource: { kind: 'session-file', filePath: '/parent/report.md', sessionPath: '/s/fork' },
      mode: 'reveal',
    });
    expect(showInFinder).toHaveBeenCalledWith('/forked/report.md');
  });

  it('完全不认识的引用仍然报错', async () => {
    await expect(resourceOpenHandler()(ctx, {
      resource: { kind: 'session-file', fileId: 'sf_unknown', sessionPath: '/s/fork' },
      mode: 'reveal',
    })).rejects.toThrow(/could not find/);
    expect(showInFinder).not.toHaveBeenCalled();
  });
});
