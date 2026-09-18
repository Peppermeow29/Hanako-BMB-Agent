import { Hono } from "hono";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";
import { createHtmlPreviewRoute } from "../server/routes/html-preview.ts";

function makeApp(options = {}) {
  const app = new Hono();
  app.route("", createHtmlPreviewRoute(options));
  return app;
}

describe("HTML preview route", () => {
  it("serves registered HTML with a dedicated CDN-capable CSP and no referrer leakage", async () => {
    const app = makeApp({
      randomId: () => "pv_test",
      randomToken: () => "preview_secret",
      now: () => 1000,
    });
    const html = '<script src="https://cdn.tailwindcss.com"></script><h1 class="text-red-500">Hello</h1>';

    const register = await app.request("http://127.0.0.1:14500/api/preview/html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "demo.html", content: html }),
    });

    expect(register.status).toBe(200);
    const registered = await register.json();
    expect(registered.previewUrl).toBe("http://127.0.0.1:14500/preview/html/pv_test?previewToken=preview_secret");

    const rendered = await app.request(registered.previewUrl);

    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("Content-Type")).toContain("text/html");
    expect(rendered.headers.get("Cache-Control")).toBe("no-store");
    expect(rendered.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(rendered.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const csp = rendered.headers.get("Content-Security-Policy") || "";
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("script-src 'unsafe-inline' https:");
    expect(csp).toContain("style-src 'unsafe-inline' https:");
    expect(csp).toContain("font-src https: data:");
    expect(csp).toContain("img-src 'self' https: data: blob:");
    expect(csp).toContain("media-src 'self' https: data: blob:");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("script-src 'self'");
    expect(await rendered.text()).toBe(html);
  });

  it("adds a token-scoped asset base for HTML files so relative attachment images load through the preview route", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hana-html-preview-"));
    const sourceFilePath = path.join(tmp, "demo.html");
    const assetDir = path.join(tmp, "assets");
    fs.mkdirSync(assetDir, { recursive: true });
    fs.writeFileSync(sourceFilePath, '<img src="./assets/pic.png">');
    fs.writeFileSync(path.join(assetDir, "pic.png"), Buffer.from("PNG"));

    const app = makeApp({
      randomId: () => "pv_assets",
      randomToken: () => "preview_secret",
      now: () => 1000,
    });

    const register = await app.request("http://127.0.0.1:14500/api/preview/html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "demo.html",
        content: '<html><head><title>Demo</title></head><body><img src="./assets/pic.png"></body></html>',
        sourceFilePath,
      }),
    });
    const registered = await register.json();
    const rendered = await app.request(registered.previewUrl);
    const html = await rendered.text();
    const csp = rendered.headers.get("Content-Security-Policy") || "";
    const assetBase = "http://127.0.0.1:14500/preview/html/pv_assets/assets/preview_secret/";

    expect(html).toContain(`<base href="${assetBase}">`);
    expect(html.indexOf(`<base href="${assetBase}">`))
      .toBeLessThan(html.indexOf('<title>Demo</title>'));
    expect(csp).toContain(`base-uri ${assetBase}`);
    expect(csp).toContain(`script-src 'unsafe-inline' https: ${assetBase}`);
    expect(csp).toContain(`style-src 'unsafe-inline' https: ${assetBase}`);
    expect(csp).toContain(`font-src https: data: ${assetBase}`);
    expect(csp).toContain(`img-src ${assetBase} https: data: blob:`);
    expect(csp).toContain(`media-src ${assetBase} https: data: blob:`);

    const asset = await app.request("http://127.0.0.1:14500/preview/html/pv_assets/assets/preview_secret/assets/pic.png");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Content-Type")).toContain("image/png");
    expect(await asset.text()).toBe("PNG");

    const traversal = await app.request("http://127.0.0.1:14500/preview/html/pv_assets/assets/preview_secret/../demo.html");
    expect(traversal.status).toBe(404);
  });

  it("uses an explicit asset root so parent-directory and file-url images can load without exposing the whole disk", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-html-preview-root-"));
    const pageDir = path.join(root, "pages");
    const assetDir = path.join(root, "assets");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-html-preview-outside-"));
    fs.mkdirSync(pageDir, { recursive: true });
    fs.mkdirSync(assetDir, { recursive: true });

    const sourceFilePath = path.join(pageDir, "demo.html");
    const assetPath = path.join(assetDir, "Cover Image.png");
    const outsidePath = path.join(outsideDir, "secret.png");
    fs.writeFileSync(sourceFilePath, "<!doctype html>");
    fs.writeFileSync(assetPath, Buffer.from("PNG"));
    fs.writeFileSync(outsidePath, Buffer.from("SECRET"));

    const app = makeApp({
      randomId: () => "pv_rooted",
      randomToken: () => "preview_secret",
      now: () => 1000,
    });

    const register = await app.request("http://127.0.0.1:14500/api/preview/html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "demo.html",
        sourceFilePath,
        sourceRootPath: root,
        content: [
          "<html><head></head><body>",
          '<img id="relative" src="../assets/Cover%20Image.png">',
          `<img id="file-url" src="${pathToFileURL(assetPath).toString()}">`,
          `<img id="outside" src="${pathToFileURL(outsidePath).toString()}">`,
          "</body></html>",
        ].join(""),
      }),
    });
    const registered = await register.json();
    const rendered = await app.request(registered.previewUrl);
    const html = await rendered.text();
    const assetBase = "http://127.0.0.1:14500/preview/html/pv_rooted/assets/preview_secret/pages/";
    const assetUrl = "http://127.0.0.1:14500/preview/html/pv_rooted/assets/preview_secret/assets/Cover%20Image.png";

    expect(html).toContain(`<base href="${assetBase}">`);
    expect(html).toContain(`id="relative" src="../assets/Cover%20Image.png"`);
    expect(html).toContain(`id="file-url" src="${assetUrl}"`);
    expect(html).toContain(`id="outside" src="${pathToFileURL(outsidePath).toString()}"`);

    const relativeAsset = await app.request(assetUrl);
    expect(relativeAsset.status).toBe(200);
    expect(relativeAsset.headers.get("Content-Type")).toContain("image/png");
    expect(await relativeAsset.text()).toBe("PNG");

    const directTraversal = await app.request("http://127.0.0.1:14500/preview/html/pv_rooted/assets/preview_secret/pages/../demo.html");
    expect(directTraversal.status).toBe(404);
  });

  it("requires the per-preview token and expires entries from memory", async () => {
    let now = 1000;
    const app = makeApp({
      randomId: () => "pv_expiring",
      randomToken: () => "preview_secret",
      now: () => now,
      ttlMs: 10,
    });

    const register = await app.request("http://127.0.0.1:14500/api/preview/html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "demo.html", content: "<h1>Hello</h1>" }),
    });
    const { previewUrl } = await register.json();

    expect((await app.request("http://127.0.0.1:14500/preview/html/pv_expiring?previewToken=wrong")).status).toBe(404);
    expect((await app.request(previewUrl)).status).toBe(200);

    now = 1011;
    expect((await app.request(previewUrl)).status).toBe(404);
  });

  it("rejects oversized preview bodies before storing them", async () => {
    const app = makeApp({
      randomId: () => "pv_large",
      randomToken: () => "preview_secret",
      maxContentBytes: 8,
    });

    const register = await app.request("http://127.0.0.1:14500/api/preview/html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "demo.html", content: "<h1>too large</h1>" }),
    });

    expect(register.status).toBe(413);
    expect(await register.json()).toEqual({ error: "html_preview_too_large" });
  });
});
