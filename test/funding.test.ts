import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildScenario, evaluate, planCash, walletHoldings } from '../src/engine'
import type {
  Account,
  CashSpotAccount,
  LoanAccount,
  PledgeInput,
  PriceBook,
  SpotAccount,
} from '../src/model'

// Synthetic prices, balances, and loan terms exist only in this suite.
const wallet: CashSpotAccount = {
  id: 'wallet',
  name: 'Spot wallet',
  kind: 'cashSpot',
  archived: false,
  updatedAt: '',
  holdings: [
    { asset: 'USDT', quantity: '31.5' },
    { asset: 'ETH', quantity: '.7' },
    { asset: 'USDT', quantity: '18.5' },
    { asset: 'ETH', quantity: '.3' },
  ],
}
const loan: LoanAccount = {
  kind: 'loan',
  id: 'loan',
  name: 'Original loan',
  archived: false,
  updatedAt: '',
  asset: 'BTC',
  collateral: '1',
  debt: '700',
  warningLtv: '.8',
  liquidationLtv: '.9',
}
const margin: SpotAccount = {
  kind: 'spot',
  id: 'margin',
  name: 'Cross wallet',
  archived: false,
  updatedAt: '',
  holdings: [{ asset: 'BTC', quantity: '1.1' }],
  debt: '800',
}
const pledge: PledgeInput = {
  accountId: wallet.id,
  asset: 'ETH',
  quantity: '1',
  borrowLtvPct: '50',
  liquidationLtvPct: '80',
}
const book: PriceBook = {
  spot: { BTC: '1000', ETH: '440' },
  loan: { BTC: '1000', ETH: '400' },
  mark: {},
}
const target = { target: '500', path: 'Base' as const }

test('ordinary spot holdings use spot prices, par USDT, no debt, funding interest, warnings or liquidation levels', () => {
  const saved = structuredClone(wallet)
  assert.deepEqual(walletHoldings(wallet), [
    { asset: 'USDT', quantity: '50' },
    { asset: 'ETH', quantity: '1' },
  ])
  const live = evaluate([wallet], book)
  assert.deepEqual([live.equity, live.exposure, live.leverage, live.debt], [490, 490, 1, 0])
  const r = live.accounts[0]
  assert.deepEqual(
    [r.warningPrice, r.liquidationPrice, r.ltv, r.maintenance, r.distancePct],
    [null, null, null, null, null],
  )
  const stressed = evaluate([wallet], buildScenario(book, 'Severe', { BTC: '100' }), 'Severe')
  assert.equal(stressed.equity, 50)
  assert.equal(stressed.leverage, 1)
  assert.deepEqual([stressed.firstWarning, stressed.firstLiquidation], [null, null])
  assert.deepEqual(wallet, saved)
  assert.deepEqual(planCash([wallet], book, target).actions, [])
  assert.equal(evaluate([wallet], { ...book, spot: { BTC: '1000' } }).equity, null)
  assert.equal(
    evaluate([{ ...wallet, holdings: [{ asset: 'USDT', quantity: '10' }] }], {
      spot: {},
      mark: {},
      loan: {},
    }).equity,
    10,
  )
})

test('shared spot/pledge pools, stressed index cap and budget route exact source amounts in destination priority order', () => {
  const records = [loan, wallet, margin]
  const saved = JSON.stringify(records)
  const plan = planCash(records, book, {
    ...target,
    useSpotUsdt: true,
    pledges: [pledge],
    budget: '200',
  })
  // At target BTC = 500, ETH index = 100. At 80% liquidation LTV, principal must be strictly below 80.
  assert.deepEqual(
    [
      plan.required,
      plan.spotUsdtUsed,
      plan.newDebt,
      plan.externalNeeded,
      plan.externalUsed,
      plan.allocated,
      plan.uncovered,
    ],
    [550.02, 50, 79.99, 420.03, 200, 329.99, 220.03],
  )
  const [first, second] = plan.actions
  assert.deepEqual(
    first.sources.map((s) => [s.kind, s.accountId, s.asset, s.amount]),
    [
      ['spotUsdt', 'wallet', 'USDT', 50],
      ['pledge', 'wallet', 'ETH', 79.99],
      ['external', null, 'USDT', 170.02],
    ],
  )
  assert.deepEqual([first.accountId, first.required, first.safe], ['margin', 300.01, true])
  assert.deepEqual([second.accountId, second.sources[0].amount, second.safe], ['loan', 29.98, false])
  const [newLoan] = plan.pledges
  assert.deepEqual(
    [
      newLoan.capacity,
      newLoan.livePrice,
      newLoan.targetPrice,
      newLoan.pledgedQuantity,
      newLoan.borrowed,
      newLoan.targetLtv,
    ],
    [79.99, 400, 100, 1, 79.99, 0.7999],
  )
  assert.ok(newLoan.liquidationPrice! < 100)
  assert.deepEqual(plan.missing, [])
  assert.equal(JSON.stringify(records), saved)
})

