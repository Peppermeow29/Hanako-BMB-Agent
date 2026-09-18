import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function runAudit(root: string) {
  const output = execFileSync(
    process.execPath,
    ["scripts/session-path-identity-audit.mjs", root, "--json"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return JSON.parse(output);
}

function runAuditProcess(root: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    ["scripts/session-path-identity-audit.mjs", root, ...args],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}

describe("session path identity audit", () => {
  it("flags path-keyed storage but allows identity adapter lookups", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-audit-"));
    fs.writeFileSync(path.join(dir, "path-cache.ts"), `
      const sessionCache = new Map();
      sessionCache.set(sessionPath, value);
    `);
    fs.writeFileSync(path.join(dir, "adapter.ts"), `
      const key = sessionScopedKey(state, sessionPath);
      const value = sessionScopedValue(state, valuesBySession, sessionPath);
    `);

    const report = runAudit(dir);
    const risks = report.identityRisk.map((item: { file: string }) => path.basename(item.file));

    expect(risks).toContain("path-cache.ts");
    expect(risks).not.toContain("adapter.ts");
  });

  it("does not treat focus locators as path-keyed identity storage", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-audit-focus-"));
    fs.writeFileSync(path.join(dir, "focus.ts"), `
      get currentSessionPath() { return this._sessionCoord.currentSessionPath; }
      this._emitEvent(event, this.currentSessionPath);
    `);

    const report = runAudit(dir);

    expect(report.identityRisk).toEqual([]);
    expect(report.counts["focus-or-transport-locator"]).toBe(2);
  });

  it("separates approved identity boundary adapters from true path-keyed storage", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-audit-approved-"));
    const browserDir = path.join(dir, "lib", "browser");
    const appDir = path.join(dir, "core");
    fs.mkdirSync(browserDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(browserDir, "browser-manager.ts"), `
      function _sessionKeyForPath(sessionPath) {
        return getSessionIdForPath(sessionPath) || sessionPath;
      }
      const key = this._sessionKeyForPath(sessionPath);
      return this._sessions.get(key) || (key !== sessionPath ? this._sessions.get(sessionPath) : null);
    `);
    fs.writeFileSync(path.join(appDir, "real-risk.ts"), `
      const sessionsByPath = new Map();
      sessionsByPath.set(sessionPath, value);
    `);

    const report = runAudit(dir);
    const risks = report.identityRisk.map((item: { file: string }) => item.file);
    const approved = report.matches
      .filter((item: { category: string }) => item.category === "approved-identity-boundary")
      .map((item: { file: string }) => item.file);

    expect(risks.some((file: string) => file.endsWith("real-risk.ts"))).toBe(true);
    expect(risks.some((file: string) => file.endsWith("browser-manager.ts"))).toBe(false);
    expect(approved.some((file: string) => file.endsWith("browser-manager.ts"))).toBe(true);
  });

  it("fail-on-risk ignores approved identity boundaries but fails on true risks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-audit-fail-gate-"));
    const browserDir = path.join(dir, "lib", "browser");
    const appDir = path.join(dir, "core");
    fs.mkdirSync(browserDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(browserDir, "browser-manager.ts"), `
      const key = this._sessionKeyForPath(sessionPath);
      return this._sessions.get(key) || (key !== sessionPath ? this._sessions.get(sessionPath) : null);
    `);

    expect(runAuditProcess(dir, "--fail-on-risk").status).toBe(0);

    fs.writeFileSync(path.join(appDir, "real-risk.ts"), `
      const sessionCache = new Map();
      sessionCache.set(sessionPath, value);
    `);

    expect(runAuditProcess(dir, "--fail-on-risk").status).toBe(1);
  });

  it("does not confuse keyboard keys with session identity keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-audit-keyboard-"));
    const browserDir = path.join(dir, "lib", "browser");
    fs.mkdirSync(browserDir, { recursive: true });
    fs.writeFileSync(path.join(browserDir, "browser-manager.ts"), `
      async pressKey(key, sessionPath, tabId = null) {
        const params: any = { key, sessionPath };
        return this._sendSessionCmd("pressKey", params);
      }
    `);

    const report = runAudit(dir);

    expect(report.identityRisk).toEqual([]);
  });

  it("allows lease registries to key by sessionId with a path fallback during migration", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-audit-lease-"));
    const leaseDir = path.join(dir, "core", "computer-use");
    fs.mkdirSync(leaseDir, { recursive: true });
    fs.writeFileSync(path.join(leaseDir, "lease-registry.ts"), `
      function leaseOwnerKey(sessionId, sessionPath) {
        return sessionId || sessionPath || null;
      }
      this._leases.set(leaseKey(lease.sessionId, lease.sessionPath, lease.agentId, lease.leaseId), lease);
    `);

    const report = runAudit(dir);

    expect(report.identityRisk).toEqual([]);
    expect(report.counts["approved-identity-boundary"]).toBeGreaterThan(0);
  });

  it("does not flag its own audit rule literals as app identity risks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-audit-self-"));
    const scriptDir = path.join(dir, "scripts");
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.writeFileSync(path.join(scriptDir, "session-path-identity-audit.mjs"), `
      /this\\._sessions\\.get\\(key\\).*sessionPath/,
      /\\bpressKey\\(key,\\s*sessionPath\\b/,
    `);

    const report = runAudit(dir);

    expect(report.identityRisk).toEqual([]);
  });

  it("classifies __tests__ files as fixtures instead of app identity risks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-audit-vitest-fixtures-"));
    const testDir = path.join(dir, "desktop", "src", "react", "__tests__", "stores");
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, "session-fixture.test.ts"), `
      expect(state.selectedIdsBySession[sessionPath]).toEqual(["m1"]);
      streamBufferManager.handle({ type: "tool_start", sessionPath, id: "call_a" });
    `);

    const report = runAudit(dir);

    expect(report.identityRisk).toEqual([]);
    expect(report.counts["test-fixture"]).toBe(2);
  });

  it("allows input-slice sessionId-first attachment helpers while flagging unrelated path-keyed maps", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-audit-input-"));
    const inputDir = path.join(dir, "desktop", "src", "react", "stores");
    const appDir = path.join(dir, "desktop", "src", "react", "app");
    fs.mkdirSync(inputDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, "input-slice.ts"), `
      const key = inputSessionKey(state, sessionPath, sessionId);
      const files = state.attachedFilesBySession[key] || state.attachedFilesBySession[sessionPath];
      if (sessionPath && key !== sessionPath) delete patch.attachedFilesBySession?.[sessionPath];
      if (key !== sessionPath) delete drafts[sessionPath];
    `);
    fs.writeFileSync(path.join(appDir, "real-risk.ts"), `
      const attachmentsByPath = new Map();
      attachmentsByPath.set(sessionPath, files);
    `);

    const report = runAudit(dir);
    const risks = report.identityRisk.map((item: { file: string }) => item.file);
    const approved = report.matches
      .filter((item: { category: string }) => item.category === "approved-identity-boundary")
      .map((item: { file: string }) => item.file);

    expect(risks.some((file: string) => file.endsWith("real-risk.ts"))).toBe(true);
    expect(risks.some((file: string) => file.endsWith("input-slice.ts"))).toBe(false);
    expect(approved.some((file: string) => file.endsWith("input-slice.ts"))).toBe(true);
  });

  it("allows stream-resume identity resolver cleanup while flagging unrelated path-keyed maps", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-audit-stream-"));
    const serviceDir = path.join(dir, "desktop", "src", "react", "services");
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(path.join(serviceDir, "stream-resume.ts"), `
      const target = resolveStreamSession(msg);
      const key = target.key || target.sessionPath;
      if (target.sessionPath && key !== target.sessionPath) delete _sessionStreams[target.sessionPath];
      if (!target.key && !target.sessionPath) return true;
    `);
    fs.writeFileSync(path.join(serviceDir, "real-risk.ts"), `
      const streamMetaByPath = new Map();
      streamMetaByPath.set(sessionPath, meta);
    `);

    const report = runAudit(dir);
    const risks = report.identityRisk.map((item: { file: string }) => item.file);
    const approved = report.matches
      .filter((item: { category: string }) => item.category === "approved-identity-boundary")
      .map((item: { file: string }) => item.file);

    expect(risks.some((file: string) => file.endsWith("real-risk.ts"))).toBe(true);
    expect(risks.some((file: string) => file.endsWith("stream-resume.ts"))).toBe(false);
    expect(approved.some((file: string) => file.endsWith("stream-resume.ts"))).toBe(true);
  });

  it("flags path-keyed session-meta business reads but allows legacy migration boundaries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-audit-meta-"));
    const appDir = path.join(dir, "core");
    const legacyDir = path.join(dir, "core", "session-manifest");
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "new-business.ts"), `
      const metaEntry = meta[path.basename(sessionPath)];
      const rawEntry = raw[path.basename(sessionPath)];
      const restoredToolNames = meta[path.basename(sessionPathForMeta)]?.toolNames;
    `);
    fs.writeFileSync(path.join(legacyDir, "legacy-migration.ts"), `
      const metaEntry = meta[path.basename(sessionPath)];
    `);

    const report = runAudit(dir);
    const risks = report.identityRisk.map((item: { file: string }) => item.file);
    const legacy = report.matches
      .filter((item: { category: string }) => item.category === "legacy-session-meta-boundary")
      .map((item: { file: string }) => item.file);

    expect(risks.some((file: string) => file.endsWith("new-business.ts"))).toBe(true);
    expect(risks.some((file: string) => file.endsWith("legacy-migration.ts"))).toBe(false);
    expect(legacy.some((file: string) => file.endsWith("legacy-migration.ts"))).toBe(true);
  });

  it("allows verified sessionId-first runtime adapters while still flagging new path-keyed maps", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-audit-runtime-adapters-"));
    const files = {
      "lib/session-files/session-file-registry.ts": `
        const key = this._sessionKeyForPath(sessionPath, sessionId);
        const keys = sessionId
          ? new Set([sessionId])
          : new Set([entry.sessionPath, requestedSessionPath].filter(Boolean));
        return normalizeSessionId(sessionId) || this._resolveSessionIdForPath(sessionPath) || sessionPath;
      `,
      "core/vision-bridge.ts": `
        const existing = this._lookupNote(sessionPath, key);
        this._rememberNote(sessionPath, key, entry);
        if (sessionPath) this._persistNote(sessionPath, key, entry);
        for (const key of this._noteCacheKeys(sessionPath, imagePath)) {}
      `,
      "lib/memory/memory-ticker.ts": `
        return sessionIdFromFilename(path.basename(sessionPath));
        _turnCounts.set(_sessionIdentityForPath(sessionPath), 1);
      `,
      "lib/terminal/terminal-session-manager.ts": `
        const key = this._sessionKeyForPath(entry.sessionPath);
      `,
      "lib/session-files/bridge-inbound-files.ts": `
        const dir = sessionFilesCacheDir(hanakoHome, { sessionId, sessionPath });
      `,
      "lib/session-files/browser-screenshot-file.ts": `
        sessionFilesCacheDir(hanakoHome, { sessionId, sessionPath });
      `,
      "lib/sandbox/read-office-media.ts": `
        function officeMediaResourceKey({ sessionId, sessionPath, docxPath, index, mimeType, hash }) {}
        key: officeMediaResourceKey({ sessionId, sessionPath, docxPath, index: image.index, mimeType: image.mimeType, hash: image.hash });
        const dir = sessionFilesCacheDir(hanakoHome, { sessionId, sessionPath });
      `,
      "server/routes/upload.ts": `
        const sessionId = engine?.getSessionIdForPath?.(sessionPath) || null;
        dir: sessionFilesCacheDir(engine.hanakoHome, { sessionId, sessionPath });
      `,
      "core/engine.ts": `
        const key = this._sessionRuntimeKeyForPath(sessionPath);
        if (key !== sessionPath) this._uiContextBySession.delete(sessionPath);
        return this._uiContextBySession.get(key)
          || (key !== sessionPath ? this._uiContextBySession.get(sessionPath) : null)
          || null;
      `,
      "core/session-coordinator.ts": `
        log.warn(\`session runtime key lookup failed for \${path.basename(sessionPath || "")}: \${err?.message || err}\`);
        return this._sessions.get(key) || (key !== sessionPath ? this._sessions.get(sessionPath) : null) || null;
        if (key !== sessionPath) map.delete(sessionPath);
        return map.get(key) || (key !== sessionPath ? map.get(sessionPath) : null) || null;
        return map.has(key) || (key !== sessionPath && map.has(sessionPath));
      `,
      "core/migrations.ts": `
        function rememberChildSessionIdentity(sessionPath, identity, priority) {
          if (!sessionPath || !identity) return;
          childSessionCandidates.set(sessionPath, { identity, priority });
        }
        const sessionId = sessionIdFromFilename(path.basename(sessionPath));
      `,
      "server/routes/chat.ts": `
        const key = sessionStateKey(sessionPath);
        if (key !== sessionPath && sessionState.has(sessionPath) && !sessionState.has(key)) {
          sessionState.set(key, sessionState.get(sessionPath));
        }
      `,
      "lib/tools/browser-tool.ts": `
        const key = actionLogKey(sessionPath);
        const snapshot = await browser.pressKey(params.key, sessionPath, params.tabId || null);
        return toolOk(t("error.browserKeyPressed", { key: params.key, snapshot }), { action: "key", key: params.key, ...await statusFields(sessionPath) });
      `,
      "lib/tools/session-folders-tool.ts": `
        id: \`\${stableKey || sessionPath || "session"}:session_folders:\${Date.now()}\`,
      `,
      "desktop/src/react/stores/session-slice.ts": `
        return !!key && (list.includes(key) || (key !== sessionPath && list.includes(sessionPath)));
        const next = list.filter((item) => item !== key && item !== sessionPath);
        if (key !== sessionPath) delete next[sessionPath];
        (s.todosLiveVersionBySession[key] ?? s.todosLiveVersionBySession[sessionPath] ?? 0) + 1;
      `,
      "desktop/src/react/stores/selection-slice.ts": `
        toggleMessageSelection: (sessionPath, messageId) => set((s) => {
        setMessageSelection: (sessionPath, messageIds) => set((s) => {
        addMessagesToSelection: (sessionPath, messageIds) => set((s) => {
        clearSelection: (sessionPath) => set((s) => {
      `,
      "desktop/src/react/stores/computer-overlay-slice.ts": `
        setComputerOverlayForSession: (sessionPath, event) => set((state) => {
        if (key !== sessionPath) delete computerOverlayBySession[sessionPath];
        clearComputerOverlayForSession: (sessionPath) => set((state) => {
      `,
      "desktop/src/react/stores/browser-slice.ts": `
        if (key !== sessionPath) delete browserBySession[sessionPath];
      `,
      "desktop/src/react/stores/create-keyed-slice.ts": `
        if (key !== sessionPath) delete keyed[sessionPath];
      `,
      "desktop/src/react/stores/agent-activity-slice.ts": `
        if (!s.agentActivitiesBySession[key] && !s.agentActivitiesBySession[sessionPath]) return {};
      `,
      "core/agent.ts": `
        getBridgeContext: (sessionPath) => this._cb?.getEngine?.()?.getBridgeContextForSessionPath?.(sessionPath, { agentId: this.id }) || null,
      `,
      "core/slash-commands/rc-pending-handler.ts": `
        summary = await summarizeSessionForRc(engine, agent, sessionPath);
      `,
      "lib/browser/browser-manager.ts": `
        .map(([sessionPath, state]: [string, any]) => [sessionPath, state.url]),
      `,
      "lib/confirm-store.ts": `
        /** @type {Map<string, { resolve, timer, sessionId, sessionPath, kind, payload }>} */
      `,
      "lib/tools/current-status-tool.ts": `
        files: deps.listSessionFiles(sessionPath).map(normalizeSessionFile),
        ? deps.listOpenSubagentThreads(sessionPath).map(normalizeSubagentThread)
      `,
      "lib/tools/workflow-tool.ts": `
        hub?.upsert({ id: taskId, kind: "workflow", status: "running", sessionId: parentSessionId, sessionPath: parentSessionPath, agentId, summary, startedAt });
      `,
      "server/routes/sessions.ts": `
        || sessionIdFromFilename(path.basename(sessionPath));
      `,
      "desktop/src/react/components/ChannelsPanel.tsx": `
        const sessionPath = history.map(activitySessionPath).find((path): path is string => !!path) || null;
      `,
      "desktop/src/react/components/app/ChatPage.tsx": `
        <InputArea key={currentSessionPath || '__new'} surface={inputSurface} />
      `,
      "desktop/src/react/components/chat/AssistantMessage.tsx": `
        fn(message.id, sessionPath);
        }, [message.id, sessionPath]);
      `,
      "desktop/src/react/components/chat/SubagentSessionPreview.tsx": `
        export function SubagentSessionPreview({ taskId, sessionId = null, sessionPath, agentId, streamStatus, summary, scrollContainerRef }: Props) {}
      `,
      "desktop/src/react/components/chat/UserMessage.tsx": `
        message.textHtml && <MarkdownContent html={message.textHtml} linkContext={{ origin: 'session', sessionPath, messageId: message.id }} />
      `,
      "desktop/src/react/hooks/use-box-selection.ts": `
        setMessageSelection(sessionPath, Array.from(new Set([...drag.base, ...hit])));
        addMessagesToSelection(sessionPath, rangeIds(orderedIds, anchorRef.current, id));
        toggleMessageSelection(sessionPath, id);
      `,
      "desktop/src/react/services/ws-message-handler.ts": `
        useStore.getState().addStreamingSession(sessionPath, identity);
        : useStore.getState().removeStreamingSession(sessionPath, identity);
      `,
      "desktop/src/react/stores/message-turn-actions.ts": `
        if (!sessionPath || !message?.id) return false;
      `,
      "desktop/src/react/stores/selectors/file-refs.ts": `
        if (cached.sessionPath === sessionPath || cached.sessionKey === sessionPath) cachedSession.delete(key);
        cachedSession.set(cacheKey, { sessionPath, sessionKey, includeUnlisted, items, registryFiles, result });
      `,
      "desktop/src/react/stores/session-actions.ts": `
        if (key !== sessionPath) delete next[sessionPath];
        return sessionPath !== key && sessionPath !== path;
      `,
      "desktop/src/react/stores/session-project-actions.ts": `
        const pathSet = new Set(sessionPaths);
        sessions: state.sessions.map(session => session.path === sessionPath
      `,
      "desktop/src/react/stores/subagent-preview-slice.ts": `
        openSubagentPreview: (taskId, sessionPath = undefined) => set((s) => setEntry(s, taskId, current => ({})));
        setSubagentPreviewSessionPath: (taskId, sessionPath) => set((s) => setEntry(s, taskId, current => ({})));
      `,
      "desktop/src/react/hooks/use-stream-buffer.ts": `
        const key = bufferKeyForSession(sessionPath, sessionId);
        this.bufferKeysByPath.set(sessionPath, key);
        if (key !== sessionPath) {
          this.adoptBufferKey(sessionPath, key, buf);
          this.bufferKeysByPath.set(sessionPath, key);
        }
        if (key !== sessionPath) this.deleteBufferKey(sessionPath);
      `,
      "core/real-risk.ts": `
        const staleStateByPath = new Map();
        staleStateByPath.set(sessionPath, state);
      `,
    };
    for (const [relative, content] of Object.entries(files)) {
      const filePath = path.join(dir, relative);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }

    const report = runAudit(dir);
    const risks = report.identityRisk.map((item: { file: string }) => item.file);
    const approved = report.matches
      .filter((item: { category: string }) => item.category === "approved-identity-boundary")
      .map((item: { file: string }) => item.file);

    expect(risks.some((file: string) => file.endsWith("real-risk.ts"))).toBe(true);
    expect(risks.some((file: string) => file.endsWith("session-file-registry.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("vision-bridge.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("memory-ticker.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("terminal-session-manager.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("bridge-inbound-files.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("browser-screenshot-file.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("read-office-media.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("upload.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("engine.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("session-coordinator.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("migrations.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("chat.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("browser-tool.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("session-folders-tool.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("session-slice.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("selection-slice.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("computer-overlay-slice.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("browser-slice.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("create-keyed-slice.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("agent-activity-slice.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("agent.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("rc-pending-handler.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("browser-manager.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("confirm-store.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("current-status-tool.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("workflow-tool.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("sessions.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("ChannelsPanel.tsx"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("ChatPage.tsx"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("AssistantMessage.tsx"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("SubagentSessionPreview.tsx"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("UserMessage.tsx"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("use-box-selection.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("ws-message-handler.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("message-turn-actions.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("file-refs.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("session-actions.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("session-project-actions.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("subagent-preview-slice.ts"))).toBe(false);
    expect(risks.some((file: string) => file.endsWith("use-stream-buffer.ts"))).toBe(false);
    expect(approved).toEqual(expect.arrayContaining([
      expect.stringMatching(/session-file-registry\.ts$/),
      expect.stringMatching(/vision-bridge\.ts$/),
      expect.stringMatching(/memory-ticker\.ts$/),
      expect.stringMatching(/terminal-session-manager\.ts$/),
      expect.stringMatching(/bridge-inbound-files\.ts$/),
      expect.stringMatching(/browser-screenshot-file\.ts$/),
      expect.stringMatching(/read-office-media\.ts$/),
      expect.stringMatching(/upload\.ts$/),
      expect.stringMatching(/engine\.ts$/),
      expect.stringMatching(/session-coordinator\.ts$/),
      expect.stringMatching(/migrations\.ts$/),
      expect.stringMatching(/chat\.ts$/),
      expect.stringMatching(/browser-tool\.ts$/),
      expect.stringMatching(/session-folders-tool\.ts$/),
      expect.stringMatching(/session-slice\.ts$/),
      expect.stringMatching(/selection-slice\.ts$/),
      expect.stringMatching(/computer-overlay-slice\.ts$/),
      expect.stringMatching(/browser-slice\.ts$/),
      expect.stringMatching(/create-keyed-slice\.ts$/),
      expect.stringMatching(/agent-activity-slice\.ts$/),
      expect.stringMatching(/agent\.ts$/),
      expect.stringMatching(/rc-pending-handler\.ts$/),
      expect.stringMatching(/browser-manager\.ts$/),
      expect.stringMatching(/confirm-store\.ts$/),
      expect.stringMatching(/current-status-tool\.ts$/),
      expect.stringMatching(/workflow-tool\.ts$/),
      expect.stringMatching(/sessions\.ts$/),
      expect.stringMatching(/ChannelsPanel\.tsx$/),
      expect.stringMatching(/ChatPage\.tsx$/),
      expect.stringMatching(/AssistantMessage\.tsx$/),
      expect.stringMatching(/SubagentSessionPreview\.tsx$/),
      expect.stringMatching(/UserMessage\.tsx$/),
      expect.stringMatching(/use-box-selection\.ts$/),
      expect.stringMatching(/ws-message-handler\.ts$/),
      expect.stringMatching(/message-turn-actions\.ts$/),
      expect.stringMatching(/file-refs\.ts$/),
      expect.stringMatching(/session-actions\.ts$/),
      expect.stringMatching(/session-project-actions\.ts$/),
      expect.stringMatching(/subagent-preview-slice\.ts$/),
      expect.stringMatching(/use-stream-buffer\.ts$/),
    ]));
  });
});
