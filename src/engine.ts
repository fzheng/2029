import { Decimal } from 'decimal.js'
import { btcMoveMultipliers } from './model'
import type {
  Account,
  CashSpotAccount,
  Holding,
  PledgeInput,
  RiskAccount,
  Basis,
  Path,
  PerpAccount,
  PlanInput,
  PlanSnapshot,
  PriceBook,
  Prices,
  SpotAccount,
} from './model'

// Prices and balances enter as decimal strings. Conversion to JS numbers happens
// only at the presentation boundary, after comparisons and cash allocation.
const D = Decimal.clone({ precision: 64 })
const d = (v: Decimal.Value) => new D(v)
const zero = d(0)
const one = d(1)
const spotMaintenance = d('0.10')
const spotAlert = d('0.65') // personal threshold; the exchange's margin call is 0.80
const perpAlert = d('0.80')
const bases: Basis[] = ['spot', 'mark', 'loan']
const number = (v: Decimal | null) => (v === null ? null : v.toNumber())
const sum = (items: Decimal[]) => items.reduce((a, b) => a.plus(b), zero)
const riskRatio = (required: Decimal, equity: Decimal) =>
  equity.gt(0) ? required.div(equity) : d(Infinity)

export const calculationSources = {
  spot: 'https://www.bitget.com/support/articles/12560603779331',
  loan: 'https://www.bitget.com/docs/catalog/crypto-loans/crypto-loans',
  pledge: 'https://www.bitget.com/academy/understanding-bitget-loan-in-one-article',
  perp: 'https://www.bitget.com/support/articles/12560603841952',
  tiers: 'https://www.bitget.com/docs/catalog/classic-contract-position/classic-contract-position',
  fees: 'https://www.bitget.com/docs/catalog/classic-contract-market/classic-contract-market',
}

function price(book: PriceBook, basis: Basis, asset: string): Decimal | null {
  if (asset === 'USDT') return one
  const raw = book[basis][asset]
  return raw === undefined ? null : d(raw)
}

/** Display anchor when a market has several price bases. Relative moves preserve their spread. */
export function referencePrice(book: PriceBook, asset: string): string | null {
  if (asset === 'USDT') return '1'
  return book.spot[asset] ?? book.mark[asset] ?? book.loan[asset] ?? null
}

function multiplier(path: Path, asset: string) {
  if (asset === 'BTC') return one
  return d(btcMoveMultipliers[path][asset] ?? 0)
}
function linkedFactor(weight: Decimal, btcFactor: Decimal) {
  return D.max(0, one.plus(weight.mul(btcFactor.minus(1))))
}
// Invert the linked move against its original basis. A zero threshold is
// first touched when the linked asset reaches its price floor.
function driverPriceAtThreshold(driver: Decimal, original: Decimal, threshold: Decimal, weight: Decimal) {
  const factor = one.plus(threshold.div(original).minus(1).div(weight))
  return factor.isNegative() ? null : driver.mul(factor)
}

interface ScenarioContext {
  snapshot: PriceBook
  overrides: Prices
  path: Path
}
const contexts = new WeakMap<PriceBook, ScenarioContext>()

/** Derive every basis from the same frozen snapshot. Unspecified altcoins stay flat. */
export function buildScenario(snapshot: PriceBook, path: Path, overrides: Prices): PriceBook {
  const book: PriceBook = { spot: {}, loan: {}, mark: {} }
  const btc = referencePrice(snapshot, 'BTC')
  const btcFactor =
    overrides.BTC !== undefined && btc !== null && d(btc).gt(0) ? D.max(0, overrides.BTC).div(btc) : one
  for (const basis of bases) {
    for (const [asset, original] of Object.entries(snapshot[basis])) {
      if (asset === 'USDT') {
        book[basis][asset] = '1'
        continue
      }
      const anchor = referencePrice(snapshot, asset)
      const overridden = overrides[asset] !== undefined && anchor !== null && d(anchor).gt(0)
      const factor = overridden
        ? D.max(0, overrides[asset]).div(anchor!)
        : linkedFactor(multiplier(path, asset), btcFactor)
      book[basis][asset] = d(original).mul(factor).toFixed()
    }
  }
  contexts.set(book, { snapshot, overrides: { ...overrides }, path })
  return book
}

/** Combine repeated lines in one spot account without rounding coin quantities. */
export function walletHoldings(wallet: CashSpotAccount | SpotAccount): Holding[] {
  const assets = new Map<string, Decimal>()
  for (const { asset, quantity } of wallet.holdings)
    assets.set(asset, (assets.get(asset) ?? zero).plus(quantity))
  return [...assets].map(([asset, quantity]) => ({ asset, quantity: quantity.toFixed() }))
}

function spotGross(account: SpotAccount | CashSpotAccount, book: PriceBook): Decimal | null {
  let total = zero
  for (const { asset, quantity } of account.holdings) {
    if (d(quantity).isZero()) continue
    const p = price(book, 'spot', asset)
    if (p === null) return null
    total = total.plus(p.mul(quantity))
  }
  return total
}

/** Solve each linear segment of the altcoin path; individual prices can reach zero
 * before BTC. A scenario uses its original snapshot and keeps manual alt overrides fixed. */