test('wallet funding is opt-in; per-destination targets can access every active spot wallet without pooling archived accounts', () => {
  const wallets = [
    wallet,
    { ...wallet, id: 'wallet2', name: 'Second', holdings: [{ asset: 'USDT', quantity: '500' }] },
    { ...wallet, id: 'closed', archived: true },
  ]
  const records = [loan, ...wallets]
  const original = planCash(records, book, { ...target, accountId: 'loan' })
  assert.deepEqual(
    [original.required, original.externalNeeded, original.externalUsed, original.spotUsdtUsed],
    [250.01, 250.01, 250.01, 0],
  )
  const funded = planCash(records, book, {
    ...target,
    accountId: 'loan',
    useSpotUsdt: true,
    pledges: [pledge],
    budget: '0',
  })
  assert.deepEqual(
    [funded.externalNeeded, funded.externalUsed, funded.newDebt, funded.uncovered],
    [0, 0, 0, 0],
  )
  assert.deepEqual(
    funded.actions[0].sources.map((s) => [s.accountId, s.amount]),
    [
      ['wallet', 50],
      ['wallet2', 200.01],
    ],
  )
  assert.deepEqual(
    [funded.pledges[0].pledgedQuantity, funded.pledges[0].unusedQuantity, funded.pledges[0].borrowed],
    [0, 1, 0],
  )
})

test('minimum loan draw funds several destinations, leaves the unspent proceeds once, and uses only pledged quantity', () => {
  const accounts = [wallet, { ...loan, debt: '450.005' }, { ...loan, id: 'loan2', debt: '450.012' }]
  const offer = { ...pledge, quantity: '.5', minBorrowUsdt: '10.001', maxBorrowUsdt: '20.005' }
  const plan = planCash(accounts, book, { ...target, pledges: [offer], budget: '0' })
  const p = plan.pledges[0]
  assert.deepEqual(
    [plan.required, plan.externalNeeded, plan.allocated, plan.newDebt],
    [0.03, 0, 0.03, 10.01],
  )
  assert.deepEqual(
    [p.pledgedQuantity, p.capacity, p.proceedsUsed, p.unspentProceeds, p.targetLtv],
    [0.5, 20, 0.03, 9.98, 0.2002],
  )
  assert.deepEqual(
    plan.actions.map((a) => a.sources[0].amount),
    [0.01, 0.02],
  )
})

test('borrow caps use live/target loan indices, initial LTV, optional exchange product limits and strict cent rounding', () => {
  const records = [wallet, loan]
  const solve = (changes: Partial<PledgeInput>, targetBTC = '500') =>
    planCash(records, book, { ...target, target: targetBTC, pledges: [{ ...pledge, ...changes }] })
  assert.equal(solve({ borrowLtvPct: '7.001' }, '900').pledges[0].capacity, 28)
  assert.equal(solve({ maxBorrowUsdt: '25.999' }).pledges[0].capacity, 25.99)
  for (const [changes, reason] of [
    [{ minCollateralUsdt: '401' }, 'collateralLimit'],
    [{ maxCollateralUsdt: '399.99' }, 'collateralLimit'],
    [{ minBorrowUsdt: '80' }, 'borrowMinimum'],
  ] as const) {
    const plan = solve(changes)
    assert.deepEqual(
      [
        plan.pledges[0].unavailableReason,
        plan.pledges[0].pledgedQuantity,
        plan.externalNeeded,
        plan.missing,
      ],
      [reason, 0, 250.01, []],
    )
  }
  const floor = solve({}, '300')
  assert.deepEqual(
    [floor.pledges[0].capacity, floor.pledges[0].unavailableReason, floor.pledges[0].targetLtv],
    [0, 'stressLimit', null],
  )
})

test('pledges reject overspend, duplicate sources, USDT collateral, inactive sources, illegal LTVs and missing index references', () => {
  const solve = (accounts: Account[], pledges: PledgeInput[], q = book) =>
    planCash(accounts, q, { ...target, pledges })
  const accounts = [wallet, loan]
  const invalid = [
    solve(accounts, [pledge, pledge]),
    solve(accounts, [{ ...pledge, quantity: '1.000001' }]),
    solve(accounts, [{ ...pledge, asset: 'USDT' }]),
    solve([{ ...wallet, archived: true }, loan], [pledge]),
    solve(accounts, [{ ...pledge, borrowLtvPct: '81' }]),
    solve(accounts, [{ ...pledge, liquidationLtvPct: '101' }]),
    solve(accounts, [{ ...pledge, minBorrowUsdt: '20', maxBorrowUsdt: '10' }]),
  ]
  for (const plan of invalid) {
    assert.equal(plan.required, null)
    assert.equal(plan.newDebt, null)
    assert.ok(plan.missing.length)
  }
  const partial = solve(accounts, [pledge], { ...book, loan: { BTC: '1000' } })
  assert.deepEqual(partial.missing, ['ETH loan reference'])
  assert.equal(partial.externalNeeded, null)
  const stale = planCash(accounts, book, { ...target, pledges: [pledge] }, [
    'loan:ETH',
    'spot:ETH',
    'mark:BTC',
    'spot:BTC',
  ])
  assert.deepEqual(stale.stale, ['loan:ETH', 'spot:BTC'])
  assert.equal(stale.pledges[0].capacity, 79.99)
})

test('a blocked source defers to the next eligible collateral offer; currency in different wallets stays distinct', () => {
  const second = { ...wallet, id: 'other', name: 'Other wallet' }
  const plan = planCash([wallet, second, loan], book, {
    ...target,
    pledges: [
      { ...pledge, minBorrowUsdt: '1000' },
      { ...pledge, accountId: 'other' },
    ],
    budget: '0',
  })
  assert.deepEqual(
    plan.pledges.map((p) => [p.accountId, p.borrowed, p.pledgedQuantity]),
    [
      ['wallet', 0, 0],
      ['other', 79.99, 1],
    ],
  )
  assert.deepEqual(
    plan.actions[0].sources.map((s) => s.accountId),
    ['other'],
  )
  assert.equal(plan.externalNeeded, 170.02)
})
