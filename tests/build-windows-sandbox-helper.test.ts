import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it, vi } from "vitest";
import {
  buildWindowsSandboxBatchScript,
  buildWindowsSandboxCompileCommand,
  shouldBuildWindowsSandboxHelper,
  windowsSandboxHelperOutputDir,
} from "../scripts/build-windows-sandbox-helper.mjs";
import {
  ensureWindowsSandboxHelper,
} from "../scripts/ensure-windows-sandbox-helper.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Windows sandbox helper build script", () => {
  it("only builds on win32", () => {
    expect(shouldBuildWindowsSandboxHelper({ platform: "darwin" })).toBe(false);
    expect(shouldBuildWindowsSandboxHelper({ platform: "linux" })).toBe(false);
    expect(shouldBuildWindowsSandboxHelper({ platform: "win32" })).toBe(true);
  });

  it("writes the helper into the Electron extraResources source directory", () => {
    expect(windowsSandboxHelperOutputDir({
      rootDir: "/repo",
      arch: "x64",
    })).toBe(path.join("/repo", "dist-sandbox", "win-x64"));
  });

  it("links the Win32 libraries required by restricted tokens, ACL APIs, and private desktops", () => {
    const command = buildWindowsSandboxCompileCommand({
      source: "C:\\repo\\desktop\\native\\HanaWindowsSandboxHelper\\main.cpp",
      output: "C:\\repo\\dist-sandbox\\win-x64\\hana-win-sandbox.exe",
    });

    expect(command).toContain("cl.exe");
    expect(command).toContain("userenv.lib");
    expect(command).toContain("advapi32.lib");
    expect(command).toContain("bcrypt.lib");
    expect(command).toContain("user32.lib");
  });

  it("uses restricted-token APIs instead of AppContainer launch APIs", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("CreateRestrictedToken");
    expect(source).toContain("WRITE_RESTRICTED");
    expect(source).toContain("CreateProcessAsUserW");
    expect(source).not.toContain("CreateAppContainerProfile");
    expect(source).not.toContain("PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES");
    expect(source).not.toContain("SECURITY_CAPABILITIES capabilities");
  });

  it("runs restricted-token children on a private desktop inside WinSta0", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).not.toContain("CreateWindowStationW");
    expect(source).toContain("OpenWindowStationW");
    expect(source).toContain("SetProcessWindowStation");
    expect(source).toContain("CreateDesktopW");
    expect(source).toContain("CloseDesktop");
    expect(source).toContain("CloseWindowStation");
    expect(source).toContain('desktop.stationName = L"WinSta0"');
    expect(source).toContain('desktop.qualifiedName = desktop.stationName + L"\\\\" + desktop.desktopName');
    expect(source).toContain("startup.StartupInfo.lpDesktop");
    expect(source).toContain("desktop.qualifiedName.c_str()");
  });

  it("keeps private desktops as the default and explicitly names the current desktop on opt-in", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );
    const parseArgs = source.match(
      /static Options parseArgs\([\s\S]*?\n\}/
    )?.[0] || "";
    const runSandboxed = source.match(
      /static int runSandboxed\([\s\S]*?\n\}/
    )?.[0] || "";
    const resolveCurrentDesktop = source.match(
      /static bool resolveCurrentDesktop\([\s\S]*?\n\}/
    )?.[0] || "";

    expect(parseArgs).toContain('--current-desktop');
    expect(resolveCurrentDesktop).toContain("GetProcessWindowStation()");
    expect(resolveCurrentDesktop).toContain("GetThreadDesktop(GetCurrentThreadId())");
    expect(resolveCurrentDesktop).toContain('desktop.qualifiedName = desktop.stationName + L"\\\\" + desktop.desktopName');
    expect(runSandboxed).toContain("const bool usesPrivateDesktop = !opts.currentDesktop");
    expect(runSandboxed).toContain("resolveCurrentDesktop(desktop)");
    expect(runSandboxed).toContain("startup.StartupInfo.lpDesktop = const_cast<LPWSTR>(desktop.qualifiedName.c_str())");
    expect(runSandboxed).toContain("probeRestrictedDesktopAccess(restrictedToken, desktop)");
    expect(runSandboxed).toContain('if (prelaunchDesktopProbe != L"ok")');
  });

  it("preserves an explicitly owned final cmd argument without generic argv escaping", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );
    const buildCommandLine = source.match(
      /static std::wstring buildCommandLine\([\s\S]*?\n\}/
    )?.[0] || "";

    expect(source).toContain('--verbatim-last-arg');
    expect(buildCommandLine).toContain("opts.verbatimLastArg && i + 1 == opts.args.size()");
    expect(buildCommandLine).toContain("command += opts.args[i]");
  });

  it("uses system cryptographic randomness for each private desktop name", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );
    const generateName = source.match(
      /static bool generatePrivateDesktopName\([\s\S]*?\n\}/
    )?.[0] || "";
    const createDesktop = source.match(
      /static bool createSandboxDesktop\([\s\S]*?\n\}/
    )?.[0] || "";

    expect(generateName).toContain("BCryptGenRandom");
    expect(generateName).toContain("BCRYPT_USE_SYSTEM_PREFERRED_RNG");
    expect(generateName).toContain("BYTE randomBytes[16]");
    expect(generateName).not.toContain("GetCurrentProcessId");
    expect(generateName).not.toContain("GetTickCount64");
    expect(createDesktop).toContain("generatePrivateDesktopName(desktop.desktopName)");
  });

  it("uses ordinary Hana write SIDs while retaining legacy capability ACL cleanup", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );
    const currentSidFunction = source.match(
      /static std::wstring sidForWritableRoot\(const std::wstring& root\) \{[\s\S]*?\n\}/
    )?.[0] || "";

    expect(currentSidFunction).toContain("S-1-5-21-");
    expect(currentSidFunction).not.toContain("S-1-15-3-4096-");
    expect(source).toContain("sidForWritableRootLegacyCapabilityNamespace");
    expect(source).toContain("sidForWritableRootLegacyAccountNamespace");
    expect(source).toContain("S-1-15-3-4096-");
    expect(source).toContain("--cleanup-hana-write-acl");
    expect(source).toContain("hana-write-acl-cleaned");
  });

  it("adds the Windows write-restricted SID to the restricted token", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("S-1-5-33");
    expect(source).toContain("appendRestrictingSid");
    expect(source).toContain("WRITE_RESTRICTED_CODE_SID");
  });

  it("adds standard object-namespace SIDs to the restricted token", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("EVERYONE_SID");
    expect(source).toContain("S-1-1-0");
    expect(source).toContain("appendEveryoneRestrictingSid");
    expect(source).toContain("appendCurrentLogonRestrictingSid");
    expect(source).toContain("TokenGroups");
    expect(source).toContain("SE_GROUP_LOGON_ID");
  });

  it("uses the enabled logon SID for private USER objects and keeps it in the restricting list", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );
    const logonSidLookup = source.match(
      /static PSID copyCurrentLogonSid\(HANDLE token\) \{[\s\S]*?\n\}/
    )?.[0] || "";
    const appendLogonSid = source.match(
      /static bool appendCurrentLogonRestrictingSid\([\s\S]*?\n\}/
    )?.[0] || "";
    const createDesktop = source.match(
      /static bool createSandboxDesktop\([\s\S]*?\n\}/
    )?.[0] || "";

    expect(logonSidLookup).toContain("TokenGroups");
    expect(logonSidLookup).toContain("SE_GROUP_LOGON_ID");
    expect(logonSidLookup).toContain("SE_GROUP_ENABLED");
    expect(appendLogonSid).toContain("copyCurrentLogonSid(token)");
    expect(appendLogonSid).toContain("ownedSids.push_back(logonSid)");
    expect(createDesktop).toContain("copyCurrentLogonSid(processToken)");
    expect(createDesktop).toContain("SANDBOX_WINDOW_STATION_ACCESS");
    expect(createDesktop).toContain("SANDBOX_DESKTOP_ACCESS");
    expect(createDesktop).toContain("baseDefaultDacl.dacl");
    expect(createDesktop).not.toContain("stationDacl");
    expect(createDesktop).not.toContain("stationDescriptor");
    expect(createDesktop).not.toContain("buildDaclWithRootSids");
    expect(createDesktop).not.toContain("root.sid");
    expect(source).not.toContain("GetTokenInformation(token, TokenUser");
  });

  it("uses existing WinSta0 access and grants full access only to the per-launch private desktop", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    const stationMask = source.match(
      /static const DWORD SANDBOX_WINDOW_STATION_ACCESS =([\s\S]*?);/
    )?.[1] || "";
    const desktopMask = source.match(
      /static const DWORD SANDBOX_DESKTOP_ACCESS =([\s\S]*?);/
    )?.[1] || "";
    const createDesktop = source.match(
      /static bool createSandboxDesktop\([\s\S]*?\n\}/
    )?.[0] || "";
    const probeDesktop = source.match(
      /static std::wstring probeRestrictedDesktopAccess\([\s\S]*?\n\}/
    )?.[0] || "";

    expect(stationMask.trim()).toBe("WINSTA_ALL_ACCESS");
    for (const accessRight of [
      "STANDARD_RIGHTS_REQUIRED",
      "DESKTOP_CREATEMENU",
      "DESKTOP_CREATEWINDOW",
      "DESKTOP_ENUMERATE",
      "DESKTOP_HOOKCONTROL",
      "DESKTOP_JOURNALPLAYBACK",
      "DESKTOP_JOURNALRECORD",
      "DESKTOP_READOBJECTS",
      "DESKTOP_SWITCHDESKTOP",
      "DESKTOP_WRITEOBJECTS",
    ]) {
      expect(desktopMask).toContain(accessRight);
    }
    expect(desktopMask).not.toContain("DESKTOP_ALL_ACCESS");
    expect(createDesktop).toContain("SANDBOX_WINDOW_STATION_ACCESS");
    expect(createDesktop).toContain("SANDBOX_DESKTOP_ACCESS");
    expect(probeDesktop).toContain("SANDBOX_WINDOW_STATION_ACCESS");
    expect(probeDesktop).toContain("SANDBOX_DESKTOP_ACCESS");
    expect(source).toContain("per-launch private desktop");
    expect(source).toContain("WinSta0 station ACL and file ACLs are unchanged");
  });

  it("exposes a token diagnostic mode with a named-object namespace probe", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("--diagnose-token");
    expect(source).toContain("diagnoseRestrictedToken");
    expect(source).toContain("restricting-sid-count");
    expect(source).toContain("probeNamedObjectNamespace");
    expect(source).toContain("ImpersonateLoggedOnUser");
    expect(source).toContain("CreateMutexW");
  });

  it("logs structured launch diagnostics when CreateProcessAsUserW fails", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("emitCreateProcessLaunchFailureDiagnostic");
    expect(source).toContain("hana-win-sandbox: launch-failure");
    expect(source).toContain("errorHex=");
    expect(source).toContain("executablePresent=");
    expect(source).toContain("executableLength=");
    expect(source).toContain("cwdPresent=");
    expect(source).toContain("cwdLength=");
    expect(source).toContain("argumentCount=");
    expect(source).toContain("commandLineLength=");
    expect(source).toContain("desktop=");
    expect(source).toContain("flagsHex=");
    expect(source).toContain("inheritHandles=");
    expect(source).toContain("inheritedHandleCount=");
    expect(source).toContain("probeRestrictedDesktopAccess");
    expect(source).toContain("probeProcessWindowStationName");
    expect(source).toContain("namedObjectsProbe=");

    const diagnostic = source.match(
      /static void emitCreateProcessLaunchFailureDiagnostic\([\s\S]*?\n\}/
    )?.[0] || "";
    expect(diagnostic).not.toContain("escapeDiagnosticValue(opts.executable)");
    expect(diagnostic).not.toContain("escapeDiagnosticValue(opts.cwd)");
    expect(diagnostic).not.toContain("escapeDiagnosticValue(commandLine)");
  });

  it("fails closed when the restricted token cannot reopen the private desktop", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );
    const runSandboxed = source.match(
      /static int runSandboxed\([\s\S]*?\n\}/
    )?.[0] || "";

    expect(source).toContain("emitPrelaunchDesktopProbeFailureDiagnostic");
    expect(runSandboxed).toContain('if (prelaunchDesktopProbe != L"ok")');
    expect(runSandboxed.indexOf('if (prelaunchDesktopProbe != L"ok")'))
      .toBeLessThan(runSandboxed.indexOf("CreateProcessAsUserW("));
    expect(runSandboxed).toContain('emitTerminalRecord(L"launch_failed"');
  });

  it("checks station and impersonation restoration and terminates if RevertToSelf fails", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );
    const probe = source.match(
      /static std::wstring probeRestrictedDesktopAccess\([\s\S]*?\n\}/
    )?.[0] || "";

    expect(probe).toContain("SetProcessWindowStation(originalStation)");
    expect(probe).toContain("restore-error:");
    expect(probe).toContain("revertImpersonationOrTerminate");
    expect(source).toContain("if (RevertToSelf()) return;");
    expect(source).toContain("ExitProcess(HELPER_LAUNCH_FAILED_EXIT_CODE)");
    expect(source).not.toContain("RevertToSelf();");
  });

  it("diagnoses post-create DLL initialization failures with the prelaunch desktop probe", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("STATUS_DLL_INIT_FAILED_EXIT_CODE");
    expect(source).toContain("0xC0000142");
    expect(source).toContain("emitPostCreateEarlyExitDiagnostic");
    expect(source).toContain("hana-win-sandbox: post-create-exit-v1");
    expect(source).toContain('classification = L"dll-init-failure"');
    expect(source).toContain("prelaunchDesktopProbe=");
    expect(source).toContain("probeRestrictedDesktopAccess(restrictedToken, desktop)");
  });

  it("keeps synthetic writable-root SIDs as the file write ACL grant surface", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );
    const applyWriteAcls = source.match(
      /static bool applyWriteAcls\([\s\S]*?\n\}/
    )?.[0] || "";

    expect(applyWriteAcls).toContain("ensureAce(root.path, root.sid, GRANT_ACCESS");
    expect(applyWriteAcls).not.toContain("EVERYONE_SID");
    expect(applyWriteAcls).not.toContain("SE_GROUP_LOGON_ID");
  });

  it("restores temporary write ACL changes after sandboxed commands", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("struct AclRestore");
    expect(source).toContain("restoreAcls");
    expect(source).toContain("applyWriteAcls(opts.writableRoots, opts.denyWritePaths, aclRestores)");
  });

  it("builds a fresh restricted-token default DACL for child IPC objects", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );
    const buildDefaultDacl = source.match(
      /static PACL buildTokenDefaultDacl\([\s\S]*?\n\}/
    )?.[0] || "";
    const createToken = source.match(
      /static HANDLE createRestrictedWriteToken\([\s\S]*?\n\}/
    )?.[0] || "";

    expect(buildDefaultDacl).toContain("SetEntriesInAclW(");
    expect(buildDefaultDacl).toMatch(/entries\.data\(\),\s*nullptr,\s*&dacl/);
    expect(buildDefaultDacl).not.toContain("baseDefaultDacl");
    expect(createToken).not.toContain("queryTokenDefaultDacl");
    expect(createToken).not.toContain("baseDefaultDacl");
  });

  it("keeps restricted child object creation compatible with Windows initialization", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );
    const createToken = source.match(
      /static HANDLE createRestrictedWriteToken\([\s\S]*?\n\}/
    )?.[0] || "";

    expect(source).toContain("buildTokenDefaultDacl");
    expect(createToken).toContain("everyoneSid");
    expect(createToken).toContain("logonSid");
    expect(createToken).toContain("SetTokenInformation(restrictedToken, TokenDefaultDacl");
    expect(createToken).toContain("enableTokenPrivilege(restrictedToken, SE_CHANGE_NOTIFY_NAME)");
    expect(source).toContain("AdjustTokenPrivileges");
    expect(source).toContain("ERROR_SUCCESS");
    expect(source.match(/buildRestrictingSids\(/g)).toHaveLength(3);
  });

  it("restricts child handle inheritance to stdio handles", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    const setupHandleList = source.match(
      /static bool setupStartupAttributeList\([\s\S]*?\n\}/
    )?.[0] || "";

    expect(setupHandleList).toContain("SetHandleInformation");
    expect(setupHandleList).toContain("HANDLE_FLAG_INHERIT");
    expect(setupHandleList.indexOf("SetHandleInformation"))
      .toBeLessThan(setupHandleList.indexOf("UpdateProcThreadAttribute"));
    expect(setupHandleList).toContain("PROC_THREAD_ATTRIBUTE_HANDLE_LIST");
    expect(source).toContain("EXTENDED_STARTUPINFO_PRESENT");
    expect(source).toContain("setupStartupAttributeList");
    expect(source).toContain("setupInheritedHandleList");
  });

  it("creates restricted commands with an explicit environment and atomic Job membership", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );
    const start = source.indexOf("static int runSandboxed(");
    const end = source.indexOf("static int diagnoseRestrictedToken(", start);
    const runSandboxed = source.slice(start, end);

    expect(runSandboxed).toContain("snapshotCurrentEnvironment(environmentBlock)");
    expect(runSandboxed).toContain("CREATE_UNICODE_ENVIRONMENT");
    expect(runSandboxed).toContain("environmentBlock.data()");
    expect(runSandboxed).toContain("setupStartupAttributeList(inheritedHandles, job");
    expect(source).toContain("PROC_THREAD_ATTRIBUTE_JOB_LIST");
    expect(runSandboxed).not.toContain("CREATE_SUSPENDED");
    expect(runSandboxed).not.toContain("AssignProcessToJobObject");
    expect(runSandboxed).not.toContain("ResumeThread");
  });

  it("owns timeout termination in the private Job and emits a versioned terminal record", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("--timeout-ms");
    expect(source).toContain("TerminateJobObject");
    expect(source).toContain("waitForJobEmpty");
    expect(source).toContain("JobObjectBasicAccountingInformation");
    expect(source).toContain("JobObjectBasicProcessIdList");
    expect(source).toContain("QueryFullProcessImageNameW");
    expect(source).toContain("timeout-processes-v1");
    expect(source).toContain("emitTimeoutProcessSnapshot(job)");
    expect(source).toContain("terminal-v1");
    expect(source).toContain('L"timed_out"');
    expect(source).toContain('L"termination_failed"');
    expect(source).toContain('L"launch_failed"');
    expect(source).not.toContain("taskkill");
    expect(source).not.toContain("CreateToolhelp32Snapshot");
    expect(source).not.toContain("Process32First");
  });

  it("supervises the desktop server tree with a parent HANDLE and kill-on-close Job", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );
    const guardian = source.match(
      /static int superviseServer\(const Options& opts\) \{[\s\S]*?\n\}/
    )?.[0] || "";

    expect(source).toContain("--supervise-server");
    expect(source).toContain("--parent-pid");
    expect(guardian).toContain("OpenProcess(SYNCHRONIZE");
    expect(guardian).toContain("CreateProcessW(");
    expect(guardian).toContain("CREATE_SUSPENDED");
    expect(guardian).toContain("AssignProcessToJobObject");
    expect(guardian).toContain("WaitForMultipleObjects");
    expect(guardian).toContain("GetStdHandle(STD_INPUT_HANDLE)");
    expect(source).toContain("ReadFile(");
    expect(source).toContain("SetEvent(");
    expect(source).toContain("CancelSynchronousIo(");
    expect(guardian).toContain("stopGuardianControlWatch(controlWatch)");
    expect(guardian).toContain("controlWatch->event");
    expect(guardian).not.toMatch(/HANDLE watched\[\][^;]*controlInput/);
    expect(source).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
    expect(source).toContain("guardian-v1");
    expect(source).not.toContain("taskkill");
  });

  it("keeps Windows dev startup fast when the native helper is current", () => {
    const rootDir = "C:\\repo";
    const target = path.join(rootDir, "dist-sandbox", "win-x64", "hana-win-sandbox.exe");
    const build = vi.fn();
    const result = ensureWindowsSandboxHelper({
      rootDir,
      platform: "win32",
      arch: "x64",
      existsSync: () => true,
      statSync: (candidate: string) => ({ mtimeMs: candidate === target ? 20 : 10 }),
      build,
    });

    expect(result).toEqual({ skipped: false, built: false, target });
    expect(build).not.toHaveBeenCalled();
  });

  it("builds the Windows dev helper when missing or stale, and is a no-op elsewhere", () => {
    const build = vi.fn(() => ({ skipped: false, target: "built-helper.exe" }));
    expect(ensureWindowsSandboxHelper({ platform: "darwin", build }))
      .toEqual({ skipped: true, built: false });
    expect(build).not.toHaveBeenCalled();

    const result = ensureWindowsSandboxHelper({
      rootDir: "C:\\repo",
      platform: "win32",
      arch: "x64",
      existsSync: (candidate: string) => !candidate.endsWith("hana-win-sandbox.exe"),
      statSync: () => ({ mtimeMs: 10 }),
      build,
    });
    expect(result).toEqual({ skipped: false, built: true, target: "built-helper.exe" });
    expect(build).toHaveBeenCalledOnce();
  });

  it("preflights the guardian for every Electron dev entry point", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
    const preflight = "node scripts/ensure-windows-sandbox-helper.mjs && ";

    expect(packageJson.scripts.start).toContain(preflight);
    expect(packageJson.scripts["start:dev"]).toContain(preflight);
    expect(packageJson.scripts["start:vite"]).toContain(preflight);
  });

  it("keeps the helper build output independent of Electron installer configuration", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
    expect(packageJson.build).toBeUndefined();
    expect(packageJson.scripts.start).toContain("ensure-windows-sandbox-helper.mjs");
  });

  it("canonicalizes existing paths through the Win32 final path API before comparing sandbox roots", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("GetFinalPathNameByHandleW");
    expect(source).toContain("FILE_FLAG_BACKUP_SEMANTICS");
    expect(source).toContain("normalizePathKey");
  });

  it("keeps a scoped legacy AppContainer diagnostic and cleanup path", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../desktop/native/HanaWindowsSandboxHelper/main.cpp"),
      "utf8"
    );

    expect(source).toContain("--legacy-appcontainer-profile");
    expect(source).toContain("--cleanup-legacy-profile");
    expect(source).toContain("--diagnose-legacy-acl");
    expect(source).toContain("legacy-appcontainer-acl");
    expect(source).toContain("S-1-15-2-");
    expect(source).toContain("DeriveAppContainerSidFromAppContainerName");
    expect(source).toContain("DeleteAppContainerProfile");
    expect(source).toContain("REVOKE_ACCESS");
  });

  it("writes a batch script that calls VsDevCmd.bat before cl.exe", () => {
    const script = buildWindowsSandboxBatchScript({
      devCmd: "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\Tools\\VsDevCmd.bat",
      compileCommand: "cl.exe /nologo main.cpp",
      arch: "x64",
    });

    expect(script).toBe([
      "@echo off",
      'call "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\Tools\\VsDevCmd.bat" -arch=x64',
      "if errorlevel 1 exit /b %errorlevel%",
      "cl.exe /nologo main.cpp",
      "exit /b %errorlevel%",
      "",
    ].join("\r\n"));
  });
});
