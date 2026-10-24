import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Integration tests run against compiled dist/. Type errors are reported by `npm run typecheck`; tsc still emits.
 * The panel extension is packed too: the server offers dist/vscode's .vsix, and CI tests before `npm run build`.
 */
export default function setup(): void {
  spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
  spawnSync(process.execPath, ['scripts/build-vsix.mjs', 'dist/vscode'], { cwd: root, stdio: 'inherit' });
}
