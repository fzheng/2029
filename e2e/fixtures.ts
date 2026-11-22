import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test as base, type BrowserContext } from '@playwright/test'

declare global {
  interface Window {
    __coverage__?: object
    __saveTestCoverage: (id: string, json: string) => Promise<void>
    __flushTestCoverage?: () => Promise<void> | undefined
  }
}

const directory = process.env.PORTFOLIO_COVERAGE_DIR

export async function trackCoverage(context: BrowserContext) {
  if (!directory) return
  await context.exposeBinding('__saveTestCoverage', (_, id: string, json: string) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid coverage document ID')
    writeFileSync(join(directory, 'browser-' + id + '.json'), json)
  })
  await context.addInitScript(() => {
    const id = crypto.randomUUID()
    window.__flushTestCoverage = () =>
      window.__coverage__ && window.__saveTestCoverage(id, JSON.stringify(window.__coverage__))
    window.addEventListener('pagehide', () => { void window.__flushTestCoverage?.() })
  })
}

export async function flushCoverage(context: BrowserContext) {
  if (!directory) return
  await Promise.all(context.pages().map((page) => page.evaluate(() => window.__flushTestCoverage?.())))
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await trackCoverage(context)
    try {
      await use(context)
    } finally {
      await flushCoverage(context)
    }
  },
})
