const PROBE_TIMEOUT_MS = 3000;

/**
 * A page whose own address no longer answers (the preview proxy in front of it is gone) moves to the daemon's,
 * so reloading it keeps working. A proxy that still answers keeps the page: a failed attempt alone also happens
 * while the daemon is being swapped for a newer version.
 */
export async function leaveDeadProxy(directPage: string | undefined, loc: Pick<Location, 'href' | 'replace'> = window.location, probe: typeof fetch = fetch): Promise<boolean> {
  if (!directPage) return false;
  try {
    await probe(loc.href, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return false;
  } catch {
    loc.replace(directPage);
    return true;
  }
}
