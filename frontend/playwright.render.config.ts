import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defineConfig } from '@playwright/test'

// The render end-to-end test: the real frontend in Chromium, the real FastAPI backend and real
// FFmpeg. It renders a project and compares frames of the MP4 with the preview.
// Needs the backend's Python environment (`npm run setup`, or set RENDER_E2E_PYTHON) and FFmpeg.
const frontendPort = 5181
const backendPort = 8799
const python =
  process.env.RENDER_E2E_PYTHON ||
  path.resolve('../backend/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
// Workers inherit the environment, so they all see the same folder.
process.env.RENDER_E2E_DATA ??= mkdtempSync(path.join(tmpdir(), 'shorts-render-e2e-'))
const data = process.env.RENDER_E2E_DATA

export default defineConfig({
  testDir: 'e2e-render',
  testMatch: '*.e2e.ts',
  timeout: 180_000,
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    viewport: { width: 1366, height: 768 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined },
  },
  webServer: [
    {
      command: `"${python}" -m uvicorn app.main:app --host 127.0.0.1 --port ${backendPort}`,
      cwd: '../backend',
      url: `http://127.0.0.1:${backendPort}/api/health`,
      env: {
        PROJECTS_DIR: path.join(data, 'projects'),
        LIBRARY_DIR: path.join(data, 'library'),
        EXPORTS_DIR: path.join(data, 'exports'),
        DATA_DIR: path.join(data, 'data'),
        MODELS_DIR: path.join(data, 'models'),
      },
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: `node node_modules/vite/bin/vite.js --port ${frontendPort} --strictPort`,
      url: `http://127.0.0.1:${frontendPort}`,
      env: { OPEN_BROWSER: '0', BACKEND_PORT: String(backendPort) },
      reuseExistingServer: false,
    },
  ],
})
