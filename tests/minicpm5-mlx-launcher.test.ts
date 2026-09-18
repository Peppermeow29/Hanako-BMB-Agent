import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const launcher = path.resolve(process.cwd(), "scripts/minicpm5-mlx-server.mjs");
const tempRoots: string[] = [];
const mlxHost = process.platform === "darwin" && process.arch === "arm64";

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function checkpoint(overrides: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-minicpm5-launcher-"));
  tempRoots.push(root);
  fs.writeFileSync(path.join(root, "model.safetensors"), "");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    rope_theta: 5_000_000,
    max_position_embeddings: 131_072,
    quantization_config: { bits: 8, group_size: 64 },
    ...overrides,
  }));
  return root;
}

function runLauncher(modelPath: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [launcher], {
    encoding: "utf8",
    env: {
      ...process.env,
      MINICPM5_MODEL_PATH: modelPath,
      // The launcher only needs a child that exits cleanly for the valid
      // configuration case; this avoids loading a real MLX model in tests.
      MINICPM5_PYTHON: "/usr/bin/true",
      MINICPM5_REQUIRE_8BIT: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: Number.isInteger(result.status) ? result.status : 1,
    output: `${String(result.stdout || "")}\n${String(result.stderr || "")}`,
  };
}

describe("MiniCPM5 MLX launcher checkpoint guards", () => {
  const testOnMlxHost = mlxHost ? it : it.skip;

  testOnMlxHost("rejects a checkpoint that only nests rope_theta", () => {
    const modelPath = checkpoint({
      rope_theta: undefined,
      rope_parameters: { rope_theta: 5_000_000 },
    });
    const result = runLauncher(modelPath);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/positive flat rope_theta/i);
  });

  testOnMlxHost("rejects a checkpoint whose position limit is below 64K", () => {
    const modelPath = checkpoint({ max_position_embeddings: 32_768 });
    const result = runLauncher(modelPath);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/max_position_embeddings must be at least 65536/i);
  });

  testOnMlxHost("can require the bundled 8-bit quantization", () => {
    const modelPath = checkpoint({
      quantization_config: { bits: 4, group_size: 64 },
    });
    const result = runLauncher(modelPath, { MINICPM5_REQUIRE_8BIT: "1" });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/REQUIRE_8BIT=1.*quantization\.bits=4/i);
  });

  testOnMlxHost("logs the long-context and 8-bit configuration before spawning", () => {
    const modelPath = checkpoint();
    const result = runLauncher(modelPath);

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/quantization=8-bit\/group64/);
    expect(result.output).toMatch(/ropeTheta=5000000/);
    expect(result.output).toMatch(/maxPositionEmbeddings=131072/);
  });
});
