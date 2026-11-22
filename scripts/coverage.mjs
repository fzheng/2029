import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import instrumentation from 'istanbul-lib-instrument'
import coverage from 'istanbul-lib-coverage'
import reporting from 'istanbul-lib-report'
import reports from 'istanbul-reports'
import { build, preview } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const reportDir = join(root, 'coverage')
mkdirSync(reportDir, { recursive: true })
const work = mkdtempSync(join(reportDir, '.run-'))
const counts = join(work, 'counts')
const map = coverage.createCoverageMap({})
const env = { ...process.env, PORTFOLIO_COVERAGE_DIR: counts }

function run(args, environment) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: environment, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) done()
      else reject(new Error(`Test command failed (${signal ?? code}): node ${args.join(' ')}`))
    })
  })
}

let server
try {
  // Both runtimes use the same counters, located against the original TS/TSX.
  // Seed every module so an unimported file still contributes to the denominator.
  for (const path of ['src', 'test', 'index.html', 'public', 'tsconfig.json']) {
    cpSync(join(root, path), join(work, path), { recursive: true })
  }
  mkdirSync(counts)
  const instrumenter = instrumentation.createInstrumenter({
    esModules: true,
    parserPlugins: ['typescript', 'jsx'],
  })
  for (const file of readdirSync(join(root, 'src'), { recursive: true })) {
    if (!/\.tsx?$/.test(file) || file.endsWith('.d.ts')) continue
    const original = join(root, 'src', file)
    const code = instrumenter.instrumentSync(readFileSync(original, 'utf8'), original)
    map.addFileCoverage(instrumenter.lastFileCoverage())
    writeFileSync(join(work, 'src', file), code)
  }

  const tests = readdirSync(join(work, 'test')).filter((name) => name.endsWith('.test.ts'))
  await run([
    '--import', 'tsx', '--import', './scripts/save-unit-coverage.mjs', '--test',
    ...tests.map((file) => join(work, 'test', file)),
  ], env)

  const viteOptions = { root: work, configFile: join(root, 'vite.config.ts'), logLevel: 'warn' }
  await build(viteOptions)
  server = await preview({ ...viteOptions, preview: { host: '127.0.0.1', port: 0 } })
  const { port } = server.httpServer.address()
  const browserEnv = { ...env, PORTFOLIO_COVERAGE_URL: `http://127.0.0.1:${port}` }
  await run([
    join(root, 'node_modules/@playwright/test/cli.js'), 'test',
    '--output', join(root, 'test-results', 'coverage'),
  ], browserEnv)

  const files = readdirSync(counts)
  for (const suite of ['unit', 'browser']) {
    if (!files.some((file) => file.startsWith(suite + '-'))) throw new Error('Missing ' + suite + ' coverage')
  }
  for (const file of files) map.merge(JSON.parse(readFileSync(join(counts, file), 'utf8')))
  const context = reporting.createContext({ dir: reportDir, coverageMap: map })
  for (const name of ['text', 'html', 'lcovonly', 'json-summary']) reports.create(name).execute(context)
  console.log('HTML coverage report:', join(reportDir, 'index.html'))
} finally {
  if (server) await server.close()
  rmSync(work, { recursive: true, force: true })
}
