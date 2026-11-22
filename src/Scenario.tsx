import { useMemo, useState } from 'react'
import { Decimal } from 'decimal.js'
import {
  Bookmark,
  Calculator,
  ChevronRight,
  FolderOpen,
  GitCompareArrows,
  LockKeyhole,
  Plus,
  RotateCcw,
  Save,
  SlidersHorizontal,
} from 'lucide-react'
import { buildScenario, evaluate, referencePrice, type RiskEvent } from './engine'
import { btcMoveMultipliers, type Basis, type Path, type PriceBook, type Prices } from './model'
import {
  accountPriceInputs,
  Coin,
  dateTime,
  describeBtcMultipliers,
  describeEvent,
  describeQuote,
  Dialog,
  dollars,
  pathName,
  price,
  riskStatus,
  SymbolPicker,
  Tag,
} from './shared'
import { useLanguage } from './i18n'
import { formError } from './formMessages'
import { saveScenario, type PortfolioState, type SavedItem } from './storage'

export interface ScenarioState {
  book: PriceBook
  path: Path
  overrides: Prices
  symbols: string[]
  asOf: string | null
  stale?: string[]
}

export function LoadScenario({
  scenarios,
  onLoad,
}: {
  scenarios: SavedItem[]
  onLoad: (scenario: ScenarioState) => void
}) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="btn" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <FolderOpen size={15} />
        {t('Load scenario', '载入情景')}
      </button>
      {open && (
        <Dialog title={t('Saved scenarios', '已保存的情景')} onClose={() => setOpen(false)}>
          {scenarios.length === 0 ? (
            <p className="small-text">{t('No saved scenarios yet.', '尚无已保存的情景。')}</p>
          ) : (
            <ul className="saved-scenarios">
              {scenarios
                .slice()
                .reverse()
                .map((item) => {
                  const snapshot = item.data as ScenarioState
                  const btc = snapshot.overrides.BTC
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="btn"
                        aria-label={item.name}
                        onClick={() => {
                          setOpen(false)
                          onLoad(structuredClone(snapshot))
                        }}
                      >
                        <span>
                          <strong>{item.name}</strong>
                          <small>
                            {pathName(snapshot.path)}
                            {btc !== undefined && ' · BTC ' + price(Number(btc)) + ' USDT'}
                            {snapshot.asOf &&
                              ' · ' + t('Snapshot', '参考报价') + ' ' + dateTime(snapshot.asOf)}
                          </small>
                        </span>
                        <ChevronRight size={15} aria-hidden="true" />
                      </button>
                    </li>
                  )
                })}
            </ul>
          )}
        </Dialog>
      )}
    </>
  )
}

