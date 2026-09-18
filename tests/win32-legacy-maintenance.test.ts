import { describe, expect, it } from "vitest";
import {
  buildWin32HanaWriteAclCleanupArgs,
  buildWin32LegacyAclDiagnosticArgs,
  buildWin32LegacyProfileCleanupArgs,
} from "../lib/sandbox/win32-legacy-maintenance.ts";

describe("Windows legacy sandbox maintenance args", () => {
  it("builds a legacy AppContainer ACL diagnostic command without executable passthrough", () => {
    expect(buildWin32LegacyAclDiagnosticArgs({
      paths: ["C:\\work", "C:\\Users\\Hana\\.hanako\\.ephemeral"],
    })).toEqual([
      "--diagnose-legacy-acl",
      "C:\\work",
      "--diagnose-legacy-acl",
      "C:\\Users\\Hana\\.hanako\\.ephemeral",
    ]);
  });

  it("can request explicit legacy AppContainer ACL cleanup", () => {
    expect(buildWin32LegacyAclDiagnosticArgs({
      cleanup: true,
      paths: ["C:\\work"],
    })).toEqual([
      "--cleanup-legacy-acl",
      "--diagnose-legacy-acl",
      "C:\\work",
    ]);
  });

  it("builds stale Hana write ACL cleanup commands without executable passthrough", () => {
    expect(buildWin32HanaWriteAclCleanupArgs({
      paths: ["C:\\work", "C:\\Users\\Hana\\.hanako\\.ephemeral", "C:\\work"],
    })).toEqual([
      "--cleanup-hana-write-acl",
      "C:\\work",
      "--cleanup-hana-write-acl",
      "C:\\Users\\Hana\\.hanako\\.ephemeral",
    ]);
  });

  it("builds explicit legacy AppContainer profile cleanup commands", () => {
    expect(buildWin32LegacyProfileCleanupArgs({
      profileNames: [
        "com.hanako.sandbox.1288.475900",
        "com.hanako.sandbox.5104.475988",
        "com.hanako.sandbox.1288.475900",
      ],
    })).toEqual([
      "--cleanup-legacy-profile",
      "com.hanako.sandbox.1288.475900",
      "--cleanup-legacy-profile",
      "com.hanako.sandbox.5104.475988",
    ]);
  });
});
