import { describe, expect, it } from "vitest";
import {
  buildConnectionWsUrl,
  createDeviceServerConnection,
  createLocalServerConnection,
} from "../desktop/src/react/services/server-connection.ts";

describe("server connection websocket URLs", () => {
  it("keeps loopback query token support for local owner connections", () => {
    const local = createLocalServerConnection({ serverPort: 14500, serverToken: "local-token" });

    expect(buildConnectionWsUrl(local!, "/ws")).toBe("ws://127.0.0.1:14500/ws?token=local-token");
  });

  it("uses short-lived websocket tickets for remote device connections instead of device credentials", () => {
    const remote = createDeviceServerConnection({
      baseUrl: "http://192.168.1.9:14500",
      credential: "hana_dev_secret",
      identity: {
        serverId: "server_remote",
        serverNodeId: "node_remote",
        userId: "user_1",
        studioId: "studio_1",
        label: "LAN Studio",
        connectionKind: "lan",
        capabilities: ["chat"],
      },
    });

    expect(buildConnectionWsUrl(remote, "/ws")).toBe("ws://192.168.1.9:14500/ws");
    expect(buildConnectionWsUrl(remote, "/ws", { wsTicket: "hana_ws_ticket" })).toBe(
      "ws://192.168.1.9:14500/ws?wsTicket=hana_ws_ticket",
    );
  });
});
