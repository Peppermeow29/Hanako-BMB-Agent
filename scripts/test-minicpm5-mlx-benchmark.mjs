#!/usr/bin/env node
/**
 * Real MiniCPM5-2B MLX-LM benchmark. The server must already be running.
 * This script is read-only and only sends chat-completion requests.
 */
import process from "node:process";
import { Agent as UndiciAgent, request as undiciRequest } from "undici";

const baseUrl = String(process.env.MINICPM5_BASE_URL || "http://127.0.0.1:18080/v1").replace(/\/$/, "");
const timeoutMs = Number(process.env.MINICPM5_BENCHMARK_TIMEOUT_MS || 180_000);
const contextTargets = String(process.env.MINICPM5_CONTEXTS || "4096,8192,16384")
  .split(",").map(value => Number(value.trim())).filter(value => Number.isFinite(value) && value > 0);
const onlyContext = process.env.MINICPM5_ONLY_CONTEXT === "1";
const onlyOutput = process.env.MINICPM5_ONLY_OUTPUT === "1";
const novelContinuation = process.env.MINICPM5_NOVEL_CONTINUATION === "1";
const cacheProbe = process.env.MINICPM5_CACHE_PROBE === "1";
const outputCaps = String(process.env.MINICPM5_OUTPUT_CAPS || "128,512,1024")
  .split(",").map(value => Number(value.trim())).filter(value => Number.isFinite(value) && value > 0);
