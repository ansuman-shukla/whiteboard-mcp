import { describe, expect, it, vi } from 'vitest';
import { leaveDeadProxy } from '../../frontend/src/proxy';

const DIRECT = 'http://127.0.0.1:47428/c/b1/tok/';
const tab = () => ({ href: 'http://127.0.0.1:59068/', replace: vi.fn() });

describe('leaving a dead preview proxy', () => {
  it('moves the tab to the daemon\'s own address when its own address no longer answers', async () => {
    const loc = tab();
    const probe = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await leaveDeadProxy(DIRECT, loc, probe)).toBe(true);
    expect(probe).toHaveBeenCalledWith('http://127.0.0.1:59068/', expect.objectContaining({ method: 'HEAD', cache: 'no-store' }));
    expect(loc.replace).toHaveBeenCalledWith(DIRECT);
  });

  it('stays behind a proxy that still answers, whatever the status (the daemon may just be restarting)', async () => {
    for (const status of [200, 404, 502]) {
      const loc = tab();
      expect(await leaveDeadProxy(DIRECT, loc, vi.fn().mockResolvedValue(new Response(null, { status })))).toBe(false);
      expect(loc.replace).not.toHaveBeenCalled();
    }
  });

  it('does nothing for a page the daemon serves itself', async () => {
    const loc = tab();
    const probe = vi.fn();
    expect(await leaveDeadProxy(undefined, loc, probe)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(loc.replace).not.toHaveBeenCalled();
  });
});
