import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { hostHint } from '../../src/mcp/editor.js';

const require = createRequire(import.meta.url);
const { announceWindow, HOST_ID_VAR } = require('../../vscode/window.js');

/** Records what the extension asks of VS Code's terminal environment collection. */
function fakeCollection() {
  const vars = new Map<string, string>();
  return {
    persistent: true,
    description: undefined as string | undefined,
    vars,
    replace: (name: string, value: string) => vars.set(name, value),
    delete: (name: string) => vars.delete(name),
  };
}

describe('announceWindow', () => {
  it('names the window in the variable whiteboard-mcp reads as its window hint, ahead of WINDSURF_EXT_HOST_PID', () => {
    expect(hostHint({ [HOST_ID_VAR]: '4242', WINDSURF_EXT_HOST_PID: '1111' })).toBe('4242');
  });

  it("gives this window's id to its terminals, without persisting it into restored terminals", () => {
    const collection = fakeCollection();
    announceWindow(collection, '4242', {});
    expect(collection.vars.get('WHITEBOARD_HOST_ID')).toBe('4242');
    expect(collection.persistent).toBe(false);
    expect(collection.description).toMatch(/this window/);
  });

  it('overrides an id inherited from another window for processes the extension host starts, and removes it on dispose', () => {
    const env: Record<string, string | undefined> = { WHITEBOARD_HOST_ID: '1111', OTHER: 'x' };
    const collection = fakeCollection();
    const announcement = announceWindow(collection, '4242', env);
    expect(env.WHITEBOARD_HOST_ID).toBe('4242');
    announcement.dispose();
    expect(env).toEqual({ OTHER: 'x' });
    expect(collection.vars.size).toBe(0);
  });

  it('leaves an id someone else set after it alone on dispose', () => {
    const env: Record<string, string | undefined> = {};
    const announcement = announceWindow(fakeCollection(), '4242', env);
    env.WHITEBOARD_HOST_ID = '9999';
    announcement.dispose();
    expect(env.WHITEBOARD_HOST_ID).toBe('9999');
  });
});
