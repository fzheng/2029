import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertCircle,
  Calculator,
  ChevronDown,
  Clock3,
  FlaskConical,
  HardDrive,
  LayoutDashboard,
  Languages,
  Layers3,
  Plus,
  Radio,
  RefreshCw,
  Settings2,
  ShieldCheck,
} from 'lucide-react'
import { evaluate, planFromScenario } from './engine'
import { previewOrderFills } from './orderFills'
import PendingOrders from './PendingOrders'
import { useLanguage, type Language } from './i18n'
import type { Account } from './model'
import { cachedQuotes, fetchQuotes } from './market'
import { loadPortfolio, subscribePortfolio, type PortfolioState } from './storage'
import AccountEditor from './AccountEditor'
import Settings from './settings'
import { Accounts, Markets, Metrics, RiskSummary } from './Overview'
import { LoadScenario, Scenario, type ScenarioState } from './Scenario'
import { newPlanDraft, Planner, type PlanDraft } from './Planner'
import { accountPriceInputs, Brand, dateTime, describeQuote, majors, Tag } from './shared'

const empty: PortfolioState = {
  accounts: [],
  plans: [],
  scenarios: [],
  revision: 0,
  generation: 0,
  lastBalanceEdit: null,
}
type Page = 'Overview' | 'Accounts' | 'Cash planner'
const pages = [
  { name: 'Overview', chinese: '概览', icon: LayoutDashboard },
  { name: 'Accounts', chinese: '账户', icon: Layers3 },
  { name: 'Cash planner', chinese: '资金规划', icon: Calculator },
] as const

