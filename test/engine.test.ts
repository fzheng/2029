import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildScenario, evaluate, planCash } from '../src/engine'
import type { CashSpotAccount, LoanAccount, PerpAccount, PriceBook, SpotAccount } from '../src/model'

// All quantities and price series in this suite are synthetic test fixtures.
const common = { archived: false, updatedAt: '2020-01-01T00:00:00Z' }
const spot = (fields: Partial<SpotAccount> = {}): SpotAccount => ({
  ...common,
  kind: 'spot',
  id: 's',
  name: 'Cross A',
  holdings: [{ asset: 'BTC', quantity: '2' }],
  debt: '1500',
  ...fields,
})
const loan = (fields: Partial<LoanAccount> = {}): LoanAccount => ({
  ...common,
  kind: 'loan',
  id: 'l',
  name: 'Loan A',
  collateral: '1',
  asset: 'BTC',
  debt: '800',
  warningLtv: '.85',
  liquidationLtv: '.91',
  ...fields,
})
const perp = (fields: Partial<PerpAccount> = {}): PerpAccount => ({
  ...common,
  kind: 'perp',
  id: 'p',
  name: 'Perp A',
  side: 'long',
  size: '2',
  asset: 'BTC',
  entry: '1000',
  margin: '200',
  takerFee: '.001',
  maintenanceRate: '.009',
  maintenanceOffset: '0',
  ...fields,
})
const book = (p: string): PriceBook => ({ spot: { BTC: p }, mark: { BTC: p }, loan: { BTC: p } })
function close(a: number | null, b: number) {
  assert.notEqual(a, null)
  assert.ok(Math.abs(a! - b) < 1e-8, `${a} ≠ ${b}`)
}

test('empty or exclusively archived portfolios have zero equity, debt and exposure, and no leverage or triggers', () => {
  for (const accounts of [[], [spot({ archived: true })]]) {
    const v = evaluate(accounts, { spot: {}, loan: {}, mark: {} })
    assert.deepEqual(
      [v.accounts, v.equity, v.debt, v.exposure, v.leverage, v.firstLiquidation, v.firstWarning],
      [[], 0, 0, 0, null, null, null],
    )
  }
})

test('specified example: 2 × 1,500 gross, 1,500 debt, 2× leverage, 10% risk, 1,650 gross boundary', () => {
  const v = evaluate([spot()], book('1500'))
  const r = v.accounts[0]
  assert.deepEqual(
    [r.gross, v.equity, v.debt, v.leverage, r.risk, r.assetBoundary, r.liquidationPrice, r.distancePct],
    [3000, 1500, 1500, 2, 0.1, 1650, 825, 45],
  )
  close(r.warningBoundary, 1500 + 150 / 0.65)
  assert.equal(evaluate([spot()], book('825')).accounts[0].status, 'Liquidation')
  assert.equal(evaluate([spot()], book('850')).accounts[0].status, 'Warning')
})

test('portfolio leverage uses combined margin, loan and perpetual exposure and equity', () => {
  const wallet: CashSpotAccount = {
    ...common, kind: 'cashSpot', id: 'cash', name: 'Reserve',
    holdings: [{ asset: 'ETH', quantity: '10' }, { asset: 'USDT', quantity: '1000' }],
  }
  const riskAccounts = [spot(), loan(), perp()]
  const quotes = { ...book('1000'), spot: { BTC: '1000', ETH: '900' } }
  const accounts = [...riskAccounts, wallet]
  const portfolio = evaluate(accounts, quotes)
  assert.deepEqual([portfolio.equity, portfolio.exposure, portfolio.debt], [10900, 15000, 2300])
  close(portfolio.leverage, 5000 / 900)
  close(evaluate(riskAccounts, quotes).leverage, 5000 / 900)

  const unpricedWallet = evaluate(accounts, book('1000'))
  assert.equal(unpricedWallet.equity, null)
  assert.deepEqual(unpricedWallet.missing, ['ETH spot'])
  close(unpricedWallet.leverage, 5000 / 900)
  assert.equal(evaluate(accounts, { ...quotes, mark: {} }).leverage, null)

  for (const debt of ['2000', '2200']) {
    const insolvent = evaluate([spot({ debt }), wallet], quotes)
    assert.ok(insolvent.equity! > 0)
    assert.equal(insolvent.leverage, null)
  }
  // A negative margin balance still reduces the combined equity of the eligible accounts.
  close(evaluate([spot({ debt: '2200' }), loan(), perp(), wallet], quotes).leverage, 5000 / 200)
})

