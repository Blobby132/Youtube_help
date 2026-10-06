import { defineConfig } from '@playwright/test'

// End-to-end tests drive the real frontend in Chromium against a faked backend
// (see e2e/fakeBackend.ts), so they need neither Python nor the AI models.
// One-time setup on a new machine: `npx playwright install chromium`.
const port = 5179

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1366, height: 768 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined },
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    env: { OPEN_BROWSER: '0' },
    reuseExistingServer: false,
  },
})
