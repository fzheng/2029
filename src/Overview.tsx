import { useEffect, useMemo, useRef, useState } from 'react'
import Decimal from 'decimal.js'
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  ArrowDownUp,
  CandlestickChart,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Crosshair,
  Database,
  Expand,
  Gauge,
  Layers3,
  ListFilter,
  Plus,
  Search,
  ShieldCheck,
  Wallet,
  WalletCards,
  X,
} from 'lucide-react'
import { MarketChart, intervalLabel } from './MarketChart'
import { useLanguage } from './i18n'
import { chartIntervals, type ChartInterval, type MarketSnapshot } from './market'
import type { Account, Path } from './model'
import { type AccountRisk, type evaluate, walletHoldings } from './engine'
import { manualAccountOrder, moveVisibleAccount, sortAccountRows } from './accountOrder'
import { useAccountReorder } from './AccountReorder'
import { saveAccountView, type AccountSort, type PortfolioState } from './storage'
import {
  accountTypeName,
  assetName,
  BitgetMark,
  Coin,
  dateTime,
  describeEvent,
  describeQuote,
  dollars,
  majors,
  pathName,
  price,
  riskStatus,
  SymbolPicker,
  Tag,
  time,
} from './shared'

type Portfolio = ReturnType<typeof evaluate>
function EquityArt() {
  return (
    <svg
      className="equity-art"
      viewBox="0 0 160 110"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="0.8"
    >
      {Array.from({ length: 16 }, (_, i) => (
        <path key={i} d={'M' + (i * 10 - 75) + ' 118l100-74 33 15 70-55'} />
      ))}
      {Array.from({ length: 10 }, (_, i) => (
        <path opacity=".4" key={i} d={'M0 ' + (60 + i * 9) + ' 160 ' + (i * 9 - 48)} />
      ))}
    </svg>
  )
}
export function Metrics({ risk }: { risk: Portfolio }) {
  const { t } = useLanguage()
  const count = risk.accounts.length
  const event = risk.firstLiquidation
  const hasMarginOrLoans = risk.accounts.some((row) => row.account.kind !== 'cashSpot')
  return (
    <section className="metrics" aria-label={t('Portfolio metrics', '投资组合指标')}>
      <article className="metric equity">
        <div className="metric-label">
          <Wallet size={16} />
          {t('Net equity', '净权益')}
        </div>
        <div className="metric-value">
          {dollars(risk.equity)} <small>USDT</small>
        </div>
        <p>
          {t(`Across ${count} active ${count === 1 ? 'account' : 'accounts'}`, `共 ${count} 个活跃账户`)}
        </p>
        <EquityArt />
      </article>
      <article className="metric">
        <div className="metric-label">
          <Gauge size={16} />
          {t('Effective leverage', '实际杠杆')}
        </div>
        <div className="metric-value">{risk.leverage == null ? '—' : dollars(risk.leverage) + '×'}</div>
        <p>{t('Spot margin, perpetuals and loans', '仅计现货杠杆、永续合约和质押借币')}</p>
      </article>
      <article className="metric">
        <div className="metric-label">
          <CircleDollarSign size={16} />
          {t('Total debt', '总负债')}
        </div>
        <div className="metric-value">
          {dollars(risk.debt)} <small>USDT</small>
        </div>
        <p>{t('Margin & loan liabilities', '杠杆账户与质押借币的负债')}</p>
      </article>
      <article className="metric">
        <div className="metric-label">
          <ShieldCheck size={16} />
          {t('Liquidation risk', '强平风险')}
        </div>
        <div className="metric-value">{event ? dollars(event.distancePct) + '%' : '—'}</div>
        <p>
          {event
            ? t('Distance to nearest trigger · ', '距最近强平触发点 · ') + event.name
            : !hasMarginOrLoans
              ? t('No liquidation exposure', '暂无强平敞口')
              : risk.missing.length
                ? t('Awaiting required prices', '等待所需报价')
                : t('No estimated trigger', '暂无预计强平触发点')}
        </p>
      </article>
    </section>
  )
}
function Change({ value }: { value: number | undefined }) {
  return (
    <span className={'change ' + (value === undefined ? '' : value >= 0 ? 'up' : 'down')}>
      {value !== undefined && (value >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />)}
      {value === undefined ? '—' : (value > 0 ? '+' : '') + dollars(value) + '%'}
    </span>
  )
}
export function Markets({
  market,
  symbol,
  setSymbol,
  refreshKey,
  loading,
}: {
  market: MarketSnapshot
  symbol: string
  setSymbol: (s: string) => void
  refreshKey: number
  loading: boolean
}) {
  const { t } = useLanguage()
  const [interval, setInterval] = useState<ChartInterval>('1D')
  const [search, setSearch] = useState(false)
  const [expanded, expand] = useState(false)
  useEffect(() => {
    if (!expanded) return
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') expand(false)
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [expanded])
  const watched = majors.includes(symbol) ? majors : [...majors, symbol]
  const noQuotes = !market.observedAt['spot:' + symbol]
  const spotInfo = market.observedAt['spot:' + symbol]
  const expandLabel = expanded ? t('Close expanded chart', '收起图表') : t('Expand chart', '展开图表')
  return (
    <section className="market-layout" aria-label={t('Markets', '市场行情')}>
      {expanded && <div className="chart-scrim" onClick={() => expand(false)} />}
      <article className={'panel chart-panel' + (expanded ? ' expanded' : '')}>
        <div className="panel-heading">
          <div className="panel-title">
            <CandlestickChart size={17} />
            <h2>{t('Market chart', '行情图表')}</h2>
          </div>
          <div className="inline">
            <span className="exchange">
              <BitgetMark />
              Bitget
            </span>
            <span className="separator" />
            <button
              className="bare icon-button"
              title={expandLabel}
              aria-label={expandLabel}
              onClick={() => expand(!expanded)}
            >
              {expanded ? <X size={16} /> : <Expand size={16} />}
            </button>
          </div>
        </div>
        <div className="chart-tools">
          <div className="chart-asset">
            <button
              className="chart-symbol"
              onClick={() => setSearch(true)}
              aria-label={t('Select chart market', '选择图表交易对')}
            >
              <Coin asset={symbol} />
              <strong>
                {symbol}
                <span>/</span>USDT
              </strong>
              <ChevronDown size={14} />
            </button>
            <div className="chart-price">
              {price(market.prices[symbol])}
              <Change value={market.changes[symbol]} />
            </div>
          </div>
          <div className="intervals" aria-label={t('Chart timeframe', 'K 线周期')}>
            {chartIntervals.map((i) => (
              <button
                key={i}
                aria-pressed={interval === i}
                className={interval === i ? 'selected' : ''}
                onClick={() => setInterval(i)}
              >
                {intervalLabel(i)}
              </button>
            ))}
          </div>
        </div>
        <div className="plot-wrap">
          <MarketChart symbol={symbol} interval={interval} refreshKey={refreshKey} />
        </div>
      </article>
      <article className="panel watch">
        <div className="panel-heading">
          <div className="panel-title">
            <Activity size={17} />
            <h2>{t('Market watch', '行情速览')}</h2>
          </div>
          <span className="quote-unit">USDT</span>
        </div>
        <div className="watch-label">
          <span>{t('Asset', '资产')}</span>
          <span>{t('Last price', '最新价')}</span>
          <span>{t('24h', '24小时')}</span>
        </div>
        <div className="watch-items">
          {watched.map((s) => (
            <button
              type="button"
              key={s}
              aria-label={t('Chart ' + s, '查看 ' + s + ' 图表')}
              aria-pressed={s === symbol}
              onClick={() => setSymbol(s)}
              className={'watch-row ' + (s === symbol ? 'selected' : '')}
            >
              <span className="watch-name">
                <Coin asset={s} small />
                <span>
                  <b>{s}</b>
                  <small>{assetName(s) || s}</small>
                </span>
              </span>
              <span className="watch-price">{price(market.prices[s])}</span>
              <Change value={market.changes[s]} />
            </button>
          ))}
        </div>
        <div className="watch-bottom">
          <button className="search-markets" onClick={() => setSearch(true)}>
            <Search size={15} />
            {t('Search markets', '搜索交易对')}
          </button>
          <div className="feed-time">
            <span
              className={
                'status-dot ' + (noQuotes || market.stale.includes('spot:' + symbol) ? 'amber' : '')
              }
            />
            {noQuotes
              ? loading
                ? t('Fetching Bitget quotes', '正在获取 Bitget 报价')
                : t('Spot quotes unavailable', '现货报价暂不可用')
              : market.stale.includes('spot:' + symbol)
                ? t('Last known quote', '上次报价（已过期）')
                : t('Spot quote', '现货报价')}
            {spotInfo && <time title={dateTime(spotInfo)}>{time(spotInfo)}</time>}
          </div>
        </div>
      </article>
      {search && (
        <SymbolPicker
          symbols={market.symbols}
          selected={symbol}
          onPick={setSymbol}
          onClose={() => setSearch(false)}
        />
      )}
    </section>
  )
}
function AccountFacts({ row }: { row: AccountRisk }) {
  const { t } = useLanguage()
  const account = row.account
  const facts: [string, string][] = []
  const percent = (ratio: number | null) =>
    ratio == null ? '—' : ratio === Infinity ? '∞' : dollars(ratio * 100) + '%'
  if (account.kind === 'spot' || account.kind === 'loan') {
    facts.push([t('Debt', '负债'), dollars(row.debt) + ' USDT'])
  }
  if (account.kind === 'spot') {
    if (row.assetBoundary != null) {
      facts.push(
        [t('Risk rate', '风险率'), percent(row.risk)],
        [t('Gross-asset liquidation boundary', '总资产强平线'), dollars(row.assetBoundary) + ' USDT'],
      )
    }
  }
  if (account.kind === 'loan' || account.kind === 'perp') {
    const nativePrice = (value: number | null) =>
      value == null ? '—' : price(value) + ' USDT / ' + account.asset
    if (account.kind === 'loan') {
      facts.push(
        [t('Pledged collateral', '质押数量'), account.collateral + ' ' + account.asset],
        [t('Collateral index price', '抵押币指数价'), nativePrice(row.referencePrice)],
        [t('LTV', '质押率（LTV）'), percent(row.ltv)],
        [
          t('Warning / liquidation LTV', '预警 / 强平质押率'),
          percent(Number(account.warningLtv)) + ' / ' + percent(Number(account.liquidationLtv)),
        ],
      )
    } else {
      const flat = new Decimal(account.size).isZero()
      const side = flat
        ? t('Flat', '已平仓')
        : t(account.side, account.side === 'long' ? '多头' : '空头')
      facts.push(
        [t('Position', '仓位'), account.size + ' ' + account.asset + ' · ' + side],
        [t('Allocated margin', '逐仓保证金'), account.margin + ' USDT'],
      )
      if (!flat) {
        facts.push(
          [t('Entry price', '开仓均价'), nativePrice(Number(account.entry))],
          [t('Mark price', '标记价格'), nativePrice(row.referencePrice)],
          [
            t('Maintenance + close fee', '维持保证金与平仓手续费'),
            row.maintenance == null ? '—' : dollars(row.maintenance) + ' USDT',
          ],
        )
      }
    }
    if (row.liquidationPrice != null) {
      const label = account.kind === 'loan'
        ? t('Index price at liquidation', '强平时的指数价')
        : t('Mark price at liquidation', '强平时的标记价')
      facts.push([label, nativePrice(row.liquidationPrice)])
    }
  }
  if (row.warningPrice != null)
    facts.push([t('Warning trigger', '预警触发价'), price(row.warningPrice) + ' USDT / ' + row.triggerAsset])
  if (row.distancePct != null)
    facts.push([t('Distance to liquidation', '距强平的价格变动'), dollars(row.distancePct) + '%'])
  facts.push([t('Last balance edit', '上次余额修改时间'), dateTime(account.updatedAt)])
  return (
    <dl>
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Accounts({
  risk,
  market,
  records,
  onRecords,
  onAdd,
  onEdit,
  onAddOrder,
  full = false,
  path = 'Base',
}: {
  risk: Portfolio
  market: MarketSnapshot
  records: PortfolioState
  onRecords: (state: PortfolioState) => void
  onAdd: () => void
  onEdit: (a: Account) => void
  onAddOrder: (accountId: string) => void
  full?: boolean
  path?: Path
}) {
  const { t, locale } = useLanguage()
  const [filter, setFilter] = useState('all')
  const [open, setOpen] = useState<string[]>([])
  const [saveError, setSaveError] = useState(false)
  const saving = useRef(false)
  const sort = records.accountView?.sort ?? 'manual'
  const order = useMemo(
    () => manualAccountOrder(records.accounts, records.accountView?.order ?? []),
    [records.accounts, records.accountView],
  )
  const sorted = useMemo(
    () => sortAccountRows(risk.accounts, order, sort, locale),
    [risk.accounts, order, sort, locale],
  )
  const rows = sorted.filter((r) => filter === 'all' || r.account.kind === filter)
  async function saveOrder(nextSort: AccountSort, nextOrder: string[]) {
    if (saving.current) return
    saving.current = true
    setSaveError(false)
    try {
      onRecords(await saveAccountView({ sort: nextSort, order: nextOrder }, records.revision))
    } catch {
      setSaveError(true)
    } finally {
      saving.current = false
    }
  }
  const reorder = useAccountReorder(
    rows.map(({ account }) => ({ id: account.id, name: account.name })),
    (source, target) => {
      const next = moveVisibleAccount(
        order,
        rows.map((r) => r.account.id),
        source,
        target,
      )
      if (next !== order) void saveOrder('manual', next)
    },
    sort === 'manual',
  )
  return (
    <section className="panel accounts-panel">
      <div className="panel-heading account-heading">
        <div className="panel-title">
          <Layers3 size={18} />
          <h2>{full ? t('Active accounts', '活跃账户') : t('Your accounts', '我的账户')}</h2>
          <span className="count">{risk.accounts.length}</span>
        </div>
        {risk.accounts.length > 0 && (
          <label className="account-order-select">
            <ArrowDownUp size={15} aria-hidden="true" />
            <span>{t('Sort by', '排序')}</span>
            <select
              aria-label={t('Account order', '账户排序')}
              value={sort}
              onChange={(e) => void saveOrder(e.target.value as AccountSort, order)}
            >
              <option value="manual">{t('Manual order', '手动排序')}</option>
              <option value="name-asc">{t('Name (A–Z)', '名称（升序）')}</option>
              <option value="name-desc">{t('Name (Z–A)', '名称（降序）')}</option>
              <option value="equity-desc">{t('Net equity (high to low)', '净权益（从高到低）')}</option>
              <option value="equity-asc">{t('Net equity (low to high)', '净权益（从低到高）')}</option>
              <option value="debt-desc">{t('Debt (high to low)', '负债（从高到低）')}</option>
              <option value="risk">
                {t('Liquidation risk (highest first)', '强平风险（最高优先）')}
              </option>
              <option value="updated">{t('Last edited (newest first)', '最近修改优先')}</option>
            </select>
          </label>
        )}
        {risk.accounts.length > 0 && (
          <button className="btn compact" onClick={onAdd}>
            <Plus size={14} />
            {t('Add account', '添加账户')}
          </button>
        )}
        {!risk.accounts.length && (
          <span className="muted local-note">
            <Database size={13} /> {t('Local portfolio', '本地投资组合')}
          </span>
        )}
      </div>
      {saveError && (
        <p className="notice" role="alert">
          {t('Could not save the account order. Please try again.', '未能保存账户顺序，请重试。')}
        </p>
      )}
      {risk.accounts.length === 0 ? (
        <div className="account-empty">
          <div className="empty-art" aria-hidden="true">
            <div className="empty-tile">
              <WalletCards size={25} strokeWidth={1.5} />
            </div>
          </div>
          <div className="empty-copy">
            <h3>{t('No accounts yet', '尚未添加账户')}</h3>
            <p>
              {t(
                'Add a spot wallet, margin account, isolated perpetual, or crypto loan to track your portfolio.',
                '添加普通现货账户、杠杆账户、逐仓永续合约仓位或质押借币订单，即可查看投资组合表现。',
              )}
            </p>
          </div>
          <button className="btn primary" onClick={onAdd}>
            <Plus size={15} />
            {t('Add your first account', '添加第一个账户')}
          </button>
        </div>
      ) : (
        <>
          {full && (
            <div className="filters">
              <ListFilter size={15} />
              {[
                ['all', t('All', '全部')],
                ['cashSpot', accountTypeName('cashSpot')],
                ['spot', t('Spot margin', '现货全仓杠杆')],
                ['perp', t('Perpetuals', '逐仓永续合约')],
                ['loan', t('Loans', '质押借币')],
              ].map(([k, v]) => (
                <button
                  key={k}
                  aria-pressed={filter === k}
                  className={filter === k ? 'active' : ''}
                  onClick={() => setFilter(k)}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
          <div className="account-list">
            {rows.map((r) => {
              const a = r.account
              const isOpen = open.includes(a.id)
              const flat = a.kind === 'perp' && new Decimal(a.size).isZero()
              const holdings =
                a.kind === 'cashSpot' ? walletHoldings(a) : a.kind === 'spot' ? a.holdings : []
              return (
                <div className="record" key={a.id} {...reorder.rowProps(a.id)}>
                  {reorder.grip(a.id)}
                  <button
                    className="record-main"
                    onClick={() => setOpen(isOpen ? open.filter((id) => id !== a.id) : [...open, a.id])}
                    aria-expanded={isOpen}
                  >
                    <span className="record-symbol">
                      {a.kind === 'cashSpot' ? (
                        <WalletCards size={19} />
                      ) : a.kind === 'spot' ? (
                        <Wallet size={19} />
                      ) : a.kind === 'perp' ? (
                        <Activity size={19} />
                      ) : (
                        <CircleDollarSign size={19} />
                      )}
                    </span>
                    <span className="record-name">
                      <b>{a.name}</b>
                      <small>{accountTypeName(a.kind)}</small>
                    </span>
                    <span className="record-metrics">
                      <span className="record-metric">
                        <small>{t('Effective leverage', '实际杠杆')}</small>
                        <b>{r.leverage == null ? '—' : dollars(r.leverage) + '×'}</b>
                      </span>
                      <span
                        className="record-metric"
                        title={t(
                          'Estimated BTC price in USDT on the ' + pathName(path) + ' path.',
                          '按' + pathName(path) + '联动路径估算，单位为 USDT/BTC。',
                        )}
                      >
                        <small>{t('BTC liquidation price', 'BTC 强平价')}</small>
                        <b>{price(r.btcLiquidationPrice)}</b>
                      </span>
                      <span className="record-metric">
                        <small>{t('Net equity (USDT)', '净权益（USDT）')}</small>
                        <b>{dollars(r.equity)}</b>
                      </span>
                    </span>
                    <Tag tone={flat ? 'neutral' : r.status === 'Safe' ? 'green' : 'warm'}>
                      {flat
                        ? t('Flat', '已平仓')
                        : a.kind === 'cashSpot' && r.status === 'Safe'
                          ? t('Unleveraged', '无杠杆')
                          : riskStatus(r.status)}
                    </Tag>
                    <ChevronDown className={isOpen ? 'record-chevron turned' : 'record-chevron'} size={15} />
                  </button>
                  {isOpen && (
                    <div className="record-details">
                      {holdings.length > 0 && (
                        <div className="table-scroll">
                          <table aria-label={t('Holdings in ' + a.name, a.name + ' 的持仓')}>
                            <thead>
                              <tr>
                                <th>{t('Asset', '资产')}</th>
                                <th>{t('Quantity', '数量')}</th>
                                <th>{t('Spot price (USDT)', '现货价格（USDT）')}</th>
                                <th>{t('Value (USDT)', '价值（USDT）')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {holdings.map((h, i) => {
                                const unitPrice = h.asset === 'USDT' ? '1' : market.book.spot[h.asset]
                                const quantity = new Decimal(h.quantity)
                                const value =
                                  unitPrice !== undefined
                                    ? quantity.times(unitPrice).toNumber()
                                    : quantity.isZero()
                                      ? 0
                                      : null
                                return (
                                  <tr key={i}>
                                    <td>{h.asset}</td>
                                    <td>{h.quantity}</td>
                                    <td>
                                      {price(unitPrice === undefined ? null : Number(unitPrice))}
                                      {unitPrice === undefined
                                        ? t(' · missing', ' · 缺少报价')
                                        : market.stale.includes('spot:' + h.asset)
                                          ? t(' · stale', ' · 已过期')
                                          : ''}
                                    </td>
                                    <td>{dollars(value)}</td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                      <AccountFacts row={r} />
                      {r.missing.length > 0 && (
                        <p>
                          {t('Missing prices', '缺少报价')} ·{' '}
                          {r.missing.map(describeQuote).join(t(', ', '、'))}
                        </p>
                      )}
                      <div className="account-detail-actions">
                        <button className="btn" onClick={() => onEdit(a)}>
                          {t('Edit account', '编辑账户')}
                        </button>
                        {(a.kind === 'spot' || a.kind === 'perp') && (
                          <button className="btn" onClick={() => onAddOrder(a.id)}>
                            <Plus size={14} />
                            {t('Add limit order', '添加限价挂单')}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            {!rows.length && (
              <p className="inner-muted">{t('No accounts of this type.', '暂无此类账户。')}</p>
            )}
          </div>
          {reorder.announcer}
        </>
      )}
    </section>
  )
}
export function RiskSummary({ risk }: { risk: Portfolio }) {
  const { t } = useLanguage()
  if (!risk.accounts.some((row) => row.account.kind !== 'cashSpot')) return null
  return (
    <div className="risk-summary">
      {[
        [t('Nearest warning threshold', '最近的预警阈值'), risk.firstWarning],
        [t('Nearest liquidation threshold', '最近的强平阈值'), risk.firstLiquidation],
      ].map(([label, item]) => {
        const event = item as Portfolio['firstWarning']
        return (
          <div key={label as string}>
            <Crosshair size={16} />
            <span>
              <small>{label as string}</small>
              <strong>{describeEvent(event)}</strong>
            </span>
            <ChevronRight size={12} />
          </div>
        )
      })}
    </div>
  )
}
