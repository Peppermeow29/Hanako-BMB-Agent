#!/usr/bin/env node
/**
 * End-to-end MiniCPM5 test through Hanako's real server/session/WebSocket path.
 *
 * The test home is kept on disk so the generated session JSONL and event log
 * can be inspected after the run. The model-facing cwd remains CodeLife.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import WebSocket from "ws";

const root = path.resolve(import.meta.dirname, "..");
const codeLife = path.resolve(process.env.MINICPM5_WORKSPACE || "/tmp/hanako-workspace");
const modelPath = path.resolve(
  process.env.MINICPM5_MODEL_PATH || path.resolve(root, "..", "MiniCPM5-2B-MLX-8-bit"),
);
const requestedHome = String(process.env.MINICPM5_HANAKO_HOME || "").trim();
const testHome = requestedHome
  ? path.resolve(requestedHome)
  : fs.mkdtempSync(path.join(codeLife, ".hanako-minicpm5-real-"));
const maxCaseMs = Number(process.env.MINICPM5_REAL_CASE_TIMEOUT_MS || 900_000);
const runContexts = String(process.env.MINICPM5_REAL_CONTEXTS || "32768")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const runKinds = String(process.env.MINICPM5_REAL_CASES || "coding,long_text,agent,tool_use")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const keepHome = process.env.MINICPM5_KEEP_HOME !== "0";
const clientTimeoutMs = Number(process.env.MINICPM5_SERVER_START_TIMEOUT_MS || 120_000);
const pythonPath = process.env.MINICPM5_PYTHON || path.join(root, ".minicpm-venv", "bin", "python");

if (!fs.statSync(codeLife, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error(`CodeLife workspace does not exist: ${codeLife}`);
}
if (!fs.statSync(modelPath, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error(`MiniCPM5 checkpoint directory does not exist: ${modelPath}`);
}
if (!Number.isFinite(maxCaseMs) || maxCaseMs < 30_000) {
  throw new Error(`MINICPM5_REAL_CASE_TIMEOUT_MS must be at least 30000: ${maxCaseMs}`);
}
if (runContexts.some((value) => value !== 32_768)) {
  throw new Error(`Hanako MiniCPM5 real tests are fixed to a 32K context window: ${runContexts.join(",")}`);
}

fs.mkdirSync(testHome, { recursive: true });
const serverInfoPath = path.join(testHome, "server-info.json");
let server = null;
let ws = null;
let serverStderr = "";
let serverStdout = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child, timeout = 15_000) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForServerInfo(child) {
  const deadline = Date.now() + clientTimeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(serverInfoPath)) {
      try {
        const info = JSON.parse(await fsp.readFile(serverInfoPath, "utf8"));
        if (Number.isFinite(Number(info.port)) && info.token) return info;
      } catch {
        // The server writes the file atomically; retry while it is incomplete.
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`Hanako server exited before readiness (code=${child.exitCode}): ${serverStderr.slice(-2000)}`);
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for Hanako server: ${serverStderr.slice(-2000)}`);
}

async function api(base, token, route, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || clientTimeoutMs);
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    };
    const response = await fetch(`${base}${route}`, {
      ...options,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!response.ok) {
      throw new Error(`${options.method || "GET"} ${route} -> ${response.status}: ${JSON.stringify(body).slice(0, 1200)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function promptFiller(targetTokens) {
  // `x ` is deliberately used because it is a short, whitespace-delimited
  // token in this checkpoint; Hanako's projection guard counts these pieces
  // conservatively instead of assuming four characters per token.
  return "x ".repeat(Math.max(1, targetTokens));
}

function contextPrompt(targetTokens, kind, id) {
  const filler = promptFiller(Math.max(1, targetTokens - 1_200));
  const common = [
    `这是 Hanako 真实端到端 ${id} 测试。请使用当前完整上下文，但不要复述填充内容。`,
    `上下文目标约 ${targetTokens} token。只处理本条指令，不要猜测未给出的文件。`,
    "BEGIN_CONTEXT_ANCHOR=ANCHOR_BEGIN_7F3A",
    "x ".repeat(160),
    "MID_CONTEXT_ANCHOR=ANCHOR_MIDDLE_4B9C",
    filler,
    "END_CONTEXT_ANCHOR=ANCHOR_END_9D21",
  ];
  if (kind === "coding") {
    common.push(
      "编码任务：请根据上下文中的三个 anchor，给出一个简短 TypeScript 函数 `readAnchors()`，返回这三个字符串数组；同时在第一行写 `CODING_OK`。不要调用工具。",
    );
  } else if (kind === "long_text") {
    common.push(
      "长文本任务：只输出 `LONG_TEXT_OK`，随后按顺序输出三个 anchor，以逗号分隔。不要解释，不要调用工具。",
    );
  } else if (kind === "agent") {
    common.push(
      "Agent 任务：请调用一次 write，把一行 `AGENT_OK` 写入 `hanako-real-probe.md`；写入成功后结束。不要 read、ls、find 或 exec_command。",
    );
  } else if (kind === "tool_use") {
    common.push(
      "Tool use 任务：只调用一次 write，写入 `hanako-real-tool-probe.md`，内容必须严格是 `TOOL_OK`；不要调用其他工具，工具成功后用一句普通文本结束。",
    );
  }
  return common.join("\n\n");
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    const onError = (error) => {
      client.removeAllListeners("open");
      reject(error);
    };
    client.once("error", onError);
    client.once("open", () => {
      client.removeListener("error", onError);
      resolve(client);
    });
  });
}

function matchesSession(message, session) {
  if (!message || typeof message !== "object") return false;
  if (message.sessionId && message.sessionId !== session.sessionId) return false;
  if (message.sessionPath && message.sessionPath !== session.sessionPath) return false;
  return true;
}

async function runPrompt(session, text, { timeoutMs = maxCaseMs } = {}) {
  const events = [];
  const startedAt = Date.now();
  const clientMessageId = `minicpm-real-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stream = await new Promise((resolve, reject) => {
    let streamId = null;
    let settled = false;
    let sawStreamingStatus = false;
    let sawTurnEnd = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`prompt timed out after ${timeoutMs}ms`);
      error.code = "PROMPT_TIMEOUT";
      error.events = events;
      error.streamId = streamId;
      reject(error);
    }, timeoutMs);
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (!matchesSession(message, session)) return;
      events.push(message);
      if (message.type === "status" && message.isStreaming) {
        sawStreamingStatus = true;
        if (message.streamId) streamId = message.streamId;
      }
      if (message.type === "error") {
        // A server error is terminal for this prompt; keep the preceding event
        // stream so the report can distinguish model failure from no response.
        settled = true;
        clearTimeout(timer);
        session.ws.removeListener("message", onMessage);
        const error = new Error(message.message || "Hanako prompt error");
        error.code = message.code || "PROMPT_ERROR";
        error.events = events;
        error.streamId = streamId;
        reject(error);
        return;
      }
      if (message.type === "turn_end") {
        // Hanako emits a turn_end for an intermediate assistant tool-call
        // round before the SDK resumes the same user prompt with the
        // toolResult. Wait for the enclosing session_status=false so the
        // final assistant response and JSONL toolResult are both observable.
        sawTurnEnd = true;
        if (!sawStreamingStatus) {
          settled = true;
          clearTimeout(timer);
          session.ws.removeListener("message", onMessage);
          resolve({ events, elapsedMs: Date.now() - startedAt, streamId });
        }
        return;
      }
      if (message.type === "status" && message.isStreaming === false && sawStreamingStatus && sawTurnEnd) {
        settled = true;
        clearTimeout(timer);
        session.ws.removeListener("message", onMessage);
        resolve({ events, elapsedMs: Date.now() - startedAt, streamId });
      }
    };
    session.ws.on("message", onMessage);
    session.ws.send(JSON.stringify({
      type: "prompt",
      text,
      sessionId: session.sessionId,
      sessionPath: session.sessionPath,
      clientMessageId,
    }));
  });
  return stream;
}

function summarizeEvents(events) {
  const text = events.filter((entry) => entry.type === "text_delta").map((entry) => entry.delta || "").join("");
  const tools = events
    .filter((entry) => entry.type === "tool_start" || entry.type === "tool_end")
    .map((entry) => `${entry.type}:${entry.name || ""}:${entry.success === false ? "failed" : "ok"}`);
  return {
    eventCount: events.length,
    textPreview: text.slice(0, 500),
    textChars: text.length,
    tools,
    toolStartCount: events.filter((entry) => entry.type === "tool_start").length,
    toolEndCount: events.filter((entry) => entry.type === "tool_end").length,
    hasTurnEnd: events.some((entry) => entry.type === "turn_end"),
    hasError: events.some((entry) => entry.type === "error"),
  };
}

function persistedMessages(history) {
  const entries = Array.isArray(history?.messages) ? history.messages : [];
  return entries
    .map((entry) => entry?.message && typeof entry.message === "object" ? entry.message : entry)
    .filter((message) => message && typeof message === "object");
}

function persistedToolSummary(history, sessionPath = null) {
  let messages = persistedMessages(history);
  // The HTTP projection intentionally omits some internal toolResult fields.
  // Read the real JSONL branch as the acceptance source so the report reflects
  // what Hanako actually persisted, not only what /api/sessions/messages
  // chooses to expose to the UI.
  if (sessionPath) {
    try {
      const entries = fs.readFileSync(sessionPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const fileMessages = entries
        .map((entry) => entry?.message)
        .filter((message) => message && typeof message === "object");
      if (fileMessages.length > 0) messages = fileMessages;
    } catch {
      // Keep the API projection as a diagnostic fallback.
    }
  }
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const toolCalls = assistantMessages.flatMap((message) => [
    ...(Array.isArray(message.content) ? message.content : []),
    ...(Array.isArray(message.toolCalls) ? message.toolCalls : []),
  ]).filter((block) => block?.type === "toolCall" || block?.name || block?.function?.name);
  const toolResults = messages.filter((message) => message.role === "toolResult");
  const assistantText = assistantMessages.flatMap((message) => {
    if (typeof message.content === "string") return [message.content];
    return Array.isArray(message.content)
      ? message.content.filter((block) => block?.type === "text").map((block) => block.text || "")
      : [];
  }).join("\n");
  return {
    messages,
    assistantText,
    toolCallCount: toolCalls.length,
    toolResultCount: toolResults.length,
    hasToolCall: toolCalls.length > 0,
    hasToolResult: toolResults.length > 0,
  };
}

function expectedCaseMarker(kind) {
  return {
    coding: "CODING_OK",
    long_text: "LONG_TEXT_OK",
    agent: "AGENT_OK",
    tool_use: "TOOL_OK",
  }[kind] || "";
}

const EXPECTED_ANCHORS = [
  "ANCHOR_BEGIN_7F3A",
  "ANCHOR_MIDDLE_4B9C",
  "ANCHOR_END_9D21",
];

function probeForCase(kind) {
  if (kind === "agent") {
    return { path: path.join(codeLife, "hanako-real-probe.md"), content: "AGENT_OK" };
  }
  if (kind === "tool_use") {
    return { path: path.join(codeLife, "hanako-real-tool-probe.md"), content: "TOOL_OK" };
  }
  return null;
}

function validateCase(kind, targetTokens, streamSummary, history, sessionPath = null) {
  const persisted = persistedToolSummary(history, sessionPath);
  const marker = expectedCaseMarker(kind);
  const probe = probeForCase(kind);
  let probeContent = null;
  let probeMatches = true;
  if (probe) {
    try {
      probeContent = fs.readFileSync(probe.path, "utf8");
      probeMatches = probeContent.includes(probe.content);
    } catch {
      probeMatches = false;
    }
  }
  const requiresTool = kind === "agent" || kind === "tool_use";
  const reasons = [];
  if (!streamSummary.hasTurnEnd) reasons.push("missing turn_end");
  if (streamSummary.hasError) reasons.push("stream error");
  if (!persisted.assistantText.includes(marker)) reasons.push(`missing assistant marker ${marker}`);
  if (kind === "coding" || kind === "long_text") {
    for (const anchor of EXPECTED_ANCHORS) {
      if (!persisted.assistantText.includes(anchor)) reasons.push(`missing recalled anchor ${anchor}`);
    }
  }
  if (requiresTool && streamSummary.toolStartCount < 1) reasons.push("missing tool_start");
  if (requiresTool && streamSummary.toolEndCount < 1) reasons.push("missing tool_end");
  if (requiresTool && !persisted.hasToolCall) reasons.push("missing persisted assistant toolCall");
  if (requiresTool && !persisted.hasToolResult) reasons.push("missing persisted toolResult");
  if (requiresTool && !probeMatches) reasons.push(`missing probe file content: ${path.basename(probe.path)}`);
  return {
    ok: reasons.length === 0,
    reasons,
    persisted,
    probe: probe ? { path: probe.path, content: probeContent, matches: probeMatches } : null,
  };
}

async function readSessionMessages(base, token, session) {
  return api(base, token, `/api/sessions/messages?sessionId=${encodeURIComponent(session.sessionId)}&all=1`, {
    timeoutMs: 30_000,
  });
}

async function createSession(base, token, modelId, agentId) {
  const body = await api(base, token, "/api/sessions/new-detached", {
    method: "POST",
    body: {
      agentId,
      cwd: codeLife,
      workspaceFolders: [codeLife],
      memoryEnabled: false,
      permissionMode: "auto",
      thinkingLevel: "off",
      recordWorkspaceHistory: false,
    },
  });
  if (body.cwd !== codeLife) throw new Error(`Hanako session cwd mismatch: ${body.cwd}`);
  if (!body.sessionId || !body.path) throw new Error(`Hanako session response missing identity: ${JSON.stringify(body)}`);
  return {
    sessionId: body.sessionId,
    sessionPath: body.path,
    cwd: body.cwd,
    modelId,
    agentId: body.agentId || agentId,
    ws: await openWebSocket(`ws://127.0.0.1:${new URL(base).port}/ws?token=${encodeURIComponent(token)}`),
  };
}

async function stopSession(session) {
  try { session?.ws?.close(); } catch {}
}

function writeProbeCleanup() {
  for (const name of ["hanako-real-probe.md", "hanako-real-tool-probe.md"]) {
    const target = path.join(codeLife, name);
    try { fs.rmSync(target, { force: true }); } catch {}
  }
}

async function main() {
  server = spawn(process.execPath, ["server/bootstrap.ts"], {
    cwd: root,
    env: {
      ...process.env,
      HANA_HOME: testHome,
      HANA_PORT: "0",
      HANA_ROOT: root,
      HANA_SERVER_ENTRY: path.join(root, "server", "main-full.ts"),
      HANA_CREATE_STARTUP_SESSION: "0",
      HANA_TURN_STALL_ABORT_MS: String(Math.max(maxCaseMs, 900_000)),
      MINICPM5_MODEL_PATH: modelPath,
      MINICPM5_PYTHON: pythonPath,
      MINICPM5_REQUIRE_8BIT: "1",
      MINICPM5_MEMORY_PROFILE: process.env.MINICPM5_MEMORY_PROFILE || "edge",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk) => { serverStdout += String(chunk); });
  server.stderr?.on("data", (chunk) => { serverStderr += String(chunk); });

  const info = await waitForServerInfo(server);
  const base = `http://127.0.0.1:${info.port}`;
  const modelList = await api(base, info.token, "/api/models");
  const localModel = modelList.models?.find((entry) => entry.provider === "minicpm5-local");
  if (!localModel) throw new Error(`MiniCPM5 model is not registered in Hanako: ${JSON.stringify(modelList.models)}`);
  if (Number(localModel.contextWindow) !== 32_768) {
    throw new Error(`Hanako MiniCPM5 context must be exactly 32K: ${localModel.contextWindow}`);
  }
  await api(base, info.token, "/api/models/set", {
    method: "POST",
    body: { modelId: localModel.id, provider: localModel.provider },
  });

  const agents = await api(base, info.token, "/api/agents");
  const agent = (Array.isArray(agents) ? agents : agents.agents || []).find((entry) => entry.isCurrent || entry.isPrimary)
    || (Array.isArray(agents) ? agents : agents.agents || [])[0];
  if (!agent?.id) throw new Error(`Hanako has no agent: ${JSON.stringify(agents)}`);

  const results = [];
  for (const targetTokens of runContexts) {
    for (const kind of runKinds) {
      const id = `${kind}-${targetTokens}`;
      // /api/models/set is deliberately a one-shot selection: createSession
      // consumes the pending model and leaves the global default untouched.
      // Each isolated case therefore has to select MiniCPM5 immediately
      // before creating its session, otherwise the second case gets the
      // server's `no_available_model` response even though /api/models lists
      // the checkpoint.
      await api(base, info.token, "/api/models/set", {
        method: "POST",
        body: { modelId: localModel.id, provider: localModel.provider },
      });
      const session = await createSession(base, info.token, localModel.id, agent.id);
      let outcome;
      try {
        const prompt = contextPrompt(targetTokens, kind, id);
        const before = Date.now();
        try {
          const stream = await runPrompt(session, prompt);
          const history = await readSessionMessages(base, info.token, session);
          const summary = summarizeEvents(stream.events);
          const historyText = JSON.stringify(history);
          const validation = validateCase(kind, targetTokens, summary, history, session.sessionPath);
          outcome = {
            id,
            kind,
            targetTokens,
            ok: validation.ok,
            elapsedMs: Date.now() - before,
            sessionId: session.sessionId,
            sessionPath: session.sessionPath,
            sessionFile: session.sessionPath,
            stream: summary,
            persistedMessageCount: validation.persisted.messages.length,
            persistedHasPrompt: historyText.includes("BEGIN_CONTEXT_ANCHOR"),
            persistedHasAssistant: validation.persisted.assistantText.includes(expectedCaseMarker(kind)),
            persistedToolCallCount: validation.persisted.toolCallCount,
            persistedToolResultCount: validation.persisted.toolResultCount,
            probe: validation.probe,
            ...(validation.reasons.length > 0 ? { validationErrors: validation.reasons } : {}),
          };
        } catch (error) {
          const events = Array.isArray(error.events) ? error.events : [];
          outcome = {
            id,
            kind,
            targetTokens,
            ok: false,
            elapsedMs: Date.now() - before,
            sessionId: session.sessionId,
            sessionPath: session.sessionPath,
            sessionFile: session.sessionPath,
            error: error.message,
            code: error.code || null,
            stream: summarizeEvents(events),
            streamId: error.streamId || null,
          };
          // Long prefill can exceed the case budget. Abort through Hanako's
          // real WS path before moving to the next isolated session.
          if (error.code === "PROMPT_TIMEOUT" && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify({
              type: "abort",
              sessionId: session.sessionId,
              sessionPath: session.sessionPath,
              ...(error.streamId ? { streamId: error.streamId } : {}),
              reason: "benchmark_case_timeout",
            }));
            await sleep(1_000);
          }
        }
      } finally {
        await stopSession(session);
      }
      results.push(outcome);
      console.error(`[minicpm5-hanako-real] ${id}: ${outcome.ok ? `ok ${outcome.elapsedMs}ms` : `FAILED ${outcome.code || outcome.error}`}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    hanako: {
      base,
      testHome,
      workspace: codeLife,
      model: localModel,
      agentId: agent.id,
      serverPid: server.pid,
    },
    config: {
      modelPath,
      pythonPath,
      contexts: runContexts,
      cases: runKinds,
      maxCaseMs,
      memoryProfile: process.env.MINICPM5_MEMORY_PROFILE || "edge",
    },
    results,
    diagnostics: {
      serverStdout: serverStdout.slice(-4000),
      serverStderr: serverStderr.slice(-6000),
    },
  };
  const reportPath = path.join(codeLife, `minicpm5-hanako-real-${Date.now()}.json`);
  await fsp.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    passed: results.length > 0 && results.every((entry) => entry.ok),
    reportPath,
    testHome,
    workspace: codeLife,
    model: localModel,
    results,
  }, null, 2));
  return results.every((entry) => entry.ok) ? 0 : 2;
}

try {
  const exitCode = await main();
  process.exitCode = exitCode;
} finally {
  writeProbeCleanup();
  if (ws) {
    try { ws.close(); } catch {}
  }
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await waitForExit(server, 20_000);
  }
  // Keep the test home by default: it contains real Hanako session records.
  // Set MINICPM5_KEEP_HOME=0 only for disposable CI-style runs.
  if (!keepHome && testHome.startsWith(os.tmpdir())) {
    await fsp.rm(testHome, { recursive: true, force: true }).catch(() => {});
  }
}