export default function App() {
  const { language, setLanguage, t } = useLanguage()
  const [page, setPage] = useState<Page>('Overview'),
    [scenario, setScenario] = useState<ScenarioState | null>(null)
  const [records, setRecords] = useState<PortfolioState>(empty),
    [ready, setReady] = useState(false),
    [dbError, setDbError] = useState<'open' | 'refresh' | null>(null)
  const [editor, setEditor] = useState<{ account?: Account; revision: number } | null>(null),
    [settings, setSettings] = useState(false)
  const [plan, setPlan] = useState<PlanDraft>(newPlanDraft)
  const [scenarioPlan, setScenarioPlan] = useState<PlanDraft | null>(null)
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(() => new Set())
  const [addOrderFor, setAddOrderFor] = useState<string | null>(null)
  const [symbol, setSymbol] = useState('BTC'),
    [market, setMarket] = useState(() => cachedQuotes()),
    [loading, setLoading] = useState(true)
  const [request, refresh] = useState(0),
    [quoteInfo, setQuoteInfo] = useState(false)
  const version = useRef({ generation: 0, revision: -1 })
  const applyRecords = useCallback((next: PortfolioState) => {
    if (next.revision < version.current.revision) return
    if (next.generation !== version.current.generation) {
      setPage('Overview')
      setScenario(null)
      setEditor(null)
      setSettings(false)
      setPlan(newPlanDraft())
      setScenarioPlan(null)
      setSelectedOrderIds(new Set())
      setAddOrderFor(null)
    } else {
      // Deleted or archived orders must not become selected again if later restored.
      setSelectedOrderIds((current) => {
        if (!current.size) return current
        const activeIds = new Set(next.accounts.filter((a) => !a.archived).map((a) => a.id))
        const kept = (next.pendingOrders ?? []).filter(
          (o) => activeIds.has(o.accountId) && current.has(o.id),
        )
        return kept.length === current.size ? current : new Set(kept.map((o) => o.id))
      })
    }
    version.current = { revision: next.revision, generation: next.generation }
    setRecords(next)
    setReady(true)
    setDbError(null)
  }, [])
  useEffect(() => {
    let mounted = true
    void loadPortfolio()
      .then((s) => {
        if (mounted) applyRecords(s)
      })
      .catch(() => setDbError('open'))
    const unsubscribe = subscribePortfolio(applyRecords)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [applyRecords])
  const active = useMemo(() => records.accounts.filter((a) => !a.archived), [records.accounts])
  const simPage = page === 'Overview' && !!scenario
  const previewingOrders = selectedOrderIds.size > 0 && !simPage && page !== 'Cash planner'
  const fills = useMemo(
    () => previewOrderFills(active, records.pendingOrders ?? [], selectedOrderIds),
    [active, records.pendingOrders, selectedOrderIds],
  )
  const displayAccounts = previewingOrders ? fills.accounts : active
  const accountPrices = useMemo(() => displayAccounts.flatMap(accountPriceInputs), [displayAccounts])
  const orderSymbols = useMemo(() => {
    const ids = new Set(active.map((a) => a.id))
    return (records.pendingOrders ?? []).filter((o) => ids.has(o.accountId)).map((o) => o.asset)
  }, [records.pendingOrders, active])
  const savedSymbols = useMemo(
    () => [
      ...new Set([...majors, symbol, ...active.flatMap(accountPriceInputs).map(({ asset }) => asset)]),
    ],
    [active, symbol],
  )
  const symbolsKey = [...new Set([...savedSymbols, ...orderSymbols])].join(',')
  useEffect(() => {
    const controller = new AbortController()
    const selected = symbolsKey.split(',')
    async function run() {
      setLoading(true)
      try {
        const tick = await fetchQuotes(selected, controller.signal)
        if (!controller.signal.aborted) setMarket(tick)
      } catch {
        if (!controller.signal.aborted) setMarket(cachedQuotes(selected))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void run()
    const timer = window.setInterval(() => void run(), 45000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [request, symbolsKey])
  const risk = useMemo(() => evaluate(displayAccounts, market.book), [displayAccounts, market.book])
  const clearFills = () => setSelectedOrderIds(new Set())
  const toggleFill = (id: string) =>
    setSelectedOrderIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const startSimulation = () => {
    setScenario({
      book: structuredClone(market.universe),
      path: 'Independent',
      overrides: {},
      symbols: savedSymbols,
      asOf: market.asOf,
      stale: Object.keys(market.universeStatus).filter((key) => market.universeStatus[key] === 'stale'),
    })
    setPage('Overview')
  }
  const live = () => {
    setScenario(null)
    clearFills()
    setPage('Overview')
  }
  const add = () => {
    if (ready) setEditor({ revision: records.revision })
  }
  const edit = (account: Account) => {
    const saved = records.accounts.find((record) => record.id === account.id)
    if (saved) setEditor({ account: saved, revision: records.revision })
  }
  const pendingOrdersPanel = active.some((a) => a.kind === 'spot' || a.kind === 'perp') && (
    <PendingOrders
      key={records.generation}
      state={records}
      selectedIds={selectedOrderIds}
      onToggle={toggleFill}
      onClear={clearFills}
      errors={fills.errors}
      filledIds={fills.filledIds}
      onRecords={applyRecords}
      addForAccountId={addOrderFor}
      onAddHandled={() => setAddOrderFor(null)}
    />
  )
  const title =
    page === 'Overview'
      ? simPage
        ? t('What if?', '情景模拟')
        : t('Portfolio overview', '投资组合概览')
      : page === 'Accounts'
        ? t('Accounts', '账户')
        : t('Cash planner', '资金规划')
  const descriptions =
    page === 'Overview'
      ? simPage
        ? t(
            'Compare your live portfolio with a hypothetical price move.',
            '对比实时投资组合与模拟价格下的表现。',
          )
        : ready && active.length === 0
          ? t(
              'Add a spot wallet, margin account, isolated perpetual, or crypto loan to track your portfolio.',
              '添加普通现货账户、杠杆账户、逐仓永续合约仓位或质押借币订单，即可查看投资组合表现。',
            )
          : t('Your Bitget accounts, valued in USDT.', '以 USDT 计价的 Bitget 账户总览。')
      : page === 'Accounts'
        ? t(
            'Manage your spot wallets, margin accounts, perpetual positions, and loan orders.',
            '管理普通现货账户、杠杆账户、永续合约仓位和借币订单。',
          )
        : t(
            'Plan funding at your BTC target with spot USDT, pledged holdings, and external cash.',
            '设定 BTC 目标价，使用现货 USDT、持仓质押借款与外部资金制定防强平方案。',
          )
  const needed = useMemo(
    () =>
      new Set([
        ...[...majors, symbol].map((s) => 'spot:' + s),
        ...accountPrices.map(({ basis, asset }) => basis + ':' + asset),
      ]),
    [accountPrices, symbol],
  )
  const stale = market.stale.filter((x) => needed.has(x)),
    missing = market.missing.filter((x) => needed.has(x))
  return (
    <>
      <header className="topbar">
        <div className="header-inner">
          <button
            className="home"
            aria-label={t('2029 portfolio overview', '2029 投资组合概览')}
            onClick={live}
          >
            <Brand />
          </button>
          <span className="nav-divider" />
          <nav aria-label={t('Main navigation', '主导航')}>
            {pages.map(({ name, chinese, icon: Icon }) => (
              <button
                className={page === name ? 'active' : ''}
                key={name}
                onClick={() => {
                  if (name === 'Cash planner') setScenarioPlan(null)
                  setPage(name)
                }}
              >
                <Icon size={16} />
                {t(name, chinese)}
              </button>
            ))}
          </nav>
          <div className="workspace">
            <HardDrive size={14} />
            <span>{t('Local workspace', '本地工作区')}</span>
          </div>
          <div className="header-preferences">
            <label className="language-picker">
              <Languages size={15} aria-hidden="true" />
              <select
                aria-label="Language / 语言"
                value={language}
                onChange={(event) => setLanguage(event.target.value as Language)}
              >
                <option value="en" lang="en">
                  English
                </option>
                <option value="zh-CN" lang="zh-CN">
                  简体中文
                </option>
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </label>
            <button
              className="settings-button"
              onClick={() => setSettings(true)}
              disabled={!ready}
              title={t('Portfolio settings', '投资组合设置')}
              aria-label={t('Portfolio settings', '投资组合设置')}
            >
              <Settings2 size={18} />
            </button>
          </div>
        </div>
      </header>
      <main className="main">
        <section className="page-heading">
          <div>
            <div className="heading-line">
              <h1>{title}</h1>
              {page !== 'Cash planner' && (
                <Tag tone={simPage || previewingOrders ? 'warm' : 'green'}>
                  <i className={'status-dot ' + (simPage || previewingOrders ? 'amber' : '')} />
                  {simPage
                    ? t('Scenario', '情景')
                    : previewingOrders
                      ? t('Fill preview', '挂单成交试算')
                      : t('Live', '实时')}
                </Tag>
              )}
            </div>
            <p>
              {previewingOrders
                ? t(
                    'Selected orders are valued as filled at their limit prices. Price scenarios and cash plans use your saved holdings.',
                    '已勾选的挂单按限价模拟成交，持仓按当前行情估值。价格情景和资金规划使用已保存的实仓。',
                  )
                : descriptions}
            </p>
          </div>
          <div className="heading-actions">
            {previewingOrders && (
              <button className="btn" onClick={live}>
                <Radio size={16} />
                {t('Return to Live', '返回实时视图')}
              </button>
            )}
            {page === 'Overview' &&
              (simPage ? (
                <button className="btn primary" onClick={live}>
                  <Radio size={16} />
                  {t('Return to Live', '返回实时视图')}
                </button>
              ) : (
                <>
                  {ready && active.length === 0 && (
                    <button className="btn primary" onClick={add}>
                      <Plus size={16} />
                      {t('Add your first account', '添加第一个账户')}
                    </button>
                  )}
                  {records.scenarios.length > 0 && (
                    <LoadScenario scenarios={records.scenarios} onLoad={setScenario} />
                  )}
                  <button
                    className="btn"
                    onClick={() => {
                      live()
                      void loadPortfolio()
                        .then(applyRecords)
                        .catch(() => {
                          setDbError('refresh')
                        })
                      refresh((n) => n + 1)
                    }}
                  >
                    <RefreshCw size={15} className={loading ? 'spinning' : ''} />
                    {t('Refresh', '刷新')}
                  </button>
                  <button
                    className={active.length ? 'btn primary' : 'btn'}
                    onClick={startSimulation}
                    title={
                      market.asOf
                        ? undefined
                        : t(
                            'A Bitget reference price is needed to simulate',
                            '需先获取 Bitget 参考价才能模拟',
                          )
                    }
                    disabled={!ready || !market.asOf}
                  >
                    <FlaskConical size={16} />
                    {t('Simulate', '模拟')}
                  </button>
                </>
              ))}

            {page === 'Cash planner' && (
              <button className="btn" onClick={() => setPage('Overview')}>
                <Activity size={15} />
                {scenario
                  ? t('Back to scenario', '返回情景模拟')
                  : selectedOrderIds.size
                    ? t('Back to fill preview', '返回挂单试算')
                    : t('Back to Live', '返回实时视图')}
              </button>
            )}
          </div>
        </section>
        {dbError && (
          <p className="notice" role="alert">
            {dbError === 'open'
              ? t(
                  'Browser storage could not be opened. Allow IndexedDB on this origin to load or save accounts.',
                  '无法打开浏览器存储。请允许此站点使用 IndexedDB，以便读取或保存账户。',
                )
              : t(
                  'Could not refresh saved accounts. Showing the last loaded portfolio.',
                  '刷新已保存的账户失败，当前显示上次加载的投资组合。',
                )}
          </p>
        )}
        {!loading && (stale.length > 0 || missing.length > 0) && (
          <div className="quote-notice">
            <button onClick={() => setQuoteInfo(!quoteInfo)} aria-expanded={quoteInfo}>
              <AlertCircle size={15} />
              {stale.length
                ? t('Using last known prices', '正在使用上次获取的价格')
                : t('Some Bitget prices are unavailable', '部分 Bitget 报价暂不可用')}
              <ChevronDown size={13} />
            </button>
            {quoteInfo && (
              <p>
                {stale.length > 0 &&
                  t('Stale · ', '已过期 · ') + stale.map(describeQuote).join(t(', ', '、'))}
                {stale.length > 0 && missing.length > 0 && <br />}
                {missing.length > 0 &&
                  t('Missing · ', '缺少报价 · ') + missing.map(describeQuote).join(t(', ', '、'))}
              </p>
            )}
          </div>
        )}
        {!ready ? (
          <div className="panel storage-status" role="status">
            {dbError
              ? t('Portfolio unavailable', '无法读取投资组合')
              : t('Loading saved portfolio…', '正在加载已保存的投资组合…')}
          </div>
        ) : simPage && scenario ? (
          <Scenario
            scenario={scenario}
            update={setScenario}
            liveBook={market.book}
            records={records}
            onRecords={applyRecords}
            onPlan={() => {
              setScenarioPlan(newPlanDraft(planFromScenario(scenario)))
              setPage('Cash planner')
            }}
          />
        ) : page === 'Cash planner' ? (
          <Planner
            key={scenarioPlan ? 'scenario-plan' : 'standalone-plan'}
            draft={scenarioPlan ?? plan}
            setDraft={
              scenarioPlan
                ? (change) => setScenarioPlan((current) =>
                    current && (typeof change === 'function' ? change(current) : change),
                  )
                : setPlan
            }
            book={market.book}
            asOf={market.asOf}
            quoteStatus={market.universeStatus}
            state={records}
            onRecords={applyRecords}
            onAdd={add}
          />
        ) : page === 'Accounts' ? (
          <>
            <Accounts
              risk={risk}
              market={market}
              records={records}
              onRecords={applyRecords}
              full
              onAdd={add}
              onEdit={edit}
              onAddOrder={setAddOrderFor}
            />
            {pendingOrdersPanel}
            <RiskSummary risk={risk} />
          </>
        ) : (
          <div className="page-stack">
            <Metrics risk={risk} />
            {pendingOrdersPanel}
            <Markets
              symbol={symbol}
              setSymbol={setSymbol}
              market={market}
              loading={loading}
              refreshKey={request}
            />
            {active.length > 0 && (
              <Accounts
                risk={risk}
                market={market}
                records={records}
                onRecords={applyRecords}
                onAdd={add}
                onEdit={edit}
                onAddOrder={setAddOrderFor}
              />
            )}
            <RiskSummary risk={risk} />
          </div>
        )}
        <footer>
          <span>
            <ShieldCheck size={14} />
            {t('Stored on this device', '数据保存在本设备')}
          </span>
          <span>
            <Clock3 size={13} />
            {t('Last balance edit', '上次余额修改')} <b>{dateTime(records.lastBalanceEdit)}</b>
            <i />
            {t('Quote time', '报价时间')} <b>{dateTime(market.asOf)}</b>
          </span>
        </footer>
      </main>
      {editor && (
        <AccountEditor
          account={editor.account}
          revision={editor.revision}
          onClose={() => setEditor(null)}
          onSaved={(s) => {
            applyRecords(s)
            setEditor(null)
          }}
        />
      )}
      {settings && (
        <Settings state={records} onClose={() => setSettings(false)} onChange={applyRecords} />
      )}
    </>
  )
}
