import { readFile } from 'node:fs/promises'
import { expect, type BrowserContext, type Locator, type Page, type Route } from '@playwright/test'
import { test, trackCoverage, flushCoverage } from './fixtures'

// Synthetic public quotes are scoped to the isolated browser context of each test.
async function market(context: BrowserContext) {
  const feed = { online: true, btc: 60000, hype: 20 }
  const handler = async (route: Route) => {
    if (!feed.online) return route.abort('internetdisconnected')
    const url = new URL(route.request().url())
    const now = Date.now()
    const prices = { BTC: feed.btc, ETH: 2000, SOL: 100, BNB: 500, HYPE: feed.hype, LINK: 10 }
    let data: unknown
    if (url.pathname.endsWith('/tickers')) {
      data = Object.entries(prices).map(([asset, value]) => ({
        symbol: asset + 'USDT',
        lastPrice: String(value),
        markPrice: String(asset === 'HYPE' ? 22 : value),
        indexPrice: String(asset === 'HYPE' ? 19 : value),
        price24hPcnt: '0.01',
        ts: String(now),
      }))
    } else if (url.pathname.endsWith('/candles')) {
      data = Array.from({ length: 56 }, (_, i) => [
        String(now - (56 - i) * 86400000),
        '950',
        '1050',
        '900',
        '1000',
        '120',
        '120000',
      ])
    } else if (url.pathname.endsWith('/query-position-lever')) {
      data = [{ startUnit: '0', endUnit: '1000000', keepMarginRate: '0.004' }]
    } else if (url.pathname.endsWith('/contracts')) {
      data = [{ symbol: url.searchParams.get('symbol'), takerFeeRate: '0.0006' }]
    } else if (url.pathname.endsWith('/loan/public/coinInfos')) {
      const coin = url.searchParams.get('coin')
      data = {
        pledgeInfos:
          coin === 'ETH'
            ? [{ coin, initRate: '0.60', forceRate: '0.90', minUsdt: '10', maxUsdt: '10000' }]
            : [],
        loanInfos: coin === 'USDT' ? [{ coin, minUsdt: '25', maxUsdt: '5000' }] : [],
      }
    } else return route.abort()
    return route.fulfill({ json: { code: '00000', requestTime: now, data } })
  }
  await context.route(/\/api\/v[23]\//, handler)
  return feed
}

const button = (page: Page, name: string | RegExp) =>
  page.getByRole('button', { name, exact: typeof name === 'string' })
async function addAccount(page: Page, name: string, kind: 'spot' | 'loan' | 'perp' = 'spot') {
  await button(page, /^(Add your first account|Add account)$/)
    .first()
    .click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Account name').fill(name)
  if (kind === 'spot') {
    await expect(dialog.getByLabel('Quantity', { exact: true })).toHaveValue('')
    await expect(dialog.getByLabel('Outstanding debt')).toHaveValue('')
    await dialog.getByLabel('Asset', { exact: true }).fill('BTC')
    await dialog.getByLabel('Quantity', { exact: true }).fill('1')
    await dialog.getByLabel('Outstanding debt').fill('35000')
  } else if (kind === 'loan') {
    await dialog.getByRole('button', { name: 'Crypto loan' }).click()
    await dialog.getByLabel('Collateral asset').fill('BTC')
    await dialog.getByLabel('Pledged quantity').fill('1')
    await dialog.getByLabel('Outstanding loan debt').fill('35000')
  } else {
    await dialog.getByRole('button', { name: 'Isolated perpetual' }).click()
    await dialog.getByLabel('Contract asset').fill('BTC')
    await dialog.getByLabel('Position size').fill('0.1')
    await dialog.getByLabel('Entry price').fill('60000')
    await dialog.getByLabel('Allocated isolated margin').fill('2000')
    await dialog.getByRole('button', { name: 'Load Bitget terms' }).click()
    await expect(dialog.getByText('Loaded Bitget maintenance tiers and public taker fee.')).toBeVisible()
  }
  await dialog.getByRole('button', { name: 'Save account' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.record-name b', { hasText: name })).toHaveCount(1)
}
async function editAccount(page: Page, name: string) {
  const record = page.locator('.record', { has: page.getByText(name, { exact: true }) })
  if ((await record.locator('.record-main').getAttribute('aria-expanded')) !== 'true')
    await record.locator('.record-main').click()
  await record.getByRole('button', { name: 'Edit account' }).click()
  return page.getByRole('dialog', { name: 'Edit account' })
}
async function settings(page: Page) {
  await button(page, /^(Settings|Portfolio settings)$/i)
    .first()
    .click()
  return page.getByRole('dialog', { name: 'Portfolio settings' })
}
async function exported(page: Page) {
  const dialog = await settings(page)
  const pending = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Export JSON' }).click()
  const path = await (await pending).path()
  if (!path) throw new Error('Backup download unavailable')
  const value = JSON.parse(await readFile(path, 'utf8'))
  await dialog.getByRole('button', { name: 'Close Portfolio settings' }).click()
  return value
}
async function emptyLive(page: Page) {
  await expect(button(page, 'Add your first account')).toBeVisible()
  await expect(page.locator('.metric.equity .metric-value')).toHaveText(/0\.00\s*USDT/)
  const values = page.locator('.metric-value')
  await expect(values.nth(1)).toHaveText('—')
  await expect(values.nth(2)).toHaveText(/0\.00\s*USDT/)
  await expect(values.nth(3)).toHaveText('—')
  await expect(page.locator('.record')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Scenario prices' })).toHaveCount(0)
}

test('blank install and refresh, chart symbol search and narrow viewport', async ({ page, context }) => {
  await market(context)
  await page.goto('/')
  await emptyLive(page)
  await page.setViewportSize({ width: 390, height: 844 })
  const firstAction = button(page, 'Add your first account')
  await expect(firstAction).toBeInViewport({ ratio: 1 })
  await expect(firstAction).toHaveClass(/primary/)
  await expect(button(page, 'Simulate')).not.toHaveClass(/primary/)
  await page.reload()
  await emptyLive(page)
  await expect(page.locator('.plot-wrap canvas').first()).toBeVisible()
  await button(page, 'Search markets').click()
  await page.getByLabel('Search symbol or asset').fill('LINK')
  await button(page, /LINK \/ USDT/).click()
  await expect(button(page, 'Select chart market')).toContainText('LINK')
  await button(page, '1H').click()
  await expect(button(page, '1H')).toHaveAttribute('aria-pressed', 'true')
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(button(page, 'Add your first account')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width + 1,
    )
  }
  await button(page, 'Add your first account').click()
  await expect(page.getByLabel('Quantity', { exact: true })).toBeVisible()
  const box = await page.getByRole('dialog').boundingBox()
  expect(box!.width).toBeLessThanOrEqual(390)
})

test('an offline chart offers retry for a new market and reuses candles only for their own market', async ({
  page, context,
}) => {
  const feed = await market(context)
  await page.goto('/')
  const ohlc = page.getByLabel('Candle prices')
  await expect(ohlc).toContainText('1,000.00')
  feed.online = false
  await button(page, 'Chart ETH').click()
  await expect(page.getByText('Bitget chart unavailable')).toBeVisible()
  await expect(ohlc).toHaveCount(0)

  feed.online = true
  await button(page, 'Retry').click()
  await expect(ohlc).toContainText('1,000.00')
  await expect(button(page, 'Retry')).toHaveCount(0)
  await button(page, 'Expand chart').click()
  await expect(button(page, 'Close expanded chart')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(button(page, 'Expand chart')).toBeVisible()

  feed.online = false
  await button(page, 'Chart SOL').click()
  await expect(button(page, 'Retry')).toBeVisible()
  await button(page, 'Chart ETH').click()
  await expect(page.getByText(/Cached candles/)).toBeVisible()
  await expect(ohlc).toContainText('1,000.00')
})

async function addHypeAccounts(page: Page) {
  const accounts = [
    { type: 'Spot wallet', assetField: 'Asset', fields: [['Quantity', '2']] },
    { type: 'Spot cross margin', assetField: 'Asset', fields: [['Quantity', '3'], ['Outstanding debt', '10']] },
    { type: 'Crypto loan', assetField: 'Collateral asset', fields: [['Pledged quantity', '4'], ['Outstanding loan debt', '50']] },
    { type: 'Isolated perpetual', assetField: 'Contract asset', fields: [['Position size', '1'], ['Entry price', '20'], ['Allocated isolated margin', '10']] },
  ]
  const editor = page.getByRole('dialog')
  for (const { type, assetField, fields } of accounts) {
    await button(page, /^(Add your first account|Add account)$/).first().click()
    await editor.getByRole('button', { name: type, exact: true }).click()
    await editor.getByLabel('Account name').fill('HYPE ' + type)
    const asset = editor.getByLabel(assetField, { exact: true })
    const suggestions = await asset.evaluate((input: HTMLInputElement) =>
      Array.from(input.list?.options ?? [], (option) => option.value),
    )
    expect(suggestions).toContain('HYPE')
    await asset.fill('hype')
    for (const [label, value] of fields) await editor.getByLabel(label, { exact: true }).fill(value)
    if (type === 'Isolated perpetual') {
      await editor.getByRole('button', { name: 'Load Bitget terms' }).click()
      await expect(editor.getByText('Loaded Bitget maintenance tiers and public taker fee.')).toBeVisible()
    }
    await editor.getByRole('button', { name: 'Save account' }).click()
    await expect(editor).toHaveCount(0)
  }
}

test('account cards show leverage, BTC liquidation and USDT equity in Overview and Accounts', async ({
  page, context,
}) => {
  await market(context)
  await page.goto('/')
  await addHypeAccounts(page)
  const record = (type: string) =>
    page.locator('.record').filter({ has: page.getByText('HYPE ' + type, { exact: true }) })
  // Base links HYPE at 1.7×. The native trigger uses spot 20, loan index 19, or perp mark 22.
  const accounts = [
    { type: 'Spot wallet', leverage: '1.00×', liquidation: '—', equity: '40.00' },
    { type: 'Spot cross margin', leverage: '1.20×', liquidation: '31,176.47', equity: '50.00' },
    { type: 'Crypto loan', leverage: '2.92×', liquidation: '50,222.16', equity: '26.00' },
    { type: 'Isolated perpetual', leverage: '1.83×', liquidation: '40,822.80', equity: '12.00' },
  ]
  for (const language of ['en', 'zh-CN']) {
    const chinese = language === 'zh-CN'
    if (chinese) {
      await button(page, 'Accounts').click()
      await page.getByLabel('Language / 语言').selectOption(language)
      await page.setViewportSize({ width: 390, height: 844 })
    }
    const labels = chinese
      ? ['实际杠杆', 'BTC 强平价', '净权益（USDT）']
      : ['Effective leverage', 'BTC liquidation price', 'Net equity (USDT)']
    for (const { type, leverage, liquidation, equity } of accounts) {
      const card = record(type)
      const metrics = card.locator('.record-main .record-metric')
      await expect(card.locator('.record-main')).toHaveAttribute('aria-expanded', 'false')
      await expect(metrics.locator('small')).toHaveText(labels)
      await expect(metrics.locator('b')).toHaveText([leverage, liquidation, equity])
      for (const metric of await metrics.all()) await expect(metric).toBeVisible()
    }
    const spot = record('Spot cross margin')
    await spot.locator('.record-main').click()
    const table = spot.getByRole('table')
    await expect(table.getByRole('row').nth(1).getByRole('cell')).toHaveText([
      'HYPE', '3', '20.00', '60.00',
    ])
    await expect(spot.getByText(chinese ? '定价依据' : 'Price basis', { exact: true })).toHaveCount(0)
    await expect(spot.getByText(chinese ? '持仓' : 'Holdings', { exact: true })).toHaveCount(0)
    await expect(spot.getByText('3 HYPE', { exact: true })).toHaveCount(0)
    await expect(spot.getByRole('button', { name: chinese ? '编辑账户' : 'Edit account' })).toBeVisible()
    await expect(
      spot.getByRole('button', { name: chinese ? '添加限价挂单' : 'Add limit order' }),
    ).toBeVisible()
    const loan = record('Crypto loan')
    await loan.locator('.record-main').click()
    await expect(loan.locator('dd').filter({ hasText: '4 HYPE' })).toHaveCount(1)
    if (chinese)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await spot.locator('.record-main').click()
    await loan.locator('.record-main').click()
  }
})

test('HYPE uses Bitget spot, mark and index prices across accounts, chart, scenario and planner', async ({
  page, context,
}) => {
  const feed = await market(context)
  await page.clock.install()
  await page.goto('/')
  await expect(button(page, 'Chart HYPE')).toContainText('20.00')
  await button(page, 'Search markets').click()
  await page.getByLabel('Search symbol or asset').fill('Hyperliquid')
  await button(page, /HYPE \/ USDT/).click()
  await expect(page.getByRole('img', { name: /HYPE\/USDT.*Bitget candlesticks/ })).toBeVisible()
  await addHypeAccounts(page)
  const equity = page.locator('.metric.equity .metric-value')
  await expect(equity).toHaveText('128.00 USDT')
  await button(page, 'Simulate').click()
  const hypePrice = page.getByLabel('HYPE scenario price')
  await page.getByLabel('BTC scenario price').fill('45000')
  const path = page.getByLabel('Price path')
  for (const [mode, expected] of [
    ['Independent', { ETH: '2000', SOL: '100', BNB: '500', HYPE: '20' }],
    ['Base', { ETH: '1250', SOL: '57.5', BNB: '375', HYPE: '11.5' }],
    ['Severe', { ETH: '750', SOL: '25', BNB: '312.5', HYPE: '5' }],
  ] as const) {
    await path.selectOption(mode)
    for (const [asset, price] of Object.entries(expected))
      await expect(page.getByLabel(asset + ' scenario price')).toHaveValue(price)
  }
  const loan = page.locator('.fund-action').filter({ hasText: 'HYPE Crypto loan' })
  const repayment = loan.getByText('Required transfer', { exact: true }).locator('+ dd')
  await button(page, 'Cash planner').click()
  await page.getByLabel('BTC target price').fill('45000')
  await expect(page.getByLabel('Altcoin path')).toHaveValue('Base')
  await expect(repayment).toHaveText('10.24 USDT')
  await button(page, 'Back to scenario').click()
  await button(page, 'Plan using this scenario').click()
  await expect(page.getByLabel('Altcoin path')).toHaveValue('Severe')
  await expect(repayment).toHaveText('32.72 USDT')
  await button(page, 'Back to scenario').click()
  await hypePrice.fill('10')
  const totals = page.locator('.comparison-row').filter({ hasText: 'Net equity' }).locator('b')
  await expect(totals).toHaveText(['128.00 USDT', '41.00 USDT'])
  feed.hype = 25
  await page.clock.fastForward(45001)
  await expect(totals).toHaveText(['153.00 USDT', '41.00 USDT'])
  await button(page, 'Plan using this scenario').click()
  await expect(repayment).toHaveText('15.43 USDT')
  await button(page, 'Back to scenario').click()
  await button(page, 'Restore BTC link').click()
  await expect(hypePrice).toHaveValue('5')
  await expect(totals).toHaveText(['153.00 USDT', '15.00 USDT'])
  await saveNamed(page, 'Save scenario', 'HYPE linked decline')
  await page.reload()
  await expect(page.locator('.heading-line .tag')).toHaveText('Live')
  await expect(equity).toHaveText('153.00 USDT')
  await expect(page.locator('.record-name b')).toHaveCount(4)
  // A valid saved scenario may show only HYPE while its frozen BTC price still drives the path.
  const backup = await exported(page)
  backup.scenarios[0].data.symbols = ['HYPE']
  const dialog = await settings(page)
  await dialog.getByLabel('Select JSON backup').setInputFiles({
    name: 'hype-only.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)),
  })
  await button(page, 'Import backup').click()
  await button(page, 'Load scenario').click()
  await button(page, 'HYPE linked decline').click()
  await expect(path).toHaveValue('Severe')
  await expect(page.getByLabel('BTC scenario price')).toHaveCount(0)
  await expect(hypePrice).toHaveValue('5')
  await button(page, 'Add asset').click()
  await button(page, /LINK \/ USDT/).click()
  const unlinked = page.getByLabel('LINK scenario price')
  await expect(unlinked).toHaveValue('10')
  await unlinked.fill('8')
  await button(page, 'Restore reference price').click()
  await expect(unlinked).toHaveValue('10')
  await button(page, 'Plan using this scenario').click()
  await expect(repayment).toHaveText('32.72 USDT')
})

test('manual edits restore once after close and reopen, reset and quote failure preserve saved quantities', async ({
  page,
  context,
}) => {
  const feed = await market(context)
  await page.goto('/')
  await addAccount(page, 'Cross wallet')
  const dialog = await editAccount(page, 'Cross wallet')
  await dialog.getByLabel('Quantity', { exact: true }).fill('1.25000001')
  await dialog.getByRole('button', { name: 'Save account' }).click()
  await expect(dialog).toHaveCount(0)
  await button(page, /Simulate/)
    .first()
    .click()
  await page.getByLabel('BTC scenario price').fill('44000')
  await page.getByLabel('BTC scenario price').blur()
  await expect(page.getByLabel('BTC percentage change')).toHaveValue('-26.666667')
  await button(page, 'Reset scenario').click()
  await expect(page.getByLabel('BTC scenario price')).toHaveValue('60000')
  await page.getByLabel('BTC percentage change').fill('-20')
  await expect(page.getByLabel('BTC scenario price')).toHaveValue('48000')
  await page.getByLabel('BTC adjustment slider').focus()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByLabel('BTC scenario price')).toHaveValue('47940')
  await button(page, 'Return to Live').click()
  await expect(page.getByRole('heading', { name: 'Scenario prices' })).toHaveCount(0)
  await button(page, /Simulate/)
    .first()
    .click()
  await page.reload()
  await expect(page.locator('.metric.equity .metric-value')).toContainText('40,000.00')
  await expect(page.getByRole('heading', { name: 'Scenario prices' })).toHaveCount(0)
  await page.close()
  feed.online = false
  const reopened = await context.newPage()
  await reopened.goto('/')
  await expect(reopened.locator('.record-name b')).toHaveText(['Cross wallet'])
  await expect(reopened.locator('.metric.equity .metric-value')).toContainText('40,000.00')
  await expect(reopened.getByText(/stale|last known/i).first()).toBeVisible()
  const saved = await editAccount(reopened, 'Cross wallet')
  await expect(saved.getByLabel('Quantity', { exact: true })).toHaveValue('1.25000001')
})

async function saveNamed(page: Page, action: string, name: string) {
  await button(page, action).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

test('44,000 scenario is independent of 35,000 loan funding, and cleanly reopens only on selection', async ({
  page,
  context,
}) => {
  const feed = await market(context)
  await page.clock.install()
  await page.goto('/')
  await addAccount(page, 'Loan order 5', 'loan')
  await addAccount(page, 'Long position 3', 'perp')
  await button(page, 'Simulate').click()
  await page.getByLabel('BTC scenario price').fill('44000')
  await page.getByLabel('BTC scenario price').blur()
  // A distinct quote update in Live cannot alter the reference snapshot.
  const comparison = page.locator('.comparison-row').filter({ hasText: 'Net equity' })
  await expect(comparison.locator('b')).toHaveText(['27,000.00 USDT', '9,400.00 USDT'])
  feed.btc = 62000
  await page.clock.fastForward(45001)
  await expect(comparison.locator('b')).toHaveText(['29,200.00 USDT', '9,400.00 USDT'])
  await expect(page.getByLabel('BTC scenario price')).toHaveValue('44000')
  feed.btc = 60000
  await page.clock.fastForward(45001)
  await expect(comparison.locator('b')).toHaveText(['27,000.00 USDT', '9,400.00 USDT'])
  await page.getByLabel('Price path').selectOption('Base')
  await expect(page.getByLabel('ETH scenario price')).toHaveValue('1200')
  await page.getByLabel('ETH scenario price').fill('1740')
  await page.getByLabel('ETH scenario price').blur()
  await expect(page.getByLabel('ETH percentage change')).toHaveValue('-13')
  await button(page, 'Restore BTC link').click()
  await expect(page.getByLabel('ETH scenario price')).toHaveValue('1200')
  await saveNamed(page, 'Save scenario', '44k inspection')
  await button(page, 'Cash planner').click()
  await page.getByLabel('BTC target price').fill('35000')
  const actions = page.locator('.fund-action')
  await expect(actions).toHaveCount(2)
  await expect(actions.first()).toContainText('Loan order 5')
  await expect(actions.first()).toContainText('3,150.01 USDT')
  await expect(actions.first()).toContainText('31,849.99 USDT')
  await expect(actions.last()).toContainText('Long position 3')
  await expect(actions.last()).toContainText('516.11 USDT')
  await page.getByLabel('Cash budget').fill('3000')
  await expect(actions.first()).toContainText('150.01 USDT')
  await expect(actions.last().locator('.tag.danger')).toHaveText('Funding shortfall')
  await page.getByLabel('Apply to').selectOption({ label: 'Loan order 5' })
  await expect(actions).toHaveCount(1)
  await saveNamed(page, 'Save plan', '35k target')
  await button(page, 'Back to scenario').click()
  await expect(page.getByLabel('BTC scenario price')).toHaveValue('44000')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Portfolio overview' })).toBeVisible()
  await button(page, 'Load scenario').click()
  await page
    .getByRole('dialog', { name: 'Saved scenarios' })
    .getByRole('button', { name: '44k inspection', exact: true })
    .click()
  await expect(page.getByLabel('BTC scenario price')).toHaveValue('44000')
  await button(page, 'Cash planner').click()
  await page.getByLabel('Load saved plan').selectOption({ label: '35k target' })
  await expect(page.getByLabel('BTC target price')).toHaveValue('35000')
  await expect(page.getByLabel('Cash budget')).toHaveValue('3000')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391)
  await expect(page.locator('.fund-action').first()).toContainText('Loan order 5')
  await button(page, 'Back to scenario').click()
  await expect(page.getByLabel('BTC scenario price')).toHaveValue('44000')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391)
  await button(page, 'Return to Live').click()
  await expect(page.getByRole('heading', { name: 'Portfolio overview' })).toBeVisible()
})

test('scenario funding reuses frozen quotes and explicit overrides while keeping the standalone plan independent', async ({
  page,
  context,
}) => {
  const feed = await market(context)
  await page.clock.install()
  await page.goto('/')
  await button(page, 'Add your first account').click()
  const editor = page.getByRole('dialog')
  await editor.getByLabel('Account name').fill('ETH margin')
  await editor.getByLabel('Asset', { exact: true }).fill('ETH')
  await editor.getByLabel('Quantity', { exact: true }).fill('2')
  await editor.getByLabel('Outstanding debt').fill('-15,00.00')
  await editor.getByRole('button', { name: 'Save account' }).click()
  await expect(editor.getByRole('alert')).toBeVisible()
  await editor.getByLabel('Outstanding debt').fill('-1,500.00')
  await expect(editor.getByText('Recorded as 1,500.00 USDT owed')).toBeVisible()
  await editor.getByRole('button', { name: 'Save account' }).click()
  await expect(editor).toHaveCount(0)

  const target = page.getByLabel('BTC target price')
  const external = page.locator('.plan-metrics .metric').filter({ hasText: 'External cash needed' })
  await button(page, 'Cash planner').click()
  await target.fill('45000')
  await expect(external.locator('.metric-value')).toHaveText('0.00 USDT')
  await button(page, 'Overview').click()
  await button(page, 'Simulate').click()
  await page.getByLabel('Price path').selectOption('Severe')
  await page.getByLabel('BTC scenario price').fill('45000')
  await expect(page.getByLabel('ETH scenario price')).toHaveValue('750')
  feed.btc = 62000
  const refresh = page.waitForResponse((r) => r.url().includes('/tickers') && r.ok())
  await page.clock.fastForward(45001)
  await refresh
  await button(page, 'Plan using this scenario').click()
  const assumptions = page.getByRole('region', { name: 'Plan assumptions' })
  await expect(assumptions.getByText('Frozen scenario quotes', { exact: true })).toBeVisible()
  await expect(assumptions.getByRole('listitem').filter({ hasText: 'ETH spot' })).toContainText('2,000.00 → 750.00')
  await expect(target).toHaveValue('45000')
  await expect(external.locator('.metric-value')).toHaveText('136.37 USDT')
  await target.fill('44000')
  await expect(external.locator('.metric-value')).toHaveText('287.88 USDT')
  await button(page, 'Back to scenario').click()
  await expect(page.getByLabel('BTC scenario price')).toHaveValue('45000')
  await page.getByLabel('ETH scenario price').fill('700')
  await button(page, 'Plan using this scenario').click()
  await target.fill('35000')
  await expect(external.locator('.metric-value')).toHaveText('227.28 USDT')
  await expect(assumptions).toContainText('ETH 700.00 USDT')
  await page.getByLabel('Language / 语言').selectOption('zh-CN')
  await expect(page.getByRole('region', { name: '方案假设' })).toContainText('手动目标价')
  await page.getByLabel('Language / 语言').selectOption('en')
  await saveNamed(page, 'Save plan', 'Frozen ETH override')
  await button(page, 'Back to scenario').click()
  await button(page, 'Cash planner').click()
  await expect(target).toHaveValue('45000')
  await expect(page.getByLabel('Altcoin path')).toHaveValue('Base')
  await expect(external.locator('.metric-value')).toHaveText('0.00 USDT')
  feed.online = false
  await page.reload()
  await expect(page.locator('.heading-line .tag')).toHaveText('Live')
  await expect(page.locator('.metric.equity .metric-value')).toHaveText('2,500.00 USDT')
  await button(page, 'Cash planner').click()
  await page.getByLabel('Load saved plan').selectOption({ label: 'Frozen ETH override' })
  await expect(target).toHaveValue('35000')
  await expect(external.locator('.metric-value')).toHaveText('227.28 USDT')
  await assumptions.getByRole('button', { name: 'Use live quotes and clear overrides' }).click()
  await expect(assumptions).toContainText('Estimated using last-known prices')
})

test('saved funding plans can be edited, copied, overwritten by name and deleted with confirmation', async ({
  page,
  context,
}) => {
  await market(context)
  await page.goto('/')
  await addAccount(page, 'Loan 1', 'loan')
  await button(page, 'Cash planner').click()
  const target = page.getByLabel('BTC target price')
  const plans = page.getByLabel('Load saved plan')
  const dialog = page.getByRole('dialog')
  const name = dialog.getByLabel('Name', { exact: true })
  const submit = dialog.getByRole('button', { name: 'Save', exact: true })
  await target.fill('35000')
  await saveNamed(page, 'Save plan', 'Selloff')
  const before = await exported(page)
  const planId = before.plans[0].id

  await target.fill('34000')
  await button(page, 'Accounts').click()
  await button(page, 'Cash planner').click()
  await expect(target).toHaveValue('34000')
  await expect(plans).toHaveValue(planId)
  await button(page, 'Save changes').click()
  await expect(name).toHaveValue('Selloff')
  await name.fill('Lower target')
  await submit.click()
  await expect(dialog).toHaveCount(0)
  expect((await exported(page)).plans).toEqual([
    { ...before.plans[0], name: 'Lower target', data: { ...before.plans[0].data, target: '34000' } },
  ])
  await saveNamed(page, 'Save as', 'Reserve')
  const renamed = await exported(page)
  expect(renamed.plans).toHaveLength(2)

  await button(page, 'New plan').click()
  await target.fill('31000')
  await button(page, 'Save plan').click()
  await name.fill(' lower TARGET ')
  await submit.click()
  const overwrite = page.getByRole('dialog', { name: 'Overwrite saved plan?' })
  await expect(overwrite).toContainText('Lower target')
  await overwrite.getByRole('button', { name: 'Cancel' }).click()
  await expect(name).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  expect((await exported(page)).plans).toEqual(renamed.plans)

  await button(page, 'Save plan').click()
  await name.fill('Lower target')
  await submit.click()
  await overwrite.getByRole('button', { name: 'Overwrite', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await target.fill('30000')
  await button(page, 'Save changes').click()
  await expect(name).toHaveValue('Lower target')
  await submit.click()
  await overwrite.getByRole('button', { name: 'Overwrite', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const updated = await exported(page)
  expect(updated.plans).toHaveLength(2)
  expect(updated.plans).toContainEqual(expect.objectContaining({
    id: planId, name: 'Lower target', data: expect.objectContaining({ target: '30000' }),
  }))
  const copy = renamed.plans.find((p: { name: string }) => p.name === 'Reserve')
  expect(updated.plans).toContainEqual(copy)

  await page.reload()
  await expect(page.locator('.heading-line .tag')).toHaveText('Live')
  await button(page, 'Cash planner').click()
  await plans.selectOption({ label: 'Lower target' })
  await expect(target).toHaveValue('30000')
  const other = await context.newPage()
  await other.goto('/')
  await button(other, 'Cash planner').click()
  await other.getByLabel('Load saved plan').selectOption(planId)
  await other.getByLabel('BTC target price').fill('29000')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('Language / 语言').selectOption('zh-CN')
  const remove = button(page, '删除方案')
  await expect(remove).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  const confirm = page.getByRole('dialog', { name: '删除已存方案？' })
  await remove.click()
  await expect(confirm).toContainText('Lower target')
  await expect(confirm.getByRole('button', { name: '确认删除' })).toBeInViewport({ ratio: 1 })
  await confirm.getByRole('button', { name: '取消' }).click()
  await expect(page.getByLabel('载入已存方案').getByRole('option', { name: 'Lower target' })).toHaveCount(1)
  await remove.click()
  await confirm.getByRole('button', { name: '确认删除' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(button(other, '保存修改')).toBeDisabled()
  await expect(other.getByLabel('BTC 目标价')).toHaveValue('29000')
  await other.close()
  await page.reload()
  await page.getByLabel('Language / 语言').selectOption('en')
  const after = await exported(page)
  expect(after.plans).toEqual([copy])
  expect(after.accounts).toEqual(before.accounts)
  expect(after.lastBalanceEdit).toBe(before.lastBalanceEdit)
})

test('renaming a frozen plan onto a legacy duplicate overwrites only the chosen record', async ({
  page,
  context,
}) => {
  await market(context)
  await page.goto('/')
  await addAccount(page, 'Legacy loan', 'loan')
  const backup = await exported(page)
  const first = { id: 'one', name: 'Legacy', data: { target: '35000', path: 'Base' } }
  const second = { id: 'two', name: 'Legacy', data: { target: '45000', path: 'Severe' } }
  const snapshot = {
    book: { spot: { BTC: '55000' }, mark: {}, loan: { BTC: '55100' } },
    overrides: {}, asOf: '2026-01-01T12:00:00Z',
  }
  const source = { id: 'three', name: 'Frozen', data: { target: '39000', path: 'Base', snapshot } }
  const settingsDialog = await settings(page)
  await settingsDialog.getByLabel('Select JSON backup').setInputFiles({
    name: 'old-plans.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...backup, plans: [first, second, source] })),
  })
  await button(page, 'Import backup').click()
  await expect(settingsDialog).toHaveCount(0)
  await button(page, 'Cash planner').click()
  await page.getByLabel('Load saved plan').selectOption(source.id)
  await page.getByLabel('BTC target price').fill('37000')
  await button(page, 'Save changes').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name', { exact: true }).fill('Legacy')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  const choice = dialog.getByLabel('Plan to overwrite')
  await expect(choice).toBeVisible()
  const overwrite = dialog.getByRole('button', { name: 'Overwrite', exact: true })
  await expect(overwrite).toBeDisabled()
  await choice.selectOption(second.id)
  await expect(dialog).toContainText('Frozen')
  await overwrite.click()
  await expect(dialog).toHaveCount(0)
  const saved = await exported(page)
  expect(saved.plans).toHaveLength(2)
  expect(saved.plans).toContainEqual(first)
  expect(saved.plans).toContainEqual(expect.objectContaining({
    id: second.id, name: 'Legacy', data: expect.objectContaining({ target: '37000', snapshot }),
  }))
})

test('pending limit orders revalue the dashboard without changing real accounts, scenarios or cash plans', async ({
  page,
  context,
}) => {
  await market(context)
  await page.goto('/')
  await addAccount(page, 'Margin reserve')
  await addAccount(page, 'Isolated long', 'perp')
  const before = await exported(page)
  const panel = page.getByRole('region', { name: 'Pending orders' })
  const accountRows = page.locator('.account-list')
  const equity = page.locator('.metrics .metric.equity .metric-value')
  const debt = page
    .locator('.metrics .metric')
    .filter({ hasText: 'Total debt' })
    .locator('.metric-value')
  const previewTag = page.locator('.heading-line .tag')
  await expect(equity).toHaveText('27,000.00 USDT')

  // LINK trades at 10; 2 bought at 8 with a 1.25 USDT fee require borrowing 17.25.
  await panel.getByRole('button', { name: 'Add limit order' }).click()
  const addOrder = page.getByRole('dialog', { name: 'Add limit order' })
  await addOrder
    .getByRole('combobox', { name: 'Account', exact: true })
    .selectOption(before.accounts[0].id)
  await addOrder.getByLabel('Asset', { exact: true }).fill('LINK')
  await addOrder.getByLabel('Quantity', { exact: true }).fill('2')
  await addOrder.getByLabel('Limit price', { exact: true }).fill('8')
  await addOrder.getByLabel('Fee (USDT)', { exact: true }).fill('1.25')
  await addOrder.getByRole('button', { name: 'Save order' }).click()
  const spotOrder = panel.getByRole('checkbox', { name: /^Assume filled.*Margin reserve/ })
  await expect(spotOrder).not.toBeChecked()
  await spotOrder.check()
  await expect(panel.getByRole('status')).toContainText('Insufficient USDT')
  await expect(equity).toHaveText('27,000.00 USDT')
  await panel.getByRole('button', { name: /^Edit order.*Margin reserve/ }).click()
  const editOrder = page.getByRole('dialog', { name: 'Edit limit order' })
  await editOrder.getByLabel('Borrow missing USDT').check()
  await editOrder.getByRole('button', { name: 'Save order' }).click()
  await expect(previewTag).toHaveText('Fill preview')
  await expect(equity).toHaveText('27,002.75 USDT')
  await expect(debt).toHaveText('35,017.25 USDT')
  const editor = await editAccount(page, 'Margin reserve')
  await expect(editor.getByLabel('Quantity', { exact: true })).toHaveCount(1)
  await expect(editor.getByLabel('Outstanding debt')).toHaveValue('35000')
  await editor.getByRole('button', { name: 'Cancel' }).click()
  const spotTable = accountRows.getByRole('table', { name: 'Holdings in Margin reserve' })
  await expect(spotTable.getByRole('row').filter({ hasText: 'LINK' }).getByRole('cell')).toHaveText([
    'LINK',
    '2',
    '10.00',
    '20.00',
  ])

  // Close 0.04 BTC at 62,000 from the account shortcut. Keep the realized 80 less the 2 USDT fee.
  const long = accountRows
    .locator('.record')
    .filter({ has: page.getByText('Isolated long', { exact: true }) })
  await long.locator('.record-main').click()
  await long.getByRole('button', { name: 'Add limit order' }).click()
  await expect(addOrder.getByRole('combobox', { name: 'Account', exact: true })).toHaveValue(
    before.accounts[1].id,
  )
  await expect(addOrder.getByLabel('Asset', { exact: true })).toHaveValue('BTC')
  await addOrder.getByRole('combobox', { name: 'Side', exact: true }).selectOption('sell')
  await addOrder.getByLabel('Quantity', { exact: true }).fill('0.04')
  await addOrder.getByLabel('Limit price', { exact: true }).fill('62000')
  await addOrder.getByLabel('Fee (USDT)', { exact: true }).fill('2')
  await addOrder.getByRole('button', { name: 'Save order' }).click()
  const perpOrder = panel.getByRole('checkbox', { name: /^Assume filled.*Isolated long/ })
  await perpOrder.check()
  await expect(equity).toHaveText('27,080.75 USDT')
  await expect(long).toContainText('0.06 BTC')
  await expect(long.getByText('Allocated margin', { exact: true }).locator('+ dd')).toHaveText(
    '2078 USDT',
  )
  await spotOrder.uncheck()
  await expect(equity).toHaveText('27,078.00 USDT')
  await expect(debt).toHaveText('35,000.00 USDT')
  await spotOrder.check()
  const withOrders = await exported(page)
  expect(withOrders.accounts).toEqual(before.accounts)
  expect(withOrders.lastBalanceEdit).toBe(before.lastBalanceEdit)
  expect(withOrders.pendingOrders).toHaveLength(2)

  await button(page, 'Cash planner').click()
  await page.getByLabel('BTC target price').fill('35000')
  const planned = page
    .locator('.fund-action')
    .filter({ has: page.getByRole('heading', { name: 'Margin reserve' }) })
  await expect(planned.getByText('Required transfer', { exact: true }).locator('+ dd')).toHaveText(
    '3,181.82 USDT',
  )
  await button(page, 'Back to fill preview').click()
  await expect(equity).toHaveText('27,080.75 USDT')
  await button(page, 'Simulate').click()
  await expect(
    page.locator('.comparison-row').filter({ hasText: 'Net equity' }).locator('b'),
  ).toHaveText(['27,000.00 USDT', '27,000.00 USDT'])
  await button(page, 'Return to Live').click()
  await spotOrder.check()
  await perpOrder.check()
  await panel.getByRole('button', { name: 'Clear fill assumptions' }).click()
  await expect(panel.getByRole('checkbox', { checked: true })).toHaveCount(0)
  await expect(equity).toHaveText('27,000.00 USDT')
  await spotOrder.check()
  await page.reload()
  await expect(previewTag).toHaveText('Live')
  await expect(spotOrder).not.toBeChecked()
  await expect(perpOrder).not.toBeChecked()
  await expect(equity).toHaveText('27,000.00 USDT')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('Language / 语言').selectOption('zh-CN')
  const cn = page.getByRole('region', { name: '挂单', exact: true })
  await cn.getByRole('checkbox', { name: /假设成交.*Margin reserve/ }).check()
  await expect(previewTag).toHaveText('挂单成交试算')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await cn.getByRole('button', { name: '删除列表挂单' }).click()
  const confirm = page.getByRole('dialog', { name: '删除挂单？' })
  await confirm.getByRole('button', { name: '取消' }).click()
  await expect(cn.getByRole('checkbox')).toHaveCount(2)
  await cn.getByRole('button', { name: '删除列表挂单' }).click()
  await confirm.getByRole('button', { name: '删除挂单', exact: true }).click()
  await expect(cn.getByRole('checkbox')).toHaveCount(0)
  await expect(previewTag).toHaveText('实时')
  await page.getByLabel('Language / 语言').selectOption('en')
  await page.reload()
  const after = await exported(page)
  expect(after.accounts).toEqual(before.accounts)
  expect(after.lastBalanceEdit).toBe(before.lastBalanceEdit)
  expect(after.pendingOrders ?? []).toHaveLength(0)
})

test('overselling blocks every selected fill in that account until the invalid order is deleted', async ({
  page, context,
}) => {
  await market(context)
  await page.goto('/')
  await addAccount(page, 'Margin reserve')
  const panel = page.getByRole('region', { name: 'Pending orders' })
  const editor = page.getByRole('dialog', { name: 'Add limit order' })
  const submit = editor.getByRole('button', { name: 'Save order' })
  const debt = page.locator('.metric').filter({ hasText: 'Total debt' }).locator('.metric-value')
  const equity = page.locator('.metric.equity .metric-value')
  const before = await exported(page)
  await panel.getByRole('button', { name: 'Add limit order' }).click()
  await editor.getByLabel('Side', { exact: true }).selectOption('sell')
  await editor.getByLabel('Asset', { exact: true }).fill('USDT')
  await submit.click()
  await expect(editor.getByRole('alert')).toHaveText('Enter a base asset for the USDT pair.')
  await editor.getByLabel('Asset', { exact: true }).fill('btc')
  await editor.getByLabel('Quantity', { exact: true }).fill('0.25')
  await editor.getByLabel('Limit price').fill('0')
  await submit.click()
  await expect(editor.getByRole('alert')).toHaveText('Enter a positive quantity and limit price.')
  await editor.getByLabel('Limit price').fill('62000')
  await editor.getByLabel('Fee (USDT)').fill('-5')
  await submit.click()
  await expect(editor.getByRole('alert')).toHaveText('Enter a nonnegative fee in USDT.')
  await editor.getByLabel('Fee (USDT)').fill('5')
  await editor.getByLabel('Repay USDT debt').check()
  await submit.click()

  const sale = panel.getByRole('listitem').filter({ hasText: '0.25 BTC' })
  await sale.getByRole('checkbox').check()
  // The sale repays 0.25 × 62,000 less the 5 USDT fee, leaving 0.75 BTC.
  await expect(debt).toHaveText('19,505.00 USDT')
  await expect(equity).toHaveText('25,495.00 USDT')
  await panel.getByRole('button', { name: 'Add limit order' }).click()
  await editor.getByLabel('Side', { exact: true }).selectOption('sell')
  await editor.getByLabel('Asset', { exact: true }).fill('BTC')
  await editor.getByLabel('Quantity', { exact: true }).fill('0.8')
  await editor.getByLabel('Limit price').fill('62000')
  await submit.click()
  const excess = panel.getByRole('listitem').filter({ hasText: '0.8 BTC' })
  await excess.getByRole('checkbox').check()
  await expect(excess.getByRole('status')).toContainText('sell quantity exceeds the available holding')
  await expect(sale.getByText('Account preview blocked')).toBeVisible()
  await expect(debt).toHaveText('35,000.00 USDT')
  await expect(equity).toHaveText('25,000.00 USDT')

  await excess.getByRole('button', { name: /^Delete order/ }).click()
  const confirmation = page.getByRole('dialog', { name: 'Delete pending orders?' })
  await expect(confirmation).toContainText('Delete 1 saved order')
  await confirmation.getByRole('button', { name: 'Delete orders' }).click()
  await expect(excess).toHaveCount(0)
  await expect(sale.getByText('Assumed filled')).toBeVisible()
  await expect(debt).toHaveText('19,505.00 USDT')
  await page.reload()
  await expect(sale.getByRole('checkbox')).not.toBeChecked()
  await expect(debt).toHaveText('35,000.00 USDT')
  const after = await exported(page)
  expect(after.accounts).toEqual(before.accounts)
  expect(after.pendingOrders).toHaveLength(1)
  expect(after.pendingOrders[0]).toMatchObject({ side: 'sell', quantity: '0.25', feeUsdt: '5', autoRepay: true })
})

test('switching perpetual contracts clears old tiers and allows manual terms when lookup fails', async ({
  page, context,
}) => {
  await market(context)
  await page.goto('/')
  await addAccount(page, 'Isolated hedge', 'perp')
  const editor = await editAccount(page, 'Isolated hedge')
  await expect(editor.getByText(/maintenance tiers.*BTC\/USDT/)).toBeVisible()
  await editor.getByLabel('Contract asset').fill('ETH')
  await expect(editor.getByLabel('Maintenance rate')).toHaveValue('')
  await expect(editor.getByLabel('Closing taker fee')).toHaveValue('')
  await page.route(/\/query-position-lever\?/, (route) =>
    route.fulfill({ json: { code: '00000', requestTime: Date.now(), data: [] } }),
  )
  await editor.getByRole('button', { name: 'Load Bitget terms' }).click()
  await expect(editor.getByRole('status')).toContainText('Bitget contract settings unavailable.')
  await editor.getByLabel('Direction').selectOption('short')
  await editor.getByLabel('Position size').fill('2')
  await editor.getByLabel('Entry price').fill('2100')
  await editor.getByLabel('Allocated isolated margin').fill('600')
  await editor.getByLabel('Maintenance rate').fill('1')
  await editor.getByLabel('Maintenance offset').fill('2')
  await editor.getByLabel('Closing taker fee').fill('0.1')
  await editor.getByRole('button', { name: 'Save account' }).click()
  await expect(editor).toHaveCount(0)
  await page.reload()
  // At the 2,000 mark: 600 + (2,100 - 2,000) × 2 = 800 equity; (4,000 × 1.1%) - 2 = 42 maintenance.
  await expect(page.locator('.metric.equity .metric-value')).toHaveText('800.00 USDT')
  const row = page.locator('.record').filter({ has: page.getByText('Isolated hedge', { exact: true }) })
  await row.locator('.record-main').click()
  await expect(row.getByText('Maintenance + close fee', { exact: true }).locator('+ dd')).toHaveText('42.00 USDT')
  const backup = await exported(page)
  expect(backup.accounts).toHaveLength(1)
  expect(backup.accounts[0]).toMatchObject({
    asset: 'ETH', side: 'short', maintenanceRate: '0.01', maintenanceOffset: '2', takerFee: '0.001',
  })
  expect(backup.accounts[0].tiers).toBeUndefined()
})

test('a liquidated isolated position contributes zero at every lower scenario price', async ({
  page,
  context,
}) => {
  await market(context)
  await page.goto('/')
  await addAccount(page, 'BTC long', 'perp')
  await button(page, 'Add account').first().click()
  const editor = page.getByRole('dialog')
  await editor.getByRole('button', { name: 'Spot wallet', exact: true }).click()
  await editor.getByLabel('Account name').fill('Cash reserve')
  await editor.getByLabel('Asset', { exact: true }).fill('USDT')
  await editor.getByLabel('Quantity', { exact: true }).fill('300')
  await editor.getByRole('button', { name: 'Save account' }).click()
  await expect(editor).toHaveCount(0)
  const before = await exported(page)

  await button(page, 'Simulate').click()
  const position = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'BTC long' }) })
  const reserve = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Cash reserve' }) })
  const equity = page.locator('.comparison-row').filter({ hasText: 'Net equity' }).locator('b')
  const leverage = page.locator('.comparison-row').filter({ hasText: 'Effective leverage' }).locator('b')
  const price = page.getByLabel('BTC scenario price')
  await price.fill('40200')
  await expect(position.getByRole('cell')).toHaveText(['BTC long', '2,000.00', '20.00', 'Warning'])
  await expect(equity).toHaveText(['2,300.00 USDT', '320.00 USDT'])
  await expect(leverage).toHaveText(['3.00×', '201.00×'])

  // 40,150 breaches maintenance with positive mark-to-market equity; 35,000 would make it negative.
  for (const mark of ['40150', '35000']) {
    await price.fill(mark)
    await expect(position.getByRole('cell')).toHaveText(['BTC long', '2,000.00', '0.00', 'Liquidated', '18.49'])
    await expect(reserve.getByRole('cell')).toHaveText(['Cash reserve', '300.00', '300.00', 'Unleveraged', '—'])
    await expect(equity).toHaveText(['2,300.00 USDT', '300.00 USDT'])
    await expect(leverage).toHaveText(['3.00×', '—'])
  }
  await page.getByLabel('Language / 语言').selectOption('zh-CN')
  await expect(position.getByRole('cell').nth(3)).toHaveText('已强平')
  await page.getByLabel('Language / 语言').selectOption('en')
  await button(page, 'Reset scenario').click()
  await expect(position.getByRole('cell')).toHaveText(['BTC long', '2,000.00', '2,000.00', 'Safe'])
  await expect(equity).toHaveText(['2,300.00 USDT', '2,300.00 USDT'])
  await button(page, 'Return to Live').click()
  await expect(page.locator('.metric.equity .metric-value')).toContainText('2,300.00')
  await expect(page.locator('.metric').filter({ hasText: 'Effective leverage' }).locator('.metric-value')).toHaveText('3.00×')
  const after = await exported(page)
  expect(after.accounts).toEqual(before.accounts)
  expect(after.lastBalanceEdit).toEqual(before.lastBalanceEdit)
})

test('the Severe path shows the SOL loan first and preserves its equity at trigger after prices fall further', async ({
  page,
  context,
}) => {
  await market(context)
  await page.goto('/')
  for (const [asset, debt] of [['BTC', '49,140.00'], ['SOL', '-72.80']]) {
    await button(page, /^(Add your first account|Add account)$/).first().click()
    const editor = page.getByRole('dialog')
    await editor.getByRole('button', { name: 'Crypto loan' }).click()
    await editor.getByLabel('Account name').fill(asset + ' loan')
    await editor.getByLabel('Collateral asset').fill(asset)
    await editor.getByLabel('Pledged quantity').fill('1')
    await editor.getByLabel('Outstanding loan debt').fill(debt)
    await editor.getByRole('button', { name: 'Save account' }).click()
    await expect(editor).toHaveCount(0)
  }
  await button(page, 'Simulate').click()
  await page.getByLabel('Price path').selectOption('Severe')
  const btc = page.getByLabel('BTC scenario price')
  await btc.fill('59400')
  const liquidation = page.locator('.comparison-row').filter({ has: page.getByText('Liquidation', { exact: true }) })
  await expect(liquidation).toContainText(/triggered during this move\s*None/i)
  await expect(liquidation).toContainText(/Next if BTC keeps falling.*SOL loan.*56,000.*80/s)
  const sol = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'SOL loan', exact: true }) })
  for (const target of ['56000', '55000']) {
    await btc.fill(target)
    await expect(liquidation).toContainText(/triggered during this move.*SOL loan.*56,000/is)
    await expect(sol.getByRole('cell').nth(2)).toHaveText('0.00')
    await expect(sol.getByRole('cell').last()).toHaveText('7.20')
    await expect(page.getByText(/actual settlement is unknown/i)).toBeVisible()
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('Language / 语言').selectOption('zh-CN')
  await expect(page.getByRole('columnheader', { name: /强平.*权益/ })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('saved scenarios can be reopened directly from the simulation with their frozen reference prices', async ({
  page,
  context,
}) => {
  const feed = await market(context)
  await page.goto('/')
  await addAccount(page, 'BTC reserve')
  await expect(page.locator('.metric.equity .metric-value')).toContainText('25,000.00')
  const original = await exported(page)

  await button(page, 'Simulate').click()
  const load = button(page, 'Load scenario')
  await expect(load).toHaveText('Load scenario')
  await load.click()
  const library = page.getByRole('dialog', { name: 'Saved scenarios' })
  await expect(library).toContainText('No saved scenarios yet.')
  await library.press('Escape')
  await expect(library).toHaveCount(0)

  await page.getByLabel('Price path').selectOption('Base')
  await page.getByLabel('BTC scenario price').fill('45000')
  await saveNamed(page, 'Save scenario', '45k 压力测试')
  await button(page, 'Reset scenario').click()
  await expect(page.getByLabel('BTC scenario price')).toHaveValue('60000')
  await load.click()
  await library.getByRole('button', { name: '45k 压力测试', exact: true }).click()
  await expect(library).toHaveCount(0)
  await expect(page.getByLabel('BTC scenario price')).toHaveValue('45000')
  await expect(page.getByLabel('Price path')).toHaveValue('Base')

  feed.btc = 62000
  await button(page, 'Return to Live').click()
  await button(page, 'Refresh').click()
  await expect(page.locator('.metric.equity .metric-value')).toContainText('27,000.00')
  await button(page, 'Simulate').click()
  await expect(page.getByLabel('BTC scenario price')).toHaveValue('62000')
  await saveNamed(page, 'Save scenario', '62k market')

  await page.setViewportSize({ width: 390, height: 844 })
  const language = page.getByLabel('Language / 语言')
  await language.selectOption('zh-CN')
  const loadChinese = button(page, '载入情景')
  await expect(loadChinese).toHaveText('载入情景')
  await loadChinese.click()
  const chineseLibrary = page.getByRole('dialog', { name: '已保存的情景' })
  await expect(chineseLibrary.getByRole('button', { name: '62k market', exact: true })).toBeVisible()
  await chineseLibrary.getByRole('button', { name: '45k 压力测试', exact: true }).click()
  await expect(page.getByLabel('BTC 情景价格')).toHaveValue('45000')
  await expect(page.getByLabel('价格路径')).toHaveValue('Base')
  await language.selectOption('en')
  await expect(page.getByLabel('BTC percentage change')).toHaveValue('-25')
  const comparison = page.locator('.comparison-row').filter({ hasText: 'Net equity' })
  await expect(comparison.locator('b')).toHaveText(['27,000.00 USDT', '10,000.00 USDT'])
  await page.reload()
  await expect(page.locator('.heading-line .tag')).toHaveText('Live')
  await expect(load).toHaveText('Load scenario')
  const after = await exported(page)
  expect(after.accounts).toEqual(original.accounts)
  expect(after.lastBalanceEdit).toEqual(original.lastBalanceEdit)
})

test('clear cancel preserves full backup, confirm invalidates an open editor, import restores explicitly', async ({
  page,
  context,
}) => {
  await market(context)
  await page.goto('/')
  await addAccount(page, 'Original cross')
  await addAccount(page, 'Archived loan', 'loan')
  await (await editAccount(page, 'Archived loan'))
    .getByRole('button', { name: 'Archive', exact: true })
    .click()
  await expect(page.locator('.record-name b')).toHaveText(['Original cross'])
  await button(page, 'Simulate').click()
  await saveNamed(page, 'Save scenario', 'Original scenario')
  await button(page, 'Cash planner').click()
  await page.getByLabel('BTC target price').fill('35000')
  await saveNamed(page, 'Save plan', 'Original target')
  const backup = await exported(page)
  expect(backup.accounts).toHaveLength(2)
  expect(backup.accounts.find((a: { name: string }) => a.name === 'Archived loan').archived).toBe(true)
  expect(backup.scenarios).toHaveLength(1)
  expect(backup.plans).toHaveLength(1)
  await (await settings(page)).getByRole('button', { name: 'Clear all portfolio data' }).click()
  const confirmation = page.getByRole('dialog', { name: 'Clear all portfolio data?' })
  await expect(confirmation).toContainText(
    /archived accounts, positions, loans, saved scenarios and target plans/,
  )
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
  await button(page, 'Close Portfolio settings').click()
  expect(await exported(page)).toEqual(backup)
  const old = await context.newPage()
  await old.goto('/')
  await (await editAccount(old, 'Original cross')).getByLabel('Quantity', { exact: true }).fill('999')
  await (await settings(page)).getByRole('button', { name: 'Clear all portfolio data' }).click()
  await button(page, 'Confirm clear all').click()
  await emptyLive(page)
  await emptyLive(old)
  await expect(old.getByRole('dialog')).toHaveCount(0)
  await page.reload()
  await emptyLive(page)
  await page.close()
  const reopened = await context.newPage()
  await reopened.goto('/')
  await emptyLive(reopened)
  const cleared = await exported(reopened)
  expect(cleared.accounts).toEqual([])
  expect(cleared.scenarios).toEqual([])
  expect(cleared.plans).toEqual([])
  await addAccount(reopened, 'New isolated position', 'perp')
  await old.reload()
  await expect(old.locator('.record-name b')).toHaveText(['New isolated position'])
  const latest = await exported(old)
  expect(latest.accounts.map((a: { name: string }) => a.name)).toEqual(['New isolated position'])
  // Only a user-selected, confirmed import can restore the historical backup.
  const dialog = await settings(reopened)
  const chooser = reopened.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'Import JSON' }).click()
  await (await chooser).setFiles({
    name: 'incomplete.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"accounts":'),
  })
  await expect(dialog.getByRole('alert')).toHaveText('The selected file does not contain valid JSON.')
  await expect(old.locator('.record-name b')).toHaveText(['New isolated position'])
  await dialog.getByLabel('Select JSON backup').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  })
  await button(reopened, 'Import backup').click()
  await expect(reopened.locator('.record-name b')).toHaveText(['Original cross'])
  const restored = await exported(reopened)
  expect(restored.accounts).toEqual(backup.accounts)
  expect(restored.scenarios).toEqual(backup.scenarios)
  expect(restored.plans).toEqual(backup.plans)
  const archives = await settings(reopened)
  await archives.getByRole('button', { name: 'Restore Archived loan' }).click()
  await expect(archives.getByText('No archived accounts')).toBeVisible()
  await button(reopened, 'Close Portfolio settings').click()
  await reopened.reload()
  await expect(reopened.locator('.record-name b')).toHaveText(['Original cross', 'Archived loan'])
  const reactivated = (await exported(reopened)).accounts.find((a: { name: string }) => a.name === 'Archived loan')
  const originalLoan = backup.accounts.find((a: { name: string }) => a.name === 'Archived loan')
  expect(reactivated).toMatchObject({
    id: originalLoan.id, asset: originalLoan.asset, archived: false,
    collateral: originalLoan.collateral, debt: originalLoan.debt,
  })
})

