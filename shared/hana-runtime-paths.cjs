const os = require("os");
const path = require("path");

function expandHome(input, homeDir = os.homedir()) {
  if (!input) return input;
  if (input === "~") return homeDir;
  if (input.startsWith("~/") || input.startsWith("~" + path.sep)) {
    return path.join(homeDir, input.slice(2));
  }
  return input;
}

function resolveHanakoHome(input, homeDir = os.homedir()) {
  const raw = input || path.join(homeDir, ".hanako");
  return path.resolve(expandHome(raw, homeDir));
}

function assertHanakoHome(hanakoHome, caller) {
  if (!hanakoHome || typeof hanakoHome !== "string") {
    throw new Error(`${caller}: hanakoHome is required`);
  }
}

function resolveHanaPiSdkRuntimeRoot(hanakoHome) {
  assertHanakoHome(hanakoHome, "resolveHanaPiSdkRuntimeRoot");
  return path.join(hanakoHome, "runtime", "pi-sdk");
}

function resolveHanaPiSdkManagedBinDir(hanakoHome) {
  return path.join(resolveHanaPiSdkRuntimeRoot(hanakoHome), "bin");
}

function resolveHanaPiSdkResourceLoaderCwd(hanakoHome) {
  return path.join(resolveHanaPiSdkRuntimeRoot(hanakoHome), "resource-loader", "project");
}

function resolveHanaPiSdkResourceLoaderAgentDir(hanakoHome) {
  return path.join(resolveHanaPiSdkRuntimeRoot(hanakoHome), "resource-loader", "agent");
}

function resolveLegacyPiSdkManagedBinDir(hanakoHome) {
  assertHanakoHome(hanakoHome, "resolveLegacyPiSdkManagedBinDir");
  return path.join(hanakoHome, ".pi", "agent", "bin");
}

module.exports = {
  resolveHanakoHome,
  resolveHanaPiSdkManagedBinDir,
  resolveHanaPiSdkResourceLoaderAgentDir,
  resolveHanaPiSdkResourceLoaderCwd,
  resolveHanaPiSdkRuntimeRoot,
  resolveLegacyPiSdkManagedBinDir,
};
