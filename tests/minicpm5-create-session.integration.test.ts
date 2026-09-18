import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AuthStorage,
  SettingsManager,
  SessionManager,
  createAgentSession,
  createModelRegistry,
} from "../lib/pi-sdk/index.ts";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("MiniCPM5 createAgentSession integration", () => {
  it("uses the compact prompt, sequential tools, and persisted thinking off", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-minicpm5-session-"));
    tempRoots.push(root);
    const authStorage = AuthStorage.inMemory({});
    const modelRegistry = createModelRegistry(authStorage, undefined);
    const sessionManager = SessionManager.inMemory(path.join(root, "CodeLife"));
    const settingsManager = SettingsManager.inMemory({});
    const model = {
      provider: "minicpm5-local",
      id: "default_model",
      name: "MiniCPM5-2B",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8080/v1",
      input: ["text"],
      reasoning: false,
      contextWindow: 65_536,
      maxTokens: 4_096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };

    const { session } = await createAgentSession({
      cwd: path.join(root, "CodeLife"),
      agentDir: root,
      sessionManager,
      settingsManager,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: "medium",
      miniCPM5SystemPrompt: "COMPACT_MINICPM5_PROMPT",
      tools: [],
      customTools: [],
    });

    expect(session.model.provider).toBe("minicpm5-local");
    expect(session.model.contextWindow).toBe(32_768);
    expect(session.thinkingLevel).toBe("off");
    expect(session.agent.state.thinkingLevel).toBe("off");
    expect(session.agent.state.systemPrompt).toBe("COMPACT_MINICPM5_PROMPT");
    expect(session.agent.toolExecution).toBe("sequential");
    expect(session.agent.transformContext).toEqual(expect.any(Function));

    const persisted = sessionManager.buildSessionContext();
    expect(persisted.thinkingLevel).toBe("off");
    await session.dispose();
  });
});