test('closing the browser process keeps IndexedDB holdings and discards the active simulation', async ({
  playwright,
  baseURL,
}, testInfo) => {
  const profile = testInfo.outputPath('browser-profile')
  const open = async () => {
    const context = await playwright.chromium.launchPersistentContext(profile, {
      baseURL,
      headless: true,
    })
    await trackCoverage(context)
    await market(context)
    const page = context.pages()[0]
    await page.goto('/')
    return { context, page }
  }
  const first = await open()
  try {
    await addAccount(first.page, 'Restart portfolio')
    const dialog = await editAccount(first.page, 'Restart portfolio')
    await dialog.getByLabel('Quantity', { exact: true }).fill('0.1234500001')
    await dialog.getByRole('button', { name: 'Save account' }).click()
    await expect(dialog).toHaveCount(0)
    await button(first.page, 'Simulate').click()
    await first.page.getByLabel('BTC scenario price').fill('44000')
  } finally {
    await flushCoverage(first.context)
    await first.context.close()
  }
  const next = await open()
  try {
    await expect(next.page.getByRole('heading', { name: 'Portfolio overview' })).toBeVisible()
    await expect(next.page.locator('.record-name b')).toHaveText(['Restart portfolio'])
    const saved = await editAccount(next.page, 'Restart portfolio')
    await expect(saved.getByLabel('Quantity', { exact: true })).toHaveValue('0.1234500001')
  } finally {
    await flushCoverage(next.context)
    await next.context.close()
  }
})