function spotTrigger(account: SpotAccount, book: PriceBook, path: Path, boundary: Decimal) {
  const context = contexts.get(book)
  const source = context?.path === path ? context.snapshot : book
  const btc = referencePrice(source, 'BTC')
  if (!btc || d(btc).isZero()) return null
  const terms: { value: Decimal; weight: Decimal }[] = []
  for (const holding of account.holdings) {
    if (d(holding.quantity).isZero()) continue
    const pinned =
      context?.path === path && holding.asset !== 'BTC' && context.overrides[holding.asset] !== undefined
    const p = price(pinned ? book : source, 'spot', holding.asset)
    if (p === null) return null
    terms.push({
      value: p.mul(holding.quantity),
      weight: pinned ? zero : multiplier(path, holding.asset),
    })
  }
  const highestSlope = sum(terms.map((t) => t.value.mul(t.weight)))
  if (highestSlope.isZero()) return null
  const bookValue = (factor: Decimal) =>
    sum(terms.map((t) => t.value.mul(linkedFactor(t.weight, factor))))
  let right = one
  let hiValue = bookValue(right)
  if (boundary.gte(hiValue)) return right.plus(boundary.minus(hiValue).div(highestSlope)).mul(btc)
  const breakpoints = [
    zero,
    ...terms.filter((t) => t.weight.gt(1)).map((t) => one.minus(one.div(t.weight))),
  ].sort((a, b) => b.cmp(a))
  for (const left of breakpoints) {
    const loValue = bookValue(left)
    if (boundary.gte(loValue) && hiValue.gt(loValue)) {
      return left
        .plus(boundary.minus(loValue).mul(right.minus(left)).div(hiValue.minus(loValue)))
        .mul(btc)
    }
    right = left
    hiValue = loValue
  }
  return null
}

interface Tier {
  min: Decimal
  rate: Decimal
  offset: Decimal
}
function positionTiers(account: PerpAccount): Tier[] {
  if (!account.tiers?.length)
    return [{ min: zero, rate: d(account.maintenanceRate), offset: d(account.maintenanceOffset) }]
  const tiers: Tier[] = []
  for (const row of [...account.tiers].sort((a, b) => d(a.min).cmp(b.min))) {
    const prev = tiers.at(-1)
    const min = d(row.min)
    const rate = d(row.rate)
    const offset = prev ? prev.offset.plus(min.mul(rate.minus(prev.rate))) : zero
    tiers.push({ min, rate, offset })
  }
  return tiers
}
function perpAmounts(account: PerpAccount, mark: Decimal) {
  const notional = mark.mul(account.size)
  const tiers = positionTiers(account)
  const tier = [...tiers].reverse().find((t) => t.min.lte(notional)) ?? tiers[0]
  const sign = account.side === 'long' ? 1 : -1
  const equity = d(account.margin).plus(mark.minus(account.entry).mul(account.size).mul(sign))
  const maintenance = D.max(0, notional.mul(tier.rate.plus(account.takerFee)).minus(tier.offset))
  return { notional, equity, maintenance }
}
function perpThresholdMarks(account: PerpAccount, threshold: Decimal) {
  const direction = account.side === 'long' ? one : d(-1)
  const size = d(account.size)
  const tiers = positionTiers(account)
  const marks: Decimal[] = []
  const zeroEquityMark = d(account.entry).minus(d(account.margin).div(size).mul(direction))
  if (zeroEquityMark.gte(0) && perpAmounts(account, zeroEquityMark).maintenance.isZero())
    marks.push(zeroEquityMark)
  for (const [i, t] of tiers.entries()) {
    // threshold × equity = maintenance, solved at the rate of the candidate tier.
    const denominator = size.mul(t.rate.plus(account.takerFee).minus(direction.mul(threshold)))
    if (denominator.isZero()) continue
    const numerator = d(account.margin)
      .minus(size.mul(account.entry).mul(direction))
      .mul(threshold)
      .plus(t.offset)
    const p = numerator.div(denominator)
    const n = p.mul(size)
    if (
      p.gte(0) &&
      n.gte(t.min) &&
      (!tiers[i + 1] || n.lte(tiers[i + 1].min)) &&
      n.mul(t.rate.plus(account.takerFee)).gte(t.offset)
    ) {
      marks.push(p)
    }
  }
  return marks
}
function perpTrigger(account: PerpAccount, threshold: Decimal) {
  return perpThresholdMarks(account, threshold)[0] ?? null
}

function btcLiquidationPrice(account: Account, book: PriceBook, path: Path, native: Decimal | null) {
  if (native === null || account.kind === 'cashSpot') return null
  if (account.kind === 'spot') return native // spotTrigger already solves across the whole account in BTC.
  const context = contexts.get(book)
  const frozen = context?.path === path ? context : undefined
  if (account.asset !== 'BTC' && frozen?.overrides[account.asset] !== undefined) return null
  const source = frozen?.snapshot ?? book
  const btc = referencePrice(source, 'BTC')
  const original = price(source, account.kind === 'perp' ? 'mark' : 'loan', account.asset)
  const weight = multiplier(path, account.asset)
  if (btc === null || !d(btc).gt(0) || !original?.gt(0) || weight.isZero()) return null
  return driverPriceAtThreshold(d(btc), original, native, weight)
}

export type RiskStatus = 'Safe' | 'Warning' | 'Liquidation' | 'Unpriced'
export interface AccountRisk {
  account: Account
  status: RiskStatus
  missing: string[]
  triggerAsset: string
  equity: number | null
  equityAtTrigger: number | null
  debt: number
  exposure: number | null
  gross: number | null
  leverage: number | null
  risk: number | null
  ltv: number | null
  maintenance: number | null
  referencePrice: number | null
  warningPrice: number | null
  liquidationPrice: number | null
  /** BTC anchor price at the liquidation boundary along the selected BTC path, in USDT. */
  btcLiquidationPrice: number | null
  distancePct: number | null
  warningDistancePct: number | null
  assetBoundary: number | null
  warningBoundary: number | null
}

function missingPrices(account: Account, book: PriceBook): string[] {
  if (account.kind === 'perp' && d(account.size).isZero()) return []
  if (account.kind === 'spot' || account.kind === 'cashSpot')
    return [
      ...new Set(
        account.holdings
          .filter((h) => d(h.quantity).gt(0) && price(book, 'spot', h.asset) === null)
          .map((h) => `${h.asset} spot`),
      ),
    ]
  const basis = account.kind === 'loan' ? 'loan' : 'mark'
  return price(book, basis, account.asset) === null
    ? [`${account.asset} ${basis === 'loan' ? 'loan reference' : 'mark'}`]
    : []
}

