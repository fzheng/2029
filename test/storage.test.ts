import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type AccountView,
  clearPortfolio,
  deletePlan,
  exportBackup,
  importBackup,
  loadPortfolio,
  parseBackup,
  removePendingOrders,
  saveAccount,
  saveAccountView,
  savePendingOrder,
  savePlan,
  saveScenario,
} from '../src/storage'
import type { Account, PendingOrder, PerpAccount } from '../src/model'

const timestamp = '2026-01-01T00:00:00.000Z'
const account: Account = {
  id: 'spot-test',
  name: 'Test cross',
  kind: 'spot',
  archived: false,
  updatedAt: timestamp,
  holdings: [{ asset: 'ETH', quantity: '2.00000000000000001' }],
  debt: '1500',
}
const plan = { id: 'plan-test', name: 'Target', data: { target: '35000', path: 'Base' } }
const scenario = {
  id: 'scenario-test',
  name: 'Move',
  data: {
    path: 'Severe',
    overrides: { ETH: '0' },
    symbols: ['ETH'],
    asOf: timestamp,
    book: { spot: { ETH: '1500' }, mark: {}, loan: {} },
  },
}

test('empty browser, exact edits, archive, backup, and clear with a stale writer', async () => {
  const first = await loadPortfolio()
  assert.deepEqual(first, {
    revision: 0,
    generation: 0,
    accounts: [],
    plans: [],
    scenarios: [],
    lastBalanceEdit: null,
  })
  assert.deepEqual(await loadPortfolio(), first)

  const saved = await saveAccount(account, first.revision)
  assert.ok(saved.lastBalanceEdit)
  const edited = await saveAccount(
    { ...account, holdings: [{ asset: 'ETH', quantity: '3.00000000000000005' }] },
    saved.revision,
  )
  assert.equal(edited.accounts.length, 1)
  assert.deepEqual(await loadPortfolio(), edited)
  const archived = await saveAccount({ ...edited.accounts[0], archived: true }, edited.revision)
  const withPlan = await savePlan(plan, archived.revision)
  const before = await saveScenario(scenario, withPlan.revision)
  assert.deepEqual(before.accounts, archived.accounts)
  assert.equal(before.lastBalanceEdit, archived.lastBalanceEdit)
  const backup = parseBackup(exportBackup(before))

  // An old tab already holds this snapshot when another tab confirms a clear.
  const old = await loadPortfolio()
  assert.deepEqual(old, before)
  const cleared = await clearPortfolio(before.revision)
  assert.equal(cleared.generation, before.generation + 1)
  assert.deepEqual(cleared.accounts, [])
  assert.deepEqual(cleared.plans, [])
  assert.deepEqual(cleared.scenarios, [])
  assert.equal(cleared.lastBalanceEdit, null)
  await assert.rejects(saveAccount(old.accounts[0], old.revision), /changed/)
  await assert.rejects(saveScenario(old.scenarios[0], old.revision), /changed/)
  await assert.rejects(savePlan(old.plans[0], old.revision), /changed/)
  await assert.rejects(importBackup(backup, old.revision), /changed/)
  assert.deepEqual(await loadPortfolio(), cleared)

  const fresh = await saveAccount({ ...account, id: 'new-account' }, cleared.revision)
  assert.deepEqual(
    (await loadPortfolio()).accounts.map((a) => a.id),
    ['new-account'],
  )
  const restored = await importBackup(backup, fresh.revision)
  assert.equal(restored.generation, cleared.generation + 1)
  assert.deepEqual(restored.accounts, before.accounts)
  assert.deepEqual(restored.plans, before.plans)
  assert.deepEqual(restored.scenarios, before.scenarios)
  const stored = restored.accounts[0]
  assert.equal(stored.kind === 'spot' && stored.holdings[0].quantity, '3.00000000000000005')
  assert.equal(stored.archived, true)
})

test('concurrent writers with the same starting revision cannot silently overwrite', async () => {
  const first = await loadPortfolio()
  const writes = await Promise.allSettled([
    saveAccount({ ...account, id: 'writer-a' }, first.revision),
    saveAccount({ ...account, id: 'writer-b' }, first.revision),
  ])
  assert.equal(writes.filter((w) => w.status === 'fulfilled').length, 1)
  assert.equal((await loadPortfolio()).revision, first.revision + 1)
})