test('language switches in place across charts, scenarios and plans, and persists on reload', async ({
  page,
  context,
}) => {
  await market(context)
  await page.goto('/')
  const languages = page.getByRole('combobox', { name: 'Language / 语言' })
  await languages.selectOption('zh-CN')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page).toHaveTitle('2029 · Bitget 投资组合')
  await expect(page.getByRole('heading', { name: '投资组合概览' })).toBeVisible()
  await expect(button(page, '添加第一个账户')).toBeVisible()
  await expect(page.getByRole('img', { name: /BTC\/USDT.*K 线/ })).toBeVisible()

  await button(page, '选择图表交易对').click()
  await page.getByLabel('搜索币种代码或名称').fill('以太坊')
  await button(page, /ETH \/ USDT/).click()
  await expect(button(page, '选择图表交易对')).toContainText('ETH')
  await button(page, '模拟').click()
  await page.getByLabel('价格路径').selectOption({ label: '与 BTC 联动（基础）' })
  await page.getByLabel('BTC 情景价格').fill('44000')
  await languages.selectOption('en')
  await expect(page.getByLabel('Price path')).toHaveValue('Base')
  await expect(page.getByLabel('BTC scenario price')).toHaveValue('44000')
  await button(page, 'Cash planner').click()
  await page.getByLabel('BTC target price').fill('35000')
  await languages.selectOption('zh-CN')
  await expect(page.getByLabel('BTC 目标价')).toHaveValue('35000')
  await button(page, '返回情景模拟').click()
  await expect(page.getByLabel('BTC 情景价格')).toHaveValue('44000')

  await page.reload()
  await expect(languages).toHaveValue('zh-CN')
  await expect(page.getByRole('heading', { name: '投资组合概览' })).toBeVisible()
  await expect(page.locator('.heading-line .tag')).toHaveText('实时')
  await page.setViewportSize({ width: 320, height: 740 })
  await expect(languages).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  await languages.selectOption('en')
  await expect(button(page, 'Add your first account')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
})

