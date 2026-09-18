import { describe, expect, it } from "vitest";

import { summarizeToolStartArgs } from "../server/routes/chat.ts";

describe("chat tool_start arg summary", () => {
  it("does not leak unsummarized args for other tools", () => {
    expect(summarizeToolStartArgs("write", {
      file_path: "/tmp/a.txt",
      content: "secret body",
    }, 1_700_000_000_000)).toEqual({
      file_path: "/tmp/a.txt",
    });
  });

  it("keeps exec_command cmd so the chat UI can show the running command", () => {
    expect(summarizeToolStartArgs("exec_command", {
      cmd: "python -m pip install numpy",
      command: "legacy command",
      content: "secret body",
    })).toEqual({
      command: "legacy command",
      cmd: "python -m pip install numpy",
    });
  });

  it("keeps write_stdin input summary for terminal continuation display", () => {
    expect(summarizeToolStartArgs("write_stdin", {
      process_id: "term_1",
      chars: "q\n",
      hidden: "secret",
    })).toEqual({
      chars: "q\n",
      process_id: "term_1",
    });
  });
});
