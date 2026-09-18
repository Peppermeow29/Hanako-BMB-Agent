import { describe, expect, it } from "vitest";
import {
  MAX_SNAPSHOT_BYTES,
  isIgnoredRelPath,
  isTrackedFile,
} from "../lib/file-history/text-file-policy.ts";

describe("file-history text policy", () => {
  it("tracks common code and text extensions", () => {
    expect(isTrackedFile("notes/todo.md")).toBe(true);
    expect(isTrackedFile("src/app.ts")).toBe(true);
    expect(isTrackedFile("config.yaml")).toBe(true);
  });

  it("tracks well-known extensionless text filenames", () => {
    expect(isTrackedFile(".gitignore")).toBe(true);
    expect(isTrackedFile("Makefile")).toBe(true);
  });

  it("rejects binaries and unknown files", () => {
    expect(isTrackedFile("photo.png")).toBe(false);
    expect(isTrackedFile("archive.zip")).toBe(false);
    expect(isTrackedFile("some.bin")).toBe(false);
    expect(isTrackedFile("noext")).toBe(false);
  });

  it("rejects churn-heavy formats (logs and lockfiles)", () => {
    expect(isTrackedFile("debug.log")).toBe(false);
    expect(isTrackedFile("package-lock.json")).toBe(false);
  });

  it("ignores build output, vcs internals and dot-directories", () => {
    expect(isIgnoredRelPath("node_modules/x/index.js")).toBe(true);
    expect(isIgnoredRelPath(".git/HEAD")).toBe(true);
    expect(isIgnoredRelPath("dist/main.js")).toBe(true);
    expect(isIgnoredRelPath(".obsidian/app.json")).toBe(true);
    expect(isIgnoredRelPath("src/app.ts")).toBe(false);
    expect(isIgnoredRelPath(".gitignore")).toBe(false);
  });

  it("exposes a 5MB size cap", () => {
    expect(MAX_SNAPSHOT_BYTES).toBe(5 * 1024 * 1024);
  });
});
