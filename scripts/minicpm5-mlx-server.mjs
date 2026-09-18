#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configuredModelPath = String(process.env.MINICPM5_MODEL_PATH || "").trim();
const defaultModelCandidates = [
  // The project ships the 8-bit checkpoint as the primary MiniCPM5 target.
  // It preserves the upstream long-context quality point and is still small
  // enough for the user's 16 GiB Apple Silicon machine.
  path.resolve(root, "..", "MiniCPM5-2B-MLX-8-bit"),
  path.resolve(root, "..", "MiniCPM5-2B-MLX-4-bit"),
  // Keep the original name as a final compatibility candidate for older
  // checkouts that stored a manually renamed checkpoint.
  path.resolve(root, "..", "MiniCPM5-2B"),
];
const hasCheckpoint = (candidate) => (
  existsSync(path.join(candidate, "config.json"))
  && existsSync(path.join(candidate, "model.safetensors"))
);
const modelPath = configuredModelPath
  ? path.resolve(configuredModelPath)
  : (defaultModelCandidates.find(hasCheckpoint) || defaultModelCandidates[0]);
const pythonPath = process.env.MINICPM5_PYTHON || path.join(root, ".minicpm-venv", "bin", "python");
const port = process.env.MINICPM5_PORT || "8080";
const memoryProfile = process.env.MINICPM5_MEMORY_PROFILE || "edge";
const memoryProfiles = {
  // Lowest idle footprint. Every request re-prefills its prompt, so this is
  // appropriate for occasional short tasks, not iterative writing or agents.
  // MLX-LM's parser accepts raw bytes (not `0B`), and its LRU must retain a
  // slot while inserting before byte trimming. A one-byte budget evicts every
  // completed KV cache without breaking the server.
  minimal: { prefillStepSize: "512", promptCacheSize: "1", promptCacheBytes: "1" },
  // Default profile for a 16 GiB machine: one 16K writing/agent cache is
  // useful, but a completed 64K cache must not remain resident by default.
  edge: { prefillStepSize: "1024", promptCacheSize: "1", promptCacheBytes: "768MB" },
  // Retains a little more cache for several medium prompts; still serial.
  balanced: { prefillStepSize: "1024", promptCacheSize: "1", promptCacheBytes: "1GB" },
  // Explicit opt-in for a full long-context review. It does not make 64K fast.
  long: { prefillStepSize: "1024", promptCacheSize: "1", promptCacheBytes: "3GB" },
};
const selectedProfile = memoryProfiles[memoryProfile];
if (!selectedProfile) {
  console.error(`Unknown MINICPM5_MEMORY_PROFILE=${memoryProfile}. Use minimal, edge, balanced, or long.`);
  process.exit(1);
}
const prefillStepSize = process.env.MINICPM5_PREFILL_STEP_SIZE || selectedProfile.prefillStepSize;
const decodeConcurrency = process.env.MINICPM5_DECODE_CONCURRENCY || "1";
const promptConcurrency = process.env.MINICPM5_PROMPT_CONCURRENCY || "1";
const promptCacheSize = process.env.MINICPM5_PROMPT_CACHE_SIZE || selectedProfile.promptCacheSize;
const promptCacheBytes = process.env.MINICPM5_PROMPT_CACHE_BYTES || selectedProfile.promptCacheBytes;