test('loan values use order thresholds, loan index and collateral just once', () => {
  const v = evaluate([loan({ collateral: '2', warningLtv: '.8', liquidationLtv: '.9', debt: '1440' })], {
    spot: { BTC: '2000' },
    mark: {},
    loan: { BTC: '900' },
  })
  const r = v.accounts[0]
  assert.deepEqual(
    [r.gross, r.equity, r.ltv, r.leverage, r.warningPrice, r.liquidationPrice, r.status],
    [1800, 360, 0.8, 5, 900, 800, 'Warning'],
  )
  close(r.btcLiquidationPrice, 2000 * 800 / 900)
})

test('long and short isolated mark-to-market and fee-aware estimated liquidation', () => {
  for (const side of ['long', 'short'] as const) {
    const account = perp({ side })
    const r = evaluate([account], { spot: { BTC: '800' }, mark: { BTC: '1050' }, loan: {} }).accounts[0]
    assert.equal(r.maintenance, 21)
    assert.equal(r.debt, 0)
    assert.equal(r.equity, side === 'long' ? 300 : 100)
    close(r.leverage, 2100 / r.equity!)
    close(r.liquidationPrice, side === 'long' ? 1800 / 1.98 : 2200 / 2.02)
    close(r.btcLiquidationPrice, 800 * r.liquidationPrice! / 1050)
    assert.equal(r.status, 'Safe')
    const adverse = side === 'long' ? '900' : '1100'
    assert.equal(evaluate([account], book(adverse)).accounts[0].status, 'Liquidation')
  }
})

test('tier changes select the tier of the candidate mark and offset the cumulative lower tiers', () => {
  const pos = perp({
    entry: '1500',
    size: '1',
    margin: '600',
    takerFee: '0',
    tiers: [
      { min: '0', max: '1000', rate: '.01' },
      { min: '1000', max: '10000', rate: '.04' },
    ],
  })
  const r = evaluate([pos], book('1500')).accounts[0]
  assert.equal(r.maintenance, 30) // 1000 × 1% + 500 × 4%
  close(r.liquidationPrice, 900 / 0.99)
  const plan = planCash([pos], book('1500'), { target: '900', path: 'Base' })
  assert.equal(plan.required, 9.01)
  assert.equal(plan.actions[0].safe, true)
})

test('no price substitutions or partial totals when a held basis is missing', () => {
  const v = evaluate([loan(), perp(), spot()], { spot: { BTC: '1000' }, mark: {}, loan: {} })
  assert.equal(v.equity, null)
  assert.equal(v.debt, 2300)
  assert.deepEqual(v.missing, ['BTC loan reference', 'BTC mark'])
  assert.equal(v.accounts[2].equity, 500)
})

test('linked moves and alt overrides use one frozen snapshot, preserve each basis spread and floor at zero', () => {
  const snapshot = {
    spot: { BTC: '1000', ETH: '100', SOL: '50', BNB: '20', HYPE: '100', ATOM: '7', USDT: '1' },
    mark: { BTC: '1010', HYPE: '110' },
    loan: { BTC: '980', HYPE: '90' },
  }
  const frozen = JSON.stringify(snapshot)
  const base = buildScenario(snapshot, 'Base', { BTC: '800' })
  assert.deepEqual(base.spot, { BTC: '800', ETH: '70', SOL: '33', BNB: '16', HYPE: '66', ATOM: '7', USDT: '1' })
  assert.equal(base.mark.BTC, '808')
  assert.equal(base.loan.BTC, '784')
  assert.deepEqual([base.mark.HYPE, base.loan.HYPE], ['72.6', '59.4'])
  const upside = buildScenario(snapshot, 'Severe', { BTC: '1100' })
  assert.deepEqual([upside.spot.HYPE, upside.mark.HYPE, upside.loan.HYPE], ['130', '143', '117'])
  const pinned = buildScenario(snapshot, 'Severe', { BTC: '1100', HYPE: '80', USDT: '0' })
  assert.deepEqual([pinned.spot.HYPE, pinned.mark.HYPE, pinned.loan.HYPE, pinned.spot.USDT], ['80', '88', '72', '1'])
  const severe = buildScenario(snapshot, 'Severe', { BTC: '500', BNB: '10' })
  assert.deepEqual(severe.spot, { BTC: '500', ETH: '0', SOL: '0', BNB: '10', HYPE: '0', ATOM: '7', USDT: '1' })
  assert.deepEqual(buildScenario(snapshot, 'Independent', { BTC: '300', ATOM: '2' }).spot, {
    BTC: '300',
    ETH: '100',
    SOL: '50',
    BNB: '20',
    HYPE: '100',
    ATOM: '2',
    USDT: '1',
  })
  assert.equal(JSON.stringify(snapshot), frozen)
})

