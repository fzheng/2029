import Decimal from 'decimal.js'
import {
  type Account,
  type PendingOrder,
  hasValidOrderTerms,
  isAssetSymbol as asset,
  isDecimalAmount as decimal,
  orderMatchesAccount,
} from './model'

export interface SavedItem {
  id: string
  name: string
  data: unknown
}

const accountSorts = [
  'manual',
  'name-asc',
  'name-desc',
  'equity-desc',
  'equity-asc',
  'debt-desc',
  'risk',
  'updated',
] as const
export type AccountSort = (typeof accountSorts)[number]
export interface AccountView {
  sort: AccountSort
  /** Accounts added since the last reorder follow the listed accounts. */
  order: string[]
}

export interface PortfolioState {
  revision: number
  generation: number
  accounts: Account[]
  accountView?: AccountView
  pendingOrders?: PendingOrder[]
  scenarios: SavedItem[]
  plans: SavedItem[]
  lastBalanceEdit: string | null
}

type Records = Pick<
  PortfolioState,
  'accounts' | 'accountView' | 'pendingOrders' | 'scenarios' | 'plans' | 'lastBalanceEdit'
>
export type Backup = Records & { app: '2029'; version: 1 }

const databaseName = '2029-portfolio'
const storeName = 'portfolio'
const stateKey = 'records'
const changeEvent = '2029:portfolio-change'
let connection: Promise<IDBDatabase> | undefined

function newState(): PortfolioState {
  return { revision: 0, generation: 0, accounts: [], scenarios: [], plans: [], lastBalanceEdit: null }
}

function openDatabase(): Promise<IDBDatabase> {
  if (connection) return connection
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      // Future migrations add stores or transform records in this same transaction.
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName).add(newState(), stateKey)
      }
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => {
        db.close()
        connection = undefined
      }
      db.onclose = () => {
        connection = undefined
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error)
  }).catch((error) => {
    connection = undefined
    throw error
  })
  return connection
}

export async function loadPortfolio(): Promise<PortfolioState> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const read = tx.objectStore(storeName).get(stateKey)
    tx.oncomplete = () =>
      read.result ? resolve(read.result) : reject(new Error('Portfolio records could not be read.'))
    tx.onabort = () => reject(tx.error ?? new Error('Could not read the portfolio.'))
  })
}

function notifyChange(revision: number) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(changeEvent))
  // Send only an invalidation. The committed IndexedDB record is authoritative.
  try {
    window.localStorage.setItem(changeEvent, String(revision))
  } catch {
    /* Storage may be restricted. */
  }
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(changeEvent)
    channel.postMessage(revision)
    channel.close()
  }
}

export function subscribePortfolio(onChange: (state: PortfolioState) => void): () => void {
  let active = true
  let seen = -1
  const refresh = () => {
    void loadPortfolio()
      .then((state) => {
        if (active && state.revision > seen) {
          seen = state.revision
          onChange(state)
        }
      })
      .catch(() => {
        /* Keep the last successfully read view. */
      })
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === changeEvent) refresh()
  }
  const onVisible = () => {
    if (!document.hidden) refresh()
  }
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(changeEvent)
  if (channel) channel.onmessage = refresh
  window.addEventListener(changeEvent, refresh)
  window.addEventListener('storage', onStorage)
  window.addEventListener('focus', refresh)
  window.addEventListener('pageshow', refresh)
  document.addEventListener('visibilitychange', onVisible)
  refresh()
  return () => {
    active = false
    channel?.close()
    window.removeEventListener(changeEvent, refresh)
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('focus', refresh)
    window.removeEventListener('pageshow', refresh)
    document.removeEventListener('visibilitychange', onVisible)
  }
}

// Read, compare and write under one cross-tab transaction. A delayed save
// cannot overwrite newer edits or resurrect a record removed by Clear all.
async function commit(
  revision: number,
  change: (state: PortfolioState) => PortfolioState,
): Promise<PortfolioState> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite', { durability: 'strict' })
    const store = transaction.objectStore(storeName)
    const read = store.get(stateKey)
    let next: PortfolioState
    let reason: unknown
    read.onsuccess = () => {
      try {
        const current: PortfolioState | undefined = read.result
        if (!current || current.revision !== revision) {
          throw new Error(
            'Your portfolio changed in another view. Close this dialog and reopen the latest record.',
          )
        }
        next = { ...change(current), revision: current.revision + 1 }
        store.put(next, stateKey)
      } catch (error) {
        reason = error
        transaction.abort()
      }
    }
    transaction.oncomplete = () => {
      resolve(next)
      notifyChange(next.revision)
    }
    transaction.onabort = () =>
      reject(reason ?? transaction.error ?? new Error('The change could not be saved.'))
  })
}

function replaceItem<T extends { id: string }>(list: T[], item: T) {
  return list.some((record) => record.id === item.id)
    ? list.map((record) => (record.id === item.id ? item : record))
    : [...list, item]
}

