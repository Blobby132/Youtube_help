// Shared helpers for the setup/dev/test scripts. Plain Node, no dependencies,
// so they run before anything is installed.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const isWindows = process.platform === 'win32';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const backendDir = path.join(root, 'backend');
export const frontendDir = path.join(root, 'frontend');
export const venvDir = path.join(backendDir, '.venv');
export const venvPython = path.join(venvDir, isWindows ? 'Scripts/python.exe' : 'bin/python');

// Pick up port overrides from .env (variables already set in the shell win).
const envFile = path.join(root, '.env');
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (error) {
    console.warn(`Could not read .env: ${error.message}`);
  }
}

export const BACKEND_PORT = process.env.BACKEND_PORT || '8765';
export const FRONTEND_PORT = process.env.FRONTEND_PORT || '5173';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
export const color = {
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  dim: paint('2'),
  bold: paint('1'),
};

export function requireVenv() {
  if (!existsSync(venvPython)) {
    console.error(color.red('The Python environment is missing.'));
    console.error(`Run ${color.bold('npm run setup')} first (see README.md).`);
    process.exit(1);
  }
  return venvPython;
}
