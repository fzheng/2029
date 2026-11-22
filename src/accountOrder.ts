import type { AccountRisk, RiskStatus } from './engine'
import type { Account } from './model'
import type { AccountSort } from './storage'

/** Include archived accounts so their places are retained when they are restored. */
export function manualAccountOrder(accounts: Account[], saved: readonly string[]) {
  const ids = new Set(accounts.map((a) => a.id))
  const order = saved.filter((id) => ids.delete(id))
  return [...order, ...ids]
}

/** Reorder the visible slots, keeping filtered and archived accounts in place. */
export function moveVisibleAccount(order: string[], visible: string[], source: string, target: string) {
  const from = visible.indexOf(source)
  const to = visible.indexOf(target)
  if (from < 0 || to < 0 || from === to) return order
  const moved = [...visible]
  moved.splice(from, 1)
  moved.splice(to, 0, source)
  const slots = new Set(visible)
  let next = 0
  return order.map((id) => (slots.has(id) ? moved[next++] : id))
}

const riskPriority: Record<RiskStatus, number> = { Liquidation: 0, Warning: 1, Safe: 2, Unpriced: 3 }

function compareValue(a: number | null, b: number | null, descending = false) {
  if (a === null) return b === null ? 0 : 1
  if (b === null) return -1
  return descending ? b - a : a - b
}

export function sortAccountRows(
  rows: AccountRisk[],
  order: string[],
  sort: AccountSort,
  locale: string,
) {
  const rank = new Map(order.map((id, index) => [id, index]))
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })
  function compare(a: AccountRisk, b: AccountRisk) {
    switch (sort) {
      case 'name-asc':
        return collator.compare(a.account.name, b.account.name)
      case 'name-desc':
        return collator.compare(b.account.name, a.account.name)
      case 'equity-desc':
      case 'equity-asc':
        return compareValue(a.equity, b.equity, sort === 'equity-desc')
      case 'debt-desc':
        return b.debt - a.debt
      case 'risk':
        return (
          riskPriority[a.status] - riskPriority[b.status] || compareValue(a.distancePct, b.distancePct)
        )
      case 'updated':
        return Date.parse(b.account.updatedAt) - Date.parse(a.account.updatedAt)
      case 'manual':
        return 0
    }
  }
  return [...rows].sort((a, b) => compare(a, b) || rank.get(a.account.id)! - rank.get(b.account.id)!)
}
