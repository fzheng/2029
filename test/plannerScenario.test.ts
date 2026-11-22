import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildScenario, evaluate, planCash, planFromScenario } from '../src/engine'
import type { CashSpotAccount, PlanSnapshot, PriceBook, SpotAccount } from '../src/model'

const margin: SpotAccount = {
  id: 'eth-margin', name: 'ETH margin', kind: 'spot', archived: false, updatedAt: '',
  debt: '1500', holdings: [{ asset: 'ETH', quantity: '2' }],
}
const snapshot: PlanSnapshot = {
  book: { spot: { BTC: '60000', ETH: '2000' }, mark: {}, loan: {} },
  overrides: { BTC: '45000' }, asOf: '2026-10-01T12:00:00.000Z', stale: ['spot:ETH'],
}

test('planning from Severe freezes quotes and path while funding targets remain independently editable', () => {
  const source = { ...structuredClone(snapshot), path: 'Severe' as const }
  const plan = planFromScenario(source)
  assert.equal(plan.target, '45000')
  assert.deepEqual(plan.snapshot?.overrides, {})
  const newer: PriceBook = { spot: { BTC: '70000', ETH: '4000' }, mark: {}, loan: {} }
  const copied = planCash([margin], newer, plan, ['spot:BTC'])
  assert.equal(copied.externalNeeded, 136.37)
  assert.deepEqual(copied.stale, ['spot:ETH'])
  assert.deepEqual(copied.references.find((r) => r.asset === 'ETH'), {
    asset: 'ETH', basis: 'spot', start: 2000, end: 750,
  })
  assert.equal(planCash([margin], snapshot.book, { path: 'Base', target: '45000' }).externalNeeded, 0)
  const deeper = planCash([margin], newer, { ...plan, target: '35000' })
  assert.equal(deeper.externalNeeded, 1500)
  assert.equal(source.overrides.BTC, '45000')
  source.book.spot.ETH = '5000'
  assert.equal(planCash([margin], newer, plan).externalNeeded, 136.37)
})

test('funding survives the lowest collateral value between safe endpoints with a pinned altcoin', () => {
  const source = {
    book: { spot: { BTC: '1000', ETH: '100', SOL: '20' }, loan: {}, mark: {} },
    path: 'Severe' as const, overrides: { BTC: '200', SOL: '140' }, asOf: null,
  }
  const account: SpotAccount = {
    ...margin, debt: '90', holdings: [{ asset: 'ETH', quantity: '1' }, { asset: 'SOL', quantity: '1' }],
  }
  const plan = planFromScenario(source)
  const funded = planCash([account], source.book, plan)
  // Halfway through the move ETH reaches zero and SOL reaches 80. The
  // starting (120) and ending (140) gross assets both exceed the 99 boundary.
  assert.equal(funded.required, 17.28)
  assert.equal(funded.actions[0].safe, true)
  const limited = planCash([account], source.book, { ...plan, budget: '17.27' })
  assert.equal(limited.actions[0].safe, false)
  assert.equal(limited.uncovered, 0.01)
  const edited = planCash([account], source.book, { ...plan, target: '600' })
  assert.equal(edited.required, 0)
  assert.equal(edited.references.find((r) => r.asset === 'SOL')?.end, 140)
  assert.deepEqual(source.overrides, { BTC: '200', SOL: '140' })
})

test('the HYPE price floor can trigger a mixed margin account and determine its required transfer', () => {
  const source = {
    book: { spot: { BTC: '1000', HYPE: '100', SOL: '20' }, loan: {}, mark: {} },
    path: 'Severe' as const, overrides: { BTC: '500', SOL: '140' }, asOf: null,
  }
  const account: SpotAccount = {
    ...margin, debt: '100', holdings: [{ asset: 'HYPE', quantity: '1' }, { asset: 'SOL', quantity: '1' }],
  }
  // When BTC reaches 666.67, HYPE reaches zero and the manually adjusted SOL is worth 100.
  // This interior low crosses the 110 USDT liquidation threshold between two solvent endpoints.
  const end = buildScenario(source.book, source.path, source.overrides)
  assert.deepEqual([end.spot.HYPE, end.spot.SOL], ['0', '140'])
  const scenario = evaluate([account], end, source.path)
  assert.equal(scenario.firstLiquidation?.id, account.id)
  assert.equal(scenario.accounts[0].equityAtTrigger, 10)
  const draft = planFromScenario(source)
  const funded = planCash([account], source.book, draft)
  assert.deepEqual([funded.required, funded.actions[0].safe], [9.10, true])
  const underfunded = planCash([account], source.book, { ...draft, budget: '9.09' })
  assert.deepEqual([underfunded.uncovered, underfunded.actions[0].safe], [0.01, false])
})

test('an independent altcoin-only scenario uses the frozen BTC anchor and keeps the price override', () => {
  const source = { ...snapshot, path: 'Independent' as const, overrides: { ETH: '750' } }
  const plan = planFromScenario(source)
  assert.equal(plan.target, '60000')
  assert.deepEqual(plan.snapshot?.overrides, { ETH: '750' })
  assert.equal(planCash([margin], snapshot.book, { ...plan, target: '35000' }).required, 136.37)
})

test('a manually priced pledge scales the frozen index from its spot anchor and retains source staleness', () => {
  const wallet: CashSpotAccount = {
    id: 'reserves', name: 'Reserves', archived: false, updatedAt: '', kind: 'cashSpot',
    holdings: [{ asset: 'ETH', quantity: '1' }],
  }
  const plan = planFromScenario({
    ...snapshot, path: 'Independent', overrides: { ETH: '750' },
    book: { ...snapshot.book, loan: { ETH: '1800' } }, stale: ['spot:ETH', 'loan:ETH'],
  })
  const result = planCash([{ ...margin, debt: '2500' }, wallet], snapshot.book, {
    ...plan, pledges: [{
      accountId: wallet.id, asset: 'ETH', quantity: '1', borrowLtvPct: '50', liquidationLtvPct: '80',
    }],
  })
  assert.deepEqual(result.stale, ['spot:ETH', 'loan:ETH'])
  assert.deepEqual(
    [result.pledges[0].targetPrice, result.newDebt, result.required, result.externalNeeded],
    [675, 539.99, 1136.37, 596.38],
  )
})

test('a HYPE wallet pledge uses the linked loan index for borrowing capacity and external cash', () => {
  const wallet: CashSpotAccount = {
    kind: 'cashSpot', id: 'wallet', name: 'HYPE reserve', archived: false, updatedAt: '',
    holdings: [{ asset: 'HYPE', quantity: '10' }],
  }
  const book = { spot: { BTC: '60000', ETH: '2000', HYPE: '20' }, loan: { HYPE: '18' }, mark: {} }
  const pledge = {
    accountId: wallet.id, asset: 'HYPE', quantity: '10', borrowLtvPct: '80', liquidationLtvPct: '90',
  }
  for (const [path, indexAtTarget, capacity, external] of [
    ['Base', 14.94, 134.45, 274.65],
    ['Severe', 12.6, 113.39, 659.34],
  ] as const) {
    const result = planCash([{ ...margin, debt: '3500' }, wallet], book, {
      target: '54000', path, pledges: [pledge],
    })
    assert.deepEqual(result.missing, [])
    assert.equal(result.pledges[0].targetPrice, indexAtTarget)
    assert.equal(result.pledges[0].capacity, capacity)
    assert.equal(result.newDebt, capacity)
    assert.equal(result.externalNeeded, external)
  }
})
