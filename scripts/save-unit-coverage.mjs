import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

process.on('exit', () => {
  if (globalThis.__coverage__) {
    const file = join(process.env.PORTFOLIO_COVERAGE_DIR, `unit-${randomUUID()}.json`)
    writeFileSync(file, JSON.stringify(globalThis.__coverage__))
  }
})
