// `npm run setup`: one-time install of everything the app needs.
//   1. a .env file copied from .env.example
//   2. a Python virtual environment in backend/.venv with the backend packages
//      (ONNX Runtime for CPU, or for DirectML when TTS_DEVICE=directml in .env)
//   3. the Kokoro voice model (~350 MB) and the Whisper caption model (~480 MB for small.en),
//      downloaded once into models/
//   4. the frontend's npm packages
// It is safe to run again after pulling updates or changing TTS_DEVICE.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
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

function readEnvValue(file, key) {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith(`${key}=`));
  return line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
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

// 2. .env
step('Settings file (.env)');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) {
  console.log('  .env already exists, leaving it alone.');
} else {
  copyFileSync(path.join(root, '.env.example'), envFile);
  console.log('  Created .env from .env.example. Add your free Pexels API key to it for stock search.');
}
let ttsDevice = (process.env.TTS_DEVICE || readEnvValue(envFile, 'TTS_DEVICE') || 'cpu').toLowerCase();
if (ttsDevice === 'directml' && !isWindows) {
  console.log(color.yellow('  TTS_DEVICE=directml only works on Windows; installing the CPU runtime instead.'));
  ttsDevice = 'cpu';
} else if (!['cpu', 'directml'].includes(ttsDevice)) {
  console.log(color.yellow(`  Unknown TTS_DEVICE "${ttsDevice}"; using cpu.`));
  ttsDevice = 'cpu';
}

// 3. Python environment
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
const pip = (...args) => run(venvPython, ['-m', 'pip', ...args, '--disable-pip-version-check']);
const requirements = (name) => path.join(backendDir, name);
pip('install', '--upgrade', 'pip', '-q');
pip('install', '-r', requirements('requirements.txt'), '-r', requirements('requirements-dev.txt'));
// faster-whisper without its dependencies (they're in requirements.txt), so it can't replace
// onnxruntime-directml with the CPU onnxruntime.
pip('install', '--no-deps', '-r', requirements('requirements-no-deps.txt'));

// The CPU and DirectML builds of ONNX Runtime install the same module, so only one may be present.
step(`ONNX Runtime for ${ttsDevice === 'directml' ? 'DirectML (GPU)' : 'CPU'}`);
const isInstalled = (name) =>
  spawnSync(venvPython, ['-m', 'pip', 'show', '-q', name, '--disable-pip-version-check'], { stdio: 'ignore' }).status === 0;
const [wanted, other, file] =
  ttsDevice === 'directml'
    ? ['onnxruntime-directml', 'onnxruntime', 'requirements-onnx-directml.txt']
    : ['onnxruntime', 'onnxruntime-directml', 'requirements-onnx-cpu.txt'];
if (isInstalled(other)) {
  // Removing the other build deletes files the wanted one shares, so reinstall it afterwards.
  pip('uninstall', '-y', '-q', other);
  pip('install', '--force-reinstall', '--no-deps', '-r', requirements(file));
} else {
  pip('install', '-r', requirements(file));
}
console.log(`  Using ${wanted}.`);
run(venvPython, ['-c', 'import onnxruntime as o; print("  Providers:", ", ".join(o.get_available_providers()))']);

// 4. Models
step('Kokoro voice model');
run(venvPython, ['-m', 'app.voiceover.assets'], { cwd: backendDir });
step('Whisper caption model');
run(venvPython, ['-m', 'app.captions.assets'], { cwd: backendDir });

// 5. Frontend
step('Frontend packages');
run('npm', ['install', '--no-fund', '--no-audit'], { cwd: frontendDir, shell: isWindows });

// 6. FFmpeg
step('FFmpeg');
if (hasCommand('ffmpeg', ['-version']) && hasCommand('ffprobe', ['-version'])) {
  console.log('  Found ffmpeg and ffprobe.');
} else {
  console.log(color.yellow('  FFmpeg was not found on PATH. Rendering needs it.'));
  console.log(`  Install it with ${color.bold('winget install --id Gyan.FFmpeg -e')} and open a new terminal.`);
}

console.log(`\n${color.green('Setup complete.')} Start the app with ${color.bold('npm run dev')}.`);
