import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InputDraftsStore } from "../core/input-drafts-store.ts";

describe("InputDraftsStore", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-input-drafts-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const filePath = () => path.join(home, "input-drafts.v1.json");

  it("persists home and session drafts per surface and survives reload", () => {
    const store = new InputDraftsStore({ hanakoHome: home });
    store.setHome("electron", { text: "home draft", doc: { type: "doc" } });
    store.setSession("electron", "sess-1", { text: "session draft" });
    store.setSession("pwa", "sess-1", { text: "phone draft" });

    const reloaded = new InputDraftsStore({ hanakoHome: home });
    expect(reloaded.getAll("electron").home?.text).toBe("home draft");
    expect(reloaded.getAll("electron").home?.doc).toEqual({ type: "doc" });
    expect(reloaded.getAll("electron").sessions["sess-1"]?.text).toBe("session draft");
    expect(reloaded.getAll("pwa").sessions["sess-1"]?.text).toBe("phone draft");
    expect(reloaded.getAll("pwa").home).toBeNull();
  });

  it("clears entries when text is empty", () => {
    const store = new InputDraftsStore({ hanakoHome: home });
    store.setHome("electron", { text: "x" });
    store.setSession("electron", "sess-1", { text: "y" });
    store.setHome("electron", { text: "" });
    store.setSession("electron", "sess-1", { text: "  " });
    expect(store.getAll("electron").home).toBeNull();
    expect(store.getAll("electron").sessions["sess-1"]).toBeUndefined();
  });

  it("deleteSession removes the session draft across all surfaces", () => {
    const store = new InputDraftsStore({ hanakoHome: home });
    store.setSession("electron", "sess-1", { text: "a" });
    store.setSession("pwa", "sess-1", { text: "b" });
    store.setSession("pwa", "sess-2", { text: "keep" });
    store.deleteSession("sess-1");
    expect(store.getAll("electron").sessions["sess-1"]).toBeUndefined();
    expect(store.getAll("pwa").sessions["sess-1"]).toBeUndefined();
    expect(store.getAll("pwa").sessions["sess-2"]?.text).toBe("keep");
  });

  it("quarantines a corrupt file and restarts from empty state", () => {
    fs.writeFileSync(filePath(), "{ not json !!!");
    const store = new InputDraftsStore({ hanakoHome: home });
    expect(store.getAll("electron")).toEqual({ home: null, sessions: {} });
    const quarantined = fs.readdirSync(home).filter((f) => f.includes(".corrupt-"));
    expect(quarantined).toHaveLength(1);
    // 新状态可正常写入
    store.setHome("electron", { text: "fresh" });
    expect(JSON.parse(fs.readFileSync(filePath(), "utf8")).surfaces.electron.home.text).toBe("fresh");
  });
});
