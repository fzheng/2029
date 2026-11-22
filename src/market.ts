import { Decimal } from 'decimal.js'
import type { Basis, PledgeInput, PriceBook } from './model'
import archivedBtcDaily from './data/bitget-btc-daily.json'

const BASE = 'https://api.bitget.com'
const QUOTE_CACHE = '2029.bitget-market.v1'
const CANDLE_CACHE = '2029.bitget-candles.v1'
const MAX_AGE = 2 * 60_000
const intervalMillis = { '1H': 3_600_000, '4H': 4 * 3_600_000, '1D': 86_400_000, '1W': 7 * 86_400_000 }
const bases: Basis[] = ['spot', 'mark', 'loan']
export const popularSymbols = ['BTC', 'ETH', 'SOL', 'BNB', 'HYPE']
export const chartIntervals = ['1H', '4H', '1D', '1W'] as const
export type ChartInterval = (typeof chartIntervals)[number]

interface Quote {
  value: string
  time: number
  change?: number
}

interface QuoteCache {
  quotes: Record<string, Quote>
  symbols: string[]
}

export interface MarketSnapshot {
  book: PriceBook
  /** All last-known instrument prices returned by this sweep, kept with a simulation snapshot. */
  universe: PriceBook
  universeStatus: Record<string, 'fresh' | 'stale'>
  prices: Record<string, number>
  marks: Record<string, number>
  loanRefs: Record<string, number>
  changes: Record<string, number>
  asOf: string | null
  observedAt: Record<string, string>
  stale: string[]
  missing: string[]
  symbols: string[]
}

// This cache contains only exchange data. The portfolio and scenario stores are independent.
function readCache<T>(key: string): T | undefined {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? undefined
  } catch {
    return undefined
  }
}

function writeCache(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* Restricted or full browser storage. */
  }
}

function lastQuotes(): QuoteCache {
  const saved = readCache<QuoteCache>(QUOTE_CACHE)
  return saved?.quotes && Array.isArray(saved.symbols) ? saved : { quotes: {}, symbols: [] }
}

interface Envelope<T> {
  code: string
  data: T
  requestTime: number
  msg: string
}

