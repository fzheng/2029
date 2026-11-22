import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { ArrowDownToLine, Bookmark, Calculator, Coins, Crosshair, Layers3, Wallet } from 'lucide-react'
import { planCash, type CashAction } from './engine'
import type { PlanInput, PriceBook } from './model'
import { SaveName } from './Scenario'
import SpotFunding from './SpotFunding'
import { accountTypeName, cash, describeQuote, triggerPrice, Tag } from './shared'
import { translate, useLanguage } from './i18n'
import { savePlan, type PortfolioState } from './storage'

const planMessages: Readonly<Record<string, string>> = {
  'The selected account is archived or missing. Choose an active account.':
    '所选账户已归档或不存在，请选择一个使用中的账户。',
  'Enter a BTC target greater than zero': 'BTC 目标价必须大于零。',
  'Enter a buffer from zero up to, but below, 100%': '安全缓冲比例必须大于或等于 0%，并小于 100%。',
  'Enter a nonnegative cash budget': '资金预算不能为负数。',
  'USDT cannot secure a USDT loan': '不能用 USDT 质押借入 USDT。',
  'Pledge quantity must be positive and within the available wallet balance':
    '质押数量必须大于零，且不能超过该现货账户中的可用数量。',
  'Borrow LTV must be positive and below a liquidation LTV of at most 100%':
    '初始质押率必须大于零且低于强平质押率，强平质押率不得超过 100%。',
  'Enter valid Bitget borrowing and collateral limits': '请检查 Bitget 借款及质押价值限额。',
  'A pledge source is archived or missing. Choose an active spot wallet.':
    '质押来源账户已归档或不存在，请移除该来源并重新选择。',
  'Choose each wallet and collateral asset only once': '每个现货账户的同一币种只能作为一次质押来源。',
  'BTC reference price': '缺少 BTC 参考价格',
}
function planIssue(message: string) {
  return planMessages[message] ? translate(message, planMessages[message]) : describeQuote(message)
}
const actionsInChinese = {
  spot: '偿还现货杠杆账户负债',
  loan: '偿还此笔借款，抵押资产继续质押',
  perp: '为该逐仓永续仓位追加保证金',
}

function FundingStatus({ required, safe }: Pick<CashAction, 'required' | 'safe'>) {
  const { t } = useLanguage()
  if (required === 0) return <Tag tone="green">{t('No funding needed', '无需补资，已达标')}</Tag>
  if (required === null || safe === null) return <Tag>{t('Unable to assess', '暂无法判断')}</Tag>
  if (safe) return <Tag tone="warm">{t('Funding required', '需补资')}</Tag>
  return <Tag tone="danger">{t('Funding shortfall', '方案资金不足')}</Tag>
}

