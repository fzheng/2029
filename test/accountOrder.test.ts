import assert from 'node:assert/strict'
import { test } from 'node:test'
import { manualAccountOrder, moveVisibleAccount, sortAccountRows } from '../src/accountOrder'
import { evaluate } from '../src/engine'
import type { Account, SpotAccount } from '../src/model'
import type { AccountSort } from '../src/storage'

const positions: SpotAccount[] = [
  ['cash', 'Reserve 10', 'USDT', '100', '0'],
  ['loan', 'Reserve 2', 'BTC', '1', '50'],
  ['breached', 'Deficit', 'BTC', '1', '110'],
  ['unknown', 'Other asset', 'SOL', '1', '500'],
].map(([id, name, asset, quantity, debt], day) => ({
  id,
  name,
  kind: 'spot',
  archived: false,
  holdings: [{ asset, quantity }],
  debt,
  updatedAt: new Date(Date.UTC(2026, 0, day + 1)).toISOString(),
}))

test('account list sorting handles unknown values, negative equity, risk, numeric names and updated time', () => {
  const rows = evaluate(positions, { spot: { BTC: '100' }, mark: {}, loan: {} }).accounts
  const manual = ['unknown', 'loan', 'cash', 'breached']
  const sorted = (sort: AccountSort) =>
    sortAccountRows(rows, manual, sort, 'en-US').map((r) => r.account.id)
  assert.deepEqual(sorted('equity-desc'), ['cash', 'loan', 'breached', 'unknown'])
  assert.deepEqual(sorted('equity-asc'), ['breached', 'loan', 'cash', 'unknown'])
  assert.deepEqual(sorted('debt-desc'), ['unknown', 'breached', 'loan', 'cash'])
  assert.deepEqual(sorted('risk'), ['breached', 'loan', 'cash', 'unknown'])
  assert.deepEqual(sorted('updated'), ['unknown', 'breached', 'loan', 'cash'])
  assert.deepEqual(sorted('name-asc'), ['breached', 'unknown', 'loan', 'cash'])
  assert.deepEqual(sorted('manual'), manual)
  assert.deepEqual(
    rows.map((r) => r.account.id),
    positions.map((p) => p.id),
  )
})

test('filtered moves preserve archived slots and append newly added accounts in their original order', () => {
  const accounts: Account[] = positions.map((a) => ({ ...a, archived: a.id === 'loan' }))
  const order = manualAccountOrder(accounts, ['breached', 'loan', 'cash'])
  assert.deepEqual(order, ['breached', 'loan', 'cash', 'unknown'])
  const visible = ['breached', 'cash', 'unknown']
  assert.deepEqual(moveVisibleAccount(order, visible, 'unknown', 'breached'), [
    'unknown',
    'loan',
    'breached',
    'cash',
  ])
  assert.equal(moveVisibleAccount(order, visible, 'cash', 'loan'), order)
})
