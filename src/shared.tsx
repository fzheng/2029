import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Search, X } from 'lucide-react'
import type { RiskEvent, RiskStatus } from './engine'
import type { Account, Basis, Path } from './model'
import { currentLocale, translate, useLanguage } from './i18n'

export const majors = ['BTC', 'ETH', 'SOL', 'BNB']
const assetNames: Record<string, string> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  BNB: 'BNB',
  XRP: 'XRP',
  DOGE: 'Dogecoin',
  ADA: 'Cardano',
  AVAX: 'Avalanche',
  LINK: 'Chainlink',
  USDT: 'Tether',
  DOT: 'Polkadot',
  LTC: 'Litecoin',
  SUI: 'Sui',
  BGB: 'Bitget Token',
  TON: 'Toncoin',
}
const chineseAssetNames: Record<string, string> = {
  BTC: '比特币',
  ETH: '以太坊',
  DOGE: '狗狗币',
  ADA: '艾达币',
  AVAX: '雪崩协议',
  USDT: '泰达币',
  DOT: '波卡',
  LTC: '莱特币',
  BGB: 'Bitget 平台币',
}
export function assetName(symbol: string) {
  return translate(
    assetNames[symbol] ?? symbol,
    chineseAssetNames[symbol] ?? assetNames[symbol] ?? symbol,
  )
}
export const dollars = (n: number | null | undefined, digits = 2) =>
  n == null || !Number.isFinite(n)
    ? '—'
    : n.toLocaleString(currentLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })
export const cash = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 20 })
export const triggerPrice = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 10 })
export const price = (n: number | null | undefined) =>
  dollars(n, n != null && n > 0 && n < 1 ? (n < 0.001 ? 8 : 5) : 2)
