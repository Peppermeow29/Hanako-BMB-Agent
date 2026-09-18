const path = require("path");

// Electron patches its fs module for asar paths. Diagnostics are written to
// the real user data directory, so prefer original-fs when it is available.
function resolveRealFs(requireFn = require) {
  try {
    return requireFn("original-fs");
  } catch {
    return requireFn("fs");
  }
}

const fs = resolveRealFs();

function writeLaunchDiagnostic({ diagnosticsDir, fileName, event, payload, now = new Date() }) {
  if (!diagnosticsDir || !fileName) {
    throw new Error("writeLaunchDiagnostic: diagnosticsDir and fileName are required");
  }
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  const filePath = path.join(diagnosticsDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify({
    event,
    time: now instanceof Date ? now.toISOString() : String(now),
    payload,
  }, null, 2) + "\n", "utf-8");
  return filePath;
}

function appendLaunchLog({ diagnosticsDir, event, payload, now = new Date() }) {
  if (!diagnosticsDir) return null;
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  const filePath = path.join(diagnosticsDir, "launch.log");
  fs.appendFileSync(filePath, JSON.stringify({
    event,
    time: now instanceof Date ? now.toISOString() : String(now),
    payload,
  }) + "\n", "utf-8");
  return filePath;
}

module.exports = {
  appendLaunchLog,
  resolveRealFs,
  writeLaunchDiagnostic,
};