async function publicData<T>(path: string, signal?: AbortSignal): Promise<Envelope<T>> {
  // Vite's same-origin proxy works in browsers where cross-origin quotes are restricted.
  // The direct public endpoint also supports static deployments.
  for (const prefix of ['/bitget', BASE]) {
    try {
      const timeout = AbortSignal.timeout(6500)
      const response = await fetch(prefix + path, {
        cache: 'no-store',
        credentials: 'omit',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (!response.ok) throw new Error('Bitget returned HTTP ' + response.status)
      const data = (await response.json()) as Envelope<T>
      if (data.code !== '00000' || !data.data) throw new Error(data.msg || 'Bitget data unavailable')
      return data
    } catch (error) {
      if (signal?.aborted || prefix === BASE) throw error
    }
  }
  throw new Error('Bitget data unavailable')
}

function positive(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d+(\.\d+)?$/.test(value) &&
    Number.isFinite(Number(value)) &&
    Number(value) > 0
  )
}

function assetName(value: string) {
  return value.trim().toUpperCase()
}

function validTime(value: number) {
  return Number.isFinite(value) && value > 0 && value < 8.64e15
}

function validSymbol(symbol: string) {
  return /^[A-Z0-9]{1,30}$/.test(symbol)
}

interface Ticker {
  symbol: string
  lastPrice?: string
  markPrice?: string
  indexPrice?: string
  price24hPcnt?: string
  volume24h?: string
  ts?: string
}

function recordQuote(
  cache: QuoteCache,
  key: string,
  value: string | undefined,
  time: number,
  observed: Set<string>,
  change?: number,
  active = true,
) {
  if (!positive(value) || !validTime(time) || time > Date.now() + MAX_AGE) return
  if (cache.quotes[key]?.time > time) return
  cache.quotes[key] = { value, time, change }
  if (active) observed.add(key)
}

function snapshot(
  symbols: string[],
  cache: QuoteCache,
  observed: Set<string>,
  now: number,
): MarketSnapshot {
  const result: MarketSnapshot = {
    book: { spot: { USDT: '1' }, mark: { USDT: '1' }, loan: { USDT: '1' } },
    universe: { spot: { USDT: '1' }, mark: { USDT: '1' }, loan: { USDT: '1' } },
    universeStatus: {},
    prices: { USDT: 1 },
    marks: { USDT: 1 },
    loanRefs: { USDT: 1 },
    changes: {},
    asOf: null,
    observedAt: {},
    stale: [],
    missing: [],
    symbols: cache.symbols,
  }
  for (const [key, data] of Object.entries(cache.quotes)) {
    const [basis, symbol] = key.split(':') as [Basis, string]
    if (
      !bases.includes(basis) ||
      !validSymbol(symbol) ||
      !positive(data?.value) ||
      !validTime(data.time)
    )
      continue
    result.universe[basis][symbol] = data.value
    result.observedAt[key] = new Date(data.time).toISOString()
    result.universeStatus[key] = observed.has(key) && now - data.time <= MAX_AGE ? 'fresh' : 'stale'
  }
  const fields = { spot: result.prices, mark: result.marks, loan: result.loanRefs }
  let latest = 0
  for (const symbol of new Set(symbols.map(assetName))) {
    if (symbol === 'USDT') continue
    for (const basis of bases) {
      const key = basis + ':' + symbol
      const data = cache.quotes[key]
      if (!data || !positive(data.value) || !validTime(data.time)) {
        result.missing.push(key)
        continue
      }
      result.book[basis][symbol] = data.value
      fields[basis][symbol] = Number(data.value)
      if (basis === 'spot' && Number.isFinite(data.change)) result.changes[symbol] = data.change!
      latest = Math.max(latest, data.time)
      if (result.universeStatus[key] === 'stale') result.stale.push(key)
    }
  }
  result.asOf = latest ? new Date(latest).toISOString() : null
  return result
}

/** Cached values are always marked stale until revalidated against Bitget. */
export function cachedQuotes(symbols: string[] = popularSymbols) {
  return snapshot(symbols, lastQuotes(), new Set(), Date.now())
}

export async function fetchQuotes(
  symbols: string[] = popularSymbols,
  signal?: AbortSignal,
): Promise<MarketSnapshot> {
  const [spot, futures] = await Promise.allSettled(
    ['SPOT', 'USDT-FUTURES'].map((category) =>
      publicData<Ticker[]>('/api/v3/market/tickers?category=' + category, signal),
    ),
  )
  signal?.throwIfAborted()
  const cache = lastQuotes()
  const observed = new Set<string>()
  if (spot.status === 'fulfilled' && Array.isArray(spot.value.data)) {
    const available: string[] = []
    for (const row of spot.value.data) {
      if (typeof row.symbol !== 'string' || !row.symbol.endsWith('USDT')) continue
      const asset = row.symbol.slice(0, -4)
      if (!validSymbol(asset)) continue
      available.push(asset)
      const change =
        positive(row.lastPrice) && row.price24hPcnt?.trim() ? Number(row.price24hPcnt) * 100 : undefined
      // The envelope is the time of the request. Only the ticker's own timestamp
      // identifies the observation, and an unchanged last trade can be much older.
      const active = row.volume24h === undefined || Number(row.volume24h) > 0
      recordQuote(cache, 'spot:' + asset, row.lastPrice, Number(row.ts), observed, change, active)
    }
    cache.symbols = [...new Set(available)].sort()
  }
  if (futures.status === 'fulfilled' && Array.isArray(futures.value.data)) {
    for (const row of futures.value.data) {
      if (typeof row.symbol !== 'string' || !row.symbol.endsWith('USDT')) continue
      const asset = row.symbol.slice(0, -4)
      if (!validSymbol(asset)) continue
      const time = Number(row.ts)
      recordQuote(cache, 'mark:' + asset, row.markPrice, time, observed)
      // Public coin/USDT index used as the reference for estimated loan LTV.
      recordQuote(cache, 'loan:' + asset, row.indexPrice, time, observed)
    }
  }
  writeCache(QUOTE_CACHE, cache)
  return snapshot(symbols, cache, observed, Date.now())
}

interface TierResponse {
  startUnit: string
  endUnit: string
  keepMarginRate: string
}
export async function fetchContractTerms(symbol: string, signal?: AbortSignal) {
  const asset = assetName(symbol)
  if (!validSymbol(asset)) throw new Error('Choose a Bitget perpetual symbol.')
  const query = '?productType=USDT-FUTURES&symbol=' + asset + 'USDT'
  const [tierData, contracts] = await Promise.all([
    publicData<TierResponse[]>('/api/v2/mix/market/query-position-lever' + query, signal),
    publicData<{ symbol: string; takerFeeRate: string }[]>(
      '/api/v2/mix/market/contracts' + query,
      signal,
    ),
  ])
  const fee = contracts.data.find((contract) => contract.symbol === asset + 'USDT')?.takerFeeRate
  if (!fee || !/^\d+(\.\d+)?$/.test(fee) || !tierData.data.length)
    throw new Error('Bitget contract settings unavailable.')
  const tiers = tierData.data
    .map((tier) => {
      if (
        !/^\d+(\.\d+)?$/.test(tier.startUnit) ||
        !positive(tier.endUnit) ||
        !positive(tier.keepMarginRate)
      ) {
        throw new Error('Incomplete Bitget tier schedule.')
      }
      return { min: tier.startUnit, max: tier.endUnit, rate: tier.keepMarginRate }
    })
    .sort((a, b) => Number(a.min) - Number(b.min))
  return { tiers, takerFee: fee, asOf: new Date(tierData.requestTime).toISOString() }
}

type TermLimits = { coin: string; minUsdt: string; maxUsdt: string }
type PublicLoanTerms = {
  pledgeInfos: (TermLimits & { initRate: string; forceRate: string })[]
  loanInfos: TermLimits[]
}

export type PledgeTerms = Pick<
  PledgeInput,
  | 'borrowLtvPct'
  | 'liquidationLtvPct'
  | 'minBorrowUsdt'
  | 'maxBorrowUsdt'
  | 'minCollateralUsdt'
  | 'maxCollateralUsdt'
>

/** Public classic-loan product terms. No balances, amounts or identifiers leave the device. */
export async function fetchPledgeTerms(asset: string, signal?: AbortSignal): Promise<PledgeTerms> {
  if (!validSymbol(asset) || asset === 'USDT') throw new Error('Unsupported collateral symbol')
  const url = '/api/v2/earn/loan/public/coinInfos?coin='
  const [collateral, loan] = await Promise.all([
    publicData<PublicLoanTerms>(url + encodeURIComponent(asset), signal),
    publicData<PublicLoanTerms>(url + 'USDT', signal),
  ])
  const pledge = collateral.data.pledgeInfos?.find((row) => row.coin === asset)
  const usdt = loan.data.loanInfos?.find((row) => row.coin === 'USDT')
  if (!pledge || !usdt) throw new Error('No published terms for this pair')
  const rates = [pledge.initRate, pledge.forceRate]
  const limits = [usdt.minUsdt, usdt.maxUsdt, pledge.minUsdt, pledge.maxUsdt]
  if (
    ![...rates, ...limits].every(
      (value) =>
        typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value)),
    )
  ) {
    throw new Error('Invalid public loan terms')
  }
  const initial = new Decimal(pledge.initRate),
    liquidation = new Decimal(pledge.forceRate)
  if (
    !initial.gt(0) ||
    !initial.lt(liquidation) ||
    liquidation.gt(1) ||
    !new Decimal(usdt.maxUsdt).gt(0) ||
    new Decimal(usdt.minUsdt).gt(usdt.maxUsdt) ||
    !new Decimal(pledge.maxUsdt).gt(0) ||
    new Decimal(pledge.minUsdt).gt(pledge.maxUsdt)
  ) {
    throw new Error('Invalid public loan limits')
  }
  return {
    borrowLtvPct: initial.mul(100).toFixed(),
    liquidationLtvPct: liquidation.mul(100).toFixed(),
    minBorrowUsdt: usdt.minUsdt,
    maxBorrowUsdt: usdt.maxUsdt,
    minCollateralUsdt: pledge.minUsdt,
    maxCollateralUsdt: pledge.maxUsdt,
  }
}

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface CandleHistory {
  bars: Candle[]
  asOf: number
  status: 'live' | 'stale' | 'archived'
}

