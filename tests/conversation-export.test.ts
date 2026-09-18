import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendMessage, createChannel } from "../lib/channels/channel-store.ts";
import { buildConversationMarkdownExport } from "../lib/channels/conversation-export.ts";

describe("current conversation Markdown export", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-conversation-export-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("exports only the selected group channel", async () => {
    const channelsDir = path.join(root, "channels");
    const selected = await createChannel(channelsDir, {
      id: "family",
      name: "Family",
      description: "",
      members: ["alice", "bob"],
      intro: "",
    });
    const other = await createChannel(channelsDir, {
      id: "other",
      name: "Other",
      description: "",
      members: ["alice", "bob"],
      intro: "",
    });
    await appendMessage(selected.filePath, "alice", "selected message");
    await appendMessage(other.filePath, "bob", "unrelated message");

    const result = await buildConversationMarkdownExport({
      filePath: selected.filePath,
      type: "channel",
      conversationId: "ch_family",
      displayName: "家庭群聊",
      now: new Date("2026-07-13T01:02:03.456Z"),
    });

    expect(result.filename).toBe("hana-channel-家庭群聊-2026-07-13T01-02-03-456Z.md");
    expect(result.messageCount).toBe(1);
    expect(result.markdown).toContain("selected message");
    expect(result.markdown).not.toContain("unrelated message");
  });

  it("exports only the selected DM owner copy", async () => {
    const selected = path.join(root, "agents", "alice", "dm", "bob.md");
    const other = path.join(root, "agents", "alice", "dm", "carol.md");
    fs.mkdirSync(path.dirname(selected), { recursive: true });
    await appendMessage(selected, "alice", "private with bob");
    await appendMessage(other, "alice", "private with carol");

    const result = await buildConversationMarkdownExport({
      filePath: selected,
      type: "dm",
      conversationId: "dm:bob",
      displayName: "Bob",
      ownerAgentId: "alice",
      peerAgentId: "bob",
      now: new Date("2026-07-13T01:02:03.456Z"),
    });

    expect(result.filename).toBe("hana-dm-alice-bob-2026-07-13T01-02-03-456Z.md");
    expect(result.markdown).toContain("private with bob");
    expect(result.markdown).not.toContain("private with carol");
  });

  it("fails explicitly when the selected conversation record is missing", async () => {
    await expect(buildConversationMarkdownExport({
      filePath: path.join(root, "missing.md"),
      type: "channel",
      conversationId: "ch_missing",
    })).rejects.toMatchObject({ code: "ENOENT" });
  });
});