function accountRisk(account: Account, book: PriceBook, path: Path) {
  const missing = missingPrices(account, book)
  const debt = account.kind === 'spot' || account.kind === 'loan' ? d(account.debt) : zero
  const triggerAsset = account.kind === 'cashSpot' ? '' : account.kind === 'spot' ? 'BTC' : account.asset
  let equity: Decimal | null = null,
    exposure: Decimal | null = null,
    gross: Decimal | null = null
  let reference: Decimal | null = null,
    warn: Decimal | null = null,
    liq: Decimal | null = null
  let risk: Decimal | null = null,
    ltv: Decimal | null = null,
    maintenance: Decimal | null = null
  let boundary: Decimal | null = null,
    warnBoundary: Decimal | null = null
  let alert = one,
    limit = one
  if (account.kind === 'cashSpot') {
    gross = spotGross(account, book)
    equity = gross
    exposure = gross
  } else if (account.kind === 'spot') {
    alert = spotAlert
    const anchor = referencePrice(book, 'BTC')
    reference = anchor === null ? null : d(anchor)
    gross = spotGross(account, book)
    exposure = gross
    equity = gross === null ? null : gross.minus(debt)
    maintenance = debt.mul(spotMaintenance)
    risk = debt.isZero() ? zero : equity === null ? null : riskRatio(maintenance, equity)
    if (!debt.isZero()) {
      boundary = debt.plus(maintenance)
      warnBoundary = debt.plus(maintenance.div(alert))
      liq = spotTrigger(account, book, path, boundary)
      warn = spotTrigger(account, book, path, warnBoundary)
    }
  } else if (account.kind === 'loan') {
    alert = d(account.warningLtv)
    limit = d(account.liquidationLtv)
    reference = price(book, 'loan', account.asset)
    gross = reference?.mul(account.collateral) ?? null
    exposure = gross
    equity = gross === null ? null : gross.minus(debt)
    ltv = debt.isZero() ? zero : gross === null ? null : riskRatio(debt, gross)
    risk = ltv
    if (debt.gt(0) && d(account.collateral).gt(0)) {
      liq = debt.div(d(account.collateral).mul(limit))
      warn = debt.div(d(account.collateral).mul(alert))
    }
  } else if (d(account.size).isZero()) {
    // A fully closed fill preview keeps realized USDT in the isolated account.
    gross = equity = d(account.margin)
    exposure = maintenance = risk = zero
  } else {
    alert = perpAlert
    reference = price(book, 'mark', account.asset)
    if (reference !== null) {
      const values = perpAmounts(account, reference)
      equity = values.equity
      maintenance = values.maintenance
      exposure = values.notional
      gross = equity
      risk = riskRatio(maintenance, equity)
    }
    warn = perpTrigger(account, alert)
    liq = perpTrigger(account, limit)
  }
  const distance = (trigger: Decimal | null) => {
    if (trigger === null || reference === null || reference.isZero()) return null
    const side = account.kind === 'perp' && account.side === 'short' ? -1 : 1
    return reference
      .minus(trigger)
      .mul(side * 100)
      .div(reference)
  }
  const status: RiskStatus = missing.length
    ? 'Unpriced'
    : risk?.gte(limit)
      ? 'Liquidation'
      : risk?.gte(alert)
        ? 'Warning'
        : 'Safe'
  const row: AccountRisk = {
    account,
    status,
    missing,
    triggerAsset,
    equity: number(equity),
    equityAtTrigger: null,
    debt: number(debt)!,
    gross: number(gross),
    exposure: number(exposure),
    leverage: equity?.gt(0) && exposure !== null ? exposure.div(equity).toNumber() : null,
    risk: number(risk),
    ltv: number(ltv),
    maintenance: number(maintenance),
    referencePrice: number(reference),
    warningPrice: number(warn),
    liquidationPrice: number(liq),
    btcLiquidationPrice: number(btcLiquidationPrice(account, book, path, liq)),
    distancePct: number(distance(liq)),
    warningDistancePct: number(distance(warn)),
    assetBoundary: number(boundary),
    warningBoundary: number(warnBoundary),
  }
  return { row, debt, equity, exposure }
}

export interface RiskEvent {
  id: string
  name: string
  asset: string
  price: number | null
  distancePct: number
  basis?: Basis
  pathPoint?: { asset: string; price: number }
  atSnapshot?: boolean
}
function firstEvent(rows: AccountRisk[], warning: boolean): RiskEvent | null {
  let closest: RiskEvent | null = null
  for (const row of rows) {
    if (row.status === 'Unpriced') continue
    const reached = row.status === 'Liquidation' || (warning && row.status === 'Warning')
    const distance = warning ? row.warningDistancePct : row.distancePct
    if (distance === null && !reached) continue
    const distancePct = reached ? 0 : Math.max(0, distance!)
    if (!closest || distancePct < closest.distancePct) {
      closest = {
        id: row.account.id,
        name: row.account.name,
        asset: row.triggerAsset,
        price: warning ? row.warningPrice : row.liquidationPrice,
        distancePct,
      }
    }
  }
  return closest
}
// A spot threshold belongs to the whole margin account. Name a single asset
// only if that asset or the modeled BTC path explains the price move.
function spotCrossingLabel(
  account: SpotAccount,
  context: ScenarioContext,
  book: PriceBook,
  sample: PriceBook,
  threshold: Decimal,
  atStart: boolean,
) {
  const { snapshot, path, overrides } = context
  const moving = [
    ...new Set(account.holdings.filter((h) => d(h.quantity).gt(0)).map((h) => h.asset)),
  ].filter((asset) => !price(snapshot, 'spot', asset)!.eq(price(book, 'spot', asset)!))
  const debt = d(account.debt)
  const boundary = debt.plus(debt.mul(spotMaintenance).div(threshold))
  const gross = { asset: 'gross assets', price: boundary.toNumber() }
  if (!moving.length) return gross
  const btcDriven = moving.every(
    (asset) => asset === 'BTC' || (overrides[asset] === undefined && multiplier(path, asset).gt(0)),
  )
  if (btcDriven) {
    const trigger = atStart
      ? spotTrigger(account, snapshot, path, boundary)?.toString()
      : referencePrice(sample, 'BTC')
    return trigger == null ? gross : { asset: 'BTC', price: Number(trigger) }
  }
  if (moving.length !== 1) return gross
  const asset = moving[0]
  if (!atStart) return { asset, price: price(sample, 'spot', asset)!.toNumber() }
  const quantity = sum(account.holdings.filter((h) => h.asset === asset).map((h) => d(h.quantity)))
  const fixedValue = spotGross(account, snapshot)!.minus(price(snapshot, 'spot', asset)!.mul(quantity))
  const trigger = boundary.minus(fixedValue).div(quantity)
  return trigger.lt(0) ? gross : { asset, price: trigger.toNumber() }
}
// Manual prices move linearly to their overrides. A linked price can reach zero
// before the end, changing the slope of a margin account's combined collateral.
function scenarioPath(book: PriceBook, context: ScenarioContext) {
  const { snapshot, overrides, path } = context
  const fromBtc = referencePrice(snapshot, 'BTC')
  const move =
    fromBtc && d(fromBtc).gt(0) && overrides.BTC !== undefined
      ? d(overrides.BTC).div(fromBtc).minus(1)
      : zero
  const stops = [zero, one]
  const linkedWeights = new Set(
    Object.entries(btcMoveMultipliers[path])
      .filter(([asset]) => overrides[asset] === undefined && referencePrice(snapshot, asset) !== null)
      .map(([, weight]) => weight),
  )
  for (const weight of linkedWeights) {
    const change = d(weight).mul(move)
    if (change.lt(-1)) stops.push(one.neg().div(change))
  }
  const samples = new Map<string, PriceBook>([
    ['0', snapshot],
    ['1', book],
  ])
  const bookAt = (fraction: Decimal) => {
    const key = fraction.toString()
    const existing = samples.get(key)
    if (existing) return existing
    const adjusted: Prices = {}
    for (const [asset, target] of Object.entries(overrides)) {
      const anchor = referencePrice(snapshot, asset)
      if (anchor !== null)
        adjusted[asset] = d(anchor).plus(d(target).minus(anchor).mul(fraction)).toFixed()
    }
    const sample = buildScenario(snapshot, path, adjusted)
    samples.set(key, sample)
    return sample
  }
  return { book, context, stops: stops.sort((a, b) => a.cmp(b)), bookAt }
}

