import { Decimal } from 'decimal.js'
import { walletHoldings } from './engine'
import { hasValidOrderTerms, orderMatchesAccount } from './model'
import type { Account, PendingOrder, PerpAccount, SpotAccount } from './model'

const D = Decimal.clone({ precision: 64 })

export type FillError =
  | 'invalidOrder'
  | 'insufficientUsdt'
  | 'insufficientAsset'
  | 'insufficientMargin'
  | 'unavailableAccount'

function fillSpot(account: SpotAccount, order: PendingOrder): SpotAccount | FillError {
  const balances = new Map(walletHoldings(account).map((h) => [h.asset, new D(h.quantity)]))
  const owned = balances.get(order.asset) ?? new D(0)
  const quantity = new D(order.quantity)
  const value = quantity.mul(order.limitPrice)
  const fee = new D(order.feeUsdt ?? 0)
  let usdt = balances.get('USDT') ?? new D(0)
  let debt = new D(account.debt)

  if (order.side === 'buy') {
    usdt = usdt.minus(value).minus(fee)
    if (usdt.lt(0)) {
      if (!order.autoBorrow) return 'insufficientUsdt'
      debt = debt.minus(usdt)
      usdt = new D(0)
    }
    balances.set(order.asset, owned.plus(quantity))
  } else {
    if (quantity.gt(owned)) return 'insufficientAsset'
    const proceeds = value.minus(fee)
    const repayment = order.autoRepay ? D.min(debt, D.max(0, proceeds)) : new D(0)
    usdt = usdt.plus(proceeds).minus(repayment)
    if (usdt.lt(0)) return 'insufficientUsdt'
    debt = debt.minus(repayment)
    balances.set(order.asset, owned.minus(quantity))
  }
  balances.set('USDT', usdt)
  const holdings = Array.from(balances, ([asset, amount]) => ({ asset, quantity: amount.toFixed() }))
  return { ...account, holdings, debt: debt.toFixed() }
}

function fillPerp(account: PerpAccount, order: PendingOrder): PerpAccount | FillError {
  const previous = new D(account.size)
  const quantity = new D(order.quantity)
  const price = new D(order.limitPrice)
  const direction = order.side === 'buy' ? 'long' : 'short'
  let margin = new D(account.margin).minus(order.feeUsdt ?? 0)
  let entry = new D(account.entry)
  let side = account.side
  let size: Decimal

  if (previous.isZero() || direction === side) {
    size = previous.plus(quantity)
    side = direction
    entry = entry.mul(previous).plus(price.mul(quantity)).div(size)
  } else {
    const closed = D.min(previous, quantity)
    const pnlPerCoin = side === 'long' ? price.minus(entry) : entry.minus(price)
    margin = margin.plus(closed.mul(pnlPerCoin))
    size = previous.minus(quantity).abs()
    if (quantity.gt(previous)) {
      side = direction
      entry = price
    } else if (size.isZero()) {
      entry = new D(0)
    }
  }
  if (margin.lt(0)) return 'insufficientMargin'
  return { ...account, side, size: size.toFixed(), entry: entry.toFixed(), margin: margin.toFixed() }
}

/** Selected orders execute at their limits, in saved list order, on independent account copies. */
export function previewOrderFills(
  accounts: Account[],
  orders: PendingOrder[],
  selectedIds: ReadonlySet<string>,
) {
  const errors = new Map<string, FillError>()
  const filledIds = new Set<string>()
  const groups = new Map<string, PendingOrder[]>()
  for (const order of orders) {
    if (!selectedIds.has(order.id)) continue
    const group = groups.get(order.accountId)
    if (group) group.push(order)
    else groups.set(order.accountId, [order])
  }
  if (!groups.size) return { accounts, errors, filledIds }

  const projected = new Map(accounts.map((a) => [a.id, a]))
  for (const [accountId, group] of groups) {
    const saved = projected.get(accountId)
    if (!saved || saved.archived || (saved.kind !== 'spot' && saved.kind !== 'perp')) {
      for (const order of group) errors.set(order.id, 'unavailableAccount')
      continue
    }
    let working: SpotAccount | PerpAccount = saved
    let complete = true
    for (const order of group) {
      if (!hasValidOrderTerms(order) || !orderMatchesAccount(order, working)) {
        errors.set(order.id, 'invalidOrder')
        complete = false
        break
      }
      const next = working.kind === 'spot' ? fillSpot(working, order) : fillPerp(working, order)
      if (typeof next === 'string') {
        errors.set(order.id, next)
        complete = false
        break
      }
      working = next
    }
    if (complete) {
      projected.set(accountId, working)
      for (const order of group) filledIds.add(order.id)
    }
  }
  return { accounts: accounts.map((a) => projected.get(a.id)!), errors, filledIds }
}