export function parseCandles(rows: string[][]) {
  const ordered = new Map<number, Candle>()
  for (const row of rows) {
    const [millis, open, high, low, close, volume] = row.map(Number)
    const time = Math.floor(millis / 1000)
    if (!validTime(millis) || ![open, high, low, close, volume].every(Number.isFinite)) continue
    if (low <= 0 || low > Math.min(open, close) || high < Math.max(open, close) || volume < 0) continue
    ordered.set(time, { time, open, high, low, close, volume })
  }
  return [...ordered.values()].sort((a, b) => a.time - b.time)
}

interface CachedHistory {
  key: string
  bars: Candle[]
  asOf: number
}
export function savedCandles(symbol: string, interval: ChartInterval): CandleHistory | undefined {
  const key = assetName(symbol) + '-' + interval
  const saved = readCache<CachedHistory[]>(CANDLE_CACHE)
  const matching =
    Array.isArray(saved) &&
    saved.find((x) => x?.key === key && validTime(x.asOf) && Array.isArray(x.bars) && x.bars.length)
  if (matching) return { bars: matching.bars, asOf: matching.asOf, status: 'stale' }
  if (key === 'BTC-1D') {
    return {
      bars: parseCandles(archivedBtcDaily.data),
      asOf: archivedBtcDaily.requestTime,
      status: 'archived',
    }
  }
}

export async function fetchCandles(
  symbol: string,
  interval: ChartInterval,
  signal?: AbortSignal,
): Promise<CandleHistory> {
  const asset = assetName(symbol)
  if (!validSymbol(asset) || !chartIntervals.includes(interval))
    throw new Error('Choose a Bitget spot market and interval.')
  const params = new URLSearchParams({
    category: 'SPOT',
    symbol: asset + 'USDT',
    interval,
    limit: '150',
  })
  const data = await publicData<string[][]>('/api/v3/market/candles?' + params, signal)
  const bars = parseCandles(data.data)
  if (!bars.length || !validTime(data.requestTime)) throw new Error('No candles available for ' + asset)
  const key = asset + '-' + interval
  const saved = readCache<CachedHistory[]>(CANDLE_CACHE)
  const history = { bars, asOf: data.requestTime, key }
  const other = Array.isArray(saved) ? saved.filter((item) => item.key !== key) : []
  writeCache(CANDLE_CACHE, [history, ...other].slice(0, 12))
  const lastBarEnd = bars[bars.length - 1].time * 1000 + intervalMillis[interval]
  const age = Date.now() - Math.min(data.requestTime, lastBarEnd)
  return { ...history, status: age > MAX_AGE ? 'stale' : 'live' }
}