// A single manually moved asset defines a continuation. Independent moves in
// multiple assets have no unique next price once their selected targets are met.
function scenarioDirection(context: ScenarioContext) {
  const axes = Object.entries(context.overrides).flatMap(([asset, target]) => {
    const ref = referencePrice(context.snapshot, asset)
    if (asset === 'USDT' || ref === null || d(ref).lte(0) || d(ref).eq(target)) return []
    return [{ asset, ref: d(ref), target: d(target), falling: d(target).lt(ref) }]
  })
  return axes.length === 1 ? axes[0] : null
}
type ScenarioDirection = NonNullable<ReturnType<typeof scenarioDirection>>

// Scan the rest of the same price path, using the frozen snapshot throughout.
// A decline ends at zero. On a rise only perpetuals can newly breach a
// threshold; scan past their possible marks, converted to the driving asset.
function remainingPath(rows: AccountRisk[], context: ScenarioContext, direction: ScenarioDirection) {
  const { asset, ref, target, falling } = direction
  let end = zero
  if (!falling) {
    end = target
    for (const { account } of rows) {
      if (account.kind !== 'perp' || d(account.size).isZero()) continue
      const linked = asset === 'BTC' && context.overrides[account.asset] === undefined
      const weight = account.asset === asset ? one : linked ? multiplier(context.path, account.asset) : zero
      const originalMark = price(context.snapshot, 'mark', account.asset)
      if (weight.isZero() || !originalMark?.gt(0)) continue
      const marks = [...perpThresholdMarks(account, one), ...perpThresholdMarks(account, perpAlert)]
      for (const mark of marks) {
        const driverPrice = driverPriceAtThreshold(ref, originalMark, mark, weight)
        if (driverPrice?.gt(target)) end = D.max(end, driverPrice.plus(ref))
      }
    }
  }
  if (end.eq(target)) return null
  const overrides = { ...context.overrides, [asset]: end.toFixed() }
  const book = buildScenario(context.snapshot, context.path, overrides)
  return scenarioPath(book, { ...context, overrides })
}

