/** Apple Silicon local runtime for the bundled MiniCPM5-2B MLX checkpoint. */
export const MINICPM5_PROVIDER_ID = "minicpm5-local";
// The checkpoint can encode longer positions, but Hanako deliberately keeps
// the interactive edge session at 32K for latency and tool-loop stability.
export const MINICPM5_CONTEXT_WINDOW = 32_768;

export const miniCPM5LocalPlugin = {
  id: MINICPM5_PROVIDER_ID,
  displayName: "MiniCPM5-2B (MLX 本地)",
  authType: "none",
  defaultBaseUrl: "http://127.0.0.1:8080/v1",
  defaultApi: "openai-completions",
  models: [{
    // MLX-LM resolves this alias to MINICPM5_MODEL_PATH. The human-facing
    // name stays stable while users can relocate the checkpoint.
    id: "default_model",
    name: "MiniCPM5-2B (MLX 本地)",
    context: MINICPM5_CONTEXT_WINDOW,
    maxOutput: 4096,
    generation: {
      // Stable defaults for a 16 GiB Apple Silicon edge session. The novel
      // writing profile can raise temperature/output for explicit creative
      // turns without changing the Agent/tool baseline.
      // Upstream 8-bit measurements report 0.6 / top-k 20 as the stable
      // quality point. The previous 0.2 / top-k 40 profile was tuned for the
      // older 4-bit checkpoint and makes this 8-bit merge overly terse.
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
      minP: 0.05,
      repetitionPenalty: 1.05,
    },
    image: false,
    // MLX-LM is started with enable_thinking=false. Keep Hana's model
    // capability metadata aligned so a restored session cannot request the
    // default medium reasoning level by accident.
    reasoning: false,
    thinkingLevels: ["off"],
    defaultThinkingLevel: "off",
    toolUse: {
      // XML is converted to this internal OpenAI-shaped contract in the stream adapter.
      supportsTools: true,
      dialect: "openai",
      toolResultFormat: "message",
      supportsParallelToolCalls: false,
    },
  }],
};
