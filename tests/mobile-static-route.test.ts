import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-mobile-static-"));
}

describe("mobile static route", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("serves the mobile renderer entry from /mobile without allowing traversal", async () => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, "assets"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "lib"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "themes"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "locales"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "mobile.html"), "<!doctype html><title>Mobile</title>", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "assets", "mobile.js"), "console.log('mobile')", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "lib", "i18n.js"), "window.t = () => ''", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "themes", "warm-paper.css"), ":root{}", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "locales", "zh.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "icon.png"), "png", "utf-8");
    const { createMobileStaticRoute } = await import("../server/routes/mobile-static.ts");
    const app = new Hono();
    app.route("", createMobileStaticRoute({ mode: "dist", distDir: tmpDir }));

    const entry = await app.request("/mobile/");
    expect(entry.status).toBe(200);
    expect(entry.headers.get("content-type")).toContain("text/html");
    expect(await entry.text()).toContain("<title>Mobile</title>");

    const asset = await app.request("/mobile/assets/mobile.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");

    const icon = await app.request("/mobile/icon.png");
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toContain("image/png");

    expect((await app.request("/mobile/lib/i18n.js")).status).toBe(200);
    expect((await app.request("/mobile/themes/warm-paper.css")).status).toBe(200);
    expect((await app.request("/mobile/locales/zh.json")).status).toBe(200);

    const traversal = await app.request("/mobile/assets/../mobile.html");
    expect(traversal.status).toBe(404);
  });

  it("serves the same PWA shell from /desktop for browser access on another computer", async () => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "mobile.html"), "<!doctype html><title>Mobile</title>", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "assets", "mobile.js"), "console.log('mobile')", "utf-8");
    const { createMobileStaticRoute } = await import("../server/routes/mobile-static.ts");
    const app = new Hono();
    app.route("", createMobileStaticRoute({ mode: "dist", distDir: tmpDir }));

    const entry = await app.request("/desktop/");
    expect(entry.status).toBe(200);
    expect(entry.headers.get("cache-control")).toBe("no-cache");
    expect(await entry.text()).toContain("<title>Mobile</title>");

    const indexAlias = await app.request("/desktop/index.html");
    expect(indexAlias.status).toBe(200);
    expect(await indexAlias.text()).toContain("<title>Mobile</title>");

    const asset = await app.request("/desktop/assets/mobile.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");

    const traversal = await app.request("/desktop/assets/../mobile.html");
    expect(traversal.status).toBe(404);
  });

  it("guide mode serves a 200 pull-the-bundle page at the base path but 404s on asset subpaths", async () => {
    const { createMobileStaticRoute } = await import("../server/routes/mobile-static.ts");
    const app = new Hono();
    app.route("", createMobileStaticRoute({ mode: "guide" }));

    const mobileEntry = await app.request("/mobile");
    expect(mobileEntry.status).toBe(200);
    expect(mobileEntry.headers.get("content-type")).toContain("text/html");
    const mobileBody = await mobileEntry.text();
    expect(mobileBody).toContain("hana bundle pull");

    const desktopEntry = await app.request("/desktop/");
    expect(desktopEntry.status).toBe(200);
    expect(await desktopEntry.text()).toContain("hana bundle pull");

    const asset = await app.request("/mobile/assets/xxx");
    expect(asset.status).toBe(404);
  });

  it("error mode serves a 503 unavailable page across the whole surface and logs the reason once, without leaking it into the body", async () => {
    const { createMobileStaticRoute } = await import("../server/routes/mobile-static.ts");
    const errorSpy = vitestSpyOnConsoleError();
    const app = new Hono();
    app.route("", createMobileStaticRoute({ mode: "error", reason: "/some/absolute/broken/path is missing mobile.html" }));

    expect(errorSpy.calls.some((args) => String(args[0]).includes("/some/absolute/broken/path"))).toBe(true);
    errorSpy.restore();

    const mobileEntry = await app.request("/mobile");
    expect(mobileEntry.status).toBe(503);
    const body = await mobileEntry.text();
    expect(body).not.toContain("/some/absolute/broken/path");

    const asset = await app.request("/mobile/assets/xxx");
    expect(asset.status).toBe(503);
  });
});

function vitestSpyOnConsoleError() {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    calls,
    restore: () => {
      console.error = original;
    },
  };
}

describe("resolveMobileStaticRouteOptions (startup decision, four quadrants)", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("env set + valid -> dist, using the injected directory", async () => {
    const { resolveMobileStaticRouteOptions } = await import("../server/routes/mobile-static.ts");
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, "mobile.html"), "<!doctype html>", "utf-8");
    const devDistDir = makeTmpDir();
    fs.writeFileSync(path.join(devDistDir, "mobile.html"), "<!doctype html>", "utf-8");

    const result = resolveMobileStaticRouteOptions({ env: { HANA_RENDERER_DIST: tmpDir }, devDistDir });
    expect(result).toEqual({ mode: "dist", distDir: tmpDir });
    fs.rmSync(devDistDir, { recursive: true, force: true });
  });

  it("env set + invalid -> error, never falls back to the dev tree", async () => {
    const { resolveMobileStaticRouteOptions } = await import("../server/routes/mobile-static.ts");
    tmpDir = makeTmpDir(); // exists but has no mobile.html
    const devDistDir = makeTmpDir();
    fs.writeFileSync(path.join(devDistDir, "mobile.html"), "<!doctype html>", "utf-8");

    const result = resolveMobileStaticRouteOptions({ env: { HANA_RENDERER_DIST: tmpDir }, devDistDir });
    expect(result.mode).toBe("error");
    expect((result as { reason: string }).reason).toContain(tmpDir);
    fs.rmSync(devDistDir, { recursive: true, force: true });
  });

  it("env unset + dev tree present -> dist, using the dev tree", async () => {
    const { resolveMobileStaticRouteOptions } = await import("../server/routes/mobile-static.ts");
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, "mobile.html"), "<!doctype html>", "utf-8");

    const result = resolveMobileStaticRouteOptions({ env: {}, devDistDir: tmpDir });
    expect(result).toEqual({ mode: "dist", distDir: tmpDir });
  });

  it("env unset + dev tree absent -> guide", async () => {
    const { resolveMobileStaticRouteOptions } = await import("../server/routes/mobile-static.ts");
    tmpDir = makeTmpDir();
    const missingDevDistDir = path.join(tmpDir, "does-not-exist");

    const result = resolveMobileStaticRouteOptions({ env: {}, devDistDir: missingDevDistDir });
    expect(result).toEqual({ mode: "guide" });
  });
});