test('changing language preserves open form edits and user names, and localizes backup and clear confirmations', async ({
  page,
  context,
}) => {
  await market(context)
  await page.goto('/')
  await addAccount(page, 'Live · 我的 BTC')
  const editor = await editAccount(page, 'Live · 我的 BTC')
  await editor.getByLabel('Quantity', { exact: true }).fill('2.025')
  const other = await context.newPage()
  await other.goto('/')
  await other.getByLabel('Language / 语言').selectOption('zh-CN')
  const chineseEditor = page.getByRole('dialog', { name: '编辑账户' })
  await expect(chineseEditor.getByLabel('账户名称')).toHaveValue('Live · 我的 BTC')
  await expect(chineseEditor.getByLabel('数量', { exact: true })).toHaveValue('2.025')
  await chineseEditor.getByRole('button', { name: '保存账户' }).click()

  await button(page, '投资组合设置').click()
  const backup = page.getByRole('dialog', { name: '投资组合设置' })
  await expect(backup.getByRole('button', { name: '导出 JSON' })).toBeVisible()
  await backup
    .getByLabel('选择 JSON 备份')
    .setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{') })
  await expect(backup.getByRole('alert')).toContainText('JSON')
  await expect(backup.getByRole('alert')).toContainText(/[\u4e00-\u9fff]/)
  await backup.getByRole('button', { name: '清除全部投资组合数据' }).click()
  const confirm = page.getByRole('dialog', { name: '清除全部投资组合数据？' })
  await expect(confirm.getByRole('button', { name: '确认全部清除' })).toBeVisible()
  await confirm.getByRole('button', { name: '取消' }).click()
  await backup.press('Escape')
  await page.getByLabel('Language / 语言').selectOption('en')
  const restored = await exported(page)
  expect(restored.accounts).toHaveLength(1)
  expect(restored.accounts[0]).toMatchObject({
    name: 'Live · 我的 BTC',
    kind: 'spot',
    holdings: [{ asset: 'BTC', quantity: '2.025' }],
  })
})

test('target badges separate current coverage, planned transfers, funding shortfalls and unknown prices', async ({
  page,
  context,
}) => {
  await market(context)
  await page.goto('/')
  for (const [kind, name, field, value] of [
    ['spot', 'Cross margin', 'Outstanding debt', '32214.27'],
    ['loan', 'BTC loan', 'Outstanding loan debt', '30000'],
    ['perp', 'BTC perpetual', 'Allocated isolated margin', '2436.21'],
  ] as const) {
    await addAccount(page, name, kind)
    const editor = await editAccount(page, name)
    await editor.getByLabel(field).fill(value)
    await editor.getByRole('button', { name: 'Save account' }).click()
    await expect(editor).toHaveCount(0)
  }
  await button(page, 'Cash planner').click()
  const target = page.getByLabel('BTC target price')
  await target.fill('35000')
  const budget = page.getByLabel('Cash budget')
  await expect(budget).toHaveValue('')
  const action = (name: string) =>
    page.locator('.fund-action').filter({ has: page.getByRole('heading', { name, exact: true }) })
  const spot = action('Cross margin')
  const loan = action('BTC loan')
  const perp = action('BTC perpetual')
  const required = (row: Locator) => row.getByText('Required transfer', { exact: true }).locator('+ dd')
  const shortfalls = page.locator('.fund-action .fund-shortfall')
  const totalShortfall = page.locator('.plan-metrics .metric').filter({ hasText: 'Still needed' })
  const buffer = page.getByLabel('Safety buffer')
  const stressPrice = page.getByText(/BTC stress price/)
  const covered = page.locator('details.covered-accounts')
  const toggle = covered.locator('summary')
  const visibleNames = page.locator('.fund-action:visible h3')
  await expect(toggle).toHaveText('No funding needed (1)')
  await expect(visibleNames).toHaveText(['Cross margin', 'BTC perpetual'])
  await toggle.focus()
  await toggle.press('Enter')
  await expect(loan).toBeVisible()
  await expect(stressPrice).toHaveCount(0)
  await buffer.fill('5')
  await expect(stressPrice).toHaveText('BTC stress price 33,250.00 USDT')
  await buffer.fill('0')
  await expect(stressPrice).toHaveCount(0)
  await expect(required(spot)).toHaveText('396.09 USDT')
  await expect(required(perp)).toHaveText('79.90 USDT')
  await expect(required(loan)).toHaveText('0.00 USDT')
  await expect(
    page
      .locator('.fund-action dt')
      .filter({ hasText: /Remaining after planned funding|Buffered BTC target/ }),
  ).toHaveCount(0)
  await expect(shortfalls).toHaveCount(0)
  await expect(totalShortfall).toHaveCount(0)
  await expect(spot.locator('.tag.warm')).toHaveText('Funding required')
  await expect(perp.locator('.tag.warm')).toHaveText('Funding required')
  await expect(loan.locator('.tag.green')).toHaveText('No funding needed')

  await budget.fill('400')
  await expect(spot.locator('.tag.warm')).toHaveText('Funding required')
  await expect(perp.locator('.tag.danger')).toHaveText('Funding shortfall')
  await expect(shortfalls).toHaveCount(1)
  await expect(perp.locator('.fund-shortfall')).toContainText('Still needed')
  await expect(perp.locator('.fund-shortfall')).toContainText('75.99 USDT')
  await expect(totalShortfall.locator('.metric-value')).toHaveText('75.99 USDT')
  const language = page.getByRole('combobox', { name: 'Language / 语言' })
  await language.selectOption('zh-CN')
  await expect(toggle).toHaveText('无需补资（1）')
  await toggle.click()
  await expect(loan).toBeHidden()
  await toggle.click()
  await expect(loan).toBeVisible()
  await expect(perp.locator('.fund-shortfall')).toContainText('仍缺')
  await expect(perp.locator('.fund-shortfall')).toContainText('75.99 USDT')
  await language.selectOption('en')
  await budget.fill('0')
  await expect(spot.locator('.tag.danger')).toHaveText('Funding shortfall')
  await expect(loan.locator('.tag.green')).toHaveText('No funding needed')
  await expect(spot.locator('.fund-shortfall')).toContainText('396.09 USDT')
  await expect(perp.locator('.fund-shortfall')).toContainText('79.90 USDT')
  await expect(totalShortfall.locator('.metric-value')).toHaveText('475.99 USDT')
  await toggle.click()
  await target.fill('60000')
  await expect(toggle).toHaveText('No funding needed (3)')
  await expect(visibleNames).toHaveCount(0)
  await toggle.click()
  await expect(visibleNames).toHaveText(['Cross margin', 'BTC loan', 'BTC perpetual'])
  await target.fill('35000')

  await button(page, 'Accounts').click()
  const editor = await editAccount(page, 'Cross margin')
  await editor.getByLabel('Asset', { exact: true }).fill('UNQUOTED')
  await editor.getByRole('button', { name: 'Save account' }).click()
  await expect(editor).toHaveCount(0)
  await button(page, 'Cash planner').click()
  await expect(spot.locator('.tag.neutral')).toHaveText('Unable to assess')
  await expect(spot).toBeVisible()
  await expect(toggle).toHaveText('No funding needed (1)')
  await expect(loan).toBeHidden()
  await expect(required(perp)).toHaveText('79.90 USDT')
  await expect(perp.locator('.tag.neutral')).toHaveText('Unable to assess')
  await expect(shortfalls).toHaveCount(0)
  await expect(totalShortfall).toHaveCount(0)
})

test('collateral limits, custom terms and removing a pledge recalculate the external transfer', async ({
  page, context,
}) => {
  await market(context)
  await page.goto('/')
  await button(page, 'Add your first account').click()
  const wallet = page.getByRole('dialog')
  await wallet.getByRole('button', { name: 'Spot wallet', exact: true }).click()
  await wallet.getByLabel('Account name').fill('ETH reserve')
  await wallet.getByLabel('Asset', { exact: true }).fill('ETH')
  await wallet.getByLabel('Quantity', { exact: true }).fill('1')
  await wallet.getByRole('button', { name: 'Save account' }).click()
  await addAccount(page, 'BTC long', 'perp')
  const original = await exported(page)

  await button(page, 'Cash planner').click()
  await page.getByLabel('BTC target price').fill('35000')
  const destination = page.locator('.fund-action').filter({ has: page.getByRole('heading', { name: 'BTC long' }) })
  const sources = destination.locator('.transfer-sources li')
  const external = sources.filter({ hasText: 'External USDT' }).locator('b')
  await expect(external).toHaveText('516.11 USDT')
  const select = page.getByLabel('Add collateral source')
  await select.selectOption({ label: 'ETH reserve · 1 ETH' })
  const pledge = page.locator('.pledge-row')
  const quantity = pledge.getByLabel('Pledge quantity')
  await quantity.fill('0.002')
  await pledge.getByRole('button', { name: 'Load Bitget loan terms' }).click()
  // 0.002 ETH is worth 4 USDT, below the published 10 USDT collateral minimum.
  await expect(pledge.getByText('Collateral value falls outside the order limits.')).toBeVisible()
  await expect(external).toHaveText('516.11 USDT')
  await quantity.fill('0.01')
  await expect(pledge.getByText('The safe borrowing limit is below the minimum loan size.')).toBeVisible()
  await expect(sources).toHaveCount(1)

  // A failed refresh preserves the original limits until the user chooses custom terms.
  await page.route(/\/loan\/public\/coinInfos\?coin=ETH$/, (route) =>
    route.fulfill({ json: { code: '00000', requestTime: Date.now(), data: { pledgeInfos: [] } } }),
  )
  await pledge.getByRole('button', { name: 'Refresh Bitget loan terms' }).click()
  await expect(pledge.getByRole('status')).toContainText('No public terms could be loaded')
  await expect(pledge.getByLabel('Initial LTV')).toBeDisabled()
  await expect(external).toHaveText('516.11 USDT')
  await pledge.getByRole('button', { name: 'Use custom terms' }).click()
  await pledge.getByLabel('Initial LTV').fill('20')
  await expect(sources.locator('span')).toHaveText(['ETH reserve · ETH collateral loan', 'External USDT'])
  await expect(sources.locator('b')).toHaveText(['4.00 USDT', '512.11 USDT'])

  await pledge.getByRole('button', { name: 'Remove collateral' }).click()
  await expect(pledge).toHaveCount(0)
  await expect(sources).toHaveCount(1)
  await expect(external).toHaveText('516.11 USDT')
  await expect(select.getByRole('option', { name: 'ETH reserve · 1 ETH' })).toHaveCount(1)
  const after = await exported(page)
  expect(after.accounts).toEqual(original.accounts)
})

test('spot wallet cash and an ETH pledge fund one isolated perpetual without changing saved accounts', async ({
  page,
  context,
}) => {
  await market(context)
  await page.goto('/')
  await button(page, 'Add your first account').click()
  const editor = page.getByRole('dialog')
  await editor.getByRole('button', { name: 'Spot wallet', exact: true }).click()
  await expect(editor.getByLabel('Outstanding debt')).toHaveCount(0)
  await editor.getByLabel('Account name').fill('Trading wallet')
  const assets = [
    ['ETH', '2'],
    ['USDT', '300'],
  ]
  for (const [index, [asset, quantity]] of assets.entries()) {
    if (index) await editor.getByRole('button', { name: 'Add holding' }).click()
    const holding = editor.getByRole('group', { name: 'Holding ' + (index + 1), exact: true })
    await holding.getByLabel('Asset', { exact: true }).fill(asset)
    await holding.getByLabel('Quantity', { exact: true }).fill(quantity)
  }
  await editor.getByRole('button', { name: 'Save account' }).click()
  await expect(editor).toHaveCount(0)
  await addAccount(page, 'BTC long', 'perp')

  await expect(page.locator('.metric.equity .metric-value')).toContainText('6,300.00')
  const original = await exported(page)
  const wallet = original.accounts.find((a: { kind: string }) => a.kind === 'cashSpot')
  const perpetual = original.accounts.find((a: { kind: string }) => a.kind === 'perp')
  expect(wallet.holdings).toEqual([
    { asset: 'ETH', quantity: '2' },
    { asset: 'USDT', quantity: '300' },
  ])
  expect(perpetual.margin).toBe('2000')

  await button(page, 'Cash planner').click()
  await page.getByLabel('Apply to').selectOption({ label: 'BTC long' })
  await page.getByLabel('BTC target price').fill('35000')
  await page.getByLabel('External cash budget').fill('0')
  await expect(page.getByRole('checkbox', { name: /Use available spot USDT first/ })).toBeChecked()
  const external = page
    .locator('.plan-metrics .metric')
    .filter({ hasText: 'External cash needed' })
    .locator('.metric-value')
  await expect(external).toHaveText('216.11 USDT')
  await page.getByLabel('Add collateral source').selectOption({ label: 'Trading wallet · 2 ETH' })
  await page.getByLabel('Pledge quantity').fill('1')
  await button(page, 'Load Bitget loan terms').click()
  await expect(page.getByLabel('Initial LTV')).toHaveValue('60')
  await expect(page.getByLabel('Liquidation LTV')).toHaveValue('90')
  await expect(external).toHaveText('0.00 USDT')

  const destination = page.locator('.fund-action')
  await expect(destination).toHaveCount(1)
  await expect(destination.getByRole('heading', { name: 'BTC long' })).toBeVisible()
  await expect(destination.locator('.tag.warm')).toHaveText('Funding required')
  const sources = destination.locator('.transfer-sources li')
  await expect(sources.locator('span')).toHaveText([
    'Trading wallet · free USDT',
    'Trading wallet · ETH collateral loan',
  ])
  await expect(sources.locator('b')).toHaveText(['300.00 USDT', '216.11 USDT'])
  const valueFor = (section: Locator, label: string) =>
    section.locator('dt').filter({ hasText: label }).locator('..').locator('dd')
  await expect(valueFor(destination, 'Required transfer')).toHaveText('516.11 USDT')
  await expect(valueFor(destination, 'Resulting margin')).toHaveText('2,516.11 USDT')
  await expect(destination.locator('.fund-shortfall')).toHaveCount(0)
  const afterTrigger = parseFloat(
    (await valueFor(destination, 'After liquidation').innerText()).replaceAll(',', ''),
  )
  expect(afterTrigger).toBeGreaterThan(0)
  expect(afterTrigger).toBeLessThan(35000)
  const pledge = page.locator('.pledge-row')
  await expect(valueFor(pledge, 'Borrowing capacity at target')).toHaveText('674.99 USDT')
  await expect(valueFor(pledge, 'Planned collateral')).toHaveText('1 ETH')
  await expect(valueFor(pledge, 'New loan principal')).toHaveText('216.11 USDT')

  const loanTrigger = parseFloat(await valueFor(pledge, 'New loan liquidation price').innerText())
  expect(loanTrigger).toBeCloseTo(216.11 / 0.9, 4)
  await saveNamed(page, 'Save plan', 'ETH pledge · 35k')
  const language = page.getByRole('combobox', { name: 'Language / 语言' })
  await language.selectOption('zh-CN')
  await expect(valueFor(pledge, '新增借款本金')).toHaveText('216.11 USDT')
  await expect(destination.locator('.tag.warm')).toHaveText('需补资')
  await expect(
    destination.locator('dt').filter({ hasText: /计划补资后缺口|计入缓冲的 BTC 目标价/ }),
  ).toHaveCount(0)
  await expect(destination.locator('.fund-shortfall')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: '投资组合概览' })).toBeVisible()
  await expect(page.locator('.heading-line .tag')).toHaveText('实时')
  await expect(page.locator('.metric.equity .metric-value')).toContainText('6,300.00')
  await button(page, '资金规划').click()
  await expect(page.getByLabel('BTC 目标价')).toHaveValue('')
  await page.getByLabel('载入已存方案').selectOption({ label: 'ETH pledge · 35k' })
  await expect(page.getByLabel('计划质押数量')).toHaveValue('1')
  await expect(valueFor(pledge, '新增借款本金')).toHaveText('216.11 USDT')
  await expect(destination).toContainText('BTC long')

  await language.selectOption('en')
  const after = await exported(page)
  expect(after.accounts).toEqual(original.accounts)
  expect(after.lastBalanceEdit).toBe(original.lastBalanceEdit)
  expect(after.plans).toHaveLength(1)
  expect(after.plans[0].data).toMatchObject({
    accountId: perpetual.id,
    target: '35000',
    useSpotUsdt: true,
    pledges: [
      {
        accountId: wallet.id,
        asset: 'ETH',
        quantity: '1',
        borrowLtvPct: '60',
        liquidationLtvPct: '90',
        minBorrowUsdt: '25',
        maxBorrowUsdt: '5000',
        minCollateralUsdt: '10',
        maxCollateralUsdt: '10000',
      },
    ],
  })
})