export function SaveName({
  title,
  onSave,
  onClose,
}: {
  title: string
  onSave: (name: string) => Promise<void>
  onClose: () => void
}) {
  const { t } = useLanguage()
  const [name, setName] = useState(''),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false)
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          try {
            await onSave(name.trim())
            onClose()
          } catch (err) {
            setError(err)
            setBusy(false)
          }
        }}
      >
        <label className="field">
          {t('Name', '名称')}
          <input
            autoFocus
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {error != null && (
          <p role="alert" className="alert-text">
            {formError(error)}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel', '取消')}
          </button>
          <button className="btn primary" disabled={busy || !name.trim()}>
            <Save size={15} />
            {t('Save', '保存')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
function EditableNumber({
  value,
  label,
  onChange,
  min,
  suffix,
}: {
  value: string
  label: string
  onChange: (s: string) => void
  min: number
  suffix: string
}) {
  const [text, setText] = useState<string | null>(null)
  return (
    <label className="unit-input">
      <input
        type="number"
        step="any"
        min={min}
        aria-label={label}
        value={text ?? value}
        onFocus={() => setText(value)}
        onBlur={() => setText(null)}
        onChange={(e) => {
          const raw = e.target.value
          setText(raw)
          if (raw !== '' && Number.isFinite(Number(raw)) && Number(raw) >= min) onChange(raw)
        }}
      />
      <span>{suffix}</span>
    </label>
  )
}
const pct = (value: string, ref: string) =>
  new Decimal(value).div(ref).minus(1).times(100).toDecimalPlaces(6).toFixed()
function Comparison({
  live,
  projected,
}: {
  live: ReturnType<typeof evaluate>
  projected: ReturnType<typeof evaluate>
}) {
  const { t } = useLanguage()
  const leverage = (r: typeof live) => (r.leverage == null ? '—' : dollars(r.leverage) + '×')
  const metrics = [
    [t('Net equity', '净权益'), dollars(live.equity) + ' USDT', dollars(projected.equity) + ' USDT'],
    [t('Effective leverage (excl. spot wallets)', '实际杠杆（不含普通现货）'), leverage(live), leverage(projected)],
    [t('Total debt', '总负债'), dollars(live.debt) + ' USDT', dollars(projected.debt) + ' USDT'],
  ]
  const thresholds = [
    {
      name: t('Warning', '预警'),
      live: live.firstWarning,
      reached: projected.firstWarning,
      next: projected.nextWarning,
    },
    {
      name: t('Liquidation', '强平'),
      live: live.firstLiquidation,
      reached: projected.firstLiquidation,
      next: projected.nextLiquidation,
    },
  ]
  const { direction } = projected
  const continuation = !direction
    ? t('Next on this path', '沿此路径的下一次触发')
    : direction.falling
      ? t(`Next if ${direction.asset} keeps falling`, `若 ${direction.asset} 继续下跌`)
      : t(`Next if ${direction.asset} keeps rising`, `若 ${direction.asset} 继续上涨`)
  const none = projected.missing.length ? t('None among priced accounts', '已估值账户中无') : t('None', '无')
  const eventText = (event: RiskEvent | null) => {
    if (!event) return none
    const parts = [event.name]
    const point = event.pathPoint
    if (point) parts.push(point.asset + ' ' + price(point.price))
    const separateTrigger = event.basis || !point || event.asset !== point.asset || event.price !== point.price
    if (event.price !== null && separateTrigger) {
      let asset = event.asset === 'gross assets' ? t('gross assets', '总资产') : event.asset
      if (event.basis === 'loan') asset += t(' loan reference', ' 借款参考价')
      if (event.basis === 'mark') asset += t(' mark', ' 标记价')
      parts.push(asset + ' ' + price(event.price))
    }
    if (event.atSnapshot) parts.push(t('Threshold reached at snapshot', '快照时已触及'))
    return parts.join(' · ')
  }
  return (
    <section className="panel">
      <div className="panel-heading">
        <div className="panel-title">
          <GitCompareArrows size={18} />
          <h2>{t('Portfolio comparison', '投资组合对比')}</h2>
        </div>
      </div>
      <div className="comparison">
        <span />
        <strong>
          <i className="status-dot" />
          {t('Live', '实时')}
        </strong>
        <strong>
          <i className="status-dot amber" />
          {t('Scenario', '情景')}
        </strong>
        {metrics.map(([k, actual, stressed], i) => (
          <div className="comparison-row" key={k}>
            <span>{k}</span>
            <b>{actual}</b>
            <div>
              <b>{stressed}</b>
              {i === 0 && (
                <small className="risk-caption">{t('Zero recovery after liquidation', '强平后按零回收估算')}</small>
              )}
            </div>
          </div>
        ))}
        {thresholds.map(({ name, live: current, reached, next }) => (
          <div className="comparison-row" key={name}>
            <span>{name}</span>
            <div>
              <small className="risk-caption">{t('Nearest threshold', '最近的阈值')}</small>
              <b>{describeEvent(current)}</b>
            </div>
            <div className="scenario-event">
              <small className="risk-caption">{t('First triggered during this move', '本次变动中最先触及')}</small>
              <b>{eventText(reached)}</b>
              <small className="risk-caption">{continuation}</small>
              <b>{direction ? eventText(next) : t('Requires a move in one asset', '需指定单一资产的变动方向')}</b>
            </div>
          </div>
        ))}
      </div>
      {projected.missing.length > 0 && (
        <p className="panel-description">
          {t('Scenario rankings include only accounts with complete prices.', '情景触发顺序仅考虑报价完整的账户。')}
        </p>
      )}
      {projected.accounts.some((row) => row.status === 'Liquidation') && (
        <p className="panel-description">
          {t(
            'This scenario treats each liquidated position as fully closed, with zero net equity and exposure. Total debt shows the recorded balances.',
            '已强平的账户或仓位按整笔平仓估算，净权益和敞口均计为零。总负债显示已录入的金额。',
          )}
        </p>
      )}
    </section>
  )
}
export function Scenario({
  scenario,
  update,
  liveBook,
  records,
  onRecords,
  onPlan,
}: {
  scenario: ScenarioState
  update: (s: ScenarioState) => void
  liveBook: PriceBook
  records: PortfolioState
  onRecords: (v: PortfolioState) => void
  onPlan: () => void
}) {
  const { t } = useLanguage()
  const [pick, setPick] = useState(false),
    [saveAt, setSaveAt] = useState<number | null>(null)
  const { scenarioBook, staleReferences } = useMemo(() => {
    // A saved scenario can hide BTC from the editor while using it to drive the move.
    const anchors = new Set(['BTC', ...scenario.symbols, ...Object.keys(scenario.overrides)])
    const inputs = records.accounts.filter((a) => !a.archived).flatMap(accountPriceInputs)
    const symbols = new Set([...anchors, ...inputs.map(({ asset }) => asset)])
    const usedBases = new Set(inputs.map(({ basis, asset }) => basis + ':' + asset))
    const book: PriceBook = { spot: {}, loan: {}, mark: {} }
    const bases: Basis[] = ['spot', 'mark', 'loan']
    for (const basis of bases) {
      for (const symbol of symbols) {
        const value = scenario.book[basis][symbol]
        if (value !== undefined) book[basis][symbol] = value
      }
    }
    for (const asset of anchors) {
      const basis = bases.find((b) => book[b][asset] !== undefined)
      if (basis) usedBases.add(basis + ':' + asset)
    }
    return {
      scenarioBook: buildScenario(book, scenario.path, scenario.overrides),
      staleReferences: scenario.stale?.filter((key) => usedBases.has(key)) ?? [],
    }
  }, [scenario, records.accounts])
  const live = useMemo(
    () => evaluate(records.accounts, liveBook, scenario.path),
    [records.accounts, liveBook, scenario.path],
  )
  const projected = useMemo(
    () => evaluate(records.accounts, scenarioBook, scenario.path),
    [records.accounts, scenarioBook, scenario.path],
  )
  const hasLiquidation = projected.accounts.some((row) => row.status === 'Liquidation')
  const setPrice = (asset: string, value: string) =>
    update({ ...scenario, overrides: { ...scenario.overrides, [asset]: new Decimal(value).toFixed() } })
  const available = Object.keys({ ...scenario.book.spot, ...scenario.book.mark, ...scenario.book.loan })
  const quoteList = (names: string[]) => names.map(describeQuote).join(t(', ', '、'))
  const multipliers = describeBtcMultipliers(scenario.path)
  return (
    <div className="page-stack">
      <div className="context-bar">
        <span>
          <LockKeyhole size={15} />
          {t('Reference prices frozen', '参考价格已锁定')} <b>{dateTime(scenario.asOf)}</b>
        </span>
        <button className="btn compact" onClick={onPlan}>
          <Calculator size={14} />
          {t('Plan using this scenario', '按此情景规划资金')}
        </button>
      </div>
      {staleReferences.length > 0 && (
        <p className="notice">
          {t(
            `Snapshot uses last known prices for ${quoteList(staleReferences)}.`,
            `快照采用以下报价的最近已知价格：${quoteList(staleReferences)}。`,
          )}
        </p>
      )}
      <Comparison live={live} projected={projected} />
      <section className="panel">
        <div className="panel-heading flex-wrap">
          <div className="panel-title">
            <SlidersHorizontal size={17} />
            <h2>{t('Scenario prices', '情景价格')}</h2>
          </div>
          <label className="inline muted">
            {t('Price path', '价格路径')}{' '}
            <select
              value={scenario.path}
              onChange={(e) => update({ ...scenario, path: e.target.value as Path })}
            >
              <option value="Independent">{t('Independent', '独立调整')}</option>
              <option value="Base">{t('BTC-linked Base', '与 BTC 联动（基础）')}</option>
              <option value="Severe">{t('BTC-linked Severe', '与 BTC 联动（严峻）')}</option>
            </select>
          </label>
        </div>
        <p className="panel-description">
          {scenario.path === 'Independent'
            ? t(
                'Adjust any asset against its frozen reference.',
                '可分别调整各资产相对于已锁定参考价的涨跌幅。',
              )
            : t(
                `BTC move multipliers (${multipliers}). Other assets keep their frozen prices. A manual price overrides the link.`,
                `BTC 涨跌幅的模拟倍数为 ${multipliers}。其他币种保持快照价格。手动设价后，该币种按手动价格计算。`,
              )}
        </p>
        <div className="scenario-grid-labels">
          <span>{t('Asset / reference', '资产 / 参考价')}</span>
          <span>{t('Price adjustment', '价格调整')}</span>
          <span>{t('Scenario price', '情景价格')}</span>
          <span>{t('Change', '涨跌幅')}</span>
        </div>
        {scenario.symbols
          .filter((asset) => asset !== 'USDT')
          .map((asset) => {
            const ref = referencePrice(scenario.book, asset),
              value = referencePrice(scenarioBook, asset)
            const change = ref && Number(ref) > 0 && value !== null ? pct(value, ref) : null
            const fromPct = (v: string) => {
              if (ref) setPrice(asset, new Decimal(ref).mul(new Decimal(v).div(100).plus(1)).toFixed())
            }
            return (
              <div key={asset} className="adjust-row">
                <div className="watch-name">
                  <Coin asset={asset} small />
                  <span>
                    <b>{asset}</b>
                    <small>{ref ? price(Number(ref)) + ' USDT' : t('Missing price', '缺少报价')}</small>
                  </span>
                </div>
                {change !== null && value !== null ? (
                  <>
                    <div className="slider-cell">
                      <input
                        type="range"
                        aria-label={t(`${asset} adjustment slider`, `${asset} 价格调整滑块`)}
                        min={-100}
                        max={Math.max(100, Math.ceil(Number(change)))}
                        step=".1"
                        value={change}
                        onChange={(e) => fromPct(e.target.value)}
                      />
                      {asset !== 'BTC' && scenario.overrides[asset] !== undefined && (
                        <button
                          className="text-button"
                          onClick={() => {
                            const overrides = { ...scenario.overrides }
                            delete overrides[asset]
                            update({ ...scenario, overrides })
                          }}
                        >
                          {btcMoveMultipliers[scenario.path][asset]
                            ? t('Restore BTC link', '恢复与 BTC 联动')
                            : t('Restore reference price', '恢复快照价格')}
                        </button>
                      )}
                    </div>
                    <EditableNumber
                      label={t(`${asset} scenario price`, `${asset} 情景价格`)}
                      value={new Decimal(value).toSignificantDigits(14).toFixed()}
                      onChange={(v) => setPrice(asset, v)}
                      min={0}
                      suffix="USDT"
                    />
                    <EditableNumber
                      label={t(`${asset} percentage change`, `${asset} 涨跌幅`)}
                      value={change}
                      onChange={fromPct}
                      min={-100}
                      suffix="%"
                    />
                  </>
                ) : (
                  <span className="unavailable">
                    {t('No reference price in this snapshot', '此快照中没有参考价')}
                  </span>
                )}
              </div>
            )
          })}
        <div className="panel-actions">
          <button className="btn" onClick={() => setPick(true)}>
            <Plus size={15} />
            {t('Add asset', '添加资产')}
          </button>
          <div className="inline scenario-file-actions">
            <button
              className="btn"
              onClick={() => update({ ...scenario, path: 'Independent', overrides: {} })}
            >
              <RotateCcw size={15} />
              {t('Reset scenario', '重置情景')}
            </button>
            <LoadScenario scenarios={records.scenarios} onLoad={update} />
            <button className="btn" onClick={() => setSaveAt(records.revision)}>
              <Bookmark size={15} />
              {t('Save scenario', '保存情景')}
            </button>
          </div>
        </div>
      </section>
      {projected.missing.length > 0 && (
        <p className="notice">
          {t(
            `Scenario valuation is incomplete. Missing ${quoteList(projected.missing)}.`,
            `情景估值不完整，缺少以下报价：${quoteList(projected.missing)}。`,
          )}
        </p>
      )}
      {projected.accounts.length > 0 && (
        <section className="panel">
          <div className="panel-heading">
            <h2>{t('Account outcomes', '各账户模拟结果')}</h2>
          </div>
          {hasLiquidation && (
            <p className="panel-description">
              {t(
                'Equity at trigger is measured before fees and execution. Actual settlement is unknown.',
                '触及强平时的净权益按执行成交前、未扣费的估值计算。实际结算金额未知。',
              )}
            </p>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('Account', '账户')}</th>
                  <th>{t('Live equity', '实时净权益')}</th>
                  <th>{t('Scenario equity', '情景净权益')}</th>
                  <th>{t('Scenario status', '情景状态')}</th>
                  {hasLiquidation && <th>{t('Equity at trigger (USDT)', '触及强平时的净权益（USDT）')}</th>}
                </tr>
              </thead>
              <tbody>
                {projected.accounts.map((r, i) => (
                  <tr key={r.account.id}>
                    <td>{r.account.name}</td>
                    <td>{dollars(live.accounts[i]?.equity)}</td>
                    <td>{dollars(r.equity)}</td>
                    <td>
                      <Tag
                        tone={
                          r.status === 'Liquidation' ? 'danger' : r.status === 'Safe' ? 'green' : 'warm'
                        }
                      >
                        {r.status === 'Liquidation'
                          ? t('Liquidated', '已强平')
                          : r.account.kind === 'cashSpot' && r.status === 'Safe'
                            ? t('Unleveraged', '无杠杆')
                            : riskStatus(r.status)}
                      </Tag>
                    </td>
                    {hasLiquidation && <td>{dollars(r.equityAtTrigger)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {pick && (
        <SymbolPicker
          scenario
          symbols={available.filter((s) => !scenario.symbols.includes(s))}
          onPick={(s) => update({ ...scenario, symbols: [...new Set([...scenario.symbols, s])] })}
          onClose={() => setPick(false)}
        />
      )}
      {saveAt !== null && (
        <SaveName
          title={t('Save scenario', '保存情景')}
          onClose={() => setSaveAt(null)}
          onSave={async (name) => {
            onRecords(await saveScenario({ id: crypto.randomUUID(), name, data: scenario }, saveAt))
          }}
        />
      )}
    </div>
  )
}