export function saveAccount(account: Account, revision: number) {
  return commit(revision, (current) => {
    if (!validAccount(account)) throw new Error('Check the account values before saving.')
    const previous = current.accounts.find((a) => a.id === account.id)
    if (
      current.pendingOrders?.some(
        (order) =>
          order.accountId === account.id &&
          (previous?.kind !== account.kind || !orderMatchesAccount(order, account)),
      )
    ) {
      throw new Error(
        'Remove the pending orders for this account before changing its contract or account type.',
      )
    }
    const updatedAt = new Date().toISOString()
    return {
      ...current,
      accounts: replaceItem(current.accounts, { ...account, updatedAt }),
      lastBalanceEdit: updatedAt,
    }
  })
}

export function savePendingOrder(order: PendingOrder, revision: number) {
  return commit(revision, (current) => {
    if (
      !hasValidOrderTerms(order) ||
      !orderMatchesAccount(
        order,
        current.accounts.find((a) => a.id === order.accountId),
      )
    ) {
      throw new Error('Check the pending order values and account before saving.')
    }
    return { ...current, pendingOrders: replaceItem(current.pendingOrders ?? [], order) }
  })
}

export function removePendingOrders(ids: string[], revision: number) {
  const removed = new Set(ids)
  return commit(revision, (current) => ({
    ...current,
    pendingOrders: (current.pendingOrders ?? []).filter((order) => !removed.has(order.id)),
  }))
}

export function saveAccountView(view: AccountView, revision: number) {
  return commit(revision, (current) => {
    if (!validAccountView(view, current.accounts))
      throw new Error('The account sort or order is invalid.')
    return { ...current, accountView: { sort: view.sort, order: [...view.order] } }
  })
}

function saveItem(collection: 'plans' | 'scenarios', item: SavedItem, revision: number) {
  return commit(revision, (current) => {
    if (!validItem(item, collection)) throw new Error('Enter a name and valid inputs before saving.')
    return { ...current, [collection]: replaceItem(current[collection], item) }
  })
}

export const savePlan = (item: SavedItem, revision: number) => saveItem('plans', item, revision)
export const saveScenario = (item: SavedItem, revision: number) => saveItem('scenarios', item, revision)

export function clearPortfolio(revision: number) {
  return commit(revision, (current) => ({ ...newState(), generation: current.generation + 1 }))
}

function object(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
const label = (value: unknown) => typeof value === 'string' && value.trim().length > 0
const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))

function validAccount(value: unknown): value is Account {
  if (
    !object(value) ||
    !label(value.id) ||
    !label(value.name) ||
    typeof value.archived !== 'boolean' ||
    !timestamp(value.updatedAt)
  )
    return false
  if (value.increment !== undefined && !decimal(value.increment, true)) return false
  if (value.kind === 'spot' || value.kind === 'cashSpot') {
    if (
      !Array.isArray(value.holdings) ||
      !value.holdings.every((h) => object(h) && asset(h.asset) && decimal(h.quantity))
    )
      return false
    if (value.kind === 'spot') return decimal(value.debt)
    // A wallet backup that also declares a liability cannot be valued as free spot assets.
    const walletFields = ['id', 'name', 'kind', 'archived', 'updatedAt', 'holdings']
    return Object.keys(value).every((key) => walletFields.includes(key))
  }
  if (!asset(value.asset)) return false
  if (value.kind === 'loan') {
    return (
      decimal(value.collateral, true) &&
      decimal(value.debt) &&
      decimal(value.warningLtv, true, 1) &&
      decimal(value.liquidationLtv, true, 1) &&
      new Decimal(value.warningLtv as string).lt(value.liquidationLtv as string)
    )
  }
  if (value.kind === 'perp') {
    return (
      (value.side === 'long' || value.side === 'short') &&
      decimal(value.size, true) &&
      decimal(value.margin) &&
      decimal(value.entry, true) &&
      decimal(value.maintenanceOffset) &&
      decimal(value.maintenanceRate, true, 1) &&
      decimal(value.takerFee, false, 1) &&
      new Decimal(value.maintenanceRate as string).add(value.takerFee as string).lt(1) &&
      (value.tiers === undefined || validTiers(value.tiers, value.takerFee as string))
    )
  }
  return false
}

function validTiers(value: unknown, fee: string) {
  if (!Array.isArray(value) || !value.length) return false
  let end = new Decimal(0)
  let previousRate = new Decimal(0)
  for (const row of value) {
    if (!object(row) || !decimal(row.min) || !decimal(row.max, true) || !decimal(row.rate, true))
      return false
    const min = new Decimal(row.min as string),
      max = new Decimal(row.max as string),
      rate = new Decimal(row.rate as string)
    if (!min.eq(end) || max.lte(min) || rate.lt(previousRate) || rate.add(fee).gte(1)) return false
    end = max
    previousRate = rate
  }
  return true
}

function validPrices(value: unknown, allowZero: boolean) {
  return (
    object(value) &&
    Object.entries(value).every(
      ([key, price]) =>
        asset(key) &&
        typeof price === 'string' &&
        /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(price) &&
        Number.isFinite(Number(price)) &&
        (allowZero ? Number(price) >= 0 : Number(price) > 0),
    )
  )
}