test('account sorting, filtered drag and keyboard reordering persist across views without editing balances', async ({
  page,
  context,
}) => {
  await market(context)
  await page.goto('/')
  const zulu = 'Zulu cross'
  const aster = 'Aster long'
  const beta = 'Beta cross'
  await addAccount(page, zulu)
  await addAccount(page, aster, 'perp')
  await addAccount(page, beta)
  const editor = await editAccount(page, beta)
  await editor.getByLabel('Quantity', { exact: true }).fill('1.25')
  await editor.getByRole('button', { name: 'Save account' }).click()
  await expect(editor).toHaveCount(0)
  const original = await exported(page)

  const names = page.locator('.record-name b')
  const order = page.getByRole('combobox', { name: 'Account order', exact: true })
  await expect(names).toHaveText([zulu, aster, beta])
  await order.selectOption('name-asc')
  await expect(names).toHaveText([aster, beta, zulu])
  await order.selectOption('equity-desc')
  await expect(names).toHaveText([beta, zulu, aster])
  await page.reload()
  await expect(page.locator('.heading-line .tag')).toHaveText('Live')
  await expect(order).toHaveValue('equity-desc')
  await expect(names).toHaveText([beta, zulu, aster])
  await button(page, 'Accounts').click()
  await expect(order).toHaveValue('equity-desc')
  await order.selectOption('manual')
  await expect(names).toHaveText([zulu, aster, beta])
  await button(page, 'Spot margin').click()
  await expect(names).toHaveText([zulu, beta])

  const zuluRow = page.locator('.record').filter({ has: page.getByText(zulu, { exact: true }) })
  await button(page, 'Reorder ' + beta).dragTo(zuluRow.locator('.record-main'))
  await expect(names).toHaveText([beta, zulu])
  await button(page, 'All').click()
  await expect(names).toHaveText([beta, aster, zulu])
  await button(page, 'Overview').click()
  await expect(names).toHaveText([beta, aster, zulu])
  await page.reload()
  await expect(names).toHaveText([beta, aster, zulu])

  await page.getByLabel('Language / 语言').selectOption('zh-CN')
  await expect(page.getByRole('combobox', { name: '账户排序', exact: true })).toHaveValue('manual')
  const grip = button(page, '调整 ' + aster + ' 的顺序')
  await grip.press('Space')
  await grip.press('ArrowDown')
  await grip.press('Escape')
  await expect(names).toHaveText([beta, aster, zulu])
  await grip.press('Space')
  await grip.press('ArrowDown')
  await grip.press('Enter')
  await expect(names).toHaveText([beta, zulu, aster])
  await page.getByLabel('Language / 语言').selectOption('en')
  await order.selectOption('name-desc')
  await expect(names).toHaveText([zulu, beta, aster])
  await order.selectOption('manual')
  await expect(names).toHaveText([beta, zulu, aster])

  await button(page, 'Cash planner').click()
  await page.getByLabel('BTC target price').fill('38450')
  const visible = page.locator('.fund-action:visible')
  await expect(visible.locator('h3')).toHaveText([aster, zulu])
  await page.getByLabel('Cash budget').fill('10')
  await expect(visible.locator('h3')).toHaveText([aster, zulu])
  // The perpetual needs 172.69, while the spot account needs 45.46 and receives the first 10.
  await expect(visible.locator('.fund-shortfall strong')).toHaveText(['172.69 USDT', '35.46 USDT'])
  await page.locator('details.covered-accounts summary').click()
  await expect(visible.locator('h3')).toHaveText([aster, zulu, beta])
  const after = await exported(page)
  expect(after.accounts).toEqual(original.accounts)
  expect(after.lastBalanceEdit).toEqual(original.lastBalanceEdit)
})

test.describe('touch account ordering', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

  test('a touch drag moves an account and keeps the phone layout in bounds', async ({
    page,
    context,
  }) => {
    await market(context)
    await page.goto('/')
    await addAccount(page, 'First loan', 'loan')
    await addAccount(page, 'Second loan', 'loan')
    await button(page, 'Accounts').click()
    const source = button(page, 'Reorder First loan')
    const target = button(page, 'Reorder Second loan')
    await target.scrollIntoViewIfNeeded()
    const from = await source.boundingBox()
    const to = await target.boundingBox()
    if (!from || !to) throw new Error('Expected both reorder handles to be rendered')
    const x = Math.round(from.x + from.width / 2)
    const start = Math.round(from.y + from.height / 2)
    const end = Math.round(to.y + to.height / 2)
    const session = await context.newCDPSession(page)
    try {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y: start }],
      })
      for (let i = 1; i <= 6; i++) {
        const y = Math.round(start + ((end - start) * i) / 6)
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } finally {
      await session.detach()
    }
    await expect(page.locator('.record-name b')).toHaveText(['Second loan', 'First loan'])
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })
})
