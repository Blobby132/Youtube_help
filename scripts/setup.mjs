// `npm run setup`: one-time install of everything the app needs.
//   1. a Python virtual environment in backend/.venv with the backend packages
//   2. the frontend's npm packages
//   3. a .env file copied from .env.example
// It is safe to run again after pulling updates.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  backendDir,
  color,
  frontendDir,
  isWindows,
  root,
  venvDir,
  venvPython,
} from './lib.mjs';

const MIN_PYTHON = [3, 12];
const PREFERRED_PYTHONS = ['3.14', '3.13', '3.12'];

function step(title) {
  console.log(`\n${color.cyan('==>')} ${color.bold(title)}`);
}

function fail(message) {
  console.error(`\n${color.red('Setup failed:')} ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`\`${[command, ...args].join(' ')}\` exited with code ${result.status}`);
}

function pythonVersion(command, args) {
  const result = spawnSync(command, [...args, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout) return null;
  const [major, minor] = result.stdout.trim().split('.').map(Number);
  return Number.isFinite(minor) ? [major, minor] : null;
}

function findPython() {
  const candidates = isWindows
    ? [
        ...PREFERRED_PYTHONS.map((v) => ['py', [`-${v}`]]),
        ['python', []],
        ['python3', []],
      ]
    : [...PREFERRED_PYTHONS.map((v) => [`python${v}`, []]), ['python3', []]];

  for (const [command, args] of candidates) {
    const version = pythonVersion(command, args);
    if (!version) continue;
    const [major, minor] = version;
    if (major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])) {
      return { command, args, label: `${major}.${minor}` };
    }
    console.log(color.yellow(`  Skipping Python ${major}.${minor} (${command}): need ${MIN_PYTHON.join('.')} or newer.`));
  }
  return null;
}

function hasCommand(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

// 1. Node
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 20 || (nodeMajor === 20 && nodeMinor < 19)) {
  fail(`Node.js ${process.versions.node} is too old. Install Node.js 22 LTS or newer.`);
}

// 2. Python environment
step('Python environment (backend/.venv)');
if (existsSync(venvPython)) {
  const version = pythonVersion(venvPython, []);
  console.log(`  Using existing environment (Python ${version ? version.join('.') : 'unknown'}).`);
  console.log(color.dim(`  To rebuild it with another Python, delete ${path.relative(root, venvDir)} and run setup again.`));
} else {
  const python = findPython();
  if (!python) {
    fail(
      'Python 3.12 or newer was not found. Install Python 3.14 from https://www.python.org/downloads/ ' +
        '(tick "Add python.exe to PATH"), open a new terminal and run `npm run setup` again.',
    );
  }
  console.log(`  Creating it with Python ${python.label}...`);
  run(python.command, [...python.args, '-m', 'venv', venvDir]);
}

step('Python packages');
run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip', '--disable-pip-version-check', '-q']);
run(venvPython, ['-m', 'pip', 'install', '-r', path.join(backendDir, 'requirements-dev.txt'), '--disable-pip-version-check']);

// 3. Frontend
step('Frontend packages');
run('npm', ['install', '--no-fund', '--no-audit'], { cwd: frontendDir, shell: isWindows });

// 4. .env
step('Settings file (.env)');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) {
  console.log('  .env already exists, leaving it alone.');
} else {
  copyFileSync(path.join(root, '.env.example'), envFile);
  console.log('  Created .env from .env.example. Add your free Pexels API key to it for stock search.');
}

// 5. FFmpeg
step('FFmpeg');
if (hasCommand('ffmpeg', ['-version']) && hasCommand('ffprobe', ['-version'])) {
  console.log('  Found ffmpeg and ffprobe.');
} else {
  console.log(color.yellow('  FFmpeg was not found on PATH. Rendering needs it.'));
  console.log(`  Install it with ${color.bold('winget install --id Gyan.FFmpeg -e')} and open a new terminal.`);
}

console.log(`\n${color.green('Setup complete.')} Start the app with ${color.bold('npm run dev')}.`);