test('account sorting round-trips independently of balances, account allocation order and old backups', async () => {
  const records = [account, { ...account, id: 'archived', archived: true }, { ...account, id: 'new' }]
  const legacyBackup = {
    app: '2029',
    version: 1,
    accounts: records,
    plans: [plan],
    scenarios: [scenario],
    lastBalanceEdit: timestamp,
  }
  const legacy = parseBackup(JSON.stringify(legacyBackup))
  const initial = await importBackup(legacy, (await loadPortfolio()).revision)
  const view: AccountView = { sort: 'equity-desc', order: ['archived', account.id] }
  const saved = await saveAccountView(view, initial.revision)
  assert.deepEqual(saved, { ...initial, revision: initial.revision + 1, accountView: view })
  assert.deepEqual(await loadPortfolio(), saved)
  const backup = parseBackup(exportBackup(saved))
  assert.deepEqual(backup, { ...legacyBackup, accountView: view })

  const withNew = await saveAccount({ ...account, id: 'fourth' }, saved.revision)
  assert.deepEqual(withNew.accountView, view)
  await assert.rejects(saveAccountView({ sort: 'updated', order: [] }, saved.revision), /changed/)
  assert.deepEqual((await loadPortfolio()).accountView, view)
  const cleared = await clearPortfolio(withNew.revision)
  assert.equal('accountView' in cleared, false)
  const restored = await importBackup(backup, cleared.revision)
  assert.deepEqual(parseBackup(exportBackup(restored)), backup)
  const restoredLegacy = await importBackup(legacy, restored.revision)
  assert.equal('accountView' in restoredLegacy, false)
  assert.deepEqual(parseBackup(exportBackup(restoredLegacy)), legacyBackup)
})

test('invalid display orders are rejected atomically on save and import', async () => {
  const before = await saveAccount(account, (await loadPortfolio()).revision)
  const backup = parseBackup(exportBackup(before))
  const id = account.id
  for (const invalid of [
    { sort: 'unknown', order: [] },
    { sort: 'manual', order: 'first' },
    { sort: 'manual', order: [id, id] },
    { sort: 'name-asc', order: ['unknown-id'] },
    { sort: 'risk', order: [null] },
  ]) {
    const view = invalid as AccountView
    await assert.rejects(saveAccountView(view, before.revision), /invalid/)
    assert.throws(() => parseBackup(JSON.stringify({ ...backup, accountView: view })), /invalid/)
    assert.throws(() => importBackup({ ...backup, accountView: view }, before.revision), /invalid/)
  }
  assert.deepEqual(await loadPortfolio(), before)
})

test('invalid backup is rejected before any write', async () => {
  const before = await loadPortfolio()
  const backup = parseBackup(exportBackup(before))
  assert.throws(() => parseBackup('{"accounts":'), /valid JSON/)
  for (const invalid of [
    { ...backup, version: 0 },
    { ...backup, accounts: [account, account] },
    { ...backup, accounts: [{ ...account, holdings: [{ asset: 'ETH', quantity: '-1' }] }] },
    { ...backup, plans: [{ ...plan, data: { target: 'NaN', path: 'Severe' } }] },
    { ...backup, scenarios: [{ ...scenario, data: { ...scenario.data, overrides: { ETH: '1e999' } } }] },
  ])
    assert.throws(() => parseBackup(JSON.stringify(invalid)))
  assert.deepEqual(await loadPortfolio(), before)
})