export const defaultPlan: PlanInput = {
  target: '',
  path: 'Base',
  budget: '',
  bufferPct: '',
  accountId: '',
  useSpotUsdt: true,
}
export function Planner({
  form,
  setForm,
  book,
  quoteStatus,
  state,
  onRecords,
  onAdd,
}: {
  form: PlanInput
  setForm: Dispatch<SetStateAction<PlanInput>>
  book: PriceBook
  quoteStatus: Record<string, 'fresh' | 'stale'>
  state: PortfolioState
  onRecords: (s: PortfolioState) => void
  onAdd: () => void
}) {
  const { t } = useLanguage()
  const [saveAt, setSaveAt] = useState<number | null>(null)
  const [loadVersion, setLoadVersion] = useState(0)
  const accounts = useMemo(() => state.accounts.filter((a) => !a.archived), [state.accounts])
  const wallets = accounts.filter((a) => a.kind === 'cashSpot')
  const destinations = accounts.filter((a) => a.kind !== 'cashSpot')
  const hasSources = wallets.length > 0 || !!form.pledges?.length
  const result = useMemo(
    () =>
      form.target
        ? planCash(
            accounts,
            book,
            form,
            Object.keys(quoteStatus).filter((key) => quoteStatus[key] === 'stale'),
          )
        : null,
    [accounts, book, form, quoteStatus],
  )
  const change = (key: 'target' | 'path' | 'budget' | 'bufferPct' | 'accountId', value: string) =>
    setForm((current) => ({ ...current, [key]: value }))
  return (
    <div className="page-stack">
      <section className="panel">
        <div className="panel-heading">
          <div className="panel-title">
            <Crosshair size={18} />
            <h2>{t('Survival target', '防强平目标')}</h2>
          </div>
          {state.plans.length > 0 && (
            <select
              aria-label={t('Load saved plan', '载入已存方案')}
              value=""
              onChange={(e) => {
                const p = state.plans.find((v) => v.id === e.target.value)
                if (p) {
                  // Plans saved before wallet funding was introduced use external cash only.
                  setForm({ ...defaultPlan, useSpotUsdt: false, ...(p.data as PlanInput) })
                  setLoadVersion((v) => v + 1)
                }
              }}
            >
              <option value="">{t('Load saved plan…', '载入已存方案…')}</option>
              {state.plans.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="plan-form">
          <label className="field">
            {t('BTC target price', 'BTC 目标价')}
            <div className="unit-input">
              <input
                type="number"
                aria-label={t('BTC target price', 'BTC 目标价')}
                min="0.00000001"
                step="any"
                placeholder={t('Enter target', '输入目标价')}
                value={form.target}
                onChange={(e) => change('target', e.target.value)}
              />
              <span>USDT</span>
            </div>
          </label>
          <label className="field">
            {t('Apply to', '适用范围')}
            <select value={form.accountId || ''} onChange={(e) => change('accountId', e.target.value)}>
              <option value="">{t('Entire portfolio', '整个投资组合')}</option>
              {form.accountId && !destinations.some((a) => a.id === form.accountId) && (
                <option value={form.accountId}>
                  {t('Archived or unavailable account', '已归档或不可用的账户')}
                </option>
              )}
              {destinations.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t('Altcoin path', '其他币种的价格路径')}
            <select value={form.path} onChange={(e) => change('path', e.target.value)}>
              <option value="Base">{t('BTC-linked Base', '与 BTC 联动（基础）')}</option>
              <option value="Severe">{t('BTC-linked Severe', '与 BTC 联动（严峻）')}</option>
              <option value="Independent">{t('Independent', '独立调整')}</option>
            </select>
          </label>
          <label className="field">
            {t('Safety buffer', '安全缓冲')} <small>{t('Optional', '可选')}</small>
            <div className="unit-input">
              <input
                type="number"
                aria-label={t('Safety buffer', '安全缓冲')}
                min="0"
                max="99.99"
                step="any"
                placeholder="0"
                value={form.bufferPct || ''}
                onChange={(e) => change('bufferPct', e.target.value)}
              />
              <span>%</span>
            </div>
            {Number(form.bufferPct) > 0 && result?.bufferedBtcTarget != null && (
              <small>
                {t('BTC stress price', 'BTC 压力测试价')} {triggerPrice(result.bufferedBtcTarget)} USDT
              </small>
            )}
          </label>
          <label className="field">
            {hasSources ? t('External cash budget', '外部资金预算') : t('Cash budget', '资金预算')}{' '}
            <small>{t('Optional', '可选')}</small>
            <div className="unit-input">
              <input
                type="number"
                aria-label={
                  hasSources ? t('External cash budget', '外部资金预算') : t('Cash budget', '资金预算')
                }
                min="0"
                step="any"
                placeholder={t('Unlimited', '不限')}
                value={form.budget || ''}
                onChange={(e) => change('budget', e.target.value)}
              />
              <span>USDT</span>
            </div>
            <small>
              {t(
                'Leave blank to assume unlimited external funding.',
                '留空时，方案假设可按需补入外部资金。',
              )}
            </small>
          </label>
        </div>
        <div className="panel-actions">
          <p className="small-text">
            {t(
              'The buffer extends the BTC move beyond your target. Other prices follow the selected path.',
              '安全缓冲会让 BTC 价格在目标价基础上沿原方向进一步变动，其他币种按所选路径变化。',
            )}
          </p>
          <button
            className="btn"
            disabled={!result || !!result.missing.length}
            onClick={() => setSaveAt(state.revision)}
          >
            <Bookmark size={14} />
            {t('Save plan', '保存方案')}
          </button>
        </div>
      </section>
      {hasSources && (
        <SpotFunding
          key={loadVersion}
          wallets={wallets}
          form={form}
          setForm={setForm}
          results={result?.pledges ?? []}
        />
      )}
      {result && (
        <div className="metrics plan-metrics">
          {[
            {
              label: t('External cash needed', '所需外部资金'),
              value: result.externalNeeded,
              Icon: Wallet,
            },
            {
              label: t('Planned funding', '计划补资金额'),
              value: result.allocated,
              Icon: ArrowDownToLine,
            },
            ...(result.uncovered !== null && result.uncovered > 0
              ? [{ label: t('Still needed', '仍缺'), value: result.uncovered, Icon: Coins }]
              : []),
          ].map(({ label, value, Icon }, i) => (
            <article className={'metric ' + (i === 0 ? 'equity' : '')} key={label}>
              <div className="metric-label">
                <Icon size={16} />
                {label}
              </div>
              <div className="metric-value">
                {cash(value)} <small>USDT</small>
              </div>
            </article>
          ))}
        </div>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div className="panel-title">
            <Layers3 size={17} />
            <h2>{t('Funding actions', '资金安排')}</h2>
          </div>
        </div>
        {result && hasSources && (
          <dl className="funding-breakdown">
            {[
              [t('Total funding required', '目标所需资金'), result.required],
              [t('Planned use of wallet USDT', '拟动用自有 USDT'), result.spotUsdtUsed],
              [t('New loan principal', '新增借款本金'), result.newDebt],
              [t('Planned external funding', '拟动用外部资金'), result.externalUsed],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt>{label}</dt>
                <dd>{cash(value as number | null)} USDT</dd>
              </div>
            ))}
          </dl>
        )}
        {!!result?.stale.length && (
          <p className="notice">
            {t('Estimated using last-known prices', '本方案使用上次获取的价格估算')} ·{' '}
            {result.stale.map(describeQuote).join(t(', ', '、'))}
          </p>
        )}
        {!!result?.missing.length && (
          <p className="notice">
            {t('Plan incomplete', '方案尚不完整')} · {result.missing.map(planIssue).join(t(', ', '、'))}
          </p>
        )}
        {accounts.length > 0 && !destinations.length ? (
          <div className="standard-empty">
            <Wallet size={25} />
            <h3>{t('No positions need margin', '暂无需要补充保证金的仓位')}</h3>
            <p>
              {t(
                'Spot wallets can fund a margin account, loan repayment or isolated perpetual position.',
                '普通现货可用于偿还杠杆账户或借币订单的负债，也可为逐仓永续仓位追加保证金。',
              )}
            </p>
            <button className="btn" onClick={onAdd}>
              {t('Add account', '添加账户')}
            </button>
          </div>
        ) : !accounts.length ? (
          <div className="standard-empty">
            <Wallet size={25} />
            <h3>{t('No accounts to plan for', '尚无可规划的账户')}</h3>
            <button className="btn primary" onClick={onAdd}>
              {t('Add your first account', '添加第一个账户')}
            </button>
          </div>
        ) : !result ? (
          <div className="standard-empty">
            <Calculator size={26} />
            <h3>{t('Enter a BTC target price', '请输入 BTC 目标价')}</h3>
            <p>
              {t(
                'Your plan will show how much USDT each account needs.',
                '输入目标价后，可查看每个账户所需的 USDT。',
              )}
            </p>
          </div>
        ) : (
          <>
            <p className="panel-description">
              {t(
                'Cash is allocated to spot margin first, then individual loans, then isolated perpetuals.',
                '资金优先用于现货全仓杠杆账户，其次逐笔偿还质押借币，最后补充逐仓永续仓位的保证金。',
              )}
              {result.budgetRemaining !== null && (
                <>
                  {' '}
                  {t(
                    `Remaining external budget · ${cash(result.budgetRemaining)} USDT.`,
                    `剩余外部预算为 ${cash(result.budgetRemaining)} USDT。`,
                  )}
                </>
              )}
            </p>
            {result.actions.map((a) => (
              <article className="fund-action" key={a.accountId}>
                <div className="action-head">
                  <div>
                    <span className="small-text">{accountTypeName(a.kind)}</span>
                    <h3>{a.name}</h3>
                  </div>
                  <FundingStatus required={a.required} safe={a.safe} />
                </div>
                {a.required !== 0 && a.applied !== null && (
                  <p>
                    {t('Planned action', '计划操作')} · <b>{cash(a.applied)} USDT</b> ·{' '}
                    {t(a.action, actionsInChinese[a.kind])}
                  </p>
                )}
                {a.uncovered !== null && a.uncovered > 0 && (
                  <p className="fund-shortfall">
                    {t('Still needed', '仍缺')} <strong>{cash(a.uncovered)} USDT</strong>
                  </p>
                )}
                {a.sources.length > 0 && (
                  <div className="transfer-sources">
                    <h4>{t('Planned funding sources', '计划转入此账户的资金来源')}</h4>
                    <ul>
                      {a.sources.map((source) => (
                        <li key={JSON.stringify([source.kind, source.accountId, source.asset])}>
                          <span>
                            {source.kind === 'external'
                              ? t('External USDT', '外部 USDT')
                              : source.kind === 'spotUsdt'
                                ? source.name + t(' · free USDT', ' · 可用 USDT')
                                : source.name +
                                  ' · ' +
                                  source.asset +
                                  t(' collateral loan', ' 质押借款')}
                          </span>
                          <b>{cash(source.amount)} USDT</b>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <dl className="action-values">
                  {[
                    [t('Required transfer', '当前需转入金额'), cash(a.required) + ' USDT'],
                    ...((a.residual ?? 0) > 0
                      ? [
                          [t('Planned transfer', '计划转入金额'), cash(a.allocated) + ' USDT'],
                          [
                            t('Cash left at destination', '目标账户剩余资金'),
                            cash(a.residual) + ' USDT',
                          ],
                        ]
                      : []),
                    [
                      a.kind === 'perp'
                        ? t('Resulting margin', '追加后保证金')
                        : t('Resulting debt', '还款后负债'),
                      cash(a.resultingBalance) + ' USDT',
                    ],
                    [
                      t('Before liquidation', '调整前强平价'),
                      triggerPrice(a.beforeLiquidation) + ' / ' + a.triggerAsset,
                    ],
                    [
                      t('After liquidation', '调整后强平价'),
                      a.afterLiquidation === null
                        ? a.safe
                          ? t('No trigger', '无强平触发价')
                          : '—'
                        : triggerPrice(a.afterLiquidation) + ' / ' + a.triggerAsset,
                    ],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
              </article>
            ))}
          </>
        )}
      </section>
      {saveAt !== null && (
        <SaveName
          title={t('Save target plan', '保存目标方案')}
          onClose={() => setSaveAt(null)}
          onSave={async (name) => {
            onRecords(await savePlan({ id: crypto.randomUUID(), name, data: form }, saveAt))
          }}
        />
      )}
    </div>
  )
}
