import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@hana/plugin-protocol": path.resolve(__dirname, "packages/plugin-protocol/src/index.ts"),
      "@hana/plugin-sdk": path.resolve(__dirname, "packages/plugin-sdk/src/index.ts"),
      "@hana/plugin-runtime": path.resolve(__dirname, "packages/plugin-runtime/src/index.ts"),
      "@hana/plugin-components": path.resolve(__dirname, "packages/plugin-components/src/index.ts"),
      "@": path.resolve(__dirname, "desktop/src/react"),
    },
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      ".cache/**",
      // git worktree 副本有自己的测试快照，混进主树测试集会双份执行、断言错位
      ".claude/worktrees/**",
      "desktop/native/**/.build/**",
      "dist-computer-use/**",
    ],
    testTimeout: 10_000,
  },
});
