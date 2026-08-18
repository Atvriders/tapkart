import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? '3132')
const HOST = '127.0.0.1'
const BASE_URL = `http://${HOST}:${PORT}`

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  timeout: 600_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build:server && node packages/server/dist/main.mjs',
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: process.env.CI === undefined,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      BIND_HOST: HOST,
      STATIC_ROOT: 'apps/web/dist',
    },
  },
})