export function describeEvent(event: RiskEvent | null) {
  if (!event) return '—'
  if (event.price === null) return event.name + translate(' · threshold reached', ' · 已触及阈值')
  const unit =
    event.asset === 'gross assets'
      ? translate(' USDT gross assets', ' USDT（总资产）')
      : ' USDT / ' + event.asset
  return event.name + ' · ' + price(event.price) + unit
}
export const time = (s: string | null | undefined) =>
  s
    ? new Date(s).toLocaleTimeString(currentLocale(), {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : '—'
export const dateTime = (s: string | null | undefined) =>
  s
    ? new Date(s).toLocaleString(currentLocale(), {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—'
export function accountTypeName(kind: Account['kind']) {
  switch (kind) {
    case 'cashSpot':
      return translate('Spot wallet', '普通现货')
    case 'spot':
      return translate('Spot cross margin', '现货全仓杠杆')
    case 'perp':
      return translate('Isolated perpetual', '逐仓永续合约')
    case 'loan':
      return translate('Crypto loan', '质押借币')
  }
}

/** Exchange prices needed to value an account. USDT is the unit of account. */
export function accountPriceInputs(account: Account): { basis: Basis; asset: string }[] {
  if (account.kind === 'perp' && account.size === '0') return []
  if (account.kind === 'cashSpot' || account.kind === 'spot') {
    return account.holdings
      .filter((holding) => holding.asset !== 'USDT' && Number(holding.quantity) > 0)
      .map(({ asset }) => ({ basis: 'spot', asset }))
  }
  return [{ basis: account.kind === 'loan' ? 'loan' : 'mark', asset: account.asset }]
}
export const pathName = (path: Path) =>
  translate(path, { Independent: '独立', Base: '基础', Severe: '严峻' }[path])
export const riskStatus = (status: RiskStatus) =>
  translate(status, { Safe: '安全', Warning: '预警', Liquidation: '强平', Unpriced: '缺少报价' }[status])

/** Both the quote cache and the risk engine identify a price by asset and basis. */
export function describeQuote(key: string) {
  const code = /^(spot|mark|loan):([A-Z0-9]+)$/.exec(key)
  const label = /^([A-Z0-9]+) (spot|mark|loan reference)$/.exec(key)
  const asset = code?.[2] ?? label?.[1]
  const basis = code?.[1] ?? label?.[2]
  if (!asset || !basis) return key
  const chinese = basis === 'spot' ? '现货价' : basis === 'mark' ? '标记价' : '借币参考价'
  return translate(key, asset + ' ' + chinese)
}
export function Coin({ asset, small = false }: { asset: string; small?: boolean }) {
  return (
    <span aria-hidden="true" className={'coin coin-' + asset.toLowerCase() + (small ? ' small' : '')}>
      {asset === 'BTC' ? (
        <b>₿</b>
      ) : asset === 'ETH' ? (
        <svg viewBox="0 0 24 24">
          <path fill="#d8e2ff" d="M12 1 4.8 12 12 16.1z" />
          <path fill="#9ab3ff" d="m12 1 7.2 11L12 16.1z" />
          <path fill="#c4d4ff" d="m4.8 13.8 7.2 4.3V23z" />
          <path fill="#879de8" d="M12 23v-4.9l7.2-4.3z" />
        </svg>
      ) : asset === 'SOL' ? (
        <svg viewBox="0 0 24 24">
          <defs>
            <linearGradient id="solgradient" x2=".4" y2="1">
              <stop stopColor="#6ffbc9" />
              <stop offset="1" stopColor="#aa68fc" />
            </linearGradient>
          </defs>
          <path fill="url(#solgradient)" d="m5 4-3 3h17l3-3zm-3 6 3 3h17l-3-3zm3 6-3 3h17l3-3z" />
        </svg>
      ) : asset === 'BNB' ? (
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="m12 1 5.5 5.5-2 2L12 5 8.5 8.5l-2-2zM5 8.5 8.5 12 5 15.5 1.5 12zm14 0 3.5 3.5-3.5 3.5-3.5-3.5zM12 9l3 3-3 3-3-3zm-3.5 6.5L12 19l3.5-3.5 2 2L12 23l-5.5-5.5z" />
        </svg>
      ) : (
        asset.slice(0, 2)
      )}
    </span>
  )
}
export function Brand() {
  return (
    <span className="brand">
      <img src="/favicon.svg" width="31" height="31" alt="" />
      <strong>2029</strong>
    </span>
  )
}
export function BitgetMark() {
  return (
    <svg className="bgmark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="m13 2 8 7-8 7v-4H4l4-4h5zm-2 20-8-7 5-4-1 2h5v3h8l-4 4h-5z" />
    </svg>
  )
}
export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={'tag ' + tone}>{children}</span>
}

export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const { t } = useLanguage()
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    d?.showModal()
    return () => d?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className="core-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <div className="dialog-inner">
        <div className="section-title">
          <h2>{title}</h2>
          <button className="icon-button" aria-label={t('Close dialog', '关闭对话框')} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  )
}
export function SymbolPicker({
  symbols,
  selected,
  onPick,
  onClose,
  scenario = false,
}: {
  symbols: string[]
  selected?: string
  onPick: (s: string) => void
  onClose: () => void
  scenario?: boolean
}) {
  const { t } = useLanguage()
  const [query, setQuery] = useState('')
  const safeQuery = query
    .trim()
    .toUpperCase()
    .replace(/\/USDT$|USDT$/, '')
  const list = [...new Set(scenario ? symbols : [...majors, ...symbols])]
    .filter(
      (s) =>
        s !== 'USDT' &&
        (!query ||
          s.includes(safeQuery) ||
          assetNames[s]?.toUpperCase().includes(query.toUpperCase()) ||
          chineseAssetNames[s]?.includes(query.trim())),
    )
    .slice(0, 80)
  if (!scenario && !symbols.length && !list.length && /^[A-Z0-9]{1,24}$/.test(safeQuery))
    list.push(safeQuery)
  return (
    <Dialog title={t('Search Bitget markets', '搜索 Bitget 市场')} onClose={onClose}>
      <label className="search-field">
        <Search size={17} />
        <input
          autoFocus
          aria-label={t('Search symbol or asset', '搜索币种代码或名称')}
          placeholder={t('Search symbol or asset', '搜索币种代码或名称')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="symbol-list">
        {list.map((s) => (
          <button
            key={s}
            onClick={() => {
              onPick(s)
              onClose()
            }}
          >
            <Coin asset={s} small />
            <strong>{s} / USDT</strong>
            <span>{assetNames[s] ? assetName(s) : t('Bitget spot', 'Bitget 现货')}</span>
            {s === selected && <Check size={16} />}
          </button>
        ))}
        {!list.length && <p>{t('No matching markets.', '没有匹配的交易市场。')}</p>}
      </div>
    </Dialog>
  )
}
