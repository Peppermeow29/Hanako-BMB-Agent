import { describe, expect, it } from "vitest";

describe("serializeSessionFile", () => {
  it("keeps legacy fields while adding a derived ResourceEnvelope when studioId is available", async () => {
    const { serializeSessionFile } = await import("../lib/session-files/session-file-response.ts");

    const serialized = serializeSessionFile({
      id: "sf_response",
      sessionId: "sess_response",
      sessionPath: "/tmp/agents/hana/sessions/main.jsonl",
      filePath: "/tmp/work/report.md",
      realPath: "/private/tmp/work/report.md",
      label: "report.md",
      displayName: "Report",
      filename: "report.md",
      ext: "md",
      mime: "text/markdown",
      size: 42,
      kind: "document",
      origin: "agent_write",
      operations: ["created"],
      storageKind: "external",
      presentation: "voice-input",
      listed: false,
      status: "available",
      missingAt: null,
      createdAt: 123,
      mtimeMs: 456,
    }, { studioId: "studio_response" });

    expect(serialized).toMatchObject({
      id: "sf_response",
      fileId: "sf_response",
      sessionId: "sess_response",
      sessionPath: "/tmp/agents/hana/sessions/main.jsonl",
      filePath: "/tmp/work/report.md",
      realPath: "/private/tmp/work/report.md",
      label: "report.md",
      mtimeMs: 456,
      size: 42,
      presentation: "voice-input",
      listed: false,
      version: { mtimeMs: 456, size: 42 },
      resource: {
        resourceId: "res_sf_response",
        name: "studios/studio_response/resources/res_sf_response",
        studioId: "studio_response",
        type: "file",
        source: "session_file",
        fileId: "sf_response",
      },
    });
  });

  it("does not add a ResourceEnvelope when space identity is unavailable", async () => {
    const { serializeSessionFile } = await import("../lib/session-files/session-file-response.ts");

    const serialized = serializeSessionFile({
      id: "sf_no_space",
      filePath: "/tmp/work/report.md",
    });

    expect(serialized.resource).toBeUndefined();
  });

  it("exposes fork aliases so unchanged history markers can resolve the child file", async () => {
    const { serializeSessionFile } = await import("../lib/session-files/session-file-response.ts");

    const serialized = serializeSessionFile({
      id: "sf_child",
      filePath: "/tmp/session-files/child/report.md",
      legacyFileIds: ["sf_parent"],
      legacyFilePaths: ["/tmp/session-files/parent/report.md"],
    });

    expect(serialized).toMatchObject({
      id: "sf_child",
      fileId: "sf_child",
      legacyFileIds: ["sf_parent"],
      legacyFilePaths: ["/tmp/session-files/parent/report.md"],
    });
  });
});