test('HYPE uses its own price basis for liquidation and per-account funding along the same BTC path', () => {
  const snapshot = { spot: { BTC: '1000', HYPE: '100' }, mark: { HYPE: '110' }, loan: { HYPE: '90' } }
  const accounts = [
    loan({ asset: 'HYPE', debt: '60', liquidationLtv: '.9' }),
    perp({ asset: 'HYPE', size: '1', entry: '110', margin: '30' }),
    spot({ holdings: [{ asset: 'HYPE', quantity: '1' }], debt: '70' }),
  ]
  const mild = evaluate(accounts, buildScenario(snapshot, 'Severe', { BTC: '990' }), 'Severe')
  assert.equal(mild.firstLiquidation, null)
  assert.equal(mild.nextLiquidation?.id, 's')
  close(mild.nextLiquidation!.pathPoint!.price, 1000 * (1 - .23 / 3))
  const stressed = evaluate(accounts, buildScenario(snapshot, 'Severe', { BTC: '900' }), 'Severe')
  assert.equal(stressed.firstLiquidation?.id, mild.nextLiquidation?.id)
  close(stressed.firstLiquidation!.pathPoint!.price, mild.nextLiquidation!.pathPoint!.price)
  assert.deepEqual(stressed.accounts.map((a) => a.status), ['Liquidation', 'Liquidation', 'Liquidation'])
  const plan = planCash(accounts, snapshot, { target: '900', path: 'Severe' })
  assert.deepEqual(plan.actions.map((a) => [a.accountId, a.targetPrice, a.required, a.safe]), [
    ['s', 900, 6.37, true],
    ['l', 63, 3.31, true],
    ['p', 77, 3.78, true],
  ])
})

test('spot BTC trigger follows named alt path incl. a floored altcoin and a pinned override', () => {
  const acct = spot({
    debt: '100',
    holdings: [
      { asset: 'BTC', quantity: '.2' },
      { asset: 'ETH', quantity: '1' },
    ],
  })
  const base = { ...book('1000'), spot: { BTC: '1000', ETH: '100' } }
  close(evaluate([acct], base, 'Severe').accounts[0].liquidationPrice, 550) // ETH has reached 0
  close(evaluate([acct], base, 'Independent').accounts[0].liquidationPrice, 50)
  const scenario = buildScenario(base, 'Severe', { BTC: '800', ETH: '40' })
  close(evaluate([acct], scenario, 'Severe').accounts[0].liquidationPrice, 350)
  close(evaluate([acct], scenario).accounts[0].btcLiquidationPrice, 350)
})

