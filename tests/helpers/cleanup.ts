import { rmSync } from 'node:fs';

/**
 * Removes a test's temp folder. Windows keeps files of just-killed processes locked for a while
 * (EBUSY); after retrying, a leftover temp folder there is harmless and not what the tests check.
 */
export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (err) {
    if (process.platform !== 'win32' || (err as NodeJS.ErrnoException).code !== 'EBUSY') throw err;
  }
}
