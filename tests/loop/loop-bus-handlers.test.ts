import { describe, it, expect, vi } from "vitest";
import { registerLoopBusHandlers } from "../../server/loop-bus-handlers.ts";

function makeController() {
  return {
    onTurnStart: vi.fn(),
    onMessageEnd: vi.fn(),
    onTurnEnd: vi.fn(async () => {}),
  };
}

// 订阅签名已核实：hub.subscribe((event, sessionPath) => ...)
function makeBus() {
  const handlers: any[] = [];
  return {
    subscribe: (h: any) => { handlers.push(h); return () => handlers.splice(handlers.indexOf(h), 1); },
    emit: (...args: any[]) => handlers.forEach((h) => h(...args)),
  };
}

describe("registerLoopBusHandlers", () => {
  it("maps turn_start / message_end / turn_end onto the controller", () => {
    const bus = makeBus();
    const controller = makeController();
    registerLoopBusHandlers(bus, () => controller);
    bus.emit({ type: "turn_start" }, "/s/a.jsonl");
    expect(controller.onTurnStart).toHaveBeenCalledWith("/s/a.jsonl");
    bus.emit({ type: "message_end", message: { stopReason: "error" } }, "/s/a.jsonl");
    expect(controller.onMessageEnd).toHaveBeenCalledWith("/s/a.jsonl", "error");
    bus.emit({ type: "turn_end", aborted: true }, "/s/a.jsonl");
    expect(controller.onTurnEnd).toHaveBeenCalledWith("/s/a.jsonl", { aborted: true });
    bus.emit({ type: "turn_end" }, "/s/a.jsonl");
    expect(controller.onTurnEnd).toHaveBeenLastCalledWith("/s/a.jsonl", { aborted: false });
  });

  it("ignores events without a session path and survives a missing controller", () => {
    const bus = makeBus();
    registerLoopBusHandlers(bus, () => null);
    expect(() => bus.emit({ type: "turn_end" }, null)).not.toThrow();
  });
});