test('a saved frozen funding plan restores its price bases, overrides and quote age across backup import', async () => {
  const before = await loadPortfolio()
  const snapshot = {
    book: { spot: { BTC: '60000', ETH: '2000' }, mark: { ETH: '2001' }, loan: { ETH: '1999' } },
    asOf: timestamp,
    stale: ['loan:ETH'],
    overrides: { ETH: '700.00000001' },
  }
  const frozen = { id: 'frozen-plan', name: 'ETH override', data: { target: '35000', path: 'Severe', snapshot } }
  const saved = await savePlan(frozen, before.revision)
  const backup = parseBackup(exportBackup(saved))
  for (const invalid of [
    { ...snapshot, book: { ...snapshot.book, mark: { ETH: '-2001' } } },
    { ...snapshot, stale: ['future:ETH'] },
    // A frozen plan prices BTC from its own target and uses USDT as its unit of account.
    { ...snapshot, overrides: { BTC: '44000' } },
    { ...snapshot, overrides: { USDT: '0.9' } },
  ]) {
    const badPlan = { ...frozen, data: { ...frozen.data, snapshot: invalid } }
    assert.throws(() => parseBackup(JSON.stringify({ ...backup, plans: [badPlan] })), /invalid/)
    await assert.rejects(savePlan(badPlan, saved.revision), /valid inputs/)
  }
  assert.deepEqual(await loadPortfolio(), saved)
  const cleared = await clearPortfolio(saved.revision)
  const restored = await importBackup(backup, cleared.revision)
  assert.deepEqual(restored.plans.find((p) => p.id === frozen.id), frozen)
  assert.deepEqual(restored.accounts, before.accounts)
  assert.equal(restored.lastBalanceEdit, before.lastBalanceEdit)
})

test('perpetual tier schedules survive archive, restore, and export; an invalid tier or loan setting is rejected', async () => {
  const position: Account = {
    id: 'position-test',
    name: 'Test isolated',
    updatedAt: timestamp,
    archived: false,
    kind: 'perp',
    asset: 'SOL',
    margin: '100',
    entry: '50',
    size: '2.00',
    side: 'long',
    maintenanceRate: '.004',
    takerFee: '.0006',
    maintenanceOffset: '0',
    tiers: [
      { min: '0', max: '2000', rate: '.004' },
      { min: '2000', max: '4000', rate: '.01' },
    ],
  }
  const saved = await saveAccount(position, (await loadPortfolio()).revision)
  const archived = await saveAccount({ ...position, archived: true }, saved.revision)
  const visible = await saveAccount({ ...position, archived: false }, archived.revision)
  const restored = parseBackup(exportBackup(visible)).accounts.find((a) => a.id === position.id)
  assert.equal(restored?.archived, false)
  assert.deepEqual(restored?.kind === 'perp' && restored.tiers, position.tiers)
  const snapshot = exportBackup(visible)
  const invalidTiers = { ...position, tiers: [{ min: '50', max: '100', rate: '0.01' }] }
  await assert.rejects(saveAccount(invalidTiers, visible.revision), /values/)
  const invalidLoan: Account = {
    kind: 'loan',
    id: 'loan-test',
    name: 'Invalid loan',
    archived: false,
    updatedAt: timestamp,
    asset: 'BTC',
    collateral: '0.1',
    debt: '1000',
    warningLtv: '0.91',
    liquidationLtv: '0.85',
  }
  await assert.rejects(saveAccount(invalidLoan, visible.revision), /values/)
  assert.equal(exportBackup(await loadPortfolio()), snapshot)
})

test('ordinary spot wallets and hypothetical funding choices round-trip without changing actual holdings', async () => {
  const wallet: Account = {
    kind: 'cashSpot',
    id: 'free-spot',
    name: 'Spot · 我的钱包',
    updatedAt: timestamp,
    archived: false,
    holdings: [
      { asset: 'BTC', quantity: '0.1234500001' },
      { asset: 'ETH', quantity: '4' },
      { asset: 'BNB', quantity: '2' },
      { asset: 'SOL', quantity: '3.000' },
      { asset: 'USDT', quantity: '1234.01' },
      { asset: 'LINK', quantity: '18' },
    ],
  }
  const added = await saveAccount(wallet, (await loadPortfolio()).revision)
  const edited = await saveAccount(
    {
      ...wallet,
      holdings: wallet.holdings.map((h) => (h.asset === 'LINK' ? { ...h, quantity: '19.50' } : h)),
    },
    added.revision,
  )
  const storedWallet = edited.accounts.find((a) => a.id === wallet.id)!
  const pledge = {
    accountId: wallet.id,
    asset: 'ETH',
    quantity: '1.0000',
    borrowLtvPct: '65.50',
    liquidationLtvPct: '91',
    minBorrowUsdt: '0',
    maxBorrowUsdt: '10000',
    minCollateralUsdt: '10',
    maxCollateralUsdt: '2000',
  }
  const funding = {
    id: 'funding-test',
    name: 'BTC / 35k',
    data: { ...plan.data, useSpotUsdt: true, pledges: [pledge] },
  }
  const planned = await savePlan(funding, edited.revision)
  assert.deepEqual(planned.accounts, edited.accounts)
  assert.equal(planned.lastBalanceEdit, edited.lastBalanceEdit)
  assert.deepEqual(await loadPortfolio(), planned)

  const archived = await saveAccount({ ...storedWallet, archived: true }, planned.revision)
  const backup = parseBackup(exportBackup(archived))
  const cleared = await clearPortfolio(archived.revision)
  const imported = await importBackup(backup, cleared.revision)
  const oldWallet = imported.accounts.find((a) => a.id === wallet.id)!
  assert.deepEqual(
    oldWallet,
    archived.accounts.find((a) => a.id === wallet.id),
  )
  assert.equal(oldWallet.archived, true)
  assert.deepEqual(
    imported.plans.find((p) => p.id === funding.id),
    funding,
  )
  const restored = await saveAccount({ ...oldWallet, archived: false }, imported.revision)
  const active = restored.accounts.find((a) => a.id === wallet.id)!
  assert.equal(active.kind, 'cashSpot')
  assert.deepEqual(active.holdings, storedWallet.kind === 'cashSpot' && storedWallet.holdings)
  assert.equal('debt' in active, false)
  assert.equal('increment' in active, false)
  assert.equal(active.archived, false)

  const oldBackup = {
    app: '2029',
    version: 1,
    accounts: [account],
    plans: [plan],
    scenarios: [],
    lastBalanceEdit: timestamp,
  }
  assert.deepEqual(parseBackup(JSON.stringify(oldBackup)), oldBackup)
})

