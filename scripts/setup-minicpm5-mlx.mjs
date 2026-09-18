#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelRoot = path.resolve(process.env.MINICPM5_MODEL_ROOT || path.join(root, ".."));
const virtualEnv = path.join(root, ".minicpm-venv");
const python = path.join(virtualEnv, "bin", "python");
const modelTargets = [
  path.join(modelRoot, "MiniCPM5-2B-MLX-8-bit"),
  path.join(modelRoot, "MiniCPM5-2B-MLX-4-bit"),
];
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (!existsSync(python)) run("python3", ["-m", "venv", virtualEnv]);
run(python, ["-m", "pip", "install", "--upgrade", "pip"]);
run(python, ["-m", "pip", "install", "mlx-lm>=0.30.0"]);
if (!modelTargets.some(target => existsSync(path.join(target, "model.safetensors")))) {
  console.error(
    "MiniCPM5 model weights are not bundled with this repository.\n"
    + "Download an MLX checkpoint from https://huggingface.co/openbmb (for example MiniCPM5-2B MLX 8-bit), "
    + `place it at ${modelTargets[0]}, then rerun this script.\n`
    + "Set MINICPM5_MODEL_ROOT to use another download location."
  );
  process.exit(1);
}
