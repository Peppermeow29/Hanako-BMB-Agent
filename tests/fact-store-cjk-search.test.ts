import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactStore } from "../lib/memory/fact-store.ts";

function removeDbFiles(dbPath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
}

function createLegacyV1FactDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE facts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      fact       TEXT NOT NULL,
      tags       TEXT NOT NULL DEFAULT '[]',
      time       TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_facts_time ON facts(time);
    CREATE INDEX idx_facts_session ON facts(session_id);

    CREATE VIRTUAL TABLE facts_fts USING fts5(
      fact,
      content=facts,
      content_rowid=id,
      tokenize='unicode61'
    );

    CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, fact) VALUES (new.id, new.fact);
    END;
    CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
    END;
    CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
      INSERT INTO facts_fts(rowid, fact) VALUES (new.id, new.fact);
    END;

    PRAGMA user_version = 1;
  `);
  db.prepare(`
    INSERT INTO facts (fact, tags, time, session_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    "用户喜欢在晚上喝茉莉花茶",
    JSON.stringify(["饮品", "习惯"]),
    "2026-05-05T18:00",
    "legacy-session",
    "2026-05-05T18:01:00.000Z",
  );
  db.close();
}

describe("FactStore CJK full-text search", () => {
  let tmpDir;
  let dbPath;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-fact-store-cjk-"));
    dbPath = path.join(tmpDir, "facts.db");
    store = new FactStore(dbPath);
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds Chinese facts by meaningful substrings instead of requiring the full sentence", () => {
    store.add({
      fact: "用户喜欢在晚上喝茉莉花茶",
      tags: ["饮品", "习惯"],
      time: "2026-05-05T18:00",
    });

    expect(store.searchFullText("茉莉花茶", 10).map((r) => r.fact)).toEqual([
      "用户喜欢在晚上喝茉莉花茶",
    ]);
    expect(store.searchFullText("晚上", 10).map((r) => r.fact)).toEqual([
      "用户喜欢在晚上喝茉莉花茶",
    ]);
  });

  it("keeps existing Latin token search behavior", () => {
    store.add({
      fact: "The user likes jasmine tea at night",
      tags: ["drink", "habit"],
      time: "2026-05-05T18:01",
    });

    expect(store.searchFullText("jasmine", 10).map((r) => r.fact)).toEqual([
      "The user likes jasmine tea at night",
    ]);
    expect(store.searchFullText("tea", 10).map((r) => r.fact)).toEqual([
      "The user likes jasmine tea at night",
    ]);
  });

  it("keeps the CJK full-text index consistent when facts are cleared", () => {
    store.add({
      fact: "用户喜欢在晚上喝茉莉花茶",
      tags: ["饮品", "习惯"],
      time: "2026-05-05T18:00",
    });

    expect(store.searchFullText("茉莉", 10)).toHaveLength(1);

    store.clearAll();

    expect(store.searchFullText("茉莉", 10)).toEqual([]);
  });

  it("deletes only facts derived from the retried session and keeps the FTS index consistent", () => {
    store.add({
      fact: "旧分支里用户喜欢茉莉花茶",
      tags: ["饮品"],
      time: "2026-05-05T18:00",
      session_id: "sess-retried",
    });
    store.add({
      fact: "另一个会话里用户喜欢乌龙茶",
      tags: ["饮品"],
      time: "2026-05-05T18:01",
      session_id: "sess-other",
    });
    store.add({
      fact: "Fork 子会话独立保留白茶偏好",
      tags: ["饮品"],
      time: "2026-05-05T18:02",
      session_id: "sess-child",
    });

    expect(store.deleteBySession("sess-retried")).toBe(1);
    expect(store.getBySession("sess-retried")).toEqual([]);
    expect(store.searchFullText("茉莉花茶", 10)).toEqual([]);
    expect(store.getBySession("sess-other")).toHaveLength(1);
    expect(store.getBySession("sess-child")).toEqual([
      expect.objectContaining({ fact: "Fork 子会话独立保留白茶偏好" }),
    ]);
  });

  // Windows full-suite I/O contention can make this SQLite migration substantially slower.
  it("migrates existing v1 databases into the CJK-aware search index", () => {
    store.close();
    store = null;
    removeDbFiles(dbPath);
    createLegacyV1FactDb(dbPath);

    store = new FactStore(dbPath);

    expect(store.db.pragma("user_version", { simple: true })).toBe(2);
    expect(store.searchFullText("茉莉花茶", 10).map((r) => r.fact)).toEqual([
      "用户喜欢在晚上喝茉莉花茶",
    ]);
  }, process.platform === "win32" ? 60_000 : 10_000);
});