test('account BTC liquidation prices invert linked loan and perpetual moves from the frozen basis', () => {
  for (const [asset, base, severe] of [
    ['ETH', 1.5, 2.5],
    ['SOL', 1.7, 3],
    ['BNB', 1, 1.5],
    ['HYPE', 1.7, 3],
  ] as const) {
    const quotes = {
      spot: { BTC: '1000', [asset]: '100' },
      mark: { [asset]: '110' },
      loan: { [asset]: '90' },
    }
    const positions = [
      loan({ asset, debt: '64.8', liquidationLtv: '.9' }), // Liquidation at 72, down 20% on the index.
      perp({ asset, size: '1', entry: '110', margin: '22.88' }), // At 88, down 20% on the mark.
      perp({ asset, id: 'short', size: '1', side: 'short', entry: '110', margin: '23.32' }), // At 132, up 20%.
    ]
    for (const [path, weight] of [['Base', base], ['Severe', severe]] as const) {
      for (const book of [quotes, buildScenario(quotes, path, { BTC: '995' })]) {
        const [loanRisk, longRisk, shortRisk] = evaluate(positions, book, path).accounts
        close(loanRisk.btcLiquidationPrice, 1000 * (1 - 0.2 / weight))
        close(longRisk.btcLiquidationPrice, 1000 * (1 - 0.2 / weight))
        close(shortRisk.btcLiquidationPrice, 1000 * (1 + 0.2 / weight))
      }
    }
    const pinned = buildScenario(quotes, 'Severe', { BTC: '995', [asset]: '99' })
    for (const [book, path] of [[pinned, 'Severe'], [quotes, 'Independent']] as const) {
      assert.ok(evaluate(positions, book, path).accounts.every((r) => r.btcLiquidationPrice === null))
    }
  }
})

test('BTC liquidation prices include a reachable zero mark and omit undefined boundaries', () => {
  const floor = perp({ asset: 'HYPE', entry: '100', size: '1', margin: '100' })
  const quotes = { spot: { BTC: '1000' }, mark: { HYPE: '100' }, loan: { HYPE: '95', ATOM: '10' } }
  close(evaluate([floor], quotes).accounts[0].btcLiquidationPrice, 1000 * (1 - 1 / 1.7))
  close(evaluate([{ ...floor, asset: 'BTC' }], book('1000')).accounts[0].btcLiquidationPrice, 0)

  const cash: CashSpotAccount = { ...common, id: 'c', name: 'Cash', kind: 'cashSpot', holdings: [] }
  const accounts = [
    cash,
    loan({ asset: 'ATOM' }),
    loan({ asset: 'USDT' }),
    loan({ asset: 'HYPE', debt: '0' }),
    spot({ debt: '0' }),
    perp({ asset: 'HYPE', size: '0' }),
    loan({ asset: 'ETH' }),
    perp({ asset: 'ETH' }),
  ]
  assert.ok(evaluate(accounts, quotes).accounts.every((r) => r.btcLiquidationPrice === null))
  assert.equal(evaluate([floor], { ...quotes, spot: {} }).accounts[0].btcLiquidationPrice, null)
})

test('target touch adds an executable cent for all three actions; lower budget prioritizes spot, then loan, then perp', () => {
  const accounts = [
    perp(),
    loan({ debt: '820' }),
    spot({ debt: '850', holdings: [{ asset: 'BTC', quantity: '1.1' }] }),
  ]
  const frozen = JSON.stringify(accounts)
  const input = { target: '800', path: 'Base' as const }
  const result = planCash(accounts, book('1000'), input)
  assert.deepEqual(
    result.actions.map((a) => [a.kind, a.required, a.resultingBalance, a.safe]),
    [
      ['spot', 50.01, 799.99, true],
      ['loan', 92.01, 727.99, true],
      ['perp', 216.01, 416.01, true],
    ],
  )
  assert.equal(result.required, 358.03)
  for (const row of result.actions) assert.ok(row.afterLiquidation! < 800)
  const limited = planCash(accounts, book('1000'), { ...input, budget: '100.009' })
  assert.deepEqual(
    limited.actions.map((a) => [a.allocated, a.uncovered, a.safe]),
    [
      [50.01, 0, true],
      [49.99, 42.02, false],
      [0, 216.01, false],
    ],
  )
  assert.equal(limited.allocated, 100)
  assert.equal(limited.uncovered, 258.03)
  assert.equal(JSON.stringify(accounts), frozen)
})