// A stress move can cross more than one account's trigger. Rank crossings by
// their order along the move, even if both endpoints finish beyond liquidation.
function scenarioCrossings(
  rows: AccountRisk[],
  move: ReturnType<typeof scenarioPath>,
  direction: ScenarioDirection | null,
  warning: boolean,
) {
  // null means the position was already beyond its threshold at the snapshot.
  const crossings = new Map<string, Decimal | null>()
  const { book, context, bookAt } = move
  const { snapshot, path } = context
  let earliest: Decimal | null = null,
    event: RiskEvent | null = null
  for (const row of rows) {
    const a = row.account
    if (
      a.kind === 'cashSpot' ||
      row.missing.length ||
      (a.kind === 'perp' ? d(a.size).isZero() : d(a.debt).isZero())
    )
      continue
    const threshold = warning ? (a.kind === 'perp' ? perpAlert : spotAlert) : one
    const headroom = (q: PriceBook) => {
      if (a.kind === 'spot')
        return spotGross(a, q)!.minus(a.debt).mul(threshold).minus(d(a.debt).mul(spotMaintenance))
      if (a.kind === 'loan')
        return price(q, 'loan', a.asset)!
          .mul(a.collateral)
          .mul(warning ? a.warningLtv : a.liquidationLtv)
          .minus(a.debt)
      const v = perpAmounts(a, price(q, 'mark', a.asset)!)
      return v.equity.mul(threshold).minus(v.maintenance)
    }
    // Within a price-floor/tier interval both equity and maintenance are linear.
    const stops = [...move.stops]
    if (a.kind === 'perp') {
      const tiers = positionTiers(a)
      const boundaries = tiers.slice(1).map((t) => t.min)
      for (const [index, tier] of tiers.entries()) {
        const rate = tier.rate.plus(a.takerFee)
        if (rate.isZero() || tier.offset.isZero()) continue
        const floor = tier.offset.div(rate)
        if (floor.gt(tier.min) && (!tiers[index + 1] || floor.lt(tiers[index + 1].min)))
          boundaries.push(floor)
      }
      const segments = [...stops]
      for (let i = 1; i < segments.length; i++) {
        const start = segments[i - 1],
          end = segments[i]
        const startN = price(bookAt(start), 'mark', a.asset)!.mul(a.size)
        const endN = price(bookAt(end), 'mark', a.asset)!.mul(a.size)
        for (const boundary of boundaries)
          if (boundary.gt(D.min(startN, endN)) && boundary.lt(D.max(startN, endN))) {
            stops.push(start.plus(boundary.minus(startN).div(endN.minus(startN)).mul(end.minus(start))))
          }
      }
      stops.sort((x, y) => x.cmp(y))
    }
    let previous = zero,
      previousRoom = headroom(snapshot)
    for (const end of stops) {
      const room = headroom(bookAt(end))
      if (room.lte(0)) {
        const fraction = previousRoom.lte(0)
          ? previous
          : previous.plus(end.minus(previous).mul(previousRoom).div(previousRoom.minus(room)))
        crossings.set(a.id, fraction.isZero() && previousRoom.lt(0) ? null : fraction)
        if (earliest === null || fraction.lt(earliest)) {
          earliest = fraction
          const sample = bookAt(fraction)
          const atStart = fraction.isZero()
          let label: { asset: string; price: number | null }
          if (a.kind === 'spot') {
            label = spotCrossingLabel(a, context, book, sample, threshold, atStart)
          } else {
            // An already-breached position reports its boundary, not the opening quote.
            const initial = atStart ? accountRisk(a, snapshot, path).row : null
            const trigger = initial
              ? warning
                ? initial.warningPrice
                : initial.liquidationPrice
              : number(price(sample, a.kind === 'loan' ? 'loan' : 'mark', a.asset))
            label = { asset: a.asset, price: trigger }
          }
          event = { id: a.id, name: a.name, ...label, distancePct: 0, atSnapshot: atStart }
          if (a.kind !== 'spot') event.basis = a.kind === 'loan' ? 'loan' : 'mark'
          if (direction && !atStart) {
            event.pathPoint = {
              asset: direction.asset,
              price: Number(referencePrice(sample, direction.asset)),
            }
          }
        }
        break
      }
      previous = end
      previousRoom = room
    }
  }
  return { first: event, crossings }
}
export function evaluate(accounts: Account[], book: PriceBook, path: Path = contexts.get(book)?.path ?? 'Base') {
  const values = accounts.filter((a) => !a.archived).map((a) => accountRisk(a, book, path))
  const rows = values.map((v) => v.row)
  const missing = [...new Set(rows.flatMap((r) => r.missing))]
  const context = contexts.get(book)
  const move = context && scenarioPath(book, context)
  const direction = context ? scenarioDirection(context) : null
  const liquidations = move && scenarioCrossings(rows, move, direction, false)
  const warnings = move && scenarioCrossings(rows, move, direction, true)
  const remaining = context && direction && remainingPath(rows, context, direction)
  const nextEvent = (observed: typeof liquidations, warning: boolean) => {
    if (!remaining || !observed) return null
    const pending = rows.filter((row) => !observed.crossings.has(row.account.id))
    return scenarioCrossings(pending, remaining, direction, warning).first
  }
  const nextWarning = nextEvent(warnings, true)
  const nextLiquidation = nextEvent(liquidations, false)

  // Settle each crossed position before summing the portfolio. A sibling position
  // can keep its equity even when this one would have a negative mark-to-market value.
  if (liquidations && move && context) {
    for (const value of values) {
      const row = value.row
      if (row.status !== 'Liquidation' && !liquidations.crossings.has(row.account.id)) continue
      const fraction = liquidations.crossings.get(row.account.id)
      if (fraction != null) {
        row.equityAtTrigger = number(accountRisk(row.account, move.bookAt(fraction), context.path).equity)
      }
      value.equity = zero
      value.exposure = zero
      row.status = 'Liquidation'
      row.equity = 0
      row.exposure = 0
      row.gross = 0
      row.leverage = null
      row.risk = null
      row.ltv = null
      row.maintenance = 0
      row.distancePct = 0
      row.warningDistancePct = 0
    }
  }
  const equity = missing.length ? null : sum(values.map((v) => v.equity!))
  const exposure = missing.length ? null : sum(values.map((v) => v.exposure!))
  const marginAndLoans = values.filter(({ row }) => row.account.kind !== 'cashSpot')
  const leveragedEquity = marginAndLoans.some(({ row }) => row.missing.length > 0)
    ? null
    : sum(marginAndLoans.map((v) => v.equity!))
  const leverage = leveragedEquity?.gt(0)
    ? sum(marginAndLoans.map((v) => v.exposure!)).div(leveragedEquity).toNumber()
    : null
  return {
    accounts: rows,
    equity: number(equity),
    debt: sum(values.map((v) => v.debt)).toNumber(),
    exposure: number(exposure),
    leverage,
    missing,
    firstWarning: warnings ? warnings.first : firstEvent(rows, true),
    firstLiquidation: liquidations ? liquidations.first : firstEvent(rows, false),
    nextWarning,
    nextLiquidation,
    direction: direction ? { asset: direction.asset, falling: direction.falling } : null,
  }
}

