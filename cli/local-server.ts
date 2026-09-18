import fs from "fs";
import os from "os";
import path from "path";

export function resolveCliHanaHome(env = process.env) {
  return resolveHomePath(env.HANA_HOME || path.join(os.homedir(), ".hanako"));
}

function resolveHomePath(value) {
  const raw = String(value || "").trim();
  if (!raw) return path.join(os.homedir(), ".hanako");
  if (raw === "~") return os.homedir();
  if (raw.startsWith(`~${path.sep}`) || raw.startsWith("~/")) {
    return path.resolve(path.join(os.homedir(), raw.slice(2)));
  }
  return path.resolve(raw);
}

export function readLocalServerInfo({ hanaHome = resolveCliHanaHome(), checkProcess = true } = {}) {
  const filePath = path.join(hanaHome, "server-info.json");
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      reason: "missing_server_info",
      filePath,
      message: `No running HanaAgent Server was found at ${filePath}`,
    };
  }

  let info;
  try {
    info = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    return {
      ok: false,
      reason: "invalid_server_info",
      filePath,
      message: `Cannot read ${filePath}: ${err.message}`,
    };
  }

  if (!Number.isInteger(info.port) || info.port <= 0 || !info.token) {
    return {
      ok: false,
      reason: "incomplete_server_info",
      filePath,
      message: `${filePath} is missing port or token`,
    };
  }

  if (checkProcess && Number.isInteger(info.pid) && !isProcessAlive(info.pid)) {
    return {
      ok: false,
      reason: "stale_server_info",
      filePath,
      message: `HanaAgent Server process ${info.pid} is no longer running`,
    };
  }

  return {
    ok: true,
    filePath,
    info,
    baseUrl: `http://127.0.0.1:${info.port}`,
    token: info.token,
    source: "server-info",
  };
}

export function resolveConnection({ url, token, hanaHome }: { url?: string; token?: string; hanaHome?: string } = {}) {
  if (url) {
    return {
      ok: true,
      baseUrl: stripTrailingSlash(url),
      token: token || "",
      source: "explicit",
      queryTokenAllowed: false,
    };
  }

  const local = readLocalServerInfo({ hanaHome });
  if (!local.ok) return local;
  return {
    ...local,
    baseUrl: stripTrailingSlash(local.baseUrl),
    queryTokenAllowed: true,
  };
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}
