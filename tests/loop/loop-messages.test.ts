import { describe, it, expect } from "vitest";
import {
  LOOP_TURN_MESSAGE_TYPE,
  LOOP_NOTICE_MESSAGE_TYPE,
  buildLoopKickoffMessage,
  buildLoopWakeupMessage,
  buildLoopNoticeMessage,
} from "../../lib/loop/loop-messages.ts";

const loop = {
  key: "sid-a",
  prompt: "watch the pipeline",
  turnCount: 2,
  limits: { maxTurns: 50, maxConsecutiveFailures: 3, minDelaySec: 60, guardedMinDelaySec: 1200, fallbackDelaySec: 1200 },
};

describe("loop messages", () => {
  it("kickoff message carries the task, the turn contract, and the budget", () => {
    const msg = buildLoopKickoffMessage(loop);
    expect(msg.customType).toBe(LOOP_TURN_MESSAGE_TYPE);
    expect(msg.display).toBe(false);
    expect(msg.content).toContain("watch the pipeline");
    expect(msg.content).toContain("loop_control");
    expect(msg.content).toContain("50");
    expect(msg.details).toMatchObject({ schemaVersion: 1, kind: "kickoff" });
  });

  it("wakeup message carries reason and progress", () => {
    const msg = buildLoopWakeupMessage(loop, "check remote pipeline status");
    expect(msg.customType).toBe(LOOP_TURN_MESSAGE_TYPE);
    expect(msg.content).toContain("check remote pipeline status");
    expect(msg.content).toContain("2/50");
    expect(msg.details).toMatchObject({ schemaVersion: 1, kind: "wakeup" });
  });

  it("notice message uses the notice type and shows text verbatim", () => {
    const msg = buildLoopNoticeMessage("循环已暂停");
    expect(msg.customType).toBe(LOOP_NOTICE_MESSAGE_TYPE);
    expect(msg.content).toContain("循环已暂停");
  });
});
