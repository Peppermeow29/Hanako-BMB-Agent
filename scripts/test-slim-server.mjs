#!/usr/bin/env node
// Boot the built mac-arm64 server with disposable state. Never reads user credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = path.join(root, 'dist-server/mac-arm64');
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hanako-slim-smoke-'));
const child = spawn(path.join(dir, 'node'), [path.join(dir, 'bootstrap.js')], {
  cwd: '/tmp/hanako-workspace',
  env: { ...process.env, HANA_ROOT: dir, HANA_SERVER_ENTRY: path.join(dir, 'bundle/index.js'), HANA_HOME: testHome, HANA_PORT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
// Startup logs can include authentication information; keep them out of test output.
child.stdout.resume();
child.stderr.resume();
let spawnError;
child.on('error', error => { spawnError = error; });
let ws;
try {
  let info;
  for (let attempt = 0; attempt < 240; attempt++) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, 'built server exited during startup');
    try { info = JSON.parse(fs.readFileSync(path.join(testHome, 'server-info.json'), 'utf8')); } catch {}
    if (info?.port && info?.token) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(info?.port && info?.token, 'server startup timed out');
  const base = `http://127.0.0.1:${info.port}`;
  const headers = { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' };
  const request = (endpoint, options = {}) => fetch(base + endpoint, { headers, signal: AbortSignal.timeout(10000), ...options });
  assert.equal((await request('/api/health')).status, 200);
  assert.ok([401, 403].includes((await request('/api/health', { headers: {} })).status));
  const computer = await (await request('/api/preferences/computer-use')).json();
  assert.equal(computer.settings.enabled, false);
  assert.equal(computer.status.supported, false);
  for (const [method, suffix] of [['PUT', ''], ['POST', '/request-permissions'], ['POST', '/approvals'], ['DELETE', '/approvals']]) {
    assert.equal((await request('/api/preferences/computer-use' + suffix, { method, body: JSON.stringify({ enabled: true }) })).status, 410);
  }
  const { agents } = await (await request('/api/agents')).json();
  const agentQuery = '?agentId=' + encodeURIComponent(agents[0].id);
  const status = await (await request('/api/bridge/status' + agentQuery)).json();
  for (const platform of ['telegram', 'qq', 'dingtalk']) {
    assert.equal(status[platform].enabled, false);
    assert.equal(status[platform].supported, false);
    for (const endpoint of ['config', 'owner', 'stop', 'test', 'send-media']) {
      const res = await request('/api/bridge/' + endpoint + agentQuery, {
        method: 'POST', body: JSON.stringify({ platform, enabled: true, useSavedCredentials: true, chatId: 'test', filePath: '/not-read' }),
      });
      assert.equal(res.status, 410);
      assert.equal((await res.json()).code, 'FEATURE_UNAVAILABLE');
    }
  }
  for (const platform of ['wechat', 'feishu']) assert.equal(status[platform].supported, true);
  const { ticket } = await (await request('/api/ws-ticket', { method: 'POST' })).json();
  ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws?wsTicket=${encodeURIComponent(ticket)}`);
  await once(ws, 'open', { signal: AbortSignal.timeout(10000) });
  const pong = once(ws, 'pong', { signal: AbortSignal.timeout(10000) });
  ws.ping();
  await pong;
  ws.close();
  await once(ws, 'close', { signal: AbortSignal.timeout(5000) });
  assert.ok(!fs.existsSync(path.join(dir, 'node_modules/node-telegram-bot-api')));
  console.log(JSON.stringify({ passed: true, healthAndAuth: true, removedComputerRequests: 4, removedBridgeRequests: 15, retainedBridgeStatus: true, webSocket: true, telegramDependencyAbsent: true }));
} finally {
  ws?.terminate();
  if (!spawnError && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    try { await once(child, 'exit', { signal: AbortSignal.timeout(10000) }); }
    catch {
      child.kill('SIGKILL');
      await once(child, 'exit', { signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
  }
  // Only this process's mkdtemp directory, never a user's HANA_HOME.
  fs.rmSync(testHome, { recursive: true, force: true });
}
