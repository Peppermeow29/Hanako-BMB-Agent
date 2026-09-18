import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAgentAvatarPath } from '../../../shared/agent-avatar-path.cjs';

let home: string;

function writeAvatar(agentId: string, file: string): string {
  const dir = path.join(home, 'agents', agentId, 'avatars');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, file);
  fs.writeFileSync(p, 'x');
  return p;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-avatar-path-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('resolveAgentAvatarPath', () => {
  it('resolves agents/<id>/avatars/agent.png', () => {
    const expected = writeAvatar('a1', 'agent.png');
    expect(resolveAgentAvatarPath(home, 'a1')).toBe(expected);
  });

  it('falls back across png → jpg → jpeg → webp by precedence', () => {
    const expected = writeAvatar('a1', 'agent.jpg');
    expect(resolveAgentAvatarPath(home, 'a1')).toBe(expected);
  });

  it('prefers png when multiple formats coexist', () => {
    const png = writeAvatar('a1', 'agent.png');
    writeAvatar('a1', 'agent.webp');
    expect(resolveAgentAvatarPath(home, 'a1')).toBe(png);
  });

  it('returns null when the agent has no custom avatar (no global fallback)', () => {
    fs.mkdirSync(path.join(home, 'agents', 'a1', 'avatars'), { recursive: true });
    expect(resolveAgentAvatarPath(home, 'a1')).toBeNull();
  });

  it('returns null when agentId is missing — never guesses an agent', () => {
    writeAvatar('a1', 'agent.png');
    expect(resolveAgentAvatarPath(home, null)).toBeNull();
    expect(resolveAgentAvatarPath(home, undefined)).toBeNull();
    expect(resolveAgentAvatarPath(home, '')).toBeNull();
  });

  it('returns null for a path-traversal agentId instead of escaping the agents dir', () => {
    writeAvatar('a1', 'agent.png');
    expect(resolveAgentAvatarPath(home, '../a1')).toBeNull();
    expect(resolveAgentAvatarPath(home, 'a/b')).toBeNull();
    expect(resolveAgentAvatarPath(home, '..')).toBeNull();
  });

  it('returns null when hanakoHome is missing', () => {
    expect(resolveAgentAvatarPath(null, 'a1')).toBeNull();
    expect(resolveAgentAvatarPath('', 'a1')).toBeNull();
  });
});
