import { describe, expect, it } from 'vitest';
import { openerArgv, splitCommand } from '../../src/mcp/open.js';

const URL = 'http://127.0.0.1:1/c/b?token=t&x=1';

describe('openerArgv', () => {
  it('treats unset, browser and auto as the platform browser', () => {
    for (const setting of ['', 'browser', 'auto', ' auto ']) expect(openerArgv(URL, setting, 'darwin')).toEqual(['open', URL]);
    expect(openerArgv(URL, 'auto', 'linux')).toEqual(['xdg-open', URL]);
  });

  it('opens nothing for none and substitutes {url} as one argument in templates', () => {
    expect(openerArgv(URL, 'none', 'darwin')).toBeNull();
    expect(openerArgv(URL, `"/Apps/My Browser" --new-window {url}`, 'darwin')).toEqual(['/Apps/My Browser', '--new-window', URL]);
    expect(openerArgv(URL, 'firefox', 'linux')).toEqual(['firefox', URL]);
  });

  it('splits commands with quotes and escapes without a shell', () => {
    expect(splitCommand(`a 'b c' "d \\"e\\"" f\\ g`)).toEqual(['a', 'b c', 'd "e"', 'f g']);
  });
});
