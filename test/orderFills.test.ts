import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildScenario, evaluate, planCash } from '../src/engine'
import { previewOrderFills } from '../src/orderFills'
import type { Account, PendingOrder, PerpAccount, PriceBook, SpotAccount } from '../src/model'

const common = { name: 'Synthetic account', archived: false, updatedAt: '2020-01-01T00:00:00Z' }
const cross: SpotAccount = {
  ...common,
  id: 'cross',
  kind: 'spot',
  debt: '10',
  holdings: [
    { asset: 'BTC', quantity: '.1' },
    { asset: 'USDT', quantity: '12.50' },
    { asset: 'BTC', quantity: '.2' },
    { asset: 'USDT', quantity: '7.50000000000000000001' },
  ],
}
const perp: PerpAccount = {
  ...common,
  id: 'perp',
  kind: 'perp',
  asset: 'BTC',
  side: 'long',
  size: '2',
  entry: '100',
  margin: '80',
  takerFee: '.0006',
  maintenanceRate: '.01',
  maintenanceOffset: '0',
}
const quotes: PriceBook = { spot: { BTC: '180' }, mark: { BTC: '105' }, loan: {} }
const order = (fields: Partial<PendingOrder> = {}): PendingOrder => ({
  id: 'first',
  accountId: 'cross',
  asset: 'BTC',
  side: 'buy',
  quantity: '.25',
  limitPrice: '100',
  ...fields,
})
function fill(accounts: Account[], orders: PendingOrder[]) {
  return previewOrderFills(accounts, orders, new Set(orders.map((o) => o.id)))
}
const holdings = (account: Account) => {
  assert.equal(account.kind, 'spot')
  return Object.fromEntries(account.holdings.map((h) => [h.asset, h.quantity]))
}

test('limit buy consumes wallet USDT before borrowing; the portfolio uses spot last to value the fill', () => {
  const buy = order({ feeUsdt: '1.25', autoBorrow: true })
  const initial = structuredClone(cross)
  const preview = fill([cross], [buy])
  const [account] = preview.accounts
  assert.equal(account.kind, 'spot')
  assert.deepEqual(holdings(account), { BTC: '0.55', USDT: '0' })
  assert.equal(account.debt, '16.24999999999999999999')
  assert.equal(preview.errors.size, 0)
  assert.deepEqual([...preview.filledIds], ['first'])
  const totals = evaluate(preview.accounts, quotes)
  assert.equal(totals.equity, 82.75)
  assert.equal(totals.exposure, 99)
  assert.equal(totals.accounts[0].liquidationPrice, 32.5)
  assert.deepEqual(cross, initial)
  assert.equal(fill([cross], [{ ...buy, autoBorrow: false }]).errors.get('first'), 'insufficientUsdt')
})

test('limit sells use owned base only, deduct the fee and optionally repay from net proceeds', () => {
  const sell = order({
    side: 'sell',
    quantity: '.2',
    limitPrice: '120',
    feeUsdt: '1.5',
    autoRepay: true,
  })
  const [paid] = fill([cross], [sell]).accounts
  assert.equal(paid.kind, 'spot')
  assert.equal(paid.debt, '0')
  assert.deepEqual(holdings(paid), { BTC: '0.1', USDT: '32.50000000000000000001' })
  const [unpaid] = fill([cross], [{ ...sell, autoRepay: false }]).accounts
  assert.equal(unpaid.kind, 'spot')
  assert.equal(unpaid.debt, '10')
  assert.equal(holdings(unpaid).USDT, '42.50000000000000000001')

  const [smallSale] = fill([cross], [{ ...sell, quantity: '.05' }]).accounts
  assert.equal(smallSale.kind, 'spot')
  assert.equal(smallSale.debt, '5.5')
  assert.equal(holdings(smallSale).USDT, '20.00000000000000000001')
  assert.equal(fill([cross], [{ ...sell, quantity: '.31' }]).errors.get('first'), 'insufficientAsset')
  assert.equal(fill([cross], [{ ...sell, feeUsdt: '45' }]).errors.get('first'), 'insufficientUsdt')
})

