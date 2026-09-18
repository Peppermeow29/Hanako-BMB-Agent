import { describe, expect, it, vi } from "vitest";
import { Client, type HttpInstance } from "@larksuiteoapi/node-sdk";
import { renderFeishuCardKitSettings } from "../lib/bridge/bridge-presentation.ts";

function createClientHarness() {
  const request = vi.fn(async () => ({ data: { card_id: "card_1" } }));
  const client = new Client({
    appId: "app-id",
    appSecret: "app-secret",
    disableTokenCache: true,
    httpInstance: { request } as unknown as HttpInstance,
  });
  return { client, request };
}

describe("Feishu SDK CardKit payload contract", () => {
  it("unwraps the SDK data envelope into the HTTP request body", async () => {
    const { client, request } = createClientHarness();

    await client.cardkit.v1.card.create({
      data: {
        type: "card_json",
        data: "{\"schema\":\"2.0\"}",
      },
    });

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: "POST",
      data: {
        type: "card_json",
        data: "{\"schema\":\"2.0\"}",
      },
    }));
  });

  it.each([true, false])("passes the nested CardKit streaming config through the SDK for %s", async (streamingMode) => {
    const { client, request } = createClientHarness();

    await client.cardkit.v1.card.settings({
      path: { card_id: "card_1" },
      data: {
        settings: renderFeishuCardKitSettings(streamingMode),
        sequence: 2,
      },
    });

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        settings: streamingMode
          ? '{"config":{"streaming_mode":true}}'
          : '{"config":{"streaming_mode":false}}',
        sequence: 2,
      },
    }));
  });
});
