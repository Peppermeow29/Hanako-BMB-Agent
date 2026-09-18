import { describe, expect, it } from "vitest";

import {
  deriveStudioAccessGrant,
  getStudioConnectionProfile,
  validateStudioConnectionTrust,
} from "../shared/studio-access-contract.ts";

function localConnection( patch: any = {}) {
  return {
    connectionId: "local",
    kind: "local",
    serverId: "local",
    userId: null,
    studioId: "local",
    baseUrl: "http://127.0.0.1:3210",
    wsUrl: "ws://127.0.0.1:3210",
    token: "local-token",
    authState: "paired",
    trustState: "local",
    credentialKind: "loopback_token",
    platformAccountId: null,
    officialServiceKind: null,
    capabilities: ["chat", "resources", "tools"],
    ...patch,
  };
}

describe("shared trusted studio access contract", () => {
  it("keeps relay as a forwarding profile for user-owned server data", () => {
    expect(getStudioConnectionProfile("relay")).toMatchObject({
      transport: "official_relay",
      credentialKinds: ["user_session"],
      requiresDevicePairing: true,
      requiresPlatformAccount: true,
      dataOwner: "user_server",
      officialServiceKind: "relay",
    });
  });

  it("keeps cloud as the only profile whose data owner is the hosted cloud studio", () => {
    expect(getStudioConnectionProfile("cloud")).toMatchObject({
      transport: "official_cloud",
      credentialKinds: ["user_session"],
      requiresDevicePairing: false,
      requiresPlatformAccount: true,
      dataOwner: "hana_cloud_studio",
      officialServiceKind: "cloud_studio",
    });
  });

  it("rejects local connections that drift away from loopback transport", () => {
    expect(() => validateStudioConnectionTrust(localConnection({
      baseUrl: "https://hana.example",
    }))).toThrow("local connection must use loopback baseUrl and wsUrl");
  });

  it("does not grant desktop-only local file access through a relay connection", () => {
    const relay = localConnection({
      connectionId: "relay:phone",
      kind: "relay",
      serverId: "server_relay",
      userId: "user_relay",
      studioId: "studio_relay",
      baseUrl: "https://relay.hana.example",
      wsUrl: "wss://relay.hana.example",
      token: "relay-session-token",
      trustState: "tunnel",
      credentialKind: "user_session",
      platformAccountId: "acct_relay",
      officialServiceKind: "relay",
    });

    expect(deriveStudioAccessGrant(relay)).toMatchObject({
      grantId: "access:relay:phone:studio_relay",
      scope: {
        serverId: "server_relay",
        userId: "user_relay",
        studioId: "studio_relay",
      },
      capabilities: [
        "chat",
        "resources.read",
        "tools.run",
      ],
    });
  });

  it("grants mobile file scopes only when the remote connection asks for file access", () => {
    const lan = localConnection({
      connectionId: "lan:phone",
      kind: "lan",
      serverId: "server_lan",
      userId: "user_lan",
      studioId: "studio_lan",
      baseUrl: "http://192.168.1.20:14500",
      wsUrl: "ws://192.168.1.20:14500",
      token: "device-token",
      trustState: "lan",
      credentialKind: "device_credential",
      capabilities: ["chat", "resources", "files"],
    });

    expect(deriveStudioAccessGrant(lan).capabilities).toEqual([
      "chat",
      "resources.read",
      "files.read",
      "files.write",
    ]);
  });

  it("treats local account browser sessions on LAN as user-owned account access, not platform account access", () => {
    const lanAccount = localConnection({
      connectionId: "lan:browser-session",
      kind: "lan",
      serverId: "server_lan",
      userId: "local_account_user",
      studioId: "studio_lan",
      baseUrl: "http://192.168.1.20:14500",
      wsUrl: "ws://192.168.1.20:14500",
      token: null,
      authState: "user",
      trustState: "lan",
      credentialKind: "user_session",
      capabilities: ["chat", "resources", "files"],
    });

    expect(deriveStudioAccessGrant(lanAccount)).toMatchObject({
      actorKind: "account_user",
      localOnly: false,
      dataOwner: "user_server",
    });
  });
});