test('isolated orders net against long and short positions, realizing P&L only on the closed size', () => {
  const cases = [
    {
      position: 'long',
      side: 'buy',
      quantity: '1',
      price: '106',
      size: '3',
      entry: '102',
      direction: 'long',
      margin: '78',
      equity: 87,
    },
    {
      position: 'long',
      side: 'sell',
      quantity: '.5',
      price: '110',
      size: '1.5',
      entry: '100',
      direction: 'long',
      margin: '83',
      equity: 90.5,
    },
    {
      position: 'long',
      side: 'sell',
      quantity: '3',
      price: '110',
      size: '1',
      entry: '110',
      direction: 'short',
      margin: '98',
      equity: 103,
    },
    {
      position: 'short',
      side: 'sell',
      quantity: '1',
      price: '94',
      size: '3',
      entry: '98',
      direction: 'short',
      margin: '78',
      equity: 57,
    },
    {
      position: 'short',
      side: 'buy',
      quantity: '.5',
      price: '90',
      size: '1.5',
      entry: '100',
      direction: 'short',
      margin: '83',
      equity: 75.5,
    },
    {
      position: 'short',
      side: 'buy',
      quantity: '3',
      price: '90',
      size: '1',
      entry: '90',
      direction: 'long',
      margin: '98',
      equity: 113,
    },
  ] as const
  for (const o of cases) {
    const previous = { ...perp, side: o.position }
    const preview = fill(
      [previous],
      [
        order({
          accountId: 'perp',
          side: o.side,
          quantity: o.quantity,
          limitPrice: o.price,
          feeUsdt: '2',
        }),
      ],
    )
    const [result] = preview.accounts
    assert.equal(preview.errors.size, 0)
    assert.equal(result.kind, 'perp')
    assert.deepEqual(
      [result.size, result.entry, result.side, result.margin],
      [o.size, o.entry, o.direction, o.margin],
    )
    assert.equal(evaluate(preview.accounts, quotes).equity, o.equity)
    assert.equal(previous.size, '2')
  }
  const loss = order({ accountId: 'perp', side: 'sell', quantity: '2', limitPrice: '59.99' })
  assert.equal(fill([perp], [loss]).errors.get('first'), 'insufficientMargin')
})

test('full closure keeps realized isolated cash, removes the mark requirement and can precede reopening', () => {
  const noMark: PriceBook = { spot: {}, mark: {}, loan: {} }
  for (const [price, margin] of [
    ['60', 0],
    ['110', 100],
  ] as const) {
    const close = order({ accountId: 'perp', side: 'sell', quantity: '2', limitPrice: price })
    const flat = fill([perp], [close]).accounts
    assert.equal(flat[0].kind, 'perp')
    assert.deepEqual([flat[0].size, flat[0].entry, flat[0].margin], ['0', '0', String(margin)])
    for (const book of [noMark, buildScenario(quotes, 'Independent', { BTC: '0' })]) {
      const v = evaluate(flat, book)
      assert.deepEqual(
        [v.equity, v.exposure, v.missing, v.firstLiquidation, v.firstWarning],
        [margin, 0, [], null, null],
      )
      assert.equal(v.accounts[0].status, 'Safe')
    }
    const plan = planCash(flat, noMark, { target: '70', path: 'Independent' })
    assert.deepEqual([plan.required, plan.missing, plan.actions[0].safe], [0, [], true])
    const reopen = order({
      id: 'next',
      accountId: 'perp',
      side: 'sell',
      quantity: '.75',
      limitPrice: '120',
    })
    const [newPosition] = fill([perp], [close, reopen]).accounts
    assert.equal(newPosition.kind, 'perp')
    assert.deepEqual(
      [newPosition.side, newPosition.entry, newPosition.size, newPosition.margin],
      ['short', '120', '0.75', String(margin)],
    )
  }
})

test('saved sequence determines fills; a failed account rolls back while independent accounts still fill', () => {
  const initial = structuredClone([cross, perp])
  const buy = order({ quantity: '.1' })
  const sell = order({ id: 'second', side: 'sell', quantity: '.35' })
  const increase = order({ id: 'perpBuy', accountId: 'perp', quantity: '1' })
  const orders = [buy, sell, increase]
  const selected = new Set(['perpBuy', 'second', 'first'])
  const valid = previewOrderFills([cross, perp], orders, selected)
  assert.equal(valid.filledIds.size, 3)
  assert.equal(holdings(valid.accounts[0]).BTC, '0.05')
  const invalid = previewOrderFills([cross, perp], [buy, { ...sell, quantity: '1' }, increase], selected)
  assert.equal(invalid.accounts[0], cross)
  assert.equal(invalid.errors.get('second'), 'insufficientAsset')
  assert.deepEqual([...invalid.filledIds], ['perpBuy'])
  assert.deepEqual(invalid.accounts[1], valid.accounts[1])
  assert.equal(
    previewOrderFills([cross, perp], orders, new Set(['second'])).errors.get('second'),
    'insufficientAsset',
  )
  const unchecked = previewOrderFills([cross, perp], orders, new Set())
  assert.deepEqual(unchecked.accounts, initial)
  assert.deepEqual([cross, perp], initial)
})

test('ineligible accounts and malformed, mismatched or unsupported fills never apply', () => {
  const unavailable: Account[] = [
    { ...perp, archived: true },
    { ...common, id: 'cross', kind: 'cashSpot', holdings: [] },
  ]
  for (const accountId of ['perp', 'cross', 'missing']) {
    const invalid = fill(unavailable, [order({ accountId })])
    assert.deepEqual(invalid.accounts, unavailable)
    assert.equal(invalid.errors.get('first'), 'unavailableAccount')
  }
  for (const fields of [
    { quantity: '0' },
    { limitPrice: 'Infinity' },
    { feeUsdt: '-1' },
    { asset: 'USDT' },
    { accountId: 'perp', asset: 'ETH' },
    { accountId: 'perp', autoBorrow: true },
  ]) {
    const invalid = fill([cross, perp], [order(fields)])
    assert.equal(invalid.errors.get('first'), 'invalidOrder')
    assert.deepEqual(invalid.accounts, [cross, perp])
  }
})
