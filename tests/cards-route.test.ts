import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createCardsRoute } from "../server/routes/cards.ts";

function buildApp() {
  const app = new Hono();
  app.route("/api", createCardsRoute({}));
  return app;
}

function putCard(app: Hono, cardId: string, body: Record<string, unknown>) {
  return app.request(`/api/cards/${cardId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("cards route", () => {
  it("PUT registers code, then GET serves it as HTML", async () => {
    const app = buildApp();
    const code = '<button onclick="x()">开始</button>';
    const put = await putCard(app, "c_abc123", { code, title: "pomodoro", varsCss: "--accent: #537D96;" });
    expect(put.status).toBe(200);

    const get = await app.request("/api/cards/c_abc123");
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toContain("text/html");
    const html = await get.text();
    expect(html).toContain(code);
    expect(html).toContain("--accent: #537D96;");
  });

  it("GET on an unknown cardId returns 404", async () => {
    const app = buildApp();
    const get = await app.request("/api/cards/c_missing");
    expect(get.status).toBe(404);
  });

  it("allows inline card code while blocking every external side-effect channel", async () => {
    const app = buildApp();
    await putCard(app, "c_csp", { code: "<div>x</div>" });
    const get = await app.request("/api/cards/c_csp");
    const csp = get.headers.get("content-security-policy");

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("navigate-to 'none'");
    expect(csp).not.toMatch(/https?:/);
  });

  it("rejects PUT without code (no silent fallback)", async () => {
    const app = buildApp();
    const res = await putCard(app, "c_nocode", { title: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid cardId on both PUT and GET", async () => {
    const app = buildApp();
    const put = await putCard(app, "bad id!", { code: "<div>x</div>" });
    expect(put.status).toBe(400);
    const get = await app.request("/api/cards/bad%20id!");
    expect(get.status).toBe(400);
  });

  it("rejects oversized code with 413", async () => {
    const app = buildApp();
    const huge = "x".repeat(512 * 1024 + 1);
    const res = await putCard(app, "c_huge", { code: huge });
    expect(res.status).toBe(413);
  });

  it("evicts the oldest card once capacity (256) is exceeded", async () => {
    const app = buildApp();
    // 注册 257 张：c_0 应被淘汰，c_256 与 c_1 仍在。
    for (let i = 0; i < 257; i++) {
      const res = await putCard(app, `c_${i}`, { code: `<div>card ${i}</div>` });
      expect(res.status).toBe(200);
    }
    const evicted = await app.request("/api/cards/c_0");
    expect(evicted.status).toBe(404);
    const newest = await app.request("/api/cards/c_256");
    expect(newest.status).toBe(200);
  });
});