test('backup and save reject invalid wallet funding and contradictory ordinary wallet records', async () => {
  const before = await loadPortfolio()
  const backup = parseBackup(exportBackup(before))
  const row = {
    accountId: 'wallet',
    asset: 'BTC',
    quantity: '.25',
    borrowLtvPct: '60',
    liquidationLtvPct: '90',
  }
  const invalidRows = [
    { ...row, accountId: '' },
    { ...row, asset: 'USDT' },
    { ...row, asset: 'btc' },
    { ...row, quantity: '0' },
    { ...row, quantity: '-1' },
    { ...row, quantity: 'Infinity' },
    { ...row, borrowLtvPct: '0' },
    { ...row, borrowLtvPct: '90' },
    { ...row, liquidationLtvPct: '101' },
    { ...row, minBorrowUsdt: '-1' },
    { ...row, maxBorrowUsdt: '0' },
    { ...row, minBorrowUsdt: '3', maxBorrowUsdt: '2' },
    { ...row, minCollateralUsdt: '4', maxCollateralUsdt: '3' },
    { ...row, maxCollateralUsdt: 'NaN' },
  ]
  const invalidPlans = [
    { ...plan.data, pledges: 'invalid' },
    { ...plan.data, useSpotUsdt: 'true' },
    { ...plan.data, pledges: [row, row] },
    ...invalidRows.map((r) => ({ ...plan.data, pledges: [r] })),
  ]
  for (const data of invalidPlans) {
    const bad = { ...plan, data }
    assert.throws(() => parseBackup(JSON.stringify({ ...backup, plans: [bad] })), /invalid or duplicate/)
    await assert.rejects(savePlan(bad, before.revision), /valid inputs/)
  }
  for (const account of [
    { kind: 'cashSpot', holdings: [{ asset: 'BTC', quantity: '-1' }] },
    { kind: 'cashSpot', holdings: [], debt: '1500' },
  ]) {
    assert.throws(
      () =>
        parseBackup(
          JSON.stringify({
            ...backup,
            accounts: [
              { ...account, id: 'bad-wallet', name: 'Spot', archived: false, updatedAt: timestamp },
            ],
          }),
        ),
      /invalid or duplicate/,
    )
  }
  assert.deepEqual(await loadPortfolio(), before)
})

const contract: PerpAccount = {
  id: 'eth-contract',
  kind: 'perp',
  name: 'ETH long',
  archived: false,
  updatedAt: timestamp,
  asset: 'ETH',
  side: 'long',
  size: '2',
  entry: '1500',
  margin: '1000',
  maintenanceRate: '.01',
  takerFee: '.0006',
  maintenanceOffset: '0',
}
const buy: PendingOrder = {
  id: 'buy-order',
  accountId: account.id,
  asset: 'ETH',
  side: 'buy',
  quantity: '0.12345678901234567',
  limitPrice: '1000.00',
  feeUsdt: '.02',
  autoBorrow: true,
}
const sell: PendingOrder = {
  id: 'sell-order',
  accountId: contract.id,
  asset: 'ETH',
  side: 'sell',
  quantity: '1.25',
  limitPrice: '2000',
}

