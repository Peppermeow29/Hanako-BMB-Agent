import { Hono } from "hono";

// Old clients must never reactivate channel scheduling or mutate saved history.
export function createChannelsRoute(_engine: any, _hub: any) {
  const route = new Hono();
  for (const path of ["/channels", "/channels/*", "/conversations/*"]) {
    route.all(path, c => c.json({
      code: "FEATURE_UNAVAILABLE",
      error: "Channels are not included in this edition.",
    }, 410));
  }
  return route;
}