test('independent cash plan while viewing BTC 44,000: target 35,000, individual loan remains pledged', () => {
  const q = book('60000')
  const a = loan({ debt: '35000', increment: '1' })
  const accountInputs = JSON.stringify(a)
  const scenario = buildScenario(q, 'Base', { BTC: '44000' })
  assert.equal(evaluate([a], scenario).equity, 9000)
  const plan = planCash([spot(), a], q, { target: '35000', path: 'Base', accountId: 'l' })
  assert.equal(plan.actions.length, 1)
  assert.equal(plan.required, 3151)
  const [row] = plan.actions
  assert.equal(row.resultingBalance, 31849)
  assert.equal(row.safe, true)
  assert.equal(row.accountId, 'l')
  assert.equal(JSON.stringify(a), accountInputs)
  const buffered = planCash([a], q, { target: '35000', bufferPct: '10', path: 'Base' })
  assert.equal(buffered.bufferedBtcTarget, 31500)
  assert.equal(buffered.actions[0].targetPrice, 31500)
  assert.equal(buffered.required, 6336)
})

test('short moving up uses an upside buffer; an already breached short must also survive its starting mark', () => {
  const a = perp({ side: 'short', size: '1', margin: '10' })
  const q = book('1000')
  const rising = planCash([a], q, { target: '1100', path: 'Base', bufferPct: '10' })
  assert.equal(rising.bufferedBtcTarget, 1210)
  assert.equal(rising.actions[0].targetPrice, 1210)
  assert.equal(rising.required, 212.11)
  assert.ok(rising.actions[0].afterLiquidation! > 1210)
  const falling = planCash([a], q, { target: '900', path: 'Base' })
  assert.equal(falling.required, 0.01)
})

test('fully repay collateral that reaches zero; do not create a negative debt or allocate stale estimates with missing prices', () => {
  const a = loan({ asset: 'SOL', debt: '13.10' })
  const q = { spot: { BTC: '1000' }, loan: { SOL: '20' }, mark: {} }
  const plan = planCash([a], q, { target: '300', path: 'Severe' })
  assert.equal(plan.required, 13.1)
  assert.deepEqual(
    [plan.actions[0].resultingBalance, plan.actions[0].afterLiquidation, plan.actions[0].safe],
    [0, null, true],
  )
  const incomplete = planCash([spot({ holdings: [{ asset: 'ETH', quantity: '1' }] }), a], q, {
    target: '300',
    path: 'Severe',
    budget: '20',
  })
  assert.equal(incomplete.required, null)
  assert.ok(incomplete.missing.includes('ETH spot'))
  assert.equal(incomplete.actions[1].allocated, null)
})

test('scenario reports the first warning and liquidation actually crossed, independently of account entry order', () => {
  const earlier = loan({ id: 'early', name: 'Earlier loan', debt: '819' }) // liquidates at 900
  const later = loan({ id: 'late', name: 'Later loan', debt: '728' }) // liquidates at 800
  const result = evaluate([later, earlier], buildScenario(book('1000'), 'Base', { BTC: '700' }), 'Base')
  assert.equal(result.firstWarning?.name, 'Earlier loan')
  assert.equal(result.firstLiquidation?.name, 'Earlier loan')
  close(result.firstLiquidation!.price, 900)
  assert.deepEqual(result.accounts.map((row) => row.equity), [0, 0])
})

