import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  PluginConfigValidationError,
  createPluginConfigStore,
  normalizePluginConfigSchema,
} from "../core/plugin-config.ts";

describe.skipIf(process.platform === "win32")("plugin config storage", () => {
  // Plugin configuration can hold connector and third-party service
  // credentials, so it is written under the same contract as the other
  // credential stores rather than with the generic writer.
  it("keeps the configuration file readable only by its owner", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-config-"));
    try {
      const schema = normalizePluginConfigSchema("demo", {
        properties: { token: { type: "string", sensitive: true } },
      });
      const store = createPluginConfigStore({ dataDir: dir, schema });
      const configPath = path.join(dir, "config.json");

      store.set("token", "abc");
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);

      // A file left open by an older version is tightened by the next write.
      fs.chmodSync(configPath, 0o644);
      store.set("token", "def");
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plugin config schema", () => {
  it("normalizes fields and materializes global defaults", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-config-"));
    try {
      const schema = normalizePluginConfigSchema("demo", {
        properties: {
          enabled: { type: "boolean", default: true, title: "Enabled" },
          token: { type: "string", sensitive: true },
        },
      });
      const store = createPluginConfigStore({ dataDir: dir, schema });

      expect(store.get("enabled")).toBe(true);
      store.set("token", "abc");
      expect(store.getAll({ redacted: true })).toEqual({ enabled: true, token: "********" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid type writes with field errors", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-config-"));
    try {
      const schema = normalizePluginConfigSchema("demo", {
        properties: {
          interval: { type: "integer" },
        },
      });
      const store = createPluginConfigStore({ dataDir: dir, schema });

      expect(() => store.set("interval", 1.5)).toThrow(PluginConfigValidationError);
      try {
        store.set("interval", 1.5);
      } catch (err) {
        expect(err.errors[0]).toMatchObject({ key: "interval", code: "INVALID_TYPE" });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps scoped values in their own keyed containers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-config-"));
    try {
      const schema = normalizePluginConfigSchema("demo", {
        properties: {
          agentMode: { type: "string", scope: "per-agent" },
        },
      });
      const store = createPluginConfigStore({ dataDir: dir, schema });

      store.set("agentMode", "strict", { scope: "per-agent", agentId: "hanako" });

      expect(store.get("agentMode", { scope: "per-agent", agentId: "hanako" })).toBe("strict");
      expect(store.getState()).toMatchObject({
        agents: {
          hanako: { agentMode: "strict" },
        },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses sessionId for per-session config while reading legacy sessionPath buckets", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-config-"));
    try {
      const schema = normalizePluginConfigSchema("demo", {
        properties: {
          sessionMode: { type: "string", scope: "per-session" },
        },
      });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
        schemaVersion: 1,
        global: {},
        agents: {},
        sessions: {
          "/sessions/legacy.jsonl": { sessionMode: "legacy" },
        },
      }), "utf-8");
      const store = createPluginConfigStore({ dataDir: dir, schema });

      expect(store.get("sessionMode", {
        scope: "per-session",
        sessionId: "sess_config",
        sessionPath: "/sessions/legacy.jsonl",
      })).toBe("legacy");

      store.set("sessionMode", "modern", {
        scope: "per-session",
        sessionId: "sess_config",
        sessionPath: "/sessions/legacy.jsonl",
      });

      expect(store.get("sessionMode", {
        scope: "per-session",
        sessionId: "sess_config",
      })).toBe("modern");
      expect(store.getState()).toMatchObject({
        sessions: {
          sess_config: { sessionMode: "modern" },
          "/sessions/legacy.jsonl": { sessionMode: "legacy" },
        },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forks raw per-session values, including sensitive fields, into an independent bucket", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-config-fork-"));
    try {
      const schema = normalizePluginConfigSchema("demo", {
        properties: {
          sessionMode: { type: "object", scope: "per-session" },
          sessionToken: { type: "string", scope: "per-session", sensitive: true },
        },
      });
      const store = createPluginConfigStore({ dataDir: dir, schema });
      store.setMany({
        sessionMode: { nested: ["source"] },
        sessionToken: "secret-source",
      }, { scope: "per-session", sessionId: "sess-source" });

      expect(store.forkSession({
        sourceSessionId: "sess-source",
        targetSessionId: "sess-child",
      })).toMatchObject({ copied: true, targetSessionId: "sess-child" });
      expect(store.getAll({ scope: "per-session", sessionId: "sess-child" })).toEqual({
        sessionMode: { nested: ["source"] },
        sessionToken: "secret-source",
      });

      store.set("sessionMode", { nested: ["child"] }, {
        scope: "per-session",
        sessionId: "sess-child",
      });
      expect(store.get("sessionMode", {
        scope: "per-session",
        sessionId: "sess-source",
      })).toEqual({ nested: ["source"] });
      expect(store.discardSession({ sessionId: "sess-child" })).toBe(true);
      expect(store.getState().sessions).not.toHaveProperty("sess-child");
      expect(store.getState().sessions).toHaveProperty("sess-source");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forks a legacy sessionPath bucket into the child sessionId without changing the source", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-config-fork-legacy-"));
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
        schemaVersion: 1,
        global: {},
        agents: {},
        sessions: { "/sessions/source.jsonl": { legacy: true } },
      }));
      const store = createPluginConfigStore({
        dataDir: dir,
        schema: normalizePluginConfigSchema("demo", {}),
      });

      expect(store.forkSession({
        sourceSessionId: "sess-source",
        sourceSessionPath: "/sessions/source.jsonl",
        targetSessionId: "sess-child",
      })).toMatchObject({ copied: true, sourceKey: "/sessions/source.jsonl" });
      expect(store.getState().sessions).toEqual({
        "/sessions/source.jsonl": { legacy: true },
        "sess-child": { legacy: true },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads old flat config files as global config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-config-"));
    try {
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ oldKey: "old" }), "utf-8");
      const store = createPluginConfigStore({
        dataDir: dir,
        schema: normalizePluginConfigSchema("demo", {}),
      });

      expect(store.get("oldKey")).toBe("old");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes optional keys when a patch value is undefined", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-config-"));
    try {
      const schema = normalizePluginConfigSchema("image-gen", {
        properties: {
          defaultImageModel: { type: "object" },
          providerDefaults: { type: "object" },
        },
      });
      const store = createPluginConfigStore({ dataDir: dir, schema });

      store.set("defaultImageModel", { id: "gpt-image-1", provider: "openai" });
      store.setMany({
        defaultImageModel: undefined,
        providerDefaults: { openai: { size: "1024x1024" } },
      });

      expect(store.getAll()).toEqual({
        providerDefaults: { openai: { size: "1024x1024" } },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
