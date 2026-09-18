#!/usr/bin/env node
// Live Agent-loop acceptance test. Requires npm run minicpm:server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { runAgentLoop, Type } from '../lib/pi-sdk/index.ts';
import { adaptMiniCPM5XmlToolCallStream } from '../lib/pi-sdk/minicpm5-stream-adapter.ts';
import { buildMiniCPM5SystemPrompt } from '../core/agent.ts';

const workspace = '/tmp/hanako-workspace';
const marker = `CL-${randomBytes(4).toString('hex')}`;
const baseUrl = String(process.env.MINICPM5_BASE_URL || 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
const model = {
  id: 'default_model', name: 'MiniCPM5-2B', provider: 'minicpm5-local',
  api: 'openai-completions', baseUrl,
  input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
let executions = 0;
let requests = 0;
let xmlResponses = 0;
const tool = {
  name: 'inspect_workspace', label: 'Inspect workspace',
  description: 'Read the current workspace directory metadata and its verification code.',
  parameters: Type.Object({}),
  async execute() {
    executions++;
    assert.ok(executions <= 2, 'unexpected repeated execution');
    assert.ok(fs.statSync(workspace).isDirectory());
    return { content: [{ type: 'text', text: JSON.stringify({ workspace, verification_code: marker }) }], details: {} };
  },
};
const streamFn = (m, context, options) => {
  assert.ok(++requests <= 5, 'request limit exceeded');
  const inner = streamSimple(m, context, { ...options, apiKey: 'local', temperature: 0, maxTokens: 256 });
  const observed = {
    async *[Symbol.asyncIterator]() {
      for await (const event of inner) {
        if (event.type === 'done' && event.message.content.some(b => b.type === 'text' && b.text.includes('<function'))) xmlResponses++;
        yield event;
      }
    },
    result: () => inner.result(),
  };
  return adaptMiniCPM5XmlToolCallStream(observed, m, context);
};
const events = [];
const signal = AbortSignal.timeout(120_000);
const config = { model, convertToLlm: messages => messages, toolExecution: 'sequential', shouldStopAfterTurn: ({ newMessages }) => newMessages.length >= 8 };
const context = {
  systemPrompt: 'You are a concise assistant. Use inspect_workspace exactly once when asked to inspect the workspace. After the tool returns, report its workspace and verification_code exactly. For follow-up questions use conversation history without calling tools.',
  tools: [tool], messages: [],
};
const first = await runAgentLoop([{ role: 'user', content: '请调用 inspect_workspace 查询工作区和校验码，然后原样告诉我结果。', timestamp: Date.now() }], context, config, e => events.push(e.type), signal, streamFn);
const finalText = messages => messages.at(-1)?.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
assert.equal(executions, 1);
assert.ok(xmlResponses >= 1, 'model did not emit native XML');
assert.equal(first.at(-1).stopReason, 'stop');
assert.ok(finalText(first).includes(workspace));
assert.ok(finalText(first).includes(marker), 'answer must use unpredictable tool result');
assert.equal(first.filter(m => m.role === 'toolResult' && !m.isError).length, 1);
assert.ok(events.includes('agent_end'));
const second = await runAgentLoop([{ role: 'user', content: '不要调用工具。刚才的校验码是什么？只回答校验码。', timestamp: Date.now() }], { ...context, messages: first }, config, () => {}, signal, streamFn);
assert.equal(executions, 1, 'follow-up unexpectedly executed a tool');
assert.ok(finalText(second).includes(marker), 'follow-up lost tool result context');
assert.equal(second.at(-1).stopReason, 'stop');

function createLiveStreamFn({ maxRequests = 6, temperature = 0, maxTokens = 1_024 } = {}) {
  let calls = 0;
  let xml = 0;
  return {
    streamFn: (m, context, options) => {
      assert.ok(++calls <= maxRequests, `request limit exceeded (${maxRequests})`);
      const inner = streamSimple(m, context, { ...options, apiKey: 'local', temperature, maxTokens });
      const observed = {
        async *[Symbol.asyncIterator]() {
          for await (const event of inner) {
            if (event.type === 'done' && event.message.content.some(b => b.type === 'text' && b.text.includes('<function'))) xml++;
            yield event;
          }
        },
        result: () => inner.result(),
      };
      return adaptMiniCPM5XmlToolCallStream(observed, m, context);
    },
    metrics: () => ({ requests: calls, xmlResponses: xml }),
  };
}

async function runLiveCase(name, prompt, tools, configPatch = {}, timeoutMs = 120_000) {
  const live = createLiveStreamFn();
  const messages = await runAgentLoop(
    [{ role: 'user', content: prompt, timestamp: Date.now() }],
    { systemPrompt: buildMiniCPM5SystemPrompt({ locale: 'zh-CN' }), tools, messages: [] },
    { model, convertToLlm: messages => messages, toolExecution: 'sequential', ...configPatch },
    () => {},
    AbortSignal.timeout(timeoutMs),
    live.streamFn,
  );
  return { name, messages, ...live.metrics() };
}

// Keep the two regressions that motivated the edge profile in the live suite:
// an algorithm question must not consume a filesystem tool, while an explicit
// "show then write" request must expose the prose and execute one write only.
let algorithmToolExecutions = 0;
const algorithmProbe = {
  name: 'write',
  label: 'Write probe',
  description: 'Writes a file when the user explicitly requests it.',
  parameters: Type.Object({ path: Type.String(), content: Type.String() }),
  async execute() {
    algorithmToolExecutions++;
    return { content: [{ type: 'text', text: 'unexpected tool execution' }], details: {} };
  },
};
const algorithmCase = await runLiveCase(
  'algorithm_without_tools',
  '请解答算法题：给定整数数组和目标值，找出和为目标值的两个下标，并分析时间复杂度。不要调用任何工具。',
  [algorithmProbe],
);
assert.equal(algorithmToolExecutions, 0, 'algorithm answer must not execute a tool');
assert.equal(algorithmCase.messages.at(-1)?.stopReason, 'stop');
assert.equal(algorithmCase.messages.filter(message => message.role === 'toolResult').length, 0);
assert.match(finalText(algorithmCase.messages), /O\s*\(n\)/i);

let writeExecutions = 0;
let writtenContent = '';
const writeProbe = {
  name: 'write',
  label: 'Write probe',
  description: 'Writes exactly the requested text to a named CodeLife file.',
  parameters: Type.Object({ path: Type.String(), content: Type.String() }),
  async execute(_id, args) {
    writeExecutions++;
    writtenContent = String(args.content || '');
    return { content: [{ type: 'text', text: `write_ok=${args.path}` }], details: {} };
  },
};
const writeCase = await runLiveCase(
  'display_then_single_write',
  '请先写出一段约80字的中文短文，完整展示给我；正文完成后，再调用一次 write，将完全相同的正文写入 CodeLife/minicpm-live-regression.md。不要先读取或检查文件。',
  [writeProbe],
);
assert.equal(writeExecutions, 1, 'display-then-write must execute exactly one write');
assert.ok(writtenContent.trim().length >= 2, 'write content must not be empty');
assert.equal(writeCase.messages.at(-1)?.stopReason, 'stop');
// XML parameter values may carry a formatter-added trailing newline. The
// user-facing contract is the正文 itself, so compare after removing only
// surrounding whitespace while retaining all internal characters.
assert.ok(finalText(writeCase.messages).includes(writtenContent.trim()), 'final answer must display the written content');

const chainedCalls = [];
const inspectForChain = {
  name: 'read_chain_code',
  label: 'Read chain code',
  description: 'Read the temporary verification code from the CodeLife workspace.',
  parameters: Type.Object({}),
  async execute() {
    chainedCalls.push('read_chain_code');
    return { content: [{ type: 'text', text: `chain_code=${marker}` }], details: {} };
  },
};
const verifyChain = {
  name: 'verify_chain_code',
  label: 'Verify chain code',
  description: 'Verify a code returned by read_chain_code. The code parameter must be copied exactly.',
  parameters: Type.Object({ code: Type.String() }),
  async execute(_id, args) {
    chainedCalls.push(`verify_chain_code:${args.code}`);
    return { content: [{ type: 'text', text: args.code === marker ? 'chain_verified=true' : 'chain_verified=false' }], details: {} };
  },
};
const chained = await runLiveCase(
  'ordered_two_tool_loop',
  '必须先调用 read_chain_code。收到它的结果后，必须调用 verify_chain_code，并把返回的 chain_code 原样放入 code 参数。最后只报告验证结果。',
  [inspectForChain, verifyChain],
);
assert.ok(chainedCalls.includes('read_chain_code'), 'first chained tool was not executed');
assert.ok(chainedCalls.includes(`verify_chain_code:${marker}`), 'second chained tool did not receive the first tool result');
assert.ok(chained.messages.some(message => message.role === 'toolResult' && !message.isError), 'chained loop did not persist tool results');

let failureExecutions = 0;
const unstableTool = {
  name: 'unstable_lookup',
  label: 'Unstable lookup',
  description: 'Performs one lookup that currently fails.',
  parameters: Type.Object({}),
  async execute() {
    failureExecutions++;
    throw new Error('controlled transient failure');
  },
};
const failureRecovery = await runLiveCase(
  'tool_failure_recovery',
  '调用 unstable_lookup 一次。即使工具失败，也不要重试；根据工具结果简短说明失败。',
  [unstableTool],
);
assert.equal(failureExecutions, 1, 'failure tool should execute exactly once');
assert.ok(failureRecovery.messages.some(message => message.role === 'toolResult' && message.isError), 'tool failure was not returned to the agent loop');
assert.equal(failureRecovery.messages.at(-1)?.stopReason, 'stop', 'agent did not recover to a final response after tool failure');

let deniedExecutions = 0;
const deniedTool = {
  name: 'approval_probe',
  label: 'Approval probe',
  description: 'A tool that requires user approval.',
  parameters: Type.Object({}),
  async execute() {
    deniedExecutions++;
    return { content: [{ type: 'text', text: 'must_not_run' }], details: {} };
  },
};
const denied = await runLiveCase(
  'approval_denial_recovery',
  '调用 approval_probe 一次，然后根据结果回复。',
  [deniedTool],
  { beforeToolCall: async () => ({ block: true, reason: 'user denied' }) },
);
assert.equal(deniedExecutions, 0, 'denied tool must not execute');
assert.ok(denied.messages.some(message => message.role === 'toolResult' && message.isError), 'approval denial was not returned as a tool error');
assert.equal(denied.messages.at(-1)?.stopReason, 'stop', 'agent did not recover after approval denial');

let cappedExecutions = 0;
const cappedTool = {
  name: 'single_turn_probe',
  label: 'Single turn probe',
  description: 'Returns a small value.',
  parameters: Type.Object({}),
  async execute() {
    cappedExecutions++;
    return { content: [{ type: 'text', text: 'one_turn_value' }], details: {} };
  },
};
const capped = await runLiveCase(
  'turn_cap',
  '调用 single_turn_probe。',
  [cappedTool],
  { shouldStopAfterTurn: ({ newMessages }) => newMessages.filter(message => message.role === 'toolResult').length >= 1 },
);
assert.equal(cappedExecutions, 1, 'turn cap should allow exactly one tool execution');
assert.equal(capped.requests, 1, 'turn cap should prevent another model request');

const cancellationController = new AbortController();
const cancelLive = createLiveStreamFn({ maxRequests: 2 });
setTimeout(() => cancellationController.abort(), 25);
let cancellationOutcome = null;
try {
  const cancelled = await runAgentLoop(
    [{ role: 'user', content: '请写一篇很长的文章，不要结束。', timestamp: Date.now() }],
    { systemPrompt: 'Answer normally.', tools: [], messages: [] },
    { model, convertToLlm: messages => messages, toolExecution: 'sequential' },
    () => {},
    cancellationController.signal,
    cancelLive.streamFn,
  );
  cancellationOutcome = { resolved: true, stopReason: cancelled.at(-1)?.stopReason || null };
} catch (error) {
  cancellationOutcome = { resolved: false, error: error instanceof Error ? error.name : String(error) };
}
const freshAfterCancel = await runLiveCase('post_cancel_fresh_request', '只回答：恢复正常。', [], {}, 120_000);
assert.equal(freshAfterCancel.messages.at(-1)?.stopReason, 'stop', 'fresh request failed after cancellation');

console.log(JSON.stringify({
  passed: true,
  workspace,
  baseline: { executions, requests, xmlResponses, toolResultUsed: true, followUpContextRetained: true, roles: first.map(m => m.role) },
  cases: [
    { name: algorithmCase.name, requests: algorithmCase.requests, xmlResponses: algorithmCase.xmlResponses, toolExecutions: algorithmToolExecutions, finalStopReason: algorithmCase.messages.at(-1)?.stopReason },
    { name: writeCase.name, requests: writeCase.requests, xmlResponses: writeCase.xmlResponses, writeExecutions, writtenChars: writtenContent.length, finalStopReason: writeCase.messages.at(-1)?.stopReason },
    { name: chained.name, requests: chained.requests, xmlResponses: chained.xmlResponses, toolCalls: chainedCalls, finalStopReason: chained.messages.at(-1)?.stopReason },
    { name: failureRecovery.name, requests: failureRecovery.requests, xmlResponses: failureRecovery.xmlResponses, failureExecutions, finalStopReason: failureRecovery.messages.at(-1)?.stopReason },
    { name: denied.name, requests: denied.requests, xmlResponses: denied.xmlResponses, deniedExecutions, finalStopReason: denied.messages.at(-1)?.stopReason },
    { name: capped.name, requests: capped.requests, xmlResponses: capped.xmlResponses, cappedExecutions, finalStopReason: capped.messages.at(-1)?.stopReason },
    { name: 'cancellation', ...cancellationOutcome, requests: cancelLive.metrics().requests },
    { name: freshAfterCancel.name, requests: freshAfterCancel.requests, finalStopReason: freshAfterCancel.messages.at(-1)?.stopReason },
  ],
}, null, 2));