test('Severe ranks upcoming and reached loan thresholds in BTC coordinates and retains equity at first touch', () => {
  const snapshot = { spot: { BTC: '60000', SOL: '100' }, loan: { BTC: '60000', SOL: '100' }, mark: {} }
  const positions = [
    loan({ id: 'btc', debt: '49140', warningLtv: '.90' }),
    loan({ id: 'sol', asset: 'SOL', debt: '72.80' }),
  ]
  const project = (BTC: string) => evaluate(positions, buildScenario(snapshot, 'Severe', { BTC }), 'Severe')
  const mild = project('59400')
  assert.deepEqual(mild.accounts.map((r) => r.status), ['Safe', 'Safe'])
  assert.equal(mild.firstWarning, null)
  assert.equal(mild.firstLiquidation, null)
  assert.equal(mild.nextWarning?.id, 'sol')
  assert.equal(mild.nextLiquidation?.id, 'sol')
  assert.deepEqual(mild.nextLiquidation?.pathPoint, { asset: 'BTC', price: 56000 })
  assert.equal(mild.nextLiquidation?.price, 80)
  assert.equal(mild.accounts[1].equityAtTrigger, null)
  const hit = project('56000')
  assert.equal(hit.firstWarning?.id, 'sol')
  assert.equal(hit.firstLiquidation?.id, 'sol')
  assert.deepEqual(hit.firstLiquidation?.pathPoint, mild.nextLiquidation?.pathPoint)
  assert.equal(hit.nextLiquidation?.id, 'btc')
  assert.equal(hit.nextLiquidation?.pathPoint?.price, 54000)
  for (const result of [hit, project('50000')]) {
    assert.equal(result.accounts[1].equity, 0)
    assert.equal(result.accounts[1].equityAtTrigger, 7.2)
  }
  assert.equal(project('50000').nextLiquidation, null)
  assert.equal(project('60000').direction, null)
  const startingBelow = evaluate(positions, buildScenario({ ...snapshot, loan: { SOL: '70' } }, 'Severe', {}))
  assert.equal(startingBelow.firstLiquidation?.atSnapshot, true)
  assert.equal(startingBelow.accounts[1].equityAtTrigger, null)
})

test('upside continuation respects mark basis, ignores long positions, and needs a single direction', () => {
  const snapshot = { spot: { BTC: '1000', SOL: '100' }, mark: { SOL: '102' }, loan: {} }
  const short = perp({ asset: 'SOL', side: 'short', size: '1', entry: '100', margin: '110' })
  const accounts = [short, perp({ asset: 'SOL', id: 'long', entry: '102' })]
  const mild = evaluate(accounts, buildScenario(snapshot, 'Severe', { BTC: '1010' }), 'Severe')
  assert.equal(mild.nextLiquidation?.id, short.id)
  const nativeTrigger = 210 / 1.01
  close(mild.nextLiquidation!.price, nativeTrigger)
  close(mild.nextLiquidation!.pathPoint!.price, 1000 * (1 + (nativeTrigger / 102 - 1) / 3))
  const pinned = evaluate(accounts, buildScenario(snapshot, 'Severe', { BTC: '1010', SOL: '100' }), 'Severe')
  assert.equal(pinned.nextLiquidation, null)
  const independent = evaluate(accounts, buildScenario(snapshot, 'Independent', { SOL: '103' }), 'Independent')
  close(independent.nextLiquidation!.pathPoint!.price, nativeTrigger / 1.02)
  const mixed = evaluate(accounts, buildScenario(snapshot, 'Severe', { BTC: '1010', SOL: '103' }), 'Severe')
  assert.deepEqual([mixed.direction, mixed.nextWarning, mixed.nextLiquidation], [null, null, null])
})

test('the zero-maintenance floor is included when predicting and valuing an isolated liquidation', () => {
  const long = perp({ size: '1', entry: '100', margin: '50', maintenanceRate: '.20', maintenanceOffset: '15', takerFee: '0' })
  assert.equal(evaluate([long], book('100')).accounts[0].liquidationPrice, 50)
  const mild = evaluate([long], buildScenario(book('100'), 'Base', { BTC: '51' }))
  assert.equal(mild.firstLiquidation, null)
  assert.equal(mild.nextLiquidation?.price, 50)
  for (const target of ['50', '0']) {
    const result = evaluate([long], buildScenario(book('100'), 'Base', { BTC: target }))
    assert.equal(result.firstLiquidation?.price, 50)
    assert.equal(result.accounts[0].equityAtTrigger, 0)
  }
})

