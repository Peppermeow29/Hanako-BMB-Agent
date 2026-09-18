import { describe, expect, it } from 'vitest';
import {
  isSameWorkspacePath,
  resolveAgentWorkspace,
} from '../../utils/agent-workspace';

describe('agent workspace resolution', () => {
  it('prefers the server-resolved effective workspace over the explicit field', () => {
    expect(resolveAgentWorkspace({
      id: 'hana',
      name: 'Hana',
      yuan: 'hanako',
      isPrimary: true,
      homeFolder: null,
      effectiveHomeFolder: '/home/test/Desktop/OH-WorkSpace',
    })).toBe('/home/test/Desktop/OH-WorkSpace');
  });

  it('treats Windows drive paths with slash and case differences as the same workspace', () => {
    expect(isSameWorkspacePath('C:\\Users\\Owner\\Work\\', 'c:/users/owner/work')).toBe(true);
  });

  it('treats Windows UNC paths case-insensitively', () => {
    expect(isSameWorkspacePath('\\\\Server\\Share\\Project', '//server/share/project/')).toBe(true);
  });
});
