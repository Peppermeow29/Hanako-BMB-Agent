import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-local-user-account-"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function writeUsers(root) {
  writeJson(path.join(root, "users.json"), {
    schemaVersion: 1,
    defaultUserId: "user_owner",
    users: [{
      userId: "user_owner",
      kind: "legacy_owner",
      displayName: "Owner",
      profileSource: "legacy_user_profile",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    }],
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
}

describe("local user account store", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("updates the default user profile without losing legacy fields", async () => {
    tmpDir = makeTmpDir();
    writeUsers(tmpDir);
    const { updateLocalAccountProfile, getLocalAccountSummary } = await import("../core/local-user-account.ts");

    const profile = updateLocalAccountProfile(tmpDir, {
      username: "hana-owner",
      displayName: "Hana Owner",
      now: "2026-05-16T01:00:00.000Z",
    });

    expect(profile).toMatchObject({
      userId: "user_owner",
      username: "hana-owner",
      displayName: "Hana Owner",
    });
    expect(getLocalAccountSummary(tmpDir)).toMatchObject({
      userId: "user_owner",
      username: "hana-owner",
      displayName: "Hana Owner",
      passwordSet: false,
    });
    const stored = JSON.parse(fs.readFileSync(path.join(tmpDir, "users.json"), "utf-8"));
    expect(stored.users[0]).toMatchObject({
      kind: "legacy_owner",
      profileSource: "legacy_user_profile",
      username: "hana-owner",
      displayName: "Hana Owner",
      updatedAt: "2026-05-16T01:00:00.000Z",
    });
  });

  it("stores only a password hash and verifies the local account password", async () => {
    tmpDir = makeTmpDir();
    writeUsers(tmpDir);
    const {
      setLocalAccountPassword,
      verifyLocalAccountPassword,
      getLocalAccountSummary,
    } = await import("../core/local-user-account.ts");

    setLocalAccountPassword(tmpDir, {
      password: "correct horse battery staple",
      now: "2026-05-16T01:00:00.000Z",
    });

    const raw = fs.readFileSync(path.join(tmpDir, "local-user-auth.json"), "utf-8");
    expect(raw).not.toContain("correct horse battery staple");
    expect(JSON.parse(raw).credentials[0]).toMatchObject({
      userId: "user_owner",
      algorithm: "scrypt-sha256",
      passwordHash: expect.any(String),
      passwordSalt: expect.any(String),
      updatedAt: "2026-05-16T01:00:00.000Z",
    });
    expect(getLocalAccountSummary(tmpDir)).toMatchObject({ passwordSet: true });
    expect(verifyLocalAccountPassword(tmpDir, {
      username: "Owner",
      password: "correct horse battery staple",
    })).toMatchObject({ ok: true, userId: "user_owner" });
    expect(verifyLocalAccountPassword(tmpDir, {
      username: "Owner",
      password: "wrong password",
    })).toEqual({ ok: false, reason: "invalid_credentials" });
  });
});