export interface FundingSource {
  kind: 'spotUsdt' | 'pledge' | 'external'
  accountId: string | null
  name: string
  asset: string
  /** Actual USDT transferred from this source to the enclosing destination. */
  amount: number
}
export interface PledgeResult {
  accountId: string
  name: string
  asset: string
  requestedQuantity: number
  pledgedQuantity: number
  unusedQuantity: number
  capacity: number
  borrowed: number
  proceedsUsed: number
  unspentProceeds: number
  liquidationPrice: number | null
  /** Borrowed / stressed collateral value, expressed as a fraction. */
  targetLtv: number | null
  livePrice: number
  targetPrice: number
  unavailableReason: 'collateralLimit' | 'borrowMinimum' | 'stressLimit' | null
}
export interface CashAction {
  sources: FundingSource[]
  accountId: string
  name: string
  kind: RiskAccount['kind']
  action: string
  triggerAsset: string
  targetPrice: number | null
  beforeLiquidation: number | null
  afterLiquidation: number | null
  /** Transfer the saved position needs to survive the path through the buffered target. */
  required: number | null
  /** Planned USDT from all sources, in the destination's executable increments. */
  allocated: number | null
  /** Amount the plan would repay or add to margin. */
  applied: number | null
  /** Free USDT left at this destination after a full repayment. */
  residual: number | null
  uncovered: number | null
  resultingBalance: number | null
  /** Projected coverage after applying the allocation to a copy of the saved position. */
  safe: boolean | null
}

function validInput(raw: string | undefined) {
  return typeof raw === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) && Number.isFinite(Number(raw))
}
function fundedAccount(account: RiskAccount, cash: Decimal): RiskAccount {
  if (account.kind === 'perp') return { ...account, margin: d(account.margin).plus(cash).toFixed() }
  return { ...account, debt: D.max(0, d(account.debt).minus(cash)).toFixed() }
}

/** Minimum external cash. Repayment uses new USDT and keeps gross assets/pledge intact.
 * Floor-plus-one enforces the strict inequality even when the boundary is an exact cent. */
function cashNeed(account: RiskAccount, book: PriceBook) {
  const increment = d(account.increment ?? '0.01')
  let shortfall: Decimal
  if (account.kind === 'perp') {
    if (d(account.size).isZero()) return zero
    const { maintenance, equity } = perpAmounts(account, price(book, 'mark', account.asset)!)
    shortfall = maintenance.minus(equity)
  } else if (d(account.debt).isZero()) {
    return zero
  } else if (account.kind === 'spot') {
    shortfall = d(account.debt).minus(spotGross(account, book)!.div(one.plus(spotMaintenance)))
  } else {
    shortfall = d(account.debt).minus(
      price(book, 'loan', account.asset)!.mul(account.collateral).mul(account.liquidationLtv),
    )
  }
  if (shortfall.lt(0)) return zero
  let required = shortfall.div(increment).floor().plus(1).mul(increment)
  if (account.kind !== 'perp')
    required = D.min(required, d(account.debt).div(increment).ceil().mul(increment))
  return required
}

interface FundingPool {
  kind: 'spotUsdt' | 'pledge'
  accountId: string
  name: string
  asset: string
  available: Decimal
  used: Decimal
}
interface PledgePool extends FundingPool {
  kind: 'pledge'
  quantity: Decimal
  livePrice: Decimal
  targetPrice: Decimal
  minBorrow: Decimal
  liquidationLtv: Decimal
  unavailableReason: PledgeResult['unavailableReason']
}

const cent = d('.01')
const floorCent = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_FLOOR)
const ceilCent = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_CEIL)

function validRange(min: string | undefined, max: string | undefined) {
  if (min !== undefined && !validInput(min)) return false
  if (max !== undefined && (!validInput(max) || d(max).lte(0))) return false
  return min === undefined || max === undefined || d(min).lte(max)
}

function pledgeSource(
  wallet: CashSpotAccount,
  request: PledgeInput,
  live: PriceBook,
  target: PriceBook,
): PledgePool | string {
  const { asset, borrowLtvPct, liquidationLtvPct, quantity } = request
  const holding = walletHoldings(wallet).find((h) => h.asset === asset)
  if (asset === 'USDT') return 'USDT cannot secure a USDT loan'
  if (!holding || !validInput(quantity) || d(quantity).lte(0) || d(quantity).gt(holding.quantity))
    return 'Pledge quantity must be positive and within the available wallet balance'
  if (
    !validInput(borrowLtvPct) ||
    !validInput(liquidationLtvPct) ||
    d(borrowLtvPct).lte(0) ||
    d(borrowLtvPct).gte(liquidationLtvPct) ||
    d(liquidationLtvPct).gt(100)
  )
    return 'Borrow LTV must be positive and below a liquidation LTV of at most 100%'
  if (
    !validRange(request.minBorrowUsdt, request.maxBorrowUsdt) ||
    !validRange(request.minCollateralUsdt, request.maxCollateralUsdt)
  )
    return 'Enter valid Bitget borrowing and collateral limits'
  const livePrice = price(live, 'loan', asset)
  const targetPrice = price(target, 'loan', asset)
  if (!livePrice || !livePrice.gt(0) || targetPrice === null) return `${asset} loan reference`
  const quantityD = d(quantity)
  const liveValue = livePrice.mul(quantityD)
  const targetValue = targetPrice.mul(quantityD)
  const liquidationLtv = d(liquidationLtvPct).div(100)
  const minBorrow = ceilCent(d(request.minBorrowUsdt ?? 0))
  // Equality is allowed at origination, but never at the liquidation threshold.
  const initialCap = floorCent(liveValue.mul(borrowLtvPct).div(100))
  const survivalCap = D.max(0, ceilCent(D.min(liveValue, targetValue).mul(liquidationLtv)).minus(cent))
  let available = D.min(initialCap, survivalCap)
  if (request.maxBorrowUsdt !== undefined)
    available = D.min(available, floorCent(d(request.maxBorrowUsdt)))
  let unavailableReason: PledgeResult['unavailableReason'] = null
  if (
    (request.minCollateralUsdt !== undefined && liveValue.lt(request.minCollateralUsdt)) ||
    (request.maxCollateralUsdt !== undefined && liveValue.gt(request.maxCollateralUsdt))
  )
    unavailableReason = 'collateralLimit'
  else if (available.lt(minBorrow)) unavailableReason = 'borrowMinimum'
  else if (available.isZero()) unavailableReason = 'stressLimit'
  if (unavailableReason) available = zero
  return {
    kind: 'pledge',
    accountId: wallet.id,
    name: wallet.name,
    asset,
    available,
    used: zero,
    quantity: quantityD,
    livePrice,
    targetPrice,
    minBorrow,
    liquidationLtv,
    unavailableReason,
  }
}

