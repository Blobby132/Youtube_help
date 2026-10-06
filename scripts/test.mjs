// `npm test`: runs the backend test suite with the project's Python environment.
// Extra arguments go to pytest, e.g. `npm test -- -k projects`.
import { spawnSync } from 'node:child_process';
import { backendDir, requireVenv } from './lib.mjs';

const python = requireVenv();
const result = spawnSync(python, ['-m', 'pytest', ...process.argv.slice(2)], {
  cwd: backendDir,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
