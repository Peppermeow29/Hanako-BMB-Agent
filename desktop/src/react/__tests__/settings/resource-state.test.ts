/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import {
  createRemoteResource,
  makeSettingsResourceKey,
  readConfigBoolean,
  readReadyResource,
  startRemoteLoad,
  finishRemoteLoad,
  failRemoteLoad,
} from '../../settings/resource-state';

describe('settings remote resource state', () => {
  it('builds keys with connection and owner so server truth cannot leak across agents', () => {
    expect(makeSettingsResourceKey('config', 'agent-a', null)).toBe('local:config:agent-a');
    expect(makeSettingsResourceKey('config', 'agent-a', 'remote-1')).toBe('remote-1:config:agent-a');
    expect(makeSettingsResourceKey('config', null, 'remote-1')).toBeNull();
  });

  it('does not expose previous data while a different owner key is loading', () => {
    const ready = finishRemoteLoad(
      startRemoteLoad(createRemoteResource<{ enabled: boolean }>(), 'local:config:agent-a', 1),
      'local:config:agent-a',
      1,
      { enabled: true },
    );
    const loadingNext = startRemoteLoad(ready, 'local:config:agent-b', 2);

    expect(readReadyResource(loadingNext, 'local:config:agent-a')).toBeUndefined();
    expect(readReadyResource(loadingNext, 'local:config:agent-b')).toBeUndefined();
    expect(loadingNext.data).toBeNull();
  });

  it('can retain same-owner data during a refresh without pretending a new owner is ready', () => {
    const ready = finishRemoteLoad(
      startRemoteLoad(createRemoteResource<{ enabled: boolean }>(), 'local:config:agent-a', 1),
      'local:config:agent-a',
      1,
      { enabled: false },
    );
    const refreshing = startRemoteLoad(ready, 'local:config:agent-a', 2, { retainSameKeyData: true });

    expect(readReadyResource(refreshing, 'local:config:agent-a')).toEqual({ enabled: false });
    expect(refreshing.status).toBe('loading');
  });

  it('ignores stale completion and error for older requests', () => {
    const loading = startRemoteLoad(createRemoteResource<{ enabled: boolean }>(), 'local:config:agent-a', 2);

    expect(finishRemoteLoad(loading, 'local:config:agent-a', 1, { enabled: true })).toBe(loading);
    expect(failRemoteLoad(loading, 'local:config:agent-a', 1, new Error('late'))).toBe(loading);
  });

  it('reads booleans as undefined until the config object exists', () => {
    type DeskConfig = { desk?: { heartbeat_master?: boolean } };
    expect(readConfigBoolean<DeskConfig>(null, cfg => cfg.desk?.heartbeat_master, true)).toBeUndefined();
    expect(readConfigBoolean<DeskConfig>({ desk: {} }, cfg => cfg.desk?.heartbeat_master, true)).toBe(true);
    expect(readConfigBoolean<DeskConfig>({ desk: { heartbeat_master: false } }, cfg => cfg.desk?.heartbeat_master, true)).toBe(false);
  });
});