function validLimits(min: unknown, max: unknown): boolean {
  if (min !== undefined && !decimal(min)) return false
  if (max !== undefined && !decimal(max, true)) return false
  return min === undefined || max === undefined || new Decimal(min as string).lte(max as string)
}

function validPledges(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const sources = new Set<string>()
  for (const row of value) {
    if (
      !object(row) ||
      !label(row.accountId) ||
      !asset(row.asset) ||
      row.asset === 'USDT' ||
      !decimal(row.quantity, true) ||
      !decimal(row.borrowLtvPct, true, 100) ||
      !decimal(row.liquidationLtvPct, true, 100) ||
      new Decimal(row.borrowLtvPct as string).gte(row.liquidationLtvPct as string) ||
      !validLimits(row.minBorrowUsdt, row.maxBorrowUsdt) ||
      !validLimits(row.minCollateralUsdt, row.maxCollateralUsdt)
    )
      return false
    const source = row.accountId + ':' + row.asset
    if (sources.has(source)) return false
    sources.add(source)
  }
  return true
}

function validItem(value: unknown, kind: 'plans' | 'scenarios'): value is SavedItem {
  if (!object(value) || !label(value.id) || !label(value.name) || !object(value.data)) return false
  const data = value.data
  if (data.path !== 'Independent' && data.path !== 'Base' && data.path !== 'Severe') return false
  if (kind === 'plans') {
    return (
      decimal(data.target, true) &&
      (data.accountId === undefined || typeof data.accountId === 'string') &&
      (data.useSpotUsdt === undefined || typeof data.useSpotUsdt === 'boolean') &&
      (data.pledges === undefined || validPledges(data.pledges)) &&
      (data.bufferPct === undefined ||
        data.bufferPct === '' ||
        (decimal(data.bufferPct) && new Decimal(data.bufferPct as string).lt(100))) &&
      (data.budget === undefined || data.budget === '' || decimal(data.budget))
    )
  }
  return (
    Array.isArray(data.symbols) &&
    data.symbols.every(asset) &&
    new Set(data.symbols).size === data.symbols.length &&
    (data.asOf === null || timestamp(data.asOf)) &&
    (data.stale === undefined ||
      (Array.isArray(data.stale) &&
        data.stale.every(
          (key) => typeof key === 'string' && /^(spot|loan|mark):[A-Z0-9]{1,30}$/.test(key),
        ))) &&
    validPrices(data.overrides, true) &&
    object(data.book) &&
    validPrices(data.book.spot, false) &&
    validPrices(data.book.mark, false) &&
    validPrices(data.book.loan, false)
  )
}
function validList<T extends { id: string }>(
  value: unknown,
  validate: (entry: unknown) => entry is T,
): value is T[] {
  return (
    Array.isArray(value) &&
    value.every(validate) &&
    new Set(value.map((entry) => entry.id)).size === value.length
  )
}

function validAccountView(view: unknown, accounts: Account[]): view is AccountView {
  if (!object(view) || !accountSorts.some((sort) => sort === view.sort) || !Array.isArray(view.order))
    return false
  const availableIds = new Set(accounts.map((account) => account.id))
  for (const id of view.order) {
    if (!availableIds.delete(id)) return false
  }
  return true
}

function validPendingOrders(value: unknown, accounts: Account[]): boolean {
  if (!validList(value, hasValidOrderTerms)) return false
  const byId = new Map(accounts.map((a) => [a.id, a]))
  return value.every((order) => orderMatchesAccount(order, byId.get(order.accountId)))
}

function validateBackup(value: unknown): asserts value is Backup {
  if (!object(value) || value.app !== '2029' || value.version !== 1)
    throw new Error('Choose a 2029 version 1 JSON backup.')
  if (
    !validList(value.accounts, validAccount) ||
    (value.accountView !== undefined && !validAccountView(value.accountView, value.accounts)) ||
    (value.pendingOrders !== undefined && !validPendingOrders(value.pendingOrders, value.accounts)) ||
    !validList(value.scenarios, (item) => validItem(item, 'scenarios')) ||
    !validList(value.plans, (item) => validItem(item, 'plans')) ||
    !(value.lastBalanceEdit === null || timestamp(value.lastBalanceEdit))
  ) {
    throw new Error('The backup contains invalid or duplicate records. Your portfolio is unchanged.')
  }
}

export function parseBackup(json: string): Backup {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new Error('The selected file does not contain valid JSON.')
  }
  validateBackup(value)
  return value
}

export function exportBackup(state: PortfolioState): string {
  const { accounts, accountView, pendingOrders, scenarios, plans, lastBalanceEdit } = state
  return JSON.stringify(
    { app: '2029', version: 1, accounts, accountView, pendingOrders, scenarios, plans, lastBalanceEdit },
    null,
    2,
  )
}

export function importBackup(backup: Backup, revision: number) {
  validateBackup(backup)
  const { accounts, accountView, pendingOrders, scenarios, plans, lastBalanceEdit } = backup
  return commit(revision, (current) => ({
    revision: current.revision,
    generation: current.generation + 1,
    accounts,
    ...(accountView && { accountView }),
    ...(pendingOrders && { pendingOrders }),
    scenarios,
    plans,
    lastBalanceEdit,
  }))
}