// One loan order can fund several destinations. Round the cumulative draw once.
function loanPrincipal(pool: PledgePool): Decimal {
  return pool.used.isZero() ? zero : D.max(ceilCent(pool.used), pool.minBorrow)
}

function pledgeOutcome(pool: PledgePool): PledgeResult {
  const borrowed = loanPrincipal(pool)
  return {
    accountId: pool.accountId,
    name: pool.name,
    asset: pool.asset,
    requestedQuantity: pool.quantity.toNumber(),
    pledgedQuantity: pool.used.isZero() ? 0 : pool.quantity.toNumber(),
    unusedQuantity: pool.used.isZero() ? pool.quantity.toNumber() : 0,
    capacity: pool.available.toNumber(),
    borrowed: borrowed.toNumber(),
    proceedsUsed: pool.used.toNumber(),
    unspentProceeds: borrowed.minus(pool.used).toNumber(),
    liquidationPrice: borrowed.isZero()
      ? null
      : borrowed.div(pool.quantity.mul(pool.liquidationLtv)).toNumber(),
    targetLtv: borrowed.isZero() ? null : borrowed.div(pool.quantity.mul(pool.targetPrice)).toNumber(),
    livePrice: pool.livePrice.toNumber(),
    targetPrice: pool.targetPrice.toNumber(),
    unavailableReason: pool.unavailableReason,
  }
}

/** Take USDT in source order. Pools are new for each run and never refer to stored holdings. */
function drawSources(pools: FundingPool[], transfer: Decimal) {
  let external = transfer
  const sources: FundingSource[] = []
  for (const pool of pools) {
    if (external.isZero()) break
    const draw = D.min(external, pool.available.minus(pool.used))
    if (draw.isZero()) continue
    pool.used = pool.used.plus(draw)
    external = external.minus(draw)
    sources.push({
      kind: pool.kind,
      accountId: pool.accountId,
      name: pool.name,
      asset: pool.asset,
      amount: draw.toNumber(),
    })
  }
  if (external.gt(0))
    sources.push({
      kind: 'external',
      accountId: null,
      name: 'External budget',
      asset: 'USDT',
      amount: external.toNumber(),
    })
  return { sources, external }
}

export function planFromScenario(scenario: PlanSnapshot & { path: Path }): PlanInput {
  const { BTC, USDT: _usdt, ...altcoins } = scenario.overrides
  const target = BTC ?? referencePrice(scenario.book, 'BTC')
  return {
    target: target == null ? '' : d(target).toFixed(),
    path: scenario.path,
    useSpotUsdt: true,
    snapshot: structuredClone({
      book: scenario.book,
      asOf: scenario.asOf,
      stale: scenario.stale,
      overrides: altcoins,
    }),
  }
}

