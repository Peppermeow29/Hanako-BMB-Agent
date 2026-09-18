import { Hono } from "hono";

// Agent-to-agent phone DM is independent from WeChat/Feishu bridge DM.
export function createDmRoute(_engine: any, _hub: any = null) {
  const route = new Hono();
  for (const path of ["/dm", "/dm/*"]) {
    route.all(path, c => c.json({
      code: "FEATURE_UNAVAILABLE",
      error: "Agent phone messaging is not included in this edition.",
    }, 410));
  }
  return route;
}
