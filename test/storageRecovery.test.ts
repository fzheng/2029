import 'fake-indexeddb/auto'
import { forceCloseDatabase } from 'fake-indexeddb'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { loadPortfolio, saveAccount, subscribePortfolio, type PortfolioState } from '../src/storage'
import type { CashSpotAccount } from '../src/model'

const wallet: CashSpotAccount = {
  kind: 'cashSpot', id: 'reserve', name: 'Reserve', archived: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
  holdings: [{ asset: 'USDT', quantity: '100.012345678901' }],
}

test('IndexedDB can retry a denied open and reconnect after an abnormal close with balances intact', async (t) => {
  const open = t.mock.method(indexedDB, 'open')
  open.mock.mockImplementationOnce(() => { throw new DOMException('Storage denied', 'SecurityError') })
  await assert.rejects(loadPortfolio(), { name: 'SecurityError' })
  const initial = await loadPortfolio()
  const saved = await saveAccount(wallet, initial.revision)

  const db: IDBDatabase = open.mock.calls.at(-1)!.result!.result
  const closed = new Promise<void>((resolve) =>
    db.addEventListener('close', () => resolve(), { once: true }),
  )
  // @ts-expect-error fake-indexeddb 6 types this argument as a constructor; its helper takes a connection.
  forceCloseDatabase(db)
  await closed
  assert.deepEqual(await loadPortfolio(), saved)
})

function installGlobal(t: TestContext, name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous)
    else Reflect.deleteProperty(globalThis, name)
  })
}

test('a second tab recovers committed revisions from storage events and visibility changes without BroadcastChannel', async (t) => {
  const viewer = new EventTarget()
  const document = Object.assign(new EventTarget(), { hidden: true })
  const notices: [string, string][] = []
  const writer = Object.assign(new EventTarget(), {
    localStorage: { setItem(key: string, value: string) { notices.push([key, value]) } },
  })
  installGlobal(t, 'window', viewer)
  installGlobal(t, 'document', document)
  installGlobal(t, 'BroadcastChannel', undefined)
  const initial = await loadPortfolio()
  const received: PortfolioState[] = []
  const unsubscribe = subscribePortfolio((state) => received.push(state))
  // A later read on the same connection also waits for previously queued subscription reads.
  await loadPortfolio()
  assert.deepEqual(received, [initial])

  Reflect.set(globalThis, 'window', writer)
  const first = await saveAccount(wallet, initial.revision)
  Reflect.set(globalThis, 'window', viewer)
  const [[key, revision]] = notices
  assert.equal(revision, String(first.revision))
  // A hidden tab and unrelated localStorage writes do not reveal the pending revision.
  document.dispatchEvent(new Event('visibilitychange'))
  viewer.dispatchEvent(Object.assign(new Event('storage'), { key: '2029.language' }))
  await loadPortfolio()
  assert.deepEqual(received, [initial])

  // New values are invalidation signals. The viewer reads the actual revision and wallet from IndexedDB.
  viewer.dispatchEvent(Object.assign(new Event('storage'), { key, newValue: '999999' }))
  viewer.dispatchEvent(new Event('focus'))
  await loadPortfolio()
  assert.deepEqual(received, [initial, first])

  const updated = { ...wallet, holdings: [{ asset: 'USDT', quantity: '80.000000000001' }] }
  Reflect.set(globalThis, 'window', writer)
  const second = await saveAccount(updated, first.revision)
  Reflect.set(globalThis, 'window', viewer)
  document.hidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  await loadPortfolio()
  assert.deepEqual(received, [initial, first, second])

  // A read already started when the tab unsubscribes cannot publish another update.
  Reflect.set(globalThis, 'window', writer)
  await saveAccount(wallet, second.revision)
  Reflect.set(globalThis, 'window', viewer)
  viewer.dispatchEvent(new Event('pageshow'))
  unsubscribe()
  viewer.dispatchEvent(new Event('focus'))
  await loadPortfolio()
  assert.deepEqual(received, [initial, first, second])
})