test('pending orders round-trip in original fill order independently from balances and transient selections', async () => {
  const legacy = parseBackup(
    JSON.stringify({
      app: '2029',
      version: 1,
      accounts: [account, contract],
      plans: [],
      scenarios: [],
      lastBalanceEdit: timestamp,
    }),
  )
  const start = await importBackup(legacy, (await loadPortfolio()).revision)
  const first = await savePendingOrder(buy, start.revision)
  const second = await savePendingOrder(sell, first.revision)
  const editedBuy = { ...buy, quantity: '0.2000000000000000001' }
  const edited = await savePendingOrder(editedBuy, second.revision)
  assert.deepEqual(edited.pendingOrders, [editedBuy, sell])
  assert.deepEqual(edited.accounts, start.accounts)
  assert.equal(edited.lastBalanceEdit, start.lastBalanceEdit)
  assert.deepEqual(await loadPortfolio(), edited)
  assert.deepEqual(parseBackup(exportBackup(edited)).pendingOrders, [editedBuy, sell])

  const archived = await saveAccount({ ...contract, archived: true }, edited.revision)
  const backup = parseBackup(exportBackup(archived))
  assert.deepEqual(backup.pendingOrders, edited.pendingOrders)
  const restored = await saveAccount(contract, archived.revision)
  assert.deepEqual(restored.pendingOrders, edited.pendingOrders)
  await assert.rejects(savePendingOrder(buy, edited.revision), /changed/)
  await assert.rejects(removePendingOrders([buy.id], edited.revision), /changed/)
  const one = await removePendingOrders([buy.id], restored.revision)
  assert.deepEqual(one.pendingOrders, [sell])
  const cleared = await clearPortfolio(one.revision)
  assert.deepEqual(cleared.pendingOrders ?? [], [])
  const imported = await importBackup(backup, cleared.revision)
  assert.deepEqual(parseBackup(exportBackup(imported)), backup)
  const removed = await removePendingOrders([buy.id, sell.id], imported.revision)
  assert.deepEqual(removed.pendingOrders, [])
  assert.deepEqual(removed.accounts, imported.accounts)
  assert.equal(removed.lastBalanceEdit, imported.lastBalanceEdit)
  const renewed = await savePendingOrder(buy, removed.revision)
  const importedOld = await importBackup(legacy, renewed.revision)
  assert.equal('pendingOrders' in importedOld, false)
  assert.deepEqual(parseBackup(exportBackup(importedOld)), legacy)
})

test('invalid orders and incompatible contract changes are rejected atomically', async () => {
  const wallet: Account = {
    id: 'cash-wallet',
    name: 'USDT wallet',
    archived: false,
    updatedAt: timestamp,
    kind: 'cashSpot',
    holdings: [],
  }
  const legacy = parseBackup(
    JSON.stringify({
      app: '2029',
      version: 1,
      accounts: [account, wallet, contract],
      plans: [],
      scenarios: [],
      lastBalanceEdit: timestamp,
    }),
  )
  const initial = await importBackup(legacy, (await loadPortfolio()).revision)
  const saved = await savePendingOrder(sell, initial.revision)
  const invalidRows = [
    { ...buy, id: '' },
    { ...buy, accountId: 'unknown' },
    { ...buy, accountId: wallet.id },
    { ...buy, side: 'long' },
    { ...buy, asset: 'USDT' },
    { ...sell, asset: 'BTC' },
    { ...buy, quantity: '0' },
    { ...buy, limitPrice: '-10' },
    { ...buy, quantity: '1e999' },
    { ...buy, feeUsdt: '-.01' },
    { ...buy, autoRepay: true },
    { ...buy, side: 'sell' },
    { ...sell, autoBorrow: true },
    { ...buy, autoBorrow: 'true' },
    { ...buy, selected: true },
  ]
  for (const order of invalidRows) {
    await assert.rejects(savePendingOrder(order as PendingOrder, saved.revision), /pending order/)
    assert.throws(() => parseBackup(JSON.stringify({ ...legacy, pendingOrders: [order] })), /invalid/)
  }
  assert.throws(() => parseBackup(JSON.stringify({ ...legacy, pendingOrders: [buy, buy] })), /duplicate/)
  await assert.rejects(
    saveAccount({ ...contract, asset: 'SOL' }, saved.revision),
    /Remove the pending orders/,
  )
  await assert.rejects(
    saveAccount({ ...account, id: contract.id }, saved.revision),
    /Remove the pending orders/,
  )
  assert.deepEqual(await loadPortfolio(), saved)

  const updated = await saveAccount({ ...contract, side: 'short', margin: '2000' }, saved.revision)
  assert.deepEqual(updated.pendingOrders, [sell])
  const removed = await removePendingOrders([sell.id], updated.revision)
  const replaced = await saveAccount({ ...contract, asset: 'SOL' }, removed.revision)
  assert.deepEqual(replaced.pendingOrders, [])
})

