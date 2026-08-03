import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

const systemChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const launchOptions = process.platform === 'win32' && existsSync(systemChrome)
  ? { executablePath: systemChrome }
  : undefined

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:1420',
    trace: 'retain-on-failure',
    ...(launchOptions ? { launchOptions } : {}),
    ...devices['Desktop Chrome']
  },
  webServer: {
    command: 'npm run dev:web -- --host 127.0.0.1',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: true,
    timeout: 120_000
  }
})