export function planCash(
  accounts: Account[],
  currentBook: PriceBook,
  input: PlanInput,
  staleKeys: readonly string[] = [],
) {
  const liveBook = input.snapshot?.book ?? currentBook
  const priority = { spot: 0, loan: 1, perp: 2 }
  const active = accounts.filter((a) => !a.archived)
  const selected = active
    .filter(
      (a): a is RiskAccount => a.kind !== 'cashSpot' && (!input.accountId || a.id === input.accountId),
    )
    .sort((a, b) => priority[a.kind] - priority[b.kind])
  const wallets = active.filter((a): a is CashSpotAccount => a.kind === 'cashSpot')
  const needed = new Set<string>()
  const btcBasis = bases.find((basis) => liveBook[basis].BTC !== undefined)
  const needsBtc = selected.some((a) => a.kind !== 'perp' || d(a.size).gt(0)) || !!input.pledges?.length
  if (btcBasis && needsBtc) needed.add(btcBasis + ':BTC')
  for (const a of selected) {
    if (a.kind === 'spot')
      a.holdings
        .filter((h) => d(h.quantity).gt(0) && h.asset !== 'USDT')
        .forEach((h) => needed.add('spot:' + h.asset))
    else if (a.kind !== 'perp' || d(a.size).gt(0))
      needed.add((a.kind === 'loan' ? 'loan:' : 'mark:') + a.asset)
  }
  for (const p of input.pledges ?? []) needed.add('loan:' + p.asset)
  const symbols = new Set([...needed].map((key) => key.split(':')[1]))
  const overrides = input.snapshot?.overrides ?? {}
  for (const asset of symbols) {
    if (overrides[asset] === undefined) continue
    const anchor = bases.find((basis) => liveBook[basis][asset] !== undefined)
    if (anchor) needed.add(anchor + ':' + asset)
  }
  const stale = (input.snapshot ? input.snapshot.stale ?? [] : staleKeys).filter((k) => needed.has(k))
  const references: { basis: Basis; asset: string; start: number | null; end: number | null }[] = []
  const actions: CashAction[] = []
  const missing = new Set<string>()
  const invalid = (message: string) => ({
    bufferedBtcTarget: null,
    required: null,
    allocated: null,
    uncovered: null,
    budgetRemaining: null,
    externalNeeded: null,
    externalUsed: null,
    spotUsdtUsed: null,
    newDebt: null,
    pledges: [] as PledgeResult[],
    references,
    actions,
    stale,
    missing: [message],
  })
  if (input.accountId && !selected.length)
    return invalid('The selected account is archived or missing. Choose an active account.')
  if (!validInput(input.target) || d(input.target).lte(0))
    return invalid('Enter a BTC target greater than zero')
  if (input.bufferPct && (!validInput(input.bufferPct) || d(input.bufferPct).gte(100)))
    return invalid('Enter a buffer from zero up to, but below, 100%')
  if (input.budget && !validInput(input.budget)) return invalid('Enter a nonnegative cash budget')
  const ref = referencePrice(liveBook, 'BTC')
  if (needsBtc && (!ref || d(ref).lte(0))) return invalid('BTC reference price')
  const descending = d(input.target).lte(ref ?? 0)
  const target = d(input.target).mul(
    one.plus(
      d(input.bufferPct || 0)
        .div(100)
        .mul(descending ? -1 : 1),
    ),
  )
  // The frozen market can include every Bitget pair. Only these quotes enter the calculation.
  const startBook: PriceBook = { spot: {}, loan: {}, mark: {} }
  for (const basis of bases)
    for (const asset of symbols) {
      const quote = liveBook[basis][asset]
      if (quote !== undefined) startBook[basis][asset] = quote
    }
  const move = {
    path: input.path,
    snapshot: startBook,
    overrides: { ...overrides, BTC: target.toFixed() },
  }
  const targetBook = buildScenario(startBook, input.path, move.overrides)
  const path = scenarioPath(targetBook, move)
  const pathBooks = path.stops.map(path.bookAt)
  for (const key of needed) {
    const [basis, asset] = key.split(':') as [Basis, string]
    references.push({
      basis,
      asset,
      start: number(price(startBook, basis, asset)),
      end: number(price(targetBook, basis, asset)),
    })
  }

  const cashPools: FundingPool[] = []
  if (input.useSpotUsdt) {
    for (const wallet of wallets) {
      const usdt = walletHoldings(wallet).find((h) => h.asset === 'USDT')
      if (usdt && d(usdt.quantity).gt(0))
        cashPools.push({
          kind: 'spotUsdt',
          accountId: wallet.id,
          name: wallet.name,
          asset: 'USDT',
          available: d(usdt.quantity),
          used: zero,
        })
    }
  }
  const pledgePools: PledgePool[] = []
  const requested = new Set<string>()
  for (const request of input.pledges ?? []) {
    const wallet = wallets.find((a) => a.id === request.accountId)
    if (!wallet) return invalid('A pledge source is archived or missing. Choose an active spot wallet.')
    const key = JSON.stringify([request.accountId, request.asset])
    if (requested.has(key)) return invalid('Choose each wallet and collateral asset only once')
    requested.add(key)
    const pool = pledgeSource(wallet, request, liveBook, targetBook)
    if (typeof pool === 'string') return invalid(pool)
    pledgePools.push(pool)
  }
  const pools = [...cashPools, ...pledgePools]
  const internalCapacity = sum(pools.map((p) => p.available))
  let internalLeft = internalCapacity
  let requiredTotal = zero,
    allocatedTotal = zero,
    externalUsed = zero
  let budgetLeft = input.budget ? d(input.budget) : null
  let unknownPriority = false
  for (const account of selected) {
    const before = accountRisk(account, startBook, input.path).row
    // A move with independent holdings can cross a gross collateral boundary
    // at several different BTC prices. State that boundary directly.
    const mixedSpot =
      account.kind === 'spot' &&
      account.holdings.some((h) => d(h.quantity).gt(0) && overrides[h.asset] !== undefined)
    const action =
      account.kind === 'spot'
        ? 'Repay spot margin debt'
        : account.kind === 'loan'
          ? 'Repay this loan while keeping its collateral pledged'
          : 'Add isolated margin'
    const row: CashAction = {
      accountId: account.id,
      name: account.name,
      kind: account.kind,
      action,
      sources: [],
      triggerAsset: mixedSpot ? 'gross assets' : before.triggerAsset,
      targetPrice:
        account.kind === 'spot'
          ? target.toNumber()
          : number(price(targetBook, account.kind === 'loan' ? 'loan' : 'mark', account.asset)),
      beforeLiquidation: mixedSpot ? before.assetBoundary : before.liquidationPrice,
      afterLiquidation: null,
      required: null,
      allocated: null,
      applied: null,
      residual: null,
      uncovered: null,
      resultingBalance: null,
      safe: null,
    }
    if (before.missing.length) {
      before.missing.forEach((m) => missing.add(m))
      if (budgetLeft !== null || pools.length) unknownPriority = true
    } else {
      const required = D.max(...pathBooks.map((book) => cashNeed(account, book)))
      requiredTotal = requiredTotal.plus(required)
      row.required = required.toNumber()
      if (!unknownPriority) {
        const step = d(account.increment ?? '0.01')
        const allocated =
          budgetLeft === null
            ? required
            : D.min(required, budgetLeft.plus(internalLeft).div(step).floor().mul(step))
        const funding = drawSources(pools, allocated)
        row.sources = funding.sources
        externalUsed = externalUsed.plus(funding.external)
        if (budgetLeft !== null) budgetLeft = budgetLeft.minus(funding.external)
        internalLeft = internalLeft.minus(allocated.minus(funding.external))
        allocatedTotal = allocatedTotal.plus(allocated)
        const applied = account.kind === 'perp' ? allocated : D.min(allocated, account.debt)
        const funded = fundedAccount(account, applied)
        row.allocated = allocated.toNumber()
        row.applied = applied.toNumber()
        row.residual = allocated.minus(applied).toNumber()
        row.uncovered = required.minus(allocated).toNumber()
        row.resultingBalance = d(funded.kind === 'perp' ? funded.margin : funded.debt).toNumber()
        const after = accountRisk(funded, startBook, input.path).row
        row.afterLiquidation = mixedSpot ? after.assetBoundary : after.liquidationPrice
        row.safe = pathBooks.every((book) => cashNeed(funded, book).isZero())
      }
    }
    actions.push(row)
  }
  const pledges = pledgePools.map(pledgeOutcome)
  return {
    bufferedBtcTarget: ref === null ? null : target.toNumber(),
    required: missing.size ? null : requiredTotal.toNumber(),
    allocated: missing.size ? null : allocatedTotal.toNumber(),
    uncovered: missing.size ? null : requiredTotal.minus(allocatedTotal).toNumber(),
    budgetRemaining: missing.size ? null : number(budgetLeft),
    externalNeeded: missing.size ? null : D.max(0, requiredTotal.minus(internalCapacity)).toNumber(),
    externalUsed: missing.size ? null : externalUsed.toNumber(),
    spotUsdtUsed: missing.size ? null : sum(cashPools.map((p) => p.used)).toNumber(),
    newDebt: missing.size ? null : sum(pledgePools.map(loanPrincipal)).toNumber(),
    actions,
    pledges,
    references,
    stale,
    missing: [...missing],
  }
}
