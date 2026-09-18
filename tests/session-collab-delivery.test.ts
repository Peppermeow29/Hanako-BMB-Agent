import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../core/desktop-session-submit.ts", async (importOriginal) => {
  const mod: any = await importOriginal();
  return {
    ...mod,
    submitDesktopSessionMessageWithReceipt: vi.fn(),
    submitDesktopSessionInterjection: vi.fn(),
  };
});
import { submitDesktopSessionMessageWithReceipt, submitDesktopSessionInterjection } from "../core/desktop-session-submit.ts";
import { deliverAgentMessage, AGENT_MESSAGE_SOURCE } from "../lib/session-collab/delivery.ts";

const FROM = { agentId: "hana", agentName: "Hana" };
function makeEngine(streaming = false) {
  return {
    getSessionManifest: vi.fn().mockReturnValue({ currentLocator: { path: "/tmp/dst.jsonl" }, ownerAgentId: "kimi" }),
    isSessionStreaming: vi.fn().mockReturnValue(streaming),
  };
}

beforeEach(() => {
  vi.mocked(submitDesktopSessionMessageWithReceipt).mockReset().mockReturnValue({
    accepted: Promise.resolve({ accepted: true, sessionId: "sid-1", sessionPath: "/tmp/dst.jsonl" }),
    completion: Promise.resolve({ text: null, toolMedia: [] }),
  } as any);
  vi.mocked(submitDesktopSessionInterjection).mockReset().mockResolvedValue({ steered: true } as any);
});

