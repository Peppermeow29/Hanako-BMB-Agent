import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUploadRoute } from "../server/routes/upload.ts";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.ts";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-upload-route-"));
}

// 大小写不敏感的文件系统（macOS / Windows）上，同一个目录有多种拼写。
// 只有这类文件系统能暴露"同一文件的不同路径表示"，大小写敏感的 Linux 上
// 大小写不同就是两个不同目录，构造不出别名，相关用例整体跳过。
const FS_CASE_INSENSITIVE = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "hana-case-probe-"));
  try {
    fs.mkdirSync(path.join(probe, "Probe"));
    return fs.existsSync(path.join(probe, "probe"));
  } catch {
    return false;
  } finally {
    try { fs.rmSync(probe, { recursive: true, force: true }); } catch {}
  }
})();

describe("upload route", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      tmpDir = null;
    }
  });

  it("rejects a symlink root path", async () => {
    tmpDir = mktemp();
    const targetFile = path.join(tmpDir, "real.txt");
    const linkPath = path.join(tmpDir, "link.txt");
    fs.writeFileSync(targetFile, "hello", "utf-8");
    fs.symlinkSync(targetFile, linkPath);

    const app = new Hono();
    app.route("/api", createUploadRoute({ hanakoHome: path.join(tmpDir, "hana-home") }));

    const res = await app.request("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [linkPath] }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.uploads[0]).toMatchObject({
      src: linkPath,
      error: "symlink not allowed",
    });
  });

  it("accepts directories that contain symlinks by registering a reference", async () => {
    tmpDir = mktemp();
    const dirPath = path.join(tmpDir, "cycle");
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, "note.txt"), "hello", "utf-8");
    fs.symlinkSync(dirPath, path.join(dirPath, "loop"));

    const app = new Hono();
    app.route("/api", createUploadRoute({ hanakoHome: path.join(tmpDir, "hana-home") }));

    const res = await app.request("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [dirPath] }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.uploads[0].error).toBeUndefined();
    expect(data.uploads[0]).toMatchObject({
      src: dirPath,
      dest: fs.realpathSync(dirPath),
      isDirectory: true,
    });
  });

  it("registers a dropped directory as an external reference without copying", async () => {
    tmpDir = mktemp();
    const dirPath = path.join(tmpDir, "big-folder");
    fs.mkdirSync(dirPath, { recursive: true });
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(dirPath, `f-${i}.txt`), "x", "utf-8");
    }
    const hanakoHome = path.join(tmpDir, "hana-home");
    const sessionPath = path.join(tmpDir, "sessions", "upload.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n");
    const registry = new SessionFileRegistry({ managedCacheRoot: path.join(hanakoHome, "session-files") });
    const engine = {
      hanakoHome,
      registerSessionFile: registry.registerFile.bind(registry),
      getSessionFileBySourceKey: registry.getBySourceKey.bind(registry),
    };
    const app = new Hono();
    app.route("/api", createUploadRoute(engine));

    const res = await app.request("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [dirPath], sessionPath }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    const up = data.uploads[0];
    expect(up.error).toBeUndefined();
    expect(up.isDirectory).toBe(true);
    expect(up.storageKind).toBe("external");
    expect(up.dest).toBe(fs.realpathSync(dirPath));
    expect(up.fileId).toBeTruthy();
    // 12 个文件的目录不再撞 9 文件上限，且没有任何字节被复制进 session-files 缓存
    const cacheRoot = path.join(hanakoHome, "session-files");
    const cacheEntries = fs.existsSync(cacheRoot)
      ? fs.readdirSync(cacheRoot).flatMap((d) => fs.readdirSync(path.join(cacheRoot, d)))
      : [];
    expect(cacheEntries).toHaveLength(0);
    const [entry] = registry.list(sessionPath);
    expect(entry.storageKind).toBe("external");
    expect(entry.filePath).toBe(fs.realpathSync(dirPath));
    expect(entry.isDirectory).toBe(true);
  });

  // upload 路由与 SessionFileRegistry 必须用同一种 realpath 语义。Node 的 JS 版
  // fs.realpathSync 保留调用方给的那种拼写，native 版（fs.realpathSync.native，以及
  // 只有 native 语义的 fs/promises.realpath）返回磁盘上的真实拼写：macOS 上体现为
  // 大小写，Windows 上体现为 8.3 短名（RUNNER~1 vs runneradmin）。两边语义只要不一致，
  // 同一个目录经不同入口就会算出两个 realPath，去重键、SessionFile id 和沙箱路径匹配
  // 会一起失准，同一个目录被登记成两条记录。
  it.skipIf(!FS_CASE_INSENSITIVE)("reuses the session file when another entry point registered the same directory under a different spelling", async () => {
    tmpDir = mktemp();
    const dirPath = path.join(tmpDir, "CasedFolder");
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, "note.txt"), "hello", "utf-8");
    const aliasPath = path.join(tmpDir, "casedfolder");
    expect(fs.existsSync(aliasPath)).toBe(true);

    const hanakoHome = path.join(tmpDir, "hana-home");
    const sessionPath = path.join(tmpDir, "sessions", "upload.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n");
    const registry = new SessionFileRegistry({ managedCacheRoot: path.join(hanakoHome, "session-files") });
    const engine = {
      hanakoHome,
      registerSessionFile: registry.registerFile.bind(registry),
      getSessionFileBySourceKey: registry.getBySourceKey.bind(registry),
    };

    // 另一条入口（stage_files、插件输出等）先用别名拼写登记了同一个目录
    const first = registry.registerFile({
      sessionPath,
      filePath: aliasPath,
      label: "casedfolder",
      origin: "tool_output",
      storageKind: "external",
    });

    const app = new Hono();
    app.route("/api", createUploadRoute(engine));
    const res = await app.request("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [aliasPath], sessionPath }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.uploads[0].error).toBeUndefined();
    expect(data.uploads[0].fileId).toBe(first.id);
    expect(registry.list(sessionPath)).toHaveLength(1);
  });

  it("caps one upload request at 9 attachments", async () => {
    tmpDir = mktemp();
    const paths = [];
    for (let i = 0; i < 10; i++) {
      const p = path.join(tmpDir, `f-${i}.txt`);
      fs.writeFileSync(p, "x", "utf-8");
      paths.push(p);
    }
    const app = new Hono();
    app.route("/api", createUploadRoute({ hanakoHome: path.join(tmpDir, "hana-home") }));

    const res = await app.request("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    });
    const data = await res.json();

    expect(data.uploads.filter((u) => !u.error)).toHaveLength(9);
    expect(data.uploads[9].error).toBeTruthy();
  });

  it("upload-blob writes base64 image to uploads dir with sanitized name", async () => {
    tmpDir = mktemp();
    const hanakoHome = path.join(tmpDir, "hana-home");
    const app = new Hono();
    app.route("/api", createUploadRoute({ hanakoHome }));

    // 1x1 PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );

    const res = await app.request("/api/upload-blob", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "shot.png", base64Data: png.toString("base64"), mimeType: "image/png" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.uploads).toHaveLength(1);
    const up = data.uploads[0];
    expect(up.error).toBeUndefined();
    expect(up.name).toBe("shot.png");
    expect(up.isDirectory).toBe(false);
    expect(fs.existsSync(up.dest)).toBe(true);
    expect(fs.readFileSync(up.dest).equals(png)).toBe(true);
  });

  it("registers copied uploads as session files when sessionPath is provided", async () => {
    tmpDir = mktemp();
    const source = path.join(tmpDir, "note.txt");
    fs.writeFileSync(source, "hello", "utf-8");
    const hanakoHome = path.join(tmpDir, "hana-home");
    const sessionPath = "/sessions/upload.jsonl";
    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
      id: "sf_upload",
      sessionPath,
      filePath,
      realPath: filePath,
      displayName: label,
      filename: path.basename(filePath),
      label,
      ext: "txt",
      mime: "text/plain",
      size: 5,
      kind: "document",
      origin,
      storageKind,
      createdAt: 1,
    }));
    const app = new Hono();
    app.route("/api", createUploadRoute({ hanakoHome, registerSessionFile }));

    const res = await app.request("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [source], sessionPath }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(registerSessionFile).toHaveBeenCalledWith({
      sessionPath,
      filePath: data.uploads[0].dest,
      label: "note.txt",
      origin: "user_upload",
      storageKind: "managed_cache",
      sourceKey: expect.stringMatching(/^upload:path:v1:[a-f0-9]{64}$/),
    });
    expect(data.uploads[0].dest.startsWith(path.join(hanakoHome, "session-files"))).toBe(true);
    expect(data.uploads[0]).toMatchObject({
      src: source,
      name: "note.txt",
      fileId: "sf_upload",
      sessionPath,
      mime: "text/plain",
      kind: "document",
      origin: "user_upload",
      storageKind: "managed_cache",
    });
  });

  it("reuses one session file for repeated uploads of the same source file", async () => {
    tmpDir = mktemp();
    const source = path.join(tmpDir, "note.txt");
    fs.writeFileSync(source, "hello", "utf-8");
    const hanakoHome = path.join(tmpDir, "hana-home");
    const sessionPath = path.join(tmpDir, "sessions", "upload.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n");
    const registry = new SessionFileRegistry({ managedCacheRoot: path.join(hanakoHome, "session-files") });
    const engine = {
      hanakoHome,
      registerSessionFile: registry.registerFile.bind(registry),
      getSessionFileBySourceKey: registry.getBySourceKey.bind(registry),
    };
    const app = new Hono();
    app.route("/api", createUploadRoute(engine));

    const body = JSON.stringify({ paths: [source], sessionPath });
    const firstRes = await app.request("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const first = await firstRes.json();
    const secondRes = await app.request("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const second = await secondRes.json();

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(second.uploads[0].fileId).toBe(first.uploads[0].fileId);
    expect(second.uploads[0].dest).toBe(first.uploads[0].dest);
    expect(registry.list(sessionPath)).toHaveLength(1);
    expect(fs.readdirSync(path.dirname(first.uploads[0].dest))).toHaveLength(1);
  });

  it("upload-blob stores session-owned pasted images under session file cache", async () => {
    tmpDir = mktemp();
    const hanakoHome = path.join(tmpDir, "hana-home");
    const sessionPath = "/sessions/blob.jsonl";
    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
      id: "sf_blob",
      sessionPath,
      filePath,
      realPath: filePath,
      displayName: label,
      filename: path.basename(filePath),
      label,
      ext: "png",
      mime: "image/png",
      size: 68,
      kind: "image",
      origin,
      storageKind,
      createdAt: 1,
    }));
    const app = new Hono();
    app.route("/api", createUploadRoute({ hanakoHome, registerSessionFile }));
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );

    const res = await app.request("/api/upload-blob", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionPath, name: "shot.png", base64Data: png.toString("base64"), mimeType: "image/png" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.uploads[0].dest.startsWith(path.join(hanakoHome, "session-files"))).toBe(true);
    expect(registerSessionFile).toHaveBeenCalledWith({
      sessionPath,
      filePath: data.uploads[0].dest,
      label: "shot.png",
      origin: "user_upload",
      storageKind: "managed_cache",
      presentation: "attachment",
      listed: true,
      sourceKey: expect.stringMatching(/^upload:blob-content:v1:[a-f0-9]{64}$/),
    });
    expect(data.uploads[0]).toMatchObject({
      fileId: "sf_blob",
      sessionPath,
      storageKind: "managed_cache",
    });
  });

  it("reuses one session file for repeated blob uploads with the same bytes", async () => {
    tmpDir = mktemp();
    const hanakoHome = path.join(tmpDir, "hana-home");
    const sessionPath = path.join(tmpDir, "sessions", "blob.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n");
    const registry = new SessionFileRegistry({ managedCacheRoot: path.join(hanakoHome, "session-files") });
    const engine = {
      hanakoHome,
      registerSessionFile: registry.registerFile.bind(registry),
      getSessionFileBySourceKey: registry.getBySourceKey.bind(registry),
    };
    const app = new Hono();
    app.route("/api", createUploadRoute(engine));
    const audioBytes = Buffer.from("webm audio bytes");
    const body = JSON.stringify({
      sessionPath,
      name: "recording.webm",
      base64Data: audioBytes.toString("base64"),
      mimeType: "audio/webm",
      presentation: "voice-input",
    });

    const firstRes = await app.request("/api/upload-blob", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const first = await firstRes.json();
    const secondRes = await app.request("/api/upload-blob", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const second = await secondRes.json();

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(second.uploads[0].fileId).toBe(first.uploads[0].fileId);
    expect(second.uploads[0].dest).toBe(first.uploads[0].dest);
    expect(registry.list(sessionPath)).toHaveLength(1);
    expect(fs.readdirSync(path.dirname(first.uploads[0].dest))).toHaveLength(1);
  });

  it("upload-blob stores session-owned recorded audio under session file cache", async () => {
    tmpDir = mktemp();
    const hanakoHome = path.join(tmpDir, "hana-home");
    const sessionPath = "/sessions/audio-blob.jsonl";
    const audioBytes = Buffer.from("webm audio bytes");
    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind, presentation, listed }) => ({
      id: "sf_audio",
      sessionPath,
      filePath,
      realPath: filePath,
      displayName: label,
      filename: path.basename(filePath),
      label,
      ext: "weba",
      mime: "audio/webm",
      size: audioBytes.length,
      kind: "audio",
      origin,
      storageKind,
      presentation,
      listed,
      createdAt: 1,
    }));
    const app = new Hono();
    app.route("/api", createUploadRoute({ hanakoHome, registerSessionFile }));

    const res = await app.request("/api/upload-blob", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionPath,
        name: "recording.webm",
        base64Data: audioBytes.toString("base64"),
        mimeType: "audio/webm",
        presentation: "voice-input",
      }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.uploads[0].error).toBeUndefined();
    expect(data.uploads[0].name).toBe("recording.weba");
    expect(data.uploads[0].dest.startsWith(path.join(hanakoHome, "session-files"))).toBe(true);
    expect(fs.readFileSync(data.uploads[0].dest).equals(audioBytes)).toBe(true);
    expect(registerSessionFile).toHaveBeenCalledWith({
      sessionPath,
      filePath: data.uploads[0].dest,
      label: "recording.weba",
      origin: "voice_input",
      storageKind: "managed_cache",
      presentation: "voice-input",
      listed: false,
      sourceKey: expect.stringMatching(/^upload:blob-content:v1:[a-f0-9]{64}$/),
    });
    expect(data.uploads[0]).toMatchObject({
      fileId: "sf_audio",
      sessionPath,
      mime: "audio/webm",
      kind: "audio",
      storageKind: "managed_cache",
      presentation: "voice-input",
      listed: false,
    });
  });

  it("upload-blob rejects non-image mimeType", async () => {
    tmpDir = mktemp();
    const app = new Hono();
    app.route("/api", createUploadRoute({ hanakoHome: path.join(tmpDir, "hana-home") }));

    const res = await app.request("/api/upload-blob", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "evil.exe",
        base64Data: Buffer.from("MZ").toString("base64"),
        mimeType: "application/x-msdownload",
      }),
    });
    const data = await res.json();
    expect(data.uploads[0].error).toBe("unsupported mimeType");
  });

  it("upload-blob rejects image mimeTypes that the chat send path cannot accept", async () => {
    tmpDir = mktemp();
    const app = new Hono();
    app.route("/api", createUploadRoute({ hanakoHome: path.join(tmpDir, "hana-home") }));

    const res = await app.request("/api/upload-blob", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "diagram.svg",
        base64Data: Buffer.from("<svg></svg>").toString("base64"),
        mimeType: "image/svg+xml",
      }),
    });
    const data = await res.json();
    expect(data.uploads[0]).toMatchObject({ error: "unsupported mimeType" });
    expect(data.uploads[0].dest).toBeUndefined();
  });

  it("upload-blob only accepts voice-input presentation for audio blobs", async () => {
    tmpDir = mktemp();
    const app = new Hono();
    app.route("/api", createUploadRoute({ hanakoHome: path.join(tmpDir, "hana-home") }));
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );

    const res = await app.request("/api/upload-blob", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "shot.png",
        base64Data: png.toString("base64"),
        mimeType: "image/png",
        presentation: "voice-input",
      }),
    });
    const data = await res.json();

    expect(data.uploads[0].error).toBe("voice-input requires audio mimeType");
  });

  it("upload-blob forces extension to match mimeType (defends against name spoofing)", async () => {
    tmpDir = mktemp();
    const hanakoHome = path.join(tmpDir, "hana-home");
    const app = new Hono();
    app.route("/api", createUploadRoute({ hanakoHome }));

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );

    const res = await app.request("/api/upload-blob", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "../../etc/passwd.exe",
        base64Data: png.toString("base64"),
        mimeType: "image/png",
      }),
    });
    const data = await res.json();
    const up = data.uploads[0];
    expect(up.error).toBeUndefined();
    // basename + 强制扩展名
    expect(up.name).toBe("passwd.png");
    // 确保落点在 uploads 目录内
    expect(up.dest.startsWith(path.join(hanakoHome, "uploads"))).toBe(true);
  });

  it("upload-blob takes the basename from Windows-style paths before sanitizing", async () => {
    tmpDir = mktemp();
    const app = new Hono();
    app.route("/api", createUploadRoute({ hanakoHome: path.join(tmpDir, "hana-home") }));

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );

    const res = await app.request("/api/upload-blob", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "C:\\Users\\hana\\evil?.exe",
        base64Data: png.toString("base64"),
        mimeType: "image/png",
      }),
    });
    const data = await res.json();

    expect(data.uploads[0].error).toBeUndefined();
    expect(data.uploads[0].name).toBe("evil.png");
    expect(path.basename(data.uploads[0].dest)).toMatch(/^evil_[a-z0-9]+_[a-f0-9]{8}\.png$/);
  });

  it("upload-blob avoids Windows reserved device filenames", async () => {
    tmpDir = mktemp();
    const app = new Hono();
    app.route("/api", createUploadRoute({ hanakoHome: path.join(tmpDir, "hana-home") }));

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );

    const res = await app.request("/api/upload-blob", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "CON. ",
        base64Data: png.toString("base64"),
        mimeType: "image/png",
      }),
    });
    const data = await res.json();

    expect(data.uploads[0].error).toBeUndefined();
    expect(data.uploads[0].name).toBe("file-CON.png");
    expect(path.basename(data.uploads[0].dest)).toMatch(/^file-CON_[a-z0-9]+_[a-f0-9]{8}\.png$/);
  });

  it("upload-blob rejects oversized blob", async () => {
    tmpDir = mktemp();
    const app = new Hono();
    app.route("/api", createUploadRoute({ hanakoHome: path.join(tmpDir, "hana-home") }));

    // 16 MiB 原始数据会膨胀成超过 20 MiB 的 base64，发送路径会拒绝，上传路径也必须提前拒绝。
    const big = Buffer.alloc(16 * 1024 * 1024);
    const res = await app.request("/api/upload-blob", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "huge.png",
        base64Data: big.toString("base64"),
        mimeType: "image/png",
      }),
    });
    const data = await res.json();
    expect(data.uploads[0].error).toMatch(/too large/);
  });
});