test('a simulated cross account, loan or isolated position loses its remaining equity exactly at liquidation', () => {
  const snapshot = book('1000')
  const cases = [
    { account: spot(), before: '825.01', trigger: '825', beyond: '500' },
    {
      account: loan({ debt: '720', liquidationLtv: '.9' }),
      before: '800.01',
      trigger: '800',
      beyond: '500',
    },
    { account: perp({ size: '1', margin: '109' }), before: '900.01', trigger: '900', beyond: '500' },
    {
      account: perp({ side: 'short', size: '1', margin: '111' }),
      before: '1099.99',
      trigger: '1100',
      beyond: '1300',
    },
  ]
  for (const { account, before, trigger, beyond } of cases) {
    const original = structuredClone(account)
    const project = (BTC: string) =>
      evaluate([account], buildScenario(snapshot, 'Independent', { BTC }), 'Independent')
    const beforeTouch = project(before)
    assert.ok(beforeTouch.equity! > 0)
    assert.equal(beforeTouch.accounts[0].status, 'Warning')
    // At the maintenance boundary raw mark-to-market equity can still be positive.
    assert.ok(evaluate([account], book(trigger)).equity! > 0)
    for (const target of [trigger, beyond]) {
      const outcome = project(target)
      const row = outcome.accounts[0]
      assert.deepEqual([row.status, row.equity, row.exposure, row.leverage], ['Liquidation', 0, 0, null])
      assert.deepEqual([outcome.equity, outcome.exposure, outcome.leverage], [0, 0, null])
      assert.equal(outcome.firstLiquidation?.id, account.id)
      close(outcome.firstLiquidation!.price, Number(trigger))
    }
    assert.ok(evaluate([account], book(beyond)).equity! < 0)
    assert.equal(project(before).equity, beforeTouch.equity)
    assert.deepEqual(account, original)
  }
})

test('liquidation is isolated to the affected account before portfolio equity and leverage are summed', () => {
  const wallet: CashSpotAccount = {
    ...common,
    kind: 'cashSpot',
    id: 'cash',
    name: 'Reserves',
    holdings: [{ asset: 'USDT', quantity: '250' }],
  }
  const positions = [spot(), loan({ debt: '182' }), wallet]
  const snapshot = book('1000')
  const original = structuredClone({ positions, snapshot })
  const target = buildScenario(snapshot, 'Base', { BTC: '500' })
  const projected = evaluate(positions, target, 'Base')
  assert.deepEqual(
    projected.accounts.map((row) => row.equity),
    [0, 318, 250],
  )
  assert.deepEqual([projected.equity, projected.exposure], [568, 750])
  close(projected.leverage, 500 / 318)
  assert.equal(projected.firstLiquidation?.id, positions[0].id)
  assert.equal(evaluate(positions, snapshot).debt, 1682)
  assert.ok(planCash(positions, snapshot, { target: '500', path: 'Base' }).actions[0].required! > 0)
  assert.deepEqual({ positions, snapshot }, original)

  const incomplete = evaluate([...positions, perp({ asset: 'SOL' })], target, 'Base')
  assert.deepEqual(
    incomplete.accounts.map((row) => row.equity),
    [0, 318, 250, null],
  )
  assert.deepEqual([incomplete.equity, incomplete.exposure, incomplete.leverage], [null, null, null])
  assert.deepEqual(incomplete.missing, ['SOL mark'])
})

test('a position liquidated midway through a single scenario stays closed even if its endpoint prices recover', () => {
  const account = spot({
    debt: '90',
    holdings: [
      { asset: 'ETH', quantity: '1' },
      { asset: 'SOL', quantity: '1' },
    ],
  })
  const snapshot = { spot: { BTC: '1000', ETH: '100', SOL: '20' }, mark: {}, loan: {} }
  // ETH floors at zero 40% of the way through this move. SOL then trades at 76:
  // gross collateral has already crossed 99, although SOL reaches 160 at the endpoint.
  const target = buildScenario(snapshot, 'Severe', { BTC: '0', SOL: '160' })
  assert.deepEqual([target.spot.ETH, target.spot.SOL], ['0', '160'])
  assert.equal(
    evaluate([account], { spot: { BTC: '0', ETH: '0', SOL: '160' }, mark: {}, loan: {} }).equity,
    70,
  )
  const projection = evaluate([account], target, 'Severe')
  assert.equal(projection.firstLiquidation?.id, account.id)
  assert.equal(projection.firstLiquidation?.price, 99)
  close(projection.accounts[0].equityAtTrigger, 9)
  assert.deepEqual(
    [projection.accounts[0].status, projection.equity, projection.exposure],
    ['Liquidation', 0, 0],
  )
  // Changing the target makes a new what-if calculation from the original snapshot.
  assert.equal(evaluate([account], buildScenario(snapshot, 'Severe', {}), 'Severe').equity, 30)
})

