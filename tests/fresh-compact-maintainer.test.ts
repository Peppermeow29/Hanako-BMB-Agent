import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateAgentPhoneProjectionMeta } from "../lib/conversations/agent-phone-projection.ts";

import { FreshCompactMaintainer } from "../hub/fresh-compact-maintainer.ts";

let rootDir;

function makeAgent(id = "agent-a") {
  const agentDir = path.join(rootDir, "agents", id);
  const sessionDir = path.join(rootDir, "sessions", id);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  return { id, agentDir, sessionDir } as any;
}

describe("FreshCompactMaintainer", () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-maintainer-"));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("runs stale bridge fresh-compacts and leaves stale phone sessions alone", async () => {
    const agent = makeAgent();
    const bridgeFile = path.join(agent.sessionDir, "bridge", "owner", "owner.jsonl");
    fs.mkdirSync(path.dirname(bridgeFile), { recursive: true });
    fs.writeFileSync(bridgeFile, "", "utf-8");
    agent.memoryTicker = {
      flushSessionAndCompile: vi.fn(async () => {}),
    };
    const phoneFile = path.join(agent.agentDir, "phone", "sessions", "ch_crew", "phone.jsonl");
    fs.mkdirSync(path.dirname(phoneFile), { recursive: true });
    fs.writeFileSync(phoneFile, "", "utf-8");
    await updateAgentPhoneProjectionMeta({
      agentDir: agent.agentDir,
      agentId: agent.id,
      conversationId: "ch_crew",
      conversationType: "channel",
      patch: {
        phoneSessionFile: path.relative(agent.agentDir, phoneFile).split(path.sep).join("/"),
        lastFreshCompactDate: "2026-05-14",
      },
    });

    const bridgeSessionManager = {
      listDailyFreshCompactTargets: vi.fn(() => [{ sessionKey: "tg_dm_owner", sessionPath: bridgeFile }]),
      freshCompactSession: vi.fn(async () => ({ fresh: true })),
    };
    const engine = {
      agents: new Map([[agent.id, agent]]),
      getAgent: (id) => (id === agent.id ? agent : null),
      bridgeSessionManager,
    };
    const maintainer = new FreshCompactMaintainer({
      hub: { engine },
      delayBetweenJobsMs: 0,
    });
    const now = new Date(2026, 4, 15, 4, 10);

    const result = await maintainer.runDaily({ now });

    expect(bridgeSessionManager.listDailyFreshCompactTargets).toHaveBeenCalledWith(agent, { now });
    expect(agent.memoryTicker.flushSessionAndCompile).toHaveBeenCalledWith(bridgeFile);
    expect(bridgeSessionManager.freshCompactSession).toHaveBeenCalledWith("tg_dm_owner", {
      agentId: agent.id,
      reason: "daily",
      now,
    });
    expect(agent.memoryTicker.flushSessionAndCompile.mock.invocationCallOrder[0])
      .toBeLessThan(bridgeSessionManager.freshCompactSession.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({
      bridgeCompacted: 1,
      phoneCompacted: 0,
      failed: 0,
      staleRemaining: 0,
    });
  });

  it("marks an already-compacted stale bridge target without flushing memory first", async () => {
    const agent = makeAgent();
    const bridgeFile = path.join(agent.sessionDir, "bridge", "owner", "already.jsonl");
    fs.mkdirSync(path.dirname(bridgeFile), { recursive: true });
    fs.writeFileSync(bridgeFile, JSON.stringify({ type: "compaction", summary: "done" }) + "\n", "utf-8");
    agent.memoryTicker = {
      flushSessionAndCompile: vi.fn(async () => {}),
    };

    const bridgeSessionManager = {
      listDailyFreshCompactTargets: vi.fn(() => [{ sessionKey: "tg_dm_already", sessionPath: bridgeFile }]),
      isFreshCompactAlreadySatisfied: vi.fn(() => ({ satisfied: true, reason: "already_compacted" })),
      markFreshCompactSatisfied: vi.fn(async () => ({ fresh: true, noop: true })),
      freshCompactSession: vi.fn(async () => ({ fresh: true })),
    };
    const engine = {
      agents: new Map([[agent.id, agent]]),
      getAgent: (id) => (id === agent.id ? agent : null),
      bridgeSessionManager,
    };
    const maintainer = new FreshCompactMaintainer({
      hub: { engine },
      delayBetweenJobsMs: 0,
    });
    const now = new Date(2026, 4, 15, 4, 10);

    const result = await maintainer.runDaily({ now });

    expect(bridgeSessionManager.isFreshCompactAlreadySatisfied).toHaveBeenCalledWith("tg_dm_already", {
      agentId: agent.id,
      sessionPath: bridgeFile,
    });
    expect(bridgeSessionManager.markFreshCompactSatisfied).toHaveBeenCalledWith("tg_dm_already", {
      agentId: agent.id,
      now,
      reason: "daily",
      noopReason: "already_compacted",
    });
    expect(agent.memoryTicker.flushSessionAndCompile).not.toHaveBeenCalled();
    expect(bridgeSessionManager.freshCompactSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({ bridgeCompacted: 1, failed: 0, staleRemaining: 0 });
  });
});