function numericEnv(name, fallback, { integer = false, min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = integer ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a ${integer ? "finite integer" : "finite number"} in [${min}, ${max}]: ${raw}`);
  }
  return value;
}

// Keep the edge profile deterministic by default, while allowing local
// benchmarking and the Hanako settings layer to choose another policy without
// editing this launcher.
const temperature = numericEnv("MINICPM5_TEMPERATURE", 0.6, { min: 0, max: 2 });
const topP = numericEnv("MINICPM5_TOP_P", 0.95, { min: 0, max: 1 });
const topK = numericEnv("MINICPM5_TOP_K", 20, { integer: true, min: 0 });
const minP = numericEnv("MINICPM5_MIN_P", 0.05, { min: 0, max: 1 });
const repetitionPenalty = numericEnv("MINICPM5_REPETITION_PENALTY", 1.05, { min: 0 });
// Keep the launcher default aligned with the provider metadata.  Ordinary
// turns still finish early because the request carries its own cap; reasoning
// turns need enough room for the native <think> block plus a visible answer.
const maxTokens = numericEnv("MINICPM5_MAX_TOKENS", 4096, { integer: true, min: 0 });

function parseCacheBytes(value) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(|M|G|MB|GB)\s*$/i.exec(String(value));
  if (!match) throw new Error(`MINICPM5_PROMPT_CACHE_BYTES must be raw bytes, MB, or GB: ${value}`);
  const units = { "": 1, M: 1e6, MB: 1e6, G: 1e9, GB: 1e9 };
  return Math.floor(Number(match[1]) * units[match[2].toUpperCase()]);
}
const enforcedPromptCacheBytes = parseCacheBytes(promptCacheBytes);

if (process.arch !== "arm64" || process.platform !== "darwin") {
  console.error("MiniCPM5 MLX local runtime requires Apple Silicon macOS.");
  process.exit(1);
}
if (!existsSync(path.join(modelPath, "config.json")) || !existsSync(path.join(modelPath, "model.safetensors"))) {
  console.error(`MiniCPM5 MLX checkpoint was not found at ${modelPath}. Set MINICPM5_MODEL_PATH to override.`);
  process.exit(1);
}

// MiniCPM5's long-context quality depends on a transformers-v5 compatibility
// detail: mlx-lm 0.31 reads the flat `rope_theta` key, not only the nested
// `rope_parameters.rope_theta` form.  Fail early instead of starting a server
// that looks healthy at short prompts but degenerates past ~12K tokens.
function readCheckpointConfig(checkpointPath) {
  try {
    return JSON.parse(readFileSync(path.join(checkpointPath, "config.json"), "utf8"));
  } catch (error) {
    throw new Error(`MiniCPM5 checkpoint config.json is invalid at ${checkpointPath}: ${error?.message || error}`);
  }
}

const checkpointConfig = readCheckpointConfig(modelPath);
const ropeTheta = Number(checkpointConfig.rope_theta);
if (!Number.isFinite(ropeTheta) || ropeTheta <= 0) {
  throw new Error(
    `MiniCPM5 checkpoint must define a positive flat rope_theta (nested rope_parameters is not enough): ${modelPath}`,
  );
}
const maxPositionEmbeddings = Number(checkpointConfig.max_position_embeddings);
if (!Number.isFinite(maxPositionEmbeddings) || maxPositionEmbeddings < 65_536) {
  throw new Error(
    `MiniCPM5 checkpoint max_position_embeddings must be at least 65536, got ${String(checkpointConfig.max_position_embeddings)}`,
  );
}
const quantization = checkpointConfig.quantization_config || checkpointConfig.quantization || {};
const quantBits = Number(quantization.bits);
const quantGroupSize = Number(quantization.group_size);
const require8Bit = process.env.MINICPM5_REQUIRE_8BIT === "1";
if (require8Bit && quantBits !== 8) {
  throw new Error(`MINICPM5_REQUIRE_8BIT=1 but checkpoint quantization.bits=${String(quantization.bits)} at ${modelPath}`);
}
if (quantBits !== 8) {
  console.error(`[minicpm5-mlx] warning: checkpoint quantization.bits=${String(quantization.bits)} (expected 8 for the bundled MLX 8-bit model)`);
}
if (quantBits === 8 && quantGroupSize !== 64) {
  console.error(`[minicpm5-mlx] warning: 8-bit checkpoint group_size=${String(quantization.group_size)} (model card reports 64)`);
}
console.error(`[minicpm5-mlx] checkpoint=${modelPath} quantization=${Number.isFinite(quantBits) ? `${quantBits}-bit` : "unknown"}/${Number.isFinite(quantGroupSize) ? `group${quantGroupSize}` : "unknown"} ropeTheta=${ropeTheta} maxPositionEmbeddings=${maxPositionEmbeddings}`);
if (!existsSync(pythonPath)) {
  console.error(`MLX Python runtime was not found at ${pythonPath}. Run: npm run minicpm:setup`);
  process.exit(1);
}

const serverEntrypoint = path.join(root, "scripts", "minicpm5_mlx_server.py");
const child = spawn(pythonPath, [
  serverEntrypoint, "--model", modelPath, "--host", "127.0.0.1", "--port", String(port),
  "--temp", String(temperature), "--top-p", String(topP), "--top-k", String(topK),
  "--min-p", String(minP), "--max-tokens", String(maxTokens),
  // A 16 GiB unified-memory machine should keep one long active session cache,
  // not MLX-LM's default ten. Exact-prefix reuse speeds novel continuation and
  // the byte cap prevents a series of 64K transcripts from exhausting memory.
  "--prefill-step-size", String(prefillStepSize),
  "--decode-concurrency", String(decodeConcurrency),
  "--prompt-concurrency", String(promptConcurrency),
  "--prompt-cache-size", String(promptCacheSize),
  "--prompt-cache-bytes", String(promptCacheBytes),
  "--chat-template-args", '{"enable_thinking":false}',
], {
  stdio: "inherit",
  env: {
    ...process.env,
    MINICPM5_ENFORCED_PROMPT_CACHE_BYTES: String(enforcedPromptCacheBytes),
    MINICPM5_DEFAULT_REPETITION_PENALTY: String(repetitionPenalty),
  },
});
console.error(`[minicpm5-mlx] memoryProfile=${memoryProfile} prefillStepSize=${prefillStepSize} promptCacheSize=${promptCacheSize} promptCacheBytes=${promptCacheBytes} decodeConcurrency=${decodeConcurrency} promptConcurrency=${promptConcurrency} temperature=${temperature} topP=${topP} topK=${topK} minP=${minP} repetitionPenalty=${repetitionPenalty} maxTokens=${maxTokens}`);

// The Hanako server may own this wrapper. Forward termination to the Python
// MLX process so closing Hanako releases the model and its unified-memory KV
// cache instead of leaving an orphan listener on port 8080.
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { child.kill(signal); } catch {}
  });
}
child.on("exit", code => process.exit(code ?? 1));
