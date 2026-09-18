import { describe, expect, it } from "vitest";

import {
  fingerprintSecret,
  formatSecretFingerprintComparison,
  redactSecretsFromText,
} from "../lib/secret-fingerprint.ts";

describe("process-scoped secret fingerprints", () => {
  it("compares secrets with length and keyed HMAC only", () => {
    const secret = "private-client-secret";
    const same = fingerprintSecret(secret);
    const changed = fingerprintSecret(`${secret}-changed`);
    const line = formatSecretFingerprintComparison({
      stage: "config_save",
      beforeLabel: "incoming",
      before: secret,
      afterLabel: "persisted",
      after: secret,
    });

    expect(same).toEqual(fingerprintSecret(secret));
    expect(changed.hmac).not.toBe(same.hmac);
    expect(line).toContain(`incoming.length=${secret.length}`);
    expect(line).toContain("incoming.hmac=");
    expect(line).toContain("persisted.hmac=");
    expect(line).toContain("match=true");
    expect(line).not.toContain(secret);
    expect(line).not.toContain(secret.slice(0, 6));
    expect(line).not.toContain(secret.slice(-6));
  });

  it("redacts exact short secrets before generic log redaction", () => {
    expect(redactSecretsFromText("upstream echoed abc123", ["abc123"]))
      .toBe("upstream echoed [redacted]");
  });
});