test('plan edits preserve IDs, require confirmation for matching names, and reject stale deletes', async () => {
  const initial = await importBackup(
    { app: '2029', version: 1, accounts: [account], scenarios: [scenario], plans: [], lastBalanceEdit: timestamp },
    (await loadPortfolio()).revision,
  )
  const saved = await savePlan({ ...plan, name: ' Target ' }, initial.revision)
  assert.deepEqual(saved.plans, [plan])
  const edited = { ...plan, data: { ...plan.data, target: '31000', budget: '25.001' } }
  await assert.rejects(savePlan(edited, saved.revision), /Confirm/)
  await assert.rejects(savePlan({ ...edited, id: 'new', name: ' ＴＡＲＧＥＴ ' }, saved.revision), /Confirm/)
  assert.deepEqual(await loadPortfolio(), saved)

  const confirmed = await savePlan(edited, saved.revision, { overwriteId: plan.id })
  const renamed = { ...edited, name: '另一目标' }
  const updated = await savePlan(renamed, confirmed.revision)
  assert.deepEqual(updated.plans, [renamed])
  await assert.rejects(deletePlan(plan.id, confirmed.revision), /changed/)
  const removed = await deletePlan(plan.id, updated.revision)
  await assert.rejects(savePlan(renamed, updated.revision, { overwriteId: plan.id }), /changed/)
  await assert.rejects(deletePlan(plan.id, removed.revision), /no longer exists/)
  assert.deepEqual(await loadPortfolio(), removed)
  assert.deepEqual(parseBackup(exportBackup(removed)), parseBackup(exportBackup(initial)))
})

test('legacy namesakes stay independently addressable when overwriting or deleting a funding plan', async () => {
  const second = { ...plan, id: 'second', data: { ...plan.data, target: '39000' } }
  const source = { ...plan, id: 'source', name: 'Another target' }
  const legacy = parseBackup(JSON.stringify({
    app: '2029',
    version: 1,
    accounts: [account],
    scenarios: [scenario],
    plans: [plan, second, source],
    lastBalanceEdit: timestamp,
  }))
  const initial = await importBackup(legacy, (await loadPortfolio()).revision)
  const incoming = { id: 'new', name: 'TARGET', data: { ...plan.data, path: 'Severe' } }
  for (const overwriteId of ['missing', source.id]) {
    await assert.rejects(savePlan(incoming, initial.revision, { overwriteId }), /no longer matches/)
  }
  assert.deepEqual(await loadPortfolio(), initial)
  const replaced = await savePlan(incoming, initial.revision, { overwriteId: second.id })
  assert.deepEqual(replaced.plans, [plan, { ...incoming, id: second.id }, source])
  const renamed = { ...source, name: plan.name, data: { ...source.data, target: '42000' } }
  const merged = await savePlan(renamed, replaced.revision, { overwriteId: plan.id })
  assert.deepEqual(merged.plans, [{ ...renamed, id: plan.id }, { ...incoming, id: second.id }])
  const removed = await deletePlan(second.id, merged.revision)
  assert.deepEqual(parseBackup(exportBackup(removed)).plans, [{ ...renamed, id: plan.id }])
  assert.deepEqual(removed.accounts, initial.accounts)
  assert.deepEqual(removed.scenarios, initial.scenarios)
  assert.equal(removed.lastBalanceEdit, initial.lastBalanceEdit)
})