const dispatcher = new UndiciAgent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchJson(url, init = {}, timeout = timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await undiciRequest(url, {
      ...init,
      dispatcher,
      headersTimeout: timeout,
      bodyTimeout: timeout,
      signal: controller.signal,
    });
    const text = await response.body.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`${response.statusCode}: ${JSON.stringify(body).slice(0, 800)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function processRssKb() {
  // Avoid shelling out from every request; macOS ps output is sufficient and
  // this remains diagnostic-only. The Hanako wrapper is a Python process whose
  // command line does not contain mlx_lm.server, so include its entrypoint.
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const { stdout } = await exec("ps", ["-axo", "pid=,rss=,command="]);
    const rows = stdout.split("\n").map(line => line.trim()).filter(Boolean);
    const matches = rows.filter(row => /mlx_lm\.server|mlx_lm server|minicpm5_mlx_server\.py/.test(row));
    const rss = matches.map(row => {
      const match = /^(\d+)\s+(\d+)\s+/.exec(row);
      return match ? { pid: Number(match[1]), rssKb: Number(match[2]), command: row.slice(match[0].length, match[0].length + 180) } : null;
    }).filter(Boolean);
    return rss.length ? rss : null;
  } catch {
    return null;
  }
}

function repeatedPrompt(targetTokens) {
  // A single ASCII character is close to one tokenizer token for this model;
  // avoid long hyphenated words that inflate the actual prompt by 8x.
  return `${"x ".repeat(targetTokens)}\n\n请只回答 CONTEXT_OK。`;
}

function novelPrompt(targetTokens) {
  const fillerTokens = Math.max(1, targetTokens - 240);
  const section = Math.floor(fillerTokens / 3);
  return [
    "【卷一设定】主角林岚在雾港醒来。开篇密令是：银杏信。",
    "x ".repeat(section),
    "【卷二设定】中段会面地点是：旧天文台。反派不知晓密令。",
    "x ".repeat(section),
    "【卷三设定】结尾交接的物品是：琥珀钥匙。林岚仍在雾港。",
    "x ".repeat(fillerTokens - section * 2),
    "\n\n仅按顺序回答开篇密令、中段地点、结尾物品；每项只写答案，以逗号分隔。",
  ].join("\n");
}

function requestBody(model, promptOrMessages, options = {}) {
  return {
    model,
    messages: Array.isArray(promptOrMessages) ? promptOrMessages : [{ role: "user", content: promptOrMessages }],
    stream: false,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    top_p: options.topP,
    ...(options.topK != null ? { top_k: options.topK } : {}),
    ...(options.minP != null ? { min_p: options.minP } : {}),
    ...(options.repetitionPenalty != null ? { repetition_penalty: options.repetitionPenalty } : {}),
    // The checkpoint's template opens a think channel by default.  Keep the
    // benchmark's ordinary text/context cases deterministic even when it is
    // pointed at a server started without Hanako's launcher defaults.
    chat_template_kwargs: { enable_thinking: options.enableThinking === true },
  };
}

async function runCase(model, name, prompt, options) {
  const startedAt = Date.now();
  const beforeRss = await processRssKb();
  try {
    const body = await fetchJson(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody(model, prompt, options)),
    });
    const choice = body.choices?.[0] || {};
    const message = choice.message || {};
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content || "");
    return {
      name,
      ok: true,
      elapsedMs: Date.now() - startedAt,
      promptChars: prompt.length,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      topP: options.topP,
      finishReason: choice.finish_reason || null,
      outputChars: text.length,
      outputPreview: text.slice(0, 240),
      outputText: text,
      usage: body.usage || null,
      beforeRss,
      afterRss: await processRssKb(),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      promptChars: prompt.length,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      topP: options.topP,
      error: error instanceof Error ? error.message : String(error),
      beforeRss,
      afterRss: await processRssKb(),
    };
  }
}

async function runNovelContinuation(model, targetTokens, options) {
  const prompt = novelPrompt(targetTokens);
  const first = await runCase(model, `novel-first-${targetTokens}`, prompt, options);
  if (!first.ok) return { first, second: null };
  const second = await runCase(
    model,
    `novel-continuation-${targetTokens}`,
    [
      { role: "user", content: prompt },
      { role: "assistant", content: first.outputText },
      { role: "user", content: "不要解释。请再次按顺序回答开篇密令、中段地点、结尾物品。" },
    ],
    options,
  );
  return { first, second };
}

const models = await fetchJson(`${baseUrl}/models`);
const model = models.data?.[0]?.id;
if (!model) throw new Error("No model returned by MLX-LM server");

const results = [];
function record(result) {
  results.push(result);
  console.error(`[minicpm5-benchmark] ${result.name}: ${result.ok ? `ok ${result.elapsedMs}ms` : `FAILED ${result.error}`}`);
  return result;
}
// Values measured and published with the bundled 8-bit checkpoint.  The old
// 4-bit profile (0.2 / top-k 40) made this benchmark disagree with the model
// card and could hide the think-channel looping seen at higher temperatures.
const stable = { temperature: 0.6, topP: 0.95, topK: 20, minP: 0.05, repetitionPenalty: 1.05, enableThinking: false };
if (!onlyContext) {
  record(await runCase(model, "basic-stable", "请用一句中文回答：MiniCPM 本地链路正常吗？", { ...stable, maxTokens: 128 }));
  record(await runCase(model, "sampling-low-temp", "请输出 5 个不同的简短中文词语，用逗号分隔。", { ...stable, temperature: 0.1, maxTokens: 128 }));
  record(await runCase(model, "sampling-default-temp", "请输出 5 个不同的简短中文词语，用逗号分隔。", { ...stable, temperature: 1.0, topP: 0.95, maxTokens: 128 }));

  for (const maxTokens of outputCaps) {
    record(await runCase(
      model,
      `max-output-${maxTokens}`,
      "请尽可能连续输出编号 1 到 200，每行一个编号，不要解释。",
      { ...stable, maxTokens },
    ));
  }
}

if (!onlyOutput) for (const targetTokens of contextTargets) {
  if (novelContinuation) {
    const novel = await runNovelContinuation(model, targetTokens, { ...stable, maxTokens: 64 });
    record({ ...novel.first, targetContextTokens: targetTokens, scenario: "novel-retrieval" });
    if (novel.second) record({ ...novel.second, targetContextTokens: targetTokens, scenario: "novel-continuation" });
    if (!novel.first.ok || (novel.second && !novel.second.ok)) break;
  } else {
    const prompt = repeatedPrompt(targetTokens);
    const result = await runCase(
      model,
      `context-${targetTokens}`,
      prompt,
      { ...stable, maxTokens: 64 },
    );
    record({ ...result, targetContextTokens: targetTokens });
    if (!result.ok && targetTokens >= 16384) break;
    if (cacheProbe && result.ok) {
      record({
        ...await runCase(model, `context-cache-probe-${targetTokens}`, prompt, { ...stable, maxTokens: 64 }),
        targetContextTokens: targetTokens,
        scenario: "identical-prompt-cache-probe",
      });
    }
  }
  // Give the unified memory allocator a moment to release temporary buffers.
  await sleep(250);
}

console.log(JSON.stringify({
  baseUrl,
  model,
  generatedAt: new Date().toISOString(),
  hostMemoryBytes: 17_179_869_184,
  results,
}, null, 2));
await dispatcher.close();
