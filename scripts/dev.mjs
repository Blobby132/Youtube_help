// `npm run dev`: starts the FastAPI backend and the Vite frontend together.
// Ctrl+C stops both; if either one exits, the other is stopped too.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  BACKEND_PORT,
  FRONTEND_PORT,
  backendDir,
  color,
  frontendDir,
  requireVenv,
} from './lib.mjs';

const python = requireVenv();
const viteBin = path.join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) {
  console.error(color.red('Frontend packages are missing. Run `npm run setup` first.'));
  process.exit(1);
}

const env = { ...process.env, BACKEND_PORT, FRONTEND_PORT, FORCE_COLOR: '1', PYTHONUNBUFFERED: '1' };
const children = [];
let stopping = false;

function run(name, paintTag, command, args, cwd) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = paintTag(`[${name}]`.padEnd(6));
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', (line) => console.log(`${tag} ${line}`));
  }
  child.on('error', (error) => {
    console.error(`${tag} ${color.red(`failed to start: ${error.message}`)}`);
    stopAll(1);
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.log(`${tag} ${color.red(`exited (${signal ?? code})`)} - stopping the other server.`);
    stopAll(code ?? 1);
  });
  children.push(child);
}

function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  setTimeout(() => process.exit(exitCode), 300);
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

console.log(color.bold('Shorts Creator'));
console.log(`  app ${color.cyan(`http://localhost:${FRONTEND_PORT}`)}   api ${color.dim(`http://127.0.0.1:${BACKEND_PORT}`)}`);
console.log(color.dim('  Press Ctrl+C to stop.\n'));

// Start the frontend once the backend answers, so the browser opens on a working app.
async function waitForBackend(timeoutMs = 60_000) {
  const url = `http://127.0.0.1:${BACKEND_PORT}/api/health`;
  const deadline = Date.now() + timeoutMs;
  while (!stopping && Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!stopping) console.log(color.yellow('Backend is slow to start; opening the app anyway.'));
}

run(
  'api',
  color.magenta,
  python,
  ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', BACKEND_PORT, '--use-colors'],
  backendDir,
);
await waitForBackend();
if (!stopping) {
  run('web', color.cyan, process.execPath, [viteBin, '--port', FRONTEND_PORT, '--strictPort'], frontendDir);
}
