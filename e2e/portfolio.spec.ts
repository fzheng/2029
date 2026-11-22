import { readFile } from 'node:fs/promises'
import { expect, test, type BrowserContext, type Locator, type Page, type Route } from '@playwright/test'

// Synthetic public quotes are scoped to the isolated browser context of each test.
async function market(context: BrowserContext) {
  const feed = { online: true, btc: 60000 }
  const handler = async (route: Route) => {
    if (!feed.online) return route.abort('internetdisconnected')
    const url = new URL(route.request().url())
    const now = Date.now()
    const prices = { BTC: feed.btc, ETH: 2000, SOL: 100, BNB: 500, LINK: 10 }
    let data: unknown
    if (url.pathname.endsWith('/tickers')) {
      data = Object.entries(prices).map(([asset, value]) => ({
        symbol: asset + 'USDT',
        lastPrice: String(value),
        markPrice: String(value),
        indexPrice: String(value),
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
      data = [{ symbol: 'BTCUSDT', takerFeeRate: '0.0006' }]
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
  await button(page, 'Open cash planner').click()
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
  await button(page, 'Open cash planner').click()
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
  const price = page.getByLabel('BTC scenario price')
  await price.fill('40200')
  await expect(position.getByRole('cell')).toHaveText(['BTC long', '2,000.00', '20.00', 'Warning'])
  await expect(equity).toHaveText(['2,300.00 USDT', '320.00 USDT'])

  // 40,150 breaches maintenance with positive mark-to-market equity; 35,000 would make it negative.
  for (const mark of ['40150', '35000']) {
    await price.fill(mark)
    await expect(position.getByRole('cell')).toHaveText(['BTC long', '2,000.00', '0.00', 'Liquidated'])
    await expect(reserve.getByRole('cell')).toHaveText(['Cash reserve', '300.00', '300.00', 'Unleveraged'])
    await expect(equity).toHaveText(['2,300.00 USDT', '300.00 USDT'])
  }
  await page.getByLabel('Language / 语言').selectOption('zh-CN')
  await expect(position.getByRole('cell').last()).toHaveText('已强平')
  await page.getByLabel('Language / 语言').selectOption('en')
  await button(page, 'Reset scenario').click()
  await expect(position.getByRole('cell')).toHaveText(['BTC long', '2,000.00', '2,000.00', 'Safe'])
  await expect(equity).toHaveText(['2,300.00 USDT', '2,300.00 USDT'])
  await button(page, 'Return to Live').click()
  await expect(page.locator('.metric.equity .metric-value')).toContainText('2,300.00')
  const after = await exported(page)
  expect(after.accounts).toEqual(before.accounts)
  expect(after.lastBalanceEdit).toEqual(before.lastBalanceEdit)
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
  await button(page, 'Open cash planner').click()
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
    await first.context.close()
  }
  const next = await open()
  try {
    await expect(next.page.getByRole('heading', { name: 'Portfolio overview' })).toBeVisible()
    await expect(next.page.locator('.record-name b')).toHaveText(['Restart portfolio'])
    const saved = await editAccount(next.page, 'Restart portfolio')
    await expect(saved.getByLabel('Quantity', { exact: true })).toHaveValue('0.1234500001')
  } finally {
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
  await button(page, 'Open cash planner').click()
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
  await page.getByLabel('BTC target price').fill('35000')
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
  await expect(perp.locator('.fund-shortfall')).toContainText('仍缺')
  await expect(perp.locator('.fund-shortfall')).toContainText('75.99 USDT')
  await language.selectOption('en')
  await budget.fill('0')
  await expect(spot.locator('.tag.danger')).toHaveText('Funding shortfall')
  await expect(loan.locator('.tag.green')).toHaveText('No funding needed')
  await expect(spot.locator('.fund-shortfall')).toContainText('396.09 USDT')
  await expect(perp.locator('.fund-shortfall')).toContainText('79.90 USDT')
  await expect(totalShortfall.locator('.metric-value')).toHaveText('475.99 USDT')

  await button(page, 'Accounts').click()
  const editor = await editAccount(page, 'Cross margin')
  await editor.getByLabel('Asset', { exact: true }).fill('UNQUOTED')
  await editor.getByRole('button', { name: 'Save account' }).click()
  await expect(editor).toHaveCount(0)
  await button(page, 'Cash planner').click()
  await expect(spot.locator('.tag.neutral')).toHaveText('Unable to assess')
  await expect(loan.locator('.tag.green')).toHaveText('No funding needed')
  await expect(required(perp)).toHaveText('79.90 USDT')
  await expect(perp.locator('.tag.neutral')).toHaveText('Unable to assess')
  await expect(shortfalls).toHaveCount(0)
  await expect(totalShortfall).toHaveCount(0)
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
  await page.getByLabel('BTC target price').fill('35000')
  await expect(page.locator('.fund-action h3')).toHaveText([zulu, beta, aster])
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
