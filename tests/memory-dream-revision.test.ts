import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDreamSections,
  createDreamRevision,
  listDreamRevisions,
  readDreamRevision,
  recoverPendingDreamApply,
  restoreDreamRevision,
  snapshotDreamSections,
} from "../lib/memory/dream/revision-store.ts";

function seed(memoryDir: string) {
  fs.mkdirSync(path.join(memoryDir, "daily"), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "facts.md"), "old facts\n");
  fs.writeFileSync(path.join(memoryDir, "today.md"), "old today\n");
  fs.writeFileSync(path.join(memoryDir, "daily", "2026-08-07.md"), "## 2026-08-07\n\nold day\n");
  fs.writeFileSync(path.join(memoryDir, "week.md"), "## 2026-08-07\n\nold day\n");
  fs.writeFileSync(path.join(memoryDir, "longterm.md"), "old longterm\n");
  fs.writeFileSync(path.join(memoryDir, "memory.md"), "old compiled\n");
}

describe("Memory Dream revisions", () => {
  let tmpDir: string;
  let memoryDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-dream-revision-"));
    memoryDir = path.join(tmpDir, "memory");
    seed(memoryDir);
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("applies only Facts/Longterm during Dream and restores a selected full snapshot", () => {
    const before = snapshotDreamSections(memoryDir);
    const todayBytes = fs.readFileSync(path.join(memoryDir, "today.md"));
    const dailyBytes = fs.readFileSync(path.join(memoryDir, "daily", "2026-08-07.md"));
    const weekBytes = fs.readFileSync(path.join(memoryDir, "week.md"));
    const revision = createDreamRevision(memoryDir, {
      runId: "run-1",
      trigger: "manual",
      before,
    });
    applyDreamSections(memoryDir, {
      revision,
      next: {
        facts: "new facts",
        today: before.today,
        weekDays: before.weekDays,
        longterm: "new longterm",
      },
    });

    expect(fs.existsSync(path.join(memoryDir, "dream", "pending-apply.json"))).toBe(false);
    expect(fs.readFileSync(path.join(memoryDir, "facts.md"), "utf-8")).toBe("new facts\n");
    expect(fs.readFileSync(path.join(memoryDir, "memory.md"), "utf-8")).toContain("new longterm");
    expect(fs.readFileSync(path.join(memoryDir, "today.md"))).toEqual(todayBytes);
    expect(fs.readFileSync(path.join(memoryDir, "daily", "2026-08-07.md"))).toEqual(dailyBytes);
    expect(fs.readFileSync(path.join(memoryDir, "week.md"))).toEqual(weekBytes);
    expect(snapshotDreamSections(memoryDir)).toMatchObject({
      today: before.today,
      weekDays: before.weekDays,
    });

    restoreDreamRevision(memoryDir, revision.revisionId);
    expect(snapshotDreamSections(memoryDir)).toEqual(before);
    expect(fs.existsSync(path.join(memoryDir, "dream", "pending-apply.json"))).toBe(false);

    const revisions = listDreamRevisions(memoryDir);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({
      kind: "pre_restore",
      restoresRevisionId: revision.revisionId,
    });

    restoreDreamRevision(memoryDir, revisions[0].revisionId);
    expect(snapshotDreamSections(memoryDir)).toMatchObject({
      facts: "new facts",
      today: "old today",
      longterm: "new longterm",
    });
  });

  it("does not create a redundant safety revision when the target is already current", () => {
    const before = snapshotDreamSections(memoryDir);
    const revision = createDreamRevision(memoryDir, {
      runId: "run-same",
      trigger: "manual",
      before,
    });

    restoreDreamRevision(memoryDir, revision.revisionId);

    expect(listDreamRevisions(memoryDir)).toHaveLength(1);
  });

  it("lists revision summaries and reads legacy v1 revisions without new metadata", () => {
    const before = snapshotDreamSections(memoryDir);
    const revisionsPath = path.join(memoryDir, "dream", "revisions");
    fs.mkdirSync(revisionsPath, { recursive: true });
    fs.writeFileSync(path.join(revisionsPath, "legacy.json"), JSON.stringify({
      schemaVersion: 1,
      revisionId: "legacy",
      runId: "legacy-run",
      trigger: "manual",
      createdAt: "2026-08-01T10:00:00.000Z",
      before,
    }));

    expect(readDreamRevision(memoryDir, "legacy")).toMatchObject({
      kind: "dream",
      restoresRevisionId: null,
    });
    expect(listDreamRevisions(memoryDir)).toEqual([
      expect.objectContaining({
        revisionId: "legacy",
        bodyChars: expect.any(Number),
        sectionChars: {
          facts: before.facts.length,
          today: before.today.length,
          week: before.weekDays.reduce((sum, entry) => sum + entry.body.length, 0),
          longterm: before.longterm.length,
        },
      }),
    ]);
  });

  it("recovers the pre-run revision from a crash journal", () => {
    const before = snapshotDreamSections(memoryDir);
    const revision = createDreamRevision(memoryDir, {
      runId: "run-crash",
      trigger: "automatic",
      before,
    });
    fs.writeFileSync(path.join(memoryDir, "facts.md"), "partial new facts\n");
    fs.writeFileSync(path.join(memoryDir, "today.md"), "partial new today\n");
    fs.writeFileSync(path.join(memoryDir, "dream", "pending-apply.json"), JSON.stringify({
      schemaVersion: 1,
      revisionId: revision.revisionId,
    }));

    expect(recoverPendingDreamApply(memoryDir)).toBe(true);
    expect(snapshotDreamSections(memoryDir)).toEqual(before);
    expect(fs.existsSync(path.join(memoryDir, "dream", "pending-apply.json"))).toBe(false);
  });

  it("keeps only the ten newest revisions", () => {
    const before = snapshotDreamSections(memoryDir);
    for (let index = 0; index < 12; index += 1) {
      createDreamRevision(memoryDir, {
        runId: `run-${index}`,
        trigger: "manual",
        before,
      });
    }
    const revisionFiles = fs.readdirSync(path.join(memoryDir, "dream", "revisions"))
      .filter((name) => name.endsWith(".json"));
    expect(revisionFiles).toHaveLength(10);
  });

  it("does not prune the selected old revision while creating its restore safety snapshot", () => {
    const before = snapshotDreamSections(memoryDir);
    const revisions = Array.from({ length: 10 }, (_, index) => createDreamRevision(memoryDir, {
      runId: `restore-retain-${index}`,
      trigger: "manual",
      before: { ...before, facts: `facts ${index}` },
    }));
    const selected = revisions[0];

    restoreDreamRevision(memoryDir, selected.revisionId);

    expect(readDreamRevision(memoryDir, selected.revisionId).revisionId).toBe(selected.revisionId);
    expect(listDreamRevisions(memoryDir)).toHaveLength(10);
  });

  it("refuses to invent or remove week dates", () => {
    const before = snapshotDreamSections(memoryDir);
    const revision = createDreamRevision(memoryDir, {
      runId: "run-dates",
      trigger: "manual",
      before,
    });

    expect(() => applyDreamSections(memoryDir, {
      revision,
      next: { ...before, weekDays: [{ date: "2026-08-06", body: "invented" }] },
    })).toThrow("may not rewrite Today or Week");
  });

  it("refuses to accept changed Today or Week content from a Dream writer", () => {
    const before = snapshotDreamSections(memoryDir);
    const revision = createDreamRevision(memoryDir, {
      runId: "run-protected-sections",
      trigger: "manual",
      before,
    });

    expect(() => applyDreamSections(memoryDir, {
      revision,
      next: { ...before, today: "changed today" },
    })).toThrow("may not rewrite Today or Week");
    expect(() => applyDreamSections(memoryDir, {
      revision,
      next: {
        ...before,
        weekDays: before.weekDays.map((entry) => ({ ...entry, body: "changed day" })),
      },
    })).toThrow("may not rewrite Today or Week");
  });
});
