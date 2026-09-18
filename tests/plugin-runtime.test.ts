import { describe, expect, it, vi } from 'vitest';
import {
  createMediaDetails,
  cancelTask,
  createChatSurfaceCard,
  completeTask,
  defineBusHandler,
  defineCommand,
  defineExtension,
  definePlugin,
  defineProvider,
  defineTool,
  failTask,
  HANA_BUS_SKIP,
  createAgent,
  createSession,
  getAgentProfile,
  getPluginRequestContext,
  getSession,
  generateMedia,
  generateImage,
  generateVideo,
  listUsageEntries,
  listAgents,
  listMediaProviders,
  listSessions,
  resolveMediaModel,
  registerTask,
  requestBus,
  sampleText,
  scheduleTask,
  sendSessionMessage,
  transcribeAudio,
  subscribeSessionEvents,
  sessionFileToMediaItem,
  subscribeUsageEvents,
  unscheduleTask,
  updateTask,
  updateAgent,
  updateSession,
} from '@hana/plugin-runtime';
import type { HanaPluginNetwork, HanaPluginNetworkFetchInit } from '@hana/plugin-runtime';

describe('plugin runtime SDK', () => {
  it('defines tools with stable fields and default parameters', async () => {
    const execute = vi.fn(async (input: { query: string }) => `search:${input.query}`);
    const tool = defineTool({
      name: 'search',
      description: 'Search things',
      execute,
    });

    expect(tool).toMatchObject({
      name: 'search',
      description: 'Search things',
      parameters: { type: 'object', properties: {} },
    });
    await expect(tool.execute({ query: 'hana' }, {} as any)).resolves.toBe('search:hana');
  });

  it('preserves tool sessionPermission metadata for host approval policy', async () => {
    const sessionPermission = {
      kind: 'plugin_output' as const,
      describeSideEffect: vi.fn(() => ({
        kind: 'session_file_output',
        summary: 'Writes generated output into plugin data and registers a SessionFile.',
        ruleId: 'plugin-output-session-file',
      })),
    };
    const execute = vi.fn(async () => 'ok');

    const tool = defineTool({
      name: 'create_note',
      description: 'Create a note',
      sessionPermission,
      execute,
    });

    expect(tool.sessionPermission).toBe(sessionPermission);
    expect(tool.sessionPermission?.describeSideEffect?.({ title: 'Hana' })).toMatchObject({
      kind: 'session_file_output',
      ruleId: 'plugin-output-session-file',
    });
    await expect(tool.execute({}, {} as any)).resolves.toBe('ok');
  });

  it('defines commands with stable slash fields', async () => {
    const handler = vi.fn(async () => ({ reply: 'pong' }));
    const command = defineCommand({
      name: 'ping',
      aliases: ['p'],
      description: 'Ping command',
      permission: 'anyone',
      scope: 'session',
      handler,
    });

    expect(command).toMatchObject({
      name: 'ping',
      aliases: ['p'],
      description: 'Ping command',
      permission: 'anyone',
      scope: 'session',
    });
    await expect(command.handler?.({} as any)).resolves.toEqual({ reply: 'pong' });
  });

  it('defines providers without altering provider metadata', () => {
    const provider = defineProvider({
      id: 'demo-provider',
      displayName: 'Demo Provider',
      authType: 'none',
      runtime: {
        kind: 'local-cli',
        protocolId: 'local-cli-media',
        command: {
          executable: 'demo-image-cli',
          args: [
            { literal: 'generate' },
            { option: '--prompt', from: 'prompt' },
            { option: '--output', from: 'outputDir' },
          ],
          timeoutMs: 120000,
          output: { kind: 'file_glob', directory: 'outputDir', pattern: '*.png' },
        },
      },
      capabilities: {
        chat: { projection: 'none' },
        media: {
          imageGeneration: {
            models: [{
              id: 'demo-image',
              displayName: 'Demo Image',
              protocolId: 'local-cli-media',
              inputs: ['text'],
              outputs: ['image'],
            }],
          },
        },
      },
    });

    expect(provider).toEqual({
      id: 'demo-provider',
      displayName: 'Demo Provider',
      authType: 'none',
      runtime: {
        kind: 'local-cli',
        protocolId: 'local-cli-media',
        command: {
          executable: 'demo-image-cli',
          args: [
            { literal: 'generate' },
            { option: '--prompt', from: 'prompt' },
            { option: '--output', from: 'outputDir' },
          ],
          timeoutMs: 120000,
          output: { kind: 'file_glob', directory: 'outputDir', pattern: '*.png' },
        },
      },
      capabilities: {
        chat: { projection: 'none' },
        media: {
          imageGeneration: {
            models: [{
              id: 'demo-image',
              displayName: 'Demo Image',
              protocolId: 'local-cli-media',
              inputs: ['text'],
              outputs: ['image'],
            }],
          },
        },
      },
    });
  });

  it('defines extensions as direct Pi SDK factories', () => {
    const factory = vi.fn();
    const extension = defineExtension(factory);
    const pi = {};

    extension(pi);

    expect(factory).toHaveBeenCalledWith(pi);
  });

  it('defines lifecycle plugins compatible with PluginManager injection', async () => {
    const disposable = vi.fn();
    const onload = vi.fn((_ctx, helpers) => {
      helpers.register(disposable);
    });
    const onunload = vi.fn();
    const PluginClass = definePlugin({ onload, onunload });
    const instance = new PluginClass();
    const register = vi.fn();
    const ctx = { pluginId: 'demo', dataDir: '/tmp/demo' };

    instance.ctx = ctx as any;
    instance.register = register;
    if (!instance.onload || !instance.onunload) {
      throw new Error('definePlugin must create lifecycle methods');
    }
    await instance.onload();
    await instance.onunload();

    expect(onload).toHaveBeenCalledWith(ctx, { register });
    expect(register).toHaveBeenCalledWith(disposable);
    expect(onunload).toHaveBeenCalledWith(ctx);
  });

  it('defines bus handlers without hiding EventBus ownership', async () => {
    const handle = vi.fn(async (payload: { text: string }) => ({ ok: payload.text === 'hello' }));
    const handler = defineBusHandler({
      type: 'bridge:send',
      handle,
    });
    const ctx = { pluginId: 'demo' };

    await expect(handler.handle({ text: 'hello' }, ctx as any)).resolves.toEqual({ ok: true });
    expect(handler.type).toBe('bridge:send');
    expect(handle).toHaveBeenCalledWith({ text: 'hello' }, ctx);
  });

  it('exports the shared EventBus SKIP symbol for chained handlers', () => {
    expect(HANA_BUS_SKIP).toBe(Symbol.for('hana.event-bus.skip'));
  });

  it('types plugin network fetch options without host internals', async () => {
    const init: HanaPluginNetworkFetchInit = {
      cacheTtlMs: 1000,
      timeoutMs: 5000,
      maxResponseBytes: 1024,
    };
    const network: HanaPluginNetwork = {
      fetch: vi.fn(async () => new Response('ok')),
    };

    await expect(network.fetch('https://api.example.com/live', init))
      .resolves.toBeInstanceOf(Response);
  });

  it('requests bus handlers through the context bus with explicit payload and options', async () => {
    const request = vi.fn(async () => ({ sent: true }));
    const ctx = {
      bus: { request },
    };

    await expect(
      requestBus(ctx as any, 'session:send', { text: 'hello' }, { timeoutMs: 5000 }),
    ).resolves.toEqual({ sent: true });

    expect(request).toHaveBeenCalledWith('session:send', { text: 'hello' }, { timeoutMs: 5000 });
  });

  it('reads plugin route request context from a Hono request object', () => {
    const request = vi.fn();
    const routeContext = {
      pluginId: 'route-plugin',
      agentId: 'hana',
      principal: { kind: 'plugin', pluginId: 'route-plugin' },
      capabilityGrant: { accessLevel: 'full-access', declaredPermissions: ['session'], legacyDeclaration: false },
      bus: { request },
    };
    const honoContext = {
      get: vi.fn((key: string) => key === 'pluginRequestContext' ? routeContext : undefined),
    };

    expect(getPluginRequestContext(honoContext)).toBe(routeContext);
    expect(honoContext.get).toHaveBeenCalledWith('pluginRequestContext');
  });

  it('throws a clear error when plugin route request context is unavailable', () => {
    expect(() => getPluginRequestContext({ get: () => undefined })).toThrow(
      'getPluginRequestContext must be called inside a Hana plugin route handler',
    );
    expect(() => getPluginRequestContext({})).toThrow(
      'getPluginRequestContext requires a Hono context with c.get(name)',
    );
  });

  it('wraps session, agent, model, and media bus calls with typed helpers', async () => {
    const unsubscribe = vi.fn();
    const request = vi.fn(async (type: string, payload: unknown) => {
      if (type === 'session:create') return { sessionPath: '/s/new.jsonl', agentId: 'agent-a' };
      if (type === 'session:get') return { session: { path: (payload as any).sessionPath } };
      if (type === 'session:list') return { sessions: [] };
      if (type === 'session:update') return { ok: true, session: { path: (payload as any).sessionPath } };
      if (type === 'session:send') return { accepted: true, sessionPath: (payload as any).sessionPath };
      if (type === 'agent:list') return { agents: [] };
      if (type === 'agent:profile') return { profile: { id: (payload as any).agentId, name: 'A' } };
      if (type === 'agent:create') return { agent: { id: 'plugin-agent', name: 'Plugin Agent' } };
      if (type === 'agent:update') return { ok: true, agent: { id: (payload as any).agentId } };
      if (type === 'model:sample-text') return { text: 'sample' };
      if (type === 'provider:media-providers') return { providers: {} };
      if (type === 'provider:resolve-media-model') return { providerId: 'openai', modelId: 'gpt-image-1', protocolId: 'openai-images' };
      if (type === 'media:generate-image') return { ok: true, batchId: 'batch-1' };
      if (type === 'media:generate-video') return { ok: true, batchId: 'batch-video' };
      if (type === 'media:generate') return { ok: true, batchId: 'batch-media' };
      if (type === 'media:transcribe-audio') return { status: 'ready', text: 'hello' };
      throw new Error(type);
    });
    const subscribe = vi.fn(() => unsubscribe);
    const ctx = { pluginId: 'tavern', bus: { request, subscribe } };

    await createSession(ctx as any, { agentId: 'agent-a', kind: 'tavern', visibility: 'plugin_private' });
    await getSession(ctx as any, '/s/new.jsonl');
    await listSessions(ctx as any, { ownerPluginId: 'tavern' });
    await updateSession(ctx as any, '/s/new.jsonl', { pinned: true });
    await sendSessionMessage(ctx as any, '/s/new.jsonl', {
      text: 'hello',
      context: { beforeUser: 'world lore' },
    });
    subscribeSessionEvents(ctx as any, '/s/new.jsonl', () => {});
    await listAgents(ctx as any, { includePluginPrivate: true });
    await getAgentProfile(ctx as any, 'agent-a');
    await createAgent(ctx as any, { name: 'Plugin Agent', visibility: 'plugin_private' });
    await updateAgent(ctx as any, 'plugin-agent', { visibility: 'public' });
    await sampleText(ctx as any, { messages: [{ role: 'user', content: 'sample' }] });
    await listMediaProviders(ctx as any, { capability: 'image_generation' });
    await resolveMediaModel(ctx as any, { providerId: 'openai', modelId: 'gpt-image-1' });
    await generateImage(ctx as any, { sessionPath: '/s/new.jsonl', prompt: 'a quiet room' });
    await generateVideo(ctx as any, { sessionPath: '/s/new.jsonl', prompt: 'a quiet room in motion' });
    await generateMedia(ctx as any, { kind: 'image', sessionPath: '/s/new.jsonl', prompt: 'a quiet room' });
    const transcription = await transcribeAudio(ctx as any, { sessionPath: '/s/new.jsonl', fileId: 'file-audio' });

    expect(request).toHaveBeenCalledWith('session:create', {
      agentId: 'agent-a',
      kind: 'tavern',
      visibility: 'plugin_private',
      ownerPluginId: 'tavern',
    }, undefined);
    expect(request).toHaveBeenCalledWith('session:send', {
      sessionPath: '/s/new.jsonl',
      text: 'hello',
      context: { beforeUser: 'world lore', metadata: { pluginId: 'tavern' } },
    }, undefined);
    expect(subscribe).toHaveBeenCalledWith(expect.any(Function), {
      sessionPath: '/s/new.jsonl',
    });
    expect(request).toHaveBeenCalledWith('agent:create', {
      name: 'Plugin Agent',
      visibility: 'plugin_private',
      ownerPluginId: 'tavern',
    }, undefined);
    expect(request).toHaveBeenCalledWith('media:generate-image', {
      sessionPath: '/s/new.jsonl',
      prompt: 'a quiet room',
      pluginId: 'tavern',
    }, undefined);
    expect(request).toHaveBeenCalledWith('media:generate-video', {
      sessionPath: '/s/new.jsonl',
      prompt: 'a quiet room in motion',
      pluginId: 'tavern',
    }, undefined);
    expect(request).toHaveBeenCalledWith('media:generate', {
      kind: 'image',
      sessionPath: '/s/new.jsonl',
      prompt: 'a quiet room',
      pluginId: 'tavern',
    }, undefined);
    expect(request).toHaveBeenCalledWith('media:transcribe-audio', {
      sessionPath: '/s/new.jsonl',
      fileId: 'file-audio',
      pluginId: 'tavern',
    }, undefined);
    expect(transcription).toEqual({
      ok: true,
      transcription: { status: 'ready', text: 'hello' },
    });
  });

  it('supports sessionId-first session helper targets while preserving legacy path targets', async () => {
    const request = vi.fn(async (type: string, payload: unknown) => {
      if (type === 'session:get') return { session: { sessionId: (payload as any).sessionId } };
      if (type === 'session:update') return { ok: true, sessionId: (payload as any).sessionId };
      if (type === 'session:send') return { accepted: true, sessionId: (payload as any).sessionId };
      throw new Error(type);
    });
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((callback: (event: unknown, sessionPath?: string | null) => void) => {
      callback({ type: 'session_event', sessionId: 'sess_plugin_1' }, '/sessions/current.jsonl');
      return unsubscribe;
    });
    const ctx = { pluginId: 'tavern', bus: { request, subscribe } };
    const target = {
      sessionId: 'sess_plugin_1',
      sessionPath: '/sessions/current.jsonl',
      legacySessionPath: '/sessions/legacy.jsonl',
    };
    const events: unknown[] = [];

    await getSession(ctx as any, target as any);
    await updateSession(ctx as any, target as any, { pinned: true });
    await sendSessionMessage(ctx as any, target as any, { text: 'hello' });
    subscribeSessionEvents(ctx as any, target as any, (event, meta) => {
      events.push({ event, meta });
    });

    expect(request).toHaveBeenCalledWith('session:get', {
      sessionId: 'sess_plugin_1',
      sessionPath: '/sessions/current.jsonl',
      legacySessionPath: '/sessions/legacy.jsonl',
      sessionRef: target,
    }, undefined);
    expect(request).toHaveBeenCalledWith('session:update', {
      sessionId: 'sess_plugin_1',
      sessionPath: '/sessions/current.jsonl',
      legacySessionPath: '/sessions/legacy.jsonl',
      sessionRef: target,
      pinned: true,
      ownerPluginId: 'tavern',
    }, undefined);
    expect(request).toHaveBeenCalledWith('session:send', {
      sessionId: 'sess_plugin_1',
      sessionPath: '/sessions/current.jsonl',
      legacySessionPath: '/sessions/legacy.jsonl',
      sessionRef: target,
      text: 'hello',
      context: { metadata: { pluginId: 'tavern' } },
    }, undefined);
    expect(subscribe).toHaveBeenCalledWith(expect.any(Function), {
      sessionId: 'sess_plugin_1',
      sessionPath: '/sessions/current.jsonl',
      legacySessionPath: '/sessions/legacy.jsonl',
      sessionRef: target,
    });
    expect(events).toEqual([{
      event: { type: 'session_event', sessionId: 'sess_plugin_1' },
      meta: {
        sessionId: 'sess_plugin_1',
        sessionPath: '/sessions/current.jsonl',
        sessionRef: target,
      },
    }]);
  });

  it('passes response delivery media helper calls without requiring sessionPath', async () => {
    const request = vi.fn(async (
      _type: string,
      _payload?: unknown,
      _options?: Record<string, unknown>,
    ) => ({ ok: true, tasks: [{ taskId: 'task-response' }] }));
    const bus = {
      request: <T = unknown>(
        type: string,
        payload?: unknown,
        options?: Record<string, unknown>,
      ) => request(type, payload, options) as Promise<T>,
    };
    const ctx = { pluginId: 'tavern', bus };

    await generateImage(ctx, {
      prompt: 'an icon',
      delivery: { mode: 'response' },
    });
    await generateVideo(ctx, {
      prompt: 'a motion icon',
      delivery: { mode: 'response' },
    });
    await generateMedia(ctx, {
      kind: 'image',
      prompt: 'a generic icon',
      delivery: { mode: 'response' },
    });

    expect(request).toHaveBeenCalledWith('media:generate-image', {
      prompt: 'an icon',
      delivery: { mode: 'response' },
      pluginId: 'tavern',
    }, undefined);
    expect(request).toHaveBeenCalledWith('media:generate-video', {
      prompt: 'a motion icon',
      delivery: { mode: 'response' },
      pluginId: 'tavern',
    }, undefined);
    expect(request).toHaveBeenCalledWith('media:generate', {
      kind: 'image',
      prompt: 'a generic icon',
      delivery: { mode: 'response' },
      pluginId: 'tavern',
    }, undefined);
  });

  it('wraps task bus calls with typed helper payloads', async () => {
    const request = vi.fn(async (type: string) => {
      if (type === 'task:cancel') return { result: 'aborted', canceled: true };
      if (type === 'task:schedule') return { ok: true, schedule: { scheduleId: 'daily', type: 'digest' } };
      if (type === 'task:unschedule') return { ok: true, removed: true };
      return { ok: true, task: { taskId: 't1', type: 'render', status: 'running' } };
    });
    const ctx = { bus: { request } };

    await registerTask(ctx as any, { taskId: 't1', type: 'render', parentSessionPath: '/s/a' });
    await updateTask(ctx as any, { taskId: 't1', progress: { current: 1, total: 2 } });
    await completeTask(ctx as any, 't1', { ok: true });
    await failTask(ctx as any, 't1', 'nope');
    await cancelTask(ctx as any, 't1', 'user');
    await scheduleTask(ctx as any, { scheduleId: 'daily', type: 'digest', intervalMs: 60_000 });
    await unscheduleTask(ctx as any, 'daily');

    expect(request).toHaveBeenCalledWith('task:register', { taskId: 't1', type: 'render', parentSessionPath: '/s/a' }, undefined);
    expect(request).toHaveBeenCalledWith('task:update', { taskId: 't1', progress: { current: 1, total: 2 } }, undefined);
    expect(request).toHaveBeenCalledWith('task:complete', { taskId: 't1', result: { ok: true } }, undefined);
    expect(request).toHaveBeenCalledWith('task:fail', { taskId: 't1', error: 'nope' }, undefined);
    expect(request).toHaveBeenCalledWith('task:cancel', { taskId: 't1', reason: 'user' }, undefined);
    expect(request).toHaveBeenCalledWith('task:schedule', { scheduleId: 'daily', type: 'digest', intervalMs: 60_000 }, undefined);
    expect(request).toHaveBeenCalledWith('task:unschedule', { scheduleId: 'daily' }, undefined);
  });

  it('wraps usage list and live usage subscriptions with typed helpers', async () => {
    const request = vi.fn(async () => ({
      entries: [{ requestId: 'req-1', schemaVersion: 1 }],
      nextCursor: null,
    }));
    const subscribe = vi.fn((callback: (event: unknown, sessionPath?: string | null) => void, filter?: unknown) => {
      callback({
        type: 'llm_usage',
        entry: {
          requestId: 'req-2',
          attribution: {
            kind: 'session',
            sessionId: 'sess_usage_plugin',
            sessionPath: '/sessions/a.jsonl',
          },
        },
      }, '/sessions/a.jsonl');
      return () => {};
    });
    const ctx = { bus: { request, subscribe } };
    const events: unknown[] = [];

    await expect(listUsageEntries(ctx as any, { limit: 25 })).resolves.toEqual({
      entries: [{ requestId: 'req-1', schemaVersion: 1 }],
      nextCursor: null,
    });
    subscribeUsageEvents(ctx as any, (entry, meta) => {
      events.push({ entry, meta });
    });

    expect(request).toHaveBeenCalledWith('usage:list', { limit: 25 }, undefined);
    expect(subscribe).toHaveBeenCalledWith(expect.any(Function), { types: ['llm_usage'] });
    expect(events).toEqual([
      {
        entry: {
          requestId: 'req-2',
          attribution: {
            kind: 'session',
            sessionId: 'sess_usage_plugin',
            sessionPath: '/sessions/a.jsonl',
          },
        },
        meta: {
          sessionId: 'sess_usage_plugin',
          sessionPath: '/sessions/a.jsonl',
          sessionRef: {
            sessionId: 'sess_usage_plugin',
            sessionPath: '/sessions/a.jsonl',
          },
        },
      },
    ]);
  });

  it('converts SessionFile records into structured media items', () => {
    expect(sessionFileToMediaItem({
      id: 'sf_1',
      fileId: 'sf_file_id',
      sessionId: 'sess_plugin_media',
      sessionPath: '/sessions/demo.jsonl',
      filePath: '/tmp/demo.png',
      displayName: 'demo image',
      mime: 'image/png',
      kind: 'image',
    })).toEqual({
      type: 'session_file',
      fileId: 'sf_file_id',
      sessionId: 'sess_plugin_media',
      sessionPath: '/sessions/demo.jsonl',
      filePath: '/tmp/demo.png',
      label: 'demo image',
      mime: 'image/png',
      kind: 'image',
    });
  });

  it('requires SessionFile media items to carry an explicit file identity', () => {
    expect(() => sessionFileToMediaItem({
      sessionPath: '/sessions/demo.jsonl',
      filePath: '/tmp/demo.png',
    })).toThrow('SessionFile media item requires id or fileId');
  });

  it('creates media details from staged files, media items, and SessionFile records', () => {
    expect(createMediaDetails([
      { mediaItem: { type: 'session_file', fileId: 'sf_staged', sessionPath: '/sessions/demo.jsonl' } },
      { type: 'session_file', fileId: 'sf_direct', sessionPath: '/sessions/demo.jsonl' },
      { id: 'sf_record', sessionId: 'sess_plugin_media', sessionPath: '/sessions/demo.jsonl', filename: 'result.txt' },
    ])).toEqual({
      media: {
        items: [
          { type: 'session_file', fileId: 'sf_staged', sessionPath: '/sessions/demo.jsonl' },
          { type: 'session_file', fileId: 'sf_direct', sessionPath: '/sessions/demo.jsonl' },
          {
            type: 'session_file',
            fileId: 'sf_record',
            sessionId: 'sess_plugin_media',
            sessionPath: '/sessions/demo.jsonl',
            label: 'result.txt',
          },
        ],
      },
    });
  });

  it('creates declarative chat surface cards from session refs', () => {
    expect(createChatSurfaceCard(
      { pluginId: 'tavern' },
      { sessionId: 'sess_private', sessionPath: '/sessions/tavern.jsonl' },
      { title: 'Tavern run', description: 'Private transcript' },
    )).toEqual({
      type: 'chat.surface',
      pluginId: 'tavern',
      sessionId: 'sess_private',
      sessionPath: '/sessions/tavern.jsonl',
      sessionRef: {
        sessionId: 'sess_private',
        sessionPath: '/sessions/tavern.jsonl',
      },
      title: 'Tavern run',
      description: 'Private transcript',
      mode: 'transcript',
    });
  });

  it('requires chat surface cards to use session identity, not path-only locators', () => {
    expect(() => createChatSurfaceCard({ pluginId: 'tavern' }, '/sessions/legacy.jsonl')).toThrow(
      'createChatSurfaceCard requires sessionId or sessionRef',
    );
  });
});