test('saved target scopes for archived and missing accounts stay unresolved', () => {
  for (const accounts of [[], [loan({ archived: true })], [perp()]]) {
    const result = planCash(accounts, book('50000'), { target: '35000', path: 'Base', accountId: 'l' })
    assert.deepEqual(
      [result.required, result.allocated, result.uncovered, result.actions],
      [null, null, null, []],
    )
    assert.match(result.missing[0], /selected account is archived or missing/)
  }
  assert.equal(planCash([], book('50000'), { target: '35000', path: 'Base' }).required, 0)
})

test('strictly positive target and buffer below 100% match saved plan constraints', () => {
  for (const target of ['0', '0.00', '-1', '', 'NaN']) {
    assert.equal(planCash([], book('50000'), { target, path: 'Severe' }).required, null)
  }
  for (const bufferPct of ['100', '100.0001', '-0.01']) {
    assert.equal(
      planCash([], book('50000'), { target: '35000', bufferPct, path: 'Base' }).required,
      null,
    )
  }
  assert.equal(
    planCash([], book('50000'), { target: '0.000001', bufferPct: '99.999', path: 'Base' }).required,
    0,
  )
})

test('rounded transfers repay exact debt and leave destination USDT distinct from reusable external budget', () => {
  const accounts = [
    loan({ debt: '0.0501', asset: 'SOL', increment: '0.001' }),
    spot({ debt: '1.003', holdings: [{ asset: 'SOL', quantity: '1' }], increment: '0.01' }),
  ]
  const q = { spot: { BTC: '1000', SOL: '10' }, loan: { SOL: '10' }, mark: {} }
  const result = planCash(accounts, q, { target: '100', path: 'Severe', budget: '1.0624' })
  const [margin, order] = result.actions
  assert.deepEqual(
    [margin.allocated, margin.applied, margin.residual, margin.resultingBalance],
    [1.01, 1.003, 0.007, 0],
  )
  assert.deepEqual(
    [order.allocated, order.applied, order.residual, order.resultingBalance],
    [0.051, 0.0501, 0.0009, 0],
  )
  assert.deepEqual([result.required, result.allocated, result.budgetRemaining], [1.061, 1.061, 0.0014])
  const limited = planCash(accounts, q, { target: '100', path: 'Severe', budget: '1.0055' })
  assert.deepEqual(
    limited.actions.map((a) => [a.allocated, a.applied, a.residual]),
    [
      [1, 1, 0],
      [0.005, 0.005, 0],
    ],
  )
  assert.equal(limited.budgetRemaining, 0.0005)
  assert.equal(limited.actions[1].resultingBalance, 0.0451)
})

test('a spot crossing driven by ETH alone reports its ETH quote while BTC stays fixed', () => {
  const account = spot({ holdings: [{ asset: 'ETH', quantity: '2' }], debt: '1500' })
  const snapshot = { spot: { BTC: '60000', ETH: '1500' }, loan: {}, mark: {} }
  const stressed = buildScenario(snapshot, 'Independent', { ETH: '500' })
  const result = evaluate([account], stressed, 'Independent')
  assert.equal(result.firstLiquidation?.asset, 'ETH')
  close(result.firstLiquidation!.price, 825)
  assert.equal(result.firstWarning?.asset, 'ETH')
  close(result.firstWarning!.price, (1500 + 150 / .65) / 2)
})

test('a spot crossing driven by two independent altcoin moves reports total gross assets', () => {
  const account = spot({ holdings: [{ asset: 'ETH', quantity: '1' }, { asset: 'SOL', quantity: '2' }], debt: '600' })
  const snapshot = { spot: { BTC: '60000', ETH: '800', SOL: '100' }, loan: {}, mark: {} }
  const stressed = buildScenario(snapshot, 'Base', { ETH: '200', SOL: '50' })
  const result = evaluate([account], stressed, 'Base')
  assert.equal(result.firstLiquidation?.asset, 'gross assets')
  close(result.firstLiquidation!.price, 660)
  assert.equal(result.firstWarning?.asset, 'gross assets')
  close(result.firstWarning!.price, 600 + 60 / .65)
})
