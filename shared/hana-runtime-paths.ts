import runtimePaths from "./hana-runtime-paths.cjs";

export const {
  resolveHanakoHome,
  resolveHanaPiSdkManagedBinDir,
  resolveHanaPiSdkResourceLoaderAgentDir,
  resolveHanaPiSdkResourceLoaderCwd,
  resolveHanaPiSdkRuntimeRoot,
  resolveLegacyPiSdkManagedBinDir,
} = runtimePaths;
