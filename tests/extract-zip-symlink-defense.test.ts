import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import archiver from "archiver";

import { extractZip } from "../lib/extract-zip.ts";

function buildZipWithSymlink(zipPath: any, { symlinkName, symlinkTarget, fileEntries = [] }: any) {
  return new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 1 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    if (symlinkName) archive.symlink(symlinkName, symlinkTarget);
    for (const entry of fileEntries) {
      archive.append(entry.content, { name: entry.name });
    }
    archive.finalize();
  });
}

describe("lib/extract-zip", () => {
  it("rejects archives that contain a symlink entry", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-extract-zip-symlink-"));
    try {
      const zipPath = path.join(tempRoot, "evil.zip");
      const targetCanary = path.join(tempRoot, "outside-canary.txt");
      fs.writeFileSync(targetCanary, "original", "utf-8");

      await buildZipWithSymlink(zipPath, {
        symlinkName: "payload",
        symlinkTarget: targetCanary,
        fileEntries: [{ name: "payload", content: "overwrite-bytes" }],
      });

      const destDir = path.join(tempRoot, "dest");
      fs.mkdirSync(destDir, { recursive: true });

      await expect(extractZip(zipPath, destDir)).rejects.toThrow(/symlink/i);

      // 关键：canary 未被覆写
      expect(fs.readFileSync(targetCanary, "utf-8")).toBe("original");
      // dest 内不应残留 symlink
      const destEntry = path.join(destDir, "payload");
      if (fs.existsSync(destEntry)) {
        const lstat = fs.lstatSync(destEntry);
        expect(lstat.isSymbolicLink()).toBe(false);
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("extracts a plain zip without symlink entries", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-extract-zip-plain-"));
    try {
      const zipPath = path.join(tempRoot, "good.zip");
      await buildZipWithSymlink(zipPath, {
        fileEntries: [
          { name: "README.md", content: "hello" },
          { name: "nested/inner.txt", content: "inner" },
        ],
      });

      const destDir = path.join(tempRoot, "dest");
      fs.mkdirSync(destDir, { recursive: true });

      await extractZip(zipPath, destDir);

      expect(fs.readFileSync(path.join(destDir, "README.md"), "utf-8")).toBe("hello");
      expect(fs.readFileSync(path.join(destDir, "nested", "inner.txt"), "utf-8")).toBe("inner");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps search tool zip downloads on the hardened wrapper", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib", "pi-sdk", "search-tools.ts"),
      "utf-8",
    );

    expect(source).toContain('import { extractZip } from "../extract-zip.ts";');
    expect(source).not.toContain('from "extract-zip"');
    expect(source).toContain("await extractZip(archivePath, extractDir);");
  });
});
