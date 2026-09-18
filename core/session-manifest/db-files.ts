import fs from "fs";
import path from "path";

export const SESSION_MANIFEST_DB_FILE_NAMES = [
  "session-manifest.db",
  "session-manifest.db-wal",
  "session-manifest.db-shm",
];

export function sanitizeSessionManifestFileSuffix(value) {
  return String(value)
    .replace(/:/g, "-")
    .replace(/\./g, "-");
}

export function moveSessionManifestDbFilesAside(opts: any = {}) {
  if (!opts.hanaHome) throw new Error("moveSessionManifestDbFilesAside requires hanaHome");
  if (!opts.suffix) throw new Error("moveSessionManifestDbFilesAside requires suffix");
  const hanaHome = path.resolve(opts.hanaHome);
  const suffix = sanitizeSessionManifestFileSuffix(opts.suffix);
  const moved = [];

  for (const name of SESSION_MANIFEST_DB_FILE_NAMES) {
    const from = path.join(hanaHome, name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(hanaHome, `${name}.${suffix}`);
    if (fs.existsSync(to)) {
      throw new Error(`Session manifest database target already exists: ${to}`);
    }
    fs.renameSync(from, to);
    moved.push({ from, to });
  }

  return moved;
}
