import Decimal from 'decimal.js'

/** Decimal quantities are stored as strings so edits and backups preserve their precision. */
export interface AccountBase {
  id: string
  name: string
  archived: boolean
  updatedAt: string
  /** Smallest executable USDT action for this account. */
  increment?: string
}
export interface Holding {
  asset: string
  quantity: string
}
export interface CashSpotAccount extends AccountBase {
  kind: 'cashSpot'
  holdings: Holding[]
}
export interface SpotAccount extends AccountBase {
  kind: 'spot'
  holdings: Holding[]
  /** Outstanding USDT debt, including accrued interest. */
  debt: string
}
export interface LoanAccount extends AccountBase {
  kind: 'loan'
  asset: string
  collateral: string
  debt: string
  warningLtv: string
  liquidationLtv: string
}
export interface PerpAccount extends AccountBase {
  kind: 'perp'
  asset: string
  side: 'long' | 'short'
  size: string
  entry: string
  margin: string
  maintenanceRate: string
  takerFee: string
  maintenanceOffset: string
  /** Current public tier schedule, when selected in the editor. The fallback rate and
   * offset above are the user's manual position settings when no schedule is supplied. */
  tiers?: { min: string; max: string; rate: string }[]
}
export type RiskAccount = SpotAccount | LoanAccount | PerpAccount
export type Account = CashSpotAccount | RiskAccount

export interface PendingOrder {
  id: string
  accountId: string
  asset: string
  side: 'buy' | 'sell'
  quantity: string
  limitPrice: string
  feeUsdt?: string
  autoBorrow?: boolean
  autoRepay?: boolean
}

export const isAssetSymbol = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z0-9]{1,30}$/.test(value)

export function isDecimalAmount(value: unknown, positive = false, max?: number): value is string {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return false
  if (!Number.isFinite(Number(value))) return false
  const n = new Decimal(value)
  return (!positive || n.gt(0)) && (max === undefined || n.lte(max))
}

const orderFields = new Set([
  'id',
  'accountId',
  'asset',
  'side',
  'quantity',
  'limitPrice',
  'feeUsdt',
  'autoBorrow',
  'autoRepay',
])

export function hasValidOrderTerms(value: unknown): value is PendingOrder {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const order = value as Record<string, unknown>
  return (
    Object.keys(order).every((key) => orderFields.has(key)) &&
    typeof order.id === 'string' &&
    order.id.trim() !== '' &&
    typeof order.accountId === 'string' &&
    order.accountId.trim() !== '' &&
    isAssetSymbol(order.asset) &&
    order.asset !== 'USDT' &&
    (order.side === 'buy' || order.side === 'sell') &&
    isDecimalAmount(order.quantity, true) &&
    isDecimalAmount(order.limitPrice, true) &&
    (order.feeUsdt === undefined || isDecimalAmount(order.feeUsdt)) &&
    (order.autoBorrow === undefined || typeof order.autoBorrow === 'boolean') &&
    (order.autoRepay === undefined || typeof order.autoRepay === 'boolean')
  )
}

export function orderMatchesAccount(order: PendingOrder, account: Account | undefined): boolean {
  if (!account || order.accountId !== account.id) return false
  if (account.kind === 'spot') {
    return !(order.autoBorrow && order.side !== 'buy') && !(order.autoRepay && order.side !== 'sell')
  }
  return (
    account.kind === 'perp' && account.asset === order.asset && !order.autoBorrow && !order.autoRepay
  )
}

export type Basis = 'spot' | 'mark' | 'loan'
export type Path = 'Independent' | 'Base' | 'Severe'
export type Prices = Record<string, string>
export interface PriceBook {
  spot: Prices
  mark: Prices
  loan: Prices
}
export interface PledgeInput {
  accountId: string
  asset: string
  quantity: string
  /** User-entered order terms, expressed as percentages, e.g. "65". */
  borrowLtvPct: string
  liquidationLtvPct: string
  minBorrowUsdt?: string
  maxBorrowUsdt?: string
  minCollateralUsdt?: string
  maxCollateralUsdt?: string
}
export interface PlanInput {
  target: string
  path: Path
  bufferPct?: string
  budget?: string
  accountId?: string
  useSpotUsdt?: boolean
  pledges?: PledgeInput[]
}
