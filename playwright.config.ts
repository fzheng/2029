import { defineConfig } from '@playwright/test'

const coverageURL = process.env.PORTFOLIO_COVERAGE_URL
const baseURL = coverageURL ?? 'http://127.0.0.1:2029'
export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL,
    browserName: 'chromium',
    viewport: { width: 1440, height: 960 },
    trace: 'retain-on-failure',
  },
  webServer: coverageURL ? undefined : { command: 'npm start', url: baseURL, reuseExistingServer: !process.env.CI },
})