describe("deliverAgentMessage", () => {
  it("空闲：走 submit，text 带身份前缀，displayMessage 带干净正文与 origin", async () => {
    await deliverAgentMessage(makeEngine(false), { targetSessionId: "sid-1", message: "正文", from: FROM });
    expect(submitDesktopSessionInterjection).not.toHaveBeenCalled();
    const call = vi.mocked(submitDesktopSessionMessageWithReceipt).mock.calls[0][1];
    expect(call.sessionId).toBe("sid-1");
    expect(call.sessionPath).toBe("/tmp/dst.jsonl");
    expect(call.text).toContain("Hana");
    expect(call.text).toContain("正文");
    expect(call.text).not.toBe("正文");
    expect(call.displayMessage.text).toBe("正文");
    expect(call.displayMessage.source).toBe(AGENT_MESSAGE_SOURCE);
    expect(call.displayMessage.origin).toEqual({ kind: "agent", agentId: "hana", agentName: "Hana" });
  });

  it("流式中：走 interjection（submit 不被调用），payload 同款断言", async () => {
    const result = await deliverAgentMessage(makeEngine(true), { targetSessionId: "sid-1", message: "正文2", from: FROM });
    expect(submitDesktopSessionMessageWithReceipt).not.toHaveBeenCalled();
    expect(submitDesktopSessionInterjection).toHaveBeenCalledTimes(1);
    const call = vi.mocked(submitDesktopSessionInterjection).mock.calls[0][1];
    expect(call.sessionId).toBe("sid-1");
    expect(call.sessionPath).toBe("/tmp/dst.jsonl");
    expect(call.text).toContain("Hana");
    expect(call.text).toContain("正文2");
    expect(call.text).not.toBe("正文2");
    expect(call.displayMessage.text).toBe("正文2");
    expect(call.displayMessage.source).toBe(AGENT_MESSAGE_SOURCE);
    expect(call.displayMessage.origin).toEqual({ kind: "agent", agentId: "hana", agentName: "Hana" });
    expect(result).toEqual({ accepted: true, targetSessionId: "sid-1" });
  });

  it("空闲但 submit 立刻 reject session_busy → 兜底走 interjection 一次，最终 resolve accepted", async () => {
    vi.mocked(submitDesktopSessionMessageWithReceipt).mockReturnValueOnce({
      accepted: Promise.reject(new Error("session_busy")),
      completion: Promise.reject(new Error("session_busy")),
    } as any);
    const result = await deliverAgentMessage(makeEngine(false), { targetSessionId: "sid-1", message: "正文3", from: FROM });
    expect(submitDesktopSessionMessageWithReceipt).toHaveBeenCalledTimes(1);
    expect(submitDesktopSessionInterjection).toHaveBeenCalledTimes(1);
    const call = vi.mocked(submitDesktopSessionInterjection).mock.calls[0][1];
    expect(call.text).toContain("正文3");
    expect(result).toEqual({ accepted: true, targetSessionId: "sid-1" });
  });

  it("空闲但 submit 同步 throw session_busy → 同样兜底走 interjection 一次", async () => {
    vi.mocked(submitDesktopSessionMessageWithReceipt).mockImplementationOnce(() => {
      throw new Error("session_busy");
    });
    const result = await deliverAgentMessage(makeEngine(false), { targetSessionId: "sid-1", message: "正文3b", from: FROM });
    expect(submitDesktopSessionMessageWithReceipt).toHaveBeenCalledTimes(1);
    expect(submitDesktopSessionInterjection).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ accepted: true, targetSessionId: "sid-1" });
  });

  it("目标 manifest 不存在 → reject session_not_found，两个 submit 入口都未被调用", async () => {
    const engine = makeEngine(false);
    vi.mocked(engine.getSessionManifest).mockReturnValue(null as any);
    await expect(
      deliverAgentMessage(engine, { targetSessionId: "sid-missing", message: "正文4", from: FROM }),
    ).rejects.toThrow(/session_not_found/);
    expect(submitDesktopSessionMessageWithReceipt).not.toHaveBeenCalled();
    expect(submitDesktopSessionInterjection).not.toHaveBeenCalled();
  });

  it("submit 与 interjection 都 reject session_busy → 整体 reject session_busy", async () => {
    vi.mocked(submitDesktopSessionMessageWithReceipt).mockReturnValueOnce({
      accepted: Promise.reject(new Error("session_busy")),
      completion: Promise.reject(new Error("session_busy")),
    } as any);
    vi.mocked(submitDesktopSessionInterjection).mockRejectedValueOnce(new Error("session_busy"));
    await expect(
      deliverAgentMessage(makeEngine(false), { targetSessionId: "sid-1", message: "正文5", from: FROM }),
    ).rejects.toThrow("session_busy");
    expect(submitDesktopSessionMessageWithReceipt).toHaveBeenCalledTimes(1);
    expect(submitDesktopSessionInterjection).toHaveBeenCalledTimes(1);
  });

  it("submit reject 的是其它错误 → 直接 reject，不走备路", async () => {
    vi.mocked(submitDesktopSessionMessageWithReceipt).mockReturnValueOnce({
      accepted: Promise.reject(new Error("boom")),
      completion: Promise.reject(new Error("boom")),
    } as any);
    await expect(
      deliverAgentMessage(makeEngine(false), { targetSessionId: "sid-1", message: "正文6", from: FROM }),
    ).rejects.toThrow("boom");
    expect(submitDesktopSessionInterjection).not.toHaveBeenCalled();
  });

  it("不会用定时器假装成功：延迟到来的 preflight 拒绝仍原样返回", async () => {
    let rejectAccepted!: (error: Error) => void;
    const accepted = new Promise((_resolve, reject) => { rejectAccepted = reject; });
    vi.mocked(submitDesktopSessionMessageWithReceipt).mockReturnValueOnce({
      accepted,
      completion: accepted,
    } as any);
    const delivery = deliverAgentMessage(makeEngine(false), {
      targetSessionId: "sid-1",
      message: "正文7",
      from: FROM,
    });
    let settled = false;
    void delivery.finally(() => { settled = true; }).catch(() => {});
    await Promise.resolve();
    expect(settled).toBe(false);
    rejectAccepted(new Error("delayed preflight rejection"));
    await expect(delivery).rejects.toThrow("delayed preflight rejection");
  });
});
