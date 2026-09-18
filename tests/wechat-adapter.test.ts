import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  decodeIlinkMediaAesKey,
  encodeIlinkMediaAesKey,
} from "../lib/bridge/wechat-ilink-media-crypto.ts";
import { createWechatAdapter } from "../lib/bridge/wechat-adapter.ts";

function jsonResponse(body) {
  return {
    ok: true,
    text: async () => JSON.stringify(body),
  };
}

function cdnUploadResponse(downloadParam = "download-param") {
  return {
    ok: true,
    headers: new Headers({ "x-encrypted-param": downloadParam }),
  };
}

describe("createWechatAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not report connected until the first getupdates call succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ret: 0, msgs: [], get_updates_buf: "buf-1" }))
      .mockImplementationOnce(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    const onStatus = vi.fn();
    const adapter = createWechatAdapter({
      botToken: "wx-token",
      agentId: "hana",
      onMessage: vi.fn(),
      onStatus,
    } as any);

    expect(onStatus).not.toHaveBeenCalledWith("connected");
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("connected"));

    adapter.stop();
  });

  it("reports error after repeated poll failures", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const onStatus = vi.fn();
    const adapter = createWechatAdapter({
      botToken: "wx-token",
      agentId: "hana",
      onMessage: vi.fn(),
      onStatus,
    } as any);

    await vi.advanceTimersByTimeAsync(8_000);

    expect(onStatus).toHaveBeenCalledWith("error", expect.stringContaining("network down"));
    adapter.stop();
  });

  it.each([
    ["image/png", "image.png", 2, "image_item"],
    ["text/plain", "note.txt", 4, "file_item"],
  ])("uploads %s buffers and sends the matching OpenClaw-compatible iLink message item", async (mime, filename, itemType, itemKey) => {
    let getUpdatesCount = 0;
    const fetchMock = vi.fn(async (url, options: any = {}) => {
      const requestUrl = String(url);
      if (requestUrl.includes("ilink/bot/getupdates")) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return jsonResponse({
            ret: 0,
            get_updates_buf: "buf-1",
            msgs: [{
              from_user_id: "user-1",
              context_token: "ctx-1",
              item_list: [{ type: 1, text_item: { text: "hi" } }],
            }],
          });
        }
        return new Promise(() => {});
      }
      if (requestUrl.includes("ilink/bot/getuploadurl")) {
        return jsonResponse({ ret: 0, upload_param: "upload-param" });
      }
      if (requestUrl.includes("/c2c/upload")) {
        return cdnUploadResponse();
      }
      if (requestUrl.includes("ilink/bot/sendmessage")) {
        return jsonResponse({ ret: 0 });
      }
      throw new Error(`unexpected fetch: ${requestUrl} ${options.method || "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onMessage = vi.fn();
    const adapter = createWechatAdapter({
      botToken: "wx-token",
      agentId: "hana",
      onMessage,
      onStatus: vi.fn(),
    } as any);

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    expect(adapter.canReply("user-1")).toBe(true);

    await adapter.sendMediaBuffer("user-1", Buffer.from("file"), { mime, filename });

    const sendMessageCall = fetchMock.mock.calls.find(([url]) => String(url).includes("ilink/bot/sendmessage"));
    expect(sendMessageCall).toBeTruthy();
    const payload = JSON.parse(sendMessageCall[1].body);
    const item = payload.msg.item_list[0];
    expect(payload.msg.context_token).toBe("ctx-1");
    expect(item.type).toBe(itemType);
    expect(item[itemKey]).toBeTruthy();
    const media = item[itemKey].media;
    expect(Buffer.from(media.aes_key, "base64").toString("ascii")).toMatch(/^[0-9a-f]{32}$/);
    expect(decodeIlinkMediaAesKey(media.aes_key)).toHaveLength(16);
    if (itemKey === "file_item") {
      expect(item.file_item.file_name).toBe(filename);
    }

    adapter.stop();
  });

  it("encodes outbound media aes keys as base64 hex strings and still decodes legacy raw-key base64", () => {
    const aesKeyHex = "00112233445566778899aabbccddeeff";
    const wireKey = encodeIlinkMediaAesKey(aesKeyHex);

    expect(Buffer.from(wireKey, "base64").toString("ascii")).toBe(aesKeyHex);
    expect(decodeIlinkMediaAesKey(wireKey).toString("hex")).toBe(aesKeyHex);

    const legacyRawWireKey = Buffer.from(aesKeyHex, "hex").toString("base64");
    expect(decodeIlinkMediaAesKey(legacyRawWireKey).toString("hex")).toBe(aesKeyHex);
  });

  it("persists context tokens so scheduled WeChat replies survive adapter restart", async () => {
    const hanaHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-wechat-context-"));
    vi.setSystemTime(new Date("2026-06-04T08:00:00.000Z"));
    let getUpdatesCount = 0;
    const fetchMock = vi.fn(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes("ilink/bot/getupdates")) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return jsonResponse({
            ret: 0,
            get_updates_buf: "buf-1",
            msgs: [{
              from_user_id: "user-1",
              context_token: "ctx-persisted",
              item_list: [{ type: 1, text_item: { text: "hi" } }],
            }],
          });
        }
        return new Promise(() => {});
      }
      if (requestUrl.includes("ilink/bot/sendmessage")) return jsonResponse({ ret: 0 });
      throw new Error(`unexpected fetch: ${requestUrl}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createWechatAdapter({
      botToken: "wx-token",
      hanaHome,
      agentId: "hana",
      onMessage: vi.fn(),
      onStatus: vi.fn(),
    });
    await vi.waitFor(() => expect(adapter.canReply("user-1")).toBe(true));
    adapter.stop();

    const restarted = createWechatAdapter({
      botToken: "wx-token",
      hanaHome,
      agentId: "hana",
      onMessage: vi.fn(),
      onStatus: vi.fn(),
    });

    expect(restarted.canReply("user-1")).toBe(true);
    await restarted.sendReply("user-1", "scheduled ping");
    const sendMessageCall = fetchMock.mock.calls.find(([url]) => String(url).includes("ilink/bot/sendmessage"));
    expect(sendMessageCall).toBeTruthy();
    expect(JSON.parse((sendMessageCall as any)![1].body).msg.context_token).toBe("ctx-persisted");

    restarted.stop();
    fs.rmSync(hanaHome, { recursive: true, force: true });
  });

  it("sends and cancels native typing status through the OpenClaw iLink typing ticket", async () => {
    let getUpdatesCount = 0;
    const fetchMock = vi.fn(async (url, options: any = {}) => {
      const requestUrl = String(url);
      if (requestUrl.includes("ilink/bot/getupdates")) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return jsonResponse({
            ret: 0,
            get_updates_buf: "buf-1",
            msgs: [{
              from_user_id: "user-1",
              context_token: "ctx-1",
              item_list: [{ type: 1, text_item: { text: "hi" } }],
            }],
          });
        }
        return new Promise(() => {});
      }
      if (requestUrl.includes("ilink/bot/getconfig")) {
        const payload = JSON.parse(options.body);
        expect(payload.ilink_user_id).toBe("user-1");
        expect(payload.context_token).toBe("ctx-1");
        return jsonResponse({ ret: 0, typing_ticket: "ticket-1" });
      }
      if (requestUrl.includes("ilink/bot/sendtyping")) {
        return jsonResponse({ ret: 0 });
      }
      throw new Error(`unexpected fetch: ${requestUrl}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createWechatAdapter({
      botToken: "wx-token",
      agentId: "hana",
      onMessage: vi.fn(),
      onStatus: vi.fn(),
    } as any);

    await vi.waitFor(() => expect(adapter.canReply("user-1")).toBe(true));
    await (adapter as any).sendTypingIndicator("user-1");
    await (adapter as any).cancelTypingIndicator("user-1");

    const sendTypingCalls = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("ilink/bot/sendtyping"))
      .map(([, options]) => JSON.parse((options as any).body));
    expect(sendTypingCalls).toEqual([
      expect.objectContaining({ ilink_user_id: "user-1", typing_ticket: "ticket-1", status: 1 }),
      expect.objectContaining({ ilink_user_id: "user-1", typing_ticket: "ticket-1", status: 2 }),
    ]);

    adapter.stop();
  });

  it("prunes expired persisted WeChat context tokens on restart", async () => {
    const hanaHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-wechat-context-expired-"));
    vi.setSystemTime(new Date("2026-06-04T08:00:00.000Z"));
    let getUpdatesCount = 0;
    const fetchMock = vi.fn(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes("ilink/bot/getupdates")) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return jsonResponse({
            ret: 0,
            get_updates_buf: "buf-1",
            msgs: [{
              from_user_id: "user-1",
              context_token: "ctx-expiring",
              item_list: [{ type: 1, text_item: { text: "hi" } }],
            }],
          });
        }
        return new Promise(() => {});
      }
      throw new Error(`unexpected fetch: ${requestUrl}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createWechatAdapter({
      botToken: "wx-token",
      hanaHome,
      agentId: "hana",
      onMessage: vi.fn(),
      onStatus: vi.fn(),
    });
    await vi.waitFor(() => expect(adapter.canReply("user-1")).toBe(true));
    adapter.stop();

    vi.setSystemTime(new Date("2026-06-05T08:00:01.000Z"));
    const restarted = createWechatAdapter({
      botToken: "wx-token",
      hanaHome,
      agentId: "hana",
      onMessage: vi.fn(),
      onStatus: vi.fn(),
    });

    expect(restarted.canReply("user-1")).toBe(false);
    await expect(restarted.sendReply("user-1", "too late")).rejects.toThrow("需要对方最近发过消息");

    restarted.stop();
    fs.rmSync(hanaHome, { recursive: true, force: true });
  });
});
