import { describe, expect, it, vi } from "vitest";

import {
  DINGTALK_API_BASE_URL,
  DINGTALK_LEGACY_AUTH_MODE,
  DINGTALK_LEGACY_REST_API_BASE_URL,
  canonicalizeDingTalkBridgeConfig,
  normalizeDingTalkBridgeCredentials,
} from "../lib/bridge/dingtalk-contract.ts";

describe("DingTalk bridge credential contract", () => {
  it("uses canonical non-empty fields before legacy aliases", () => {
    expect(normalizeDingTalkBridgeCredentials({
      corpId: "corp-canonical",
      clientId: "client-canonical",
      clientSecret: "secret-canonical",
      robotCode: "robot-canonical",
      apiBaseUrl: "https://gateway.example/v1.0",
      appKey: "client-legacy",
      appSecret: "secret-legacy",
      restBaseUrl: "https://legacy-gateway.example/v1.0",
    })).toMatchObject({
      corpId: "corp-canonical",
      clientId: "client-canonical",
      clientSecret: "secret-canonical",
      robotCode: "robot-canonical",
      apiBaseUrl: "https://gateway.example/v1.0",
    });
  });

  it("reads legacy aliases but canonicalizes persistence fields", () => {
    expect(canonicalizeDingTalkBridgeConfig({
      corpId: "corp-1",
      appKey: "client-legacy",
      appSecret: "secret-legacy",
      robotCode: "robot-1",
      restBaseUrl: DINGTALK_LEGACY_REST_API_BASE_URL,
      enabled: true,
    })).toMatchObject({
      corpId: "corp-1",
      clientId: "client-legacy",
      clientSecret: "secret-legacy",
      robotCode: "robot-1",
      apiBaseUrl: DINGTALK_API_BASE_URL,
      appKey: null,
      appSecret: null,
      restBaseUrl: null,
      enabled: true,
    });
  });

  it("does not resurrect legacy aliases after canonical fields were explicitly cleared", () => {
    expect(canonicalizeDingTalkBridgeConfig({
      corpId: "corp-1",
      clientId: "",
      appKey: "legacy-client",
      clientSecret: "",
      appSecret: "legacy-secret",
      robotCode: "robot-1",
      apiBaseUrl: "",
      restBaseUrl: "https://legacy-gateway.example/v1.0",
    })).toMatchObject({
      clientId: "",
      clientSecret: "",
      apiBaseUrl: DINGTALK_API_BASE_URL,
      appKey: null,
      appSecret: null,
      restBaseUrl: null,
    });
  });

  it("migrates only the exact legacy default host and preserves custom gateways", () => {
    expect(normalizeDingTalkBridgeCredentials({
      corpId: "corp-1",
      clientId: "client-1",
      clientSecret: "secret-1",
      robotCode: "robot-1",
      restBaseUrl: `${DINGTALK_LEGACY_REST_API_BASE_URL}/`,
    }).apiBaseUrl).toBe(DINGTALK_API_BASE_URL);

    expect(normalizeDingTalkBridgeCredentials({
      corpId: "corp-1",
      clientId: "client-1",
      clientSecret: "secret-1",
      robotCode: "robot-1",
      restBaseUrl: "https://tenant-gateway.example/dingtalk/v1.0/",
    }).apiBaseUrl).toBe("https://tenant-gateway.example/dingtalk/v1.0");
  });

  it("preserves an explicit custom Stream registration endpoint", () => {
    expect(normalizeDingTalkBridgeCredentials({
      corpId: "corp-1",
      clientId: "client-1",
      clientSecret: "secret-1",
      robotCode: "robot-1",
      streamOpenUrl: "https://stream.example/v1.0/gateway/connections/open#fragment",
    }).streamOpenUrl).toBe("https://stream.example/v1.0/gateway/connections/open");
  });

  it("requires corpId in addition to Stream and robot credentials", () => {
    expect(() => normalizeDingTalkBridgeCredentials({
      clientId: "client-1",
      clientSecret: "secret-1",
      robotCode: "robot-1",
    })).toThrow(/corpId/i);
  });

  it("allows missing corpId only with the persisted legacy application marker", () => {
    expect(normalizeDingTalkBridgeCredentials({
      authMode: DINGTALK_LEGACY_AUTH_MODE,
      clientId: "client-1",
      clientSecret: "secret-1",
      robotCode: "robot-1",
    })).toMatchObject({
      authMode: "legacy_app",
      corpId: "",
      apiBaseUrl: DINGTALK_LEGACY_REST_API_BASE_URL,
    });
    expect(() => normalizeDingTalkBridgeCredentials({
      authMode: "future-mode",
      clientId: "client-1",
      clientSecret: "secret-1",
      robotCode: "robot-1",
    })).toThrow(/unsupported.*authMode/i);
  });

  it("switches a legacy-marked config to the current contract when corpId is supplied", () => {
    expect(canonicalizeDingTalkBridgeConfig({
      authMode: DINGTALK_LEGACY_AUTH_MODE,
      corpId: "corp-1",
      clientId: "client-1",
      clientSecret: "secret-1",
      robotCode: "robot-1",
      apiBaseUrl: DINGTALK_LEGACY_REST_API_BASE_URL,
    })).toMatchObject({
      authMode: null,
      corpId: "corp-1",
      apiBaseUrl: DINGTALK_API_BASE_URL,
    });
  });

});
