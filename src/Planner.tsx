import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import {
  ArrowDownToLine, Bookmark, Calculator, Coins, Crosshair, Layers3, Plus, Trash2, Wallet,
} from 'lucide-react'
import { planCash, type CashAction } from './engine'
import type { PlanInput, PriceBook } from './model'
import { PlanDeleteDialog, PlanSaveDialog, planOptionLabel } from './PlanDialogs'
import SpotFunding from './SpotFunding'
import {
  accountTypeName,
  cash,
  dateTime,
  describeBtcMultipliers,
  describeQuote,
  pathName,
  triggerPrice,
  Tag,
} from './shared'
import { translate, useLanguage } from './i18n'
import { planNameKey, type PortfolioState, type SavedItem } from './storage'

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

function liquidationLabel(value: number | null, asset: string) {
  if (value === null) return '—'
  const unit = asset === 'gross assets' ? translate(' USDT gross assets', ' USDT（总资产）') : ' / ' + asset
  return triggerPrice(value) + unit
}

function FundingAction({ action: a }: { action: CashAction }) {
  const { t } = useLanguage()
  return (
    <article className="fund-action">
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
            liquidationLabel(a.beforeLiquidation, a.triggerAsset),
          ],
          [
            t('After liquidation', '调整后强平价'),
            a.afterLiquidation === null
              ? a.safe
                ? t('No trigger', '无强平触发价')
                : '—'
              : liquidationLabel(a.afterLiquidation, a.triggerAsset),
          ],
        ].map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </article>
  )
}

const defaultPlan: PlanInput = {
  target: '',
  path: 'Base',
  budget: '',
  bufferPct: '',
  accountId: '',
  useSpotUsdt: true,
}

export interface PlanDraft {
  form: PlanInput
  source: SavedItem | null
}
export function newPlanDraft(form: PlanInput = defaultPlan): PlanDraft {
  return { form: { ...form }, source: null }
}
function savedPlanForm(plan: SavedItem): PlanInput {
  // Plans saved before wallet funding was introduced use external cash only.
  return { ...defaultPlan, useSpotUsdt: false, ...(plan.data as PlanInput) }
}
type PlanAction = 'save' | 'copy' | 'delete'

export function Planner({
  draft,
  setDraft,
  book,
  asOf,
  quoteStatus,
  state,
  onRecords,
  onAdd,
}: {
  draft: PlanDraft
  setDraft: Dispatch<SetStateAction<PlanDraft>>
  book: PriceBook
  asOf: string | null
  quoteStatus: Record<string, 'fresh' | 'stale'>
  state: PortfolioState
  onRecords: (s: PortfolioState) => void
  onAdd: () => void
}) {
  const { t } = useLanguage()
  const { form, source } = draft
  const [dialog, setDialog] = useState<{ action: PlanAction; revision: number } | null>(null)
  const [loadVersion, setLoadVersion] = useState(0)
  const openDialog = (action: PlanAction) => setDialog({ action, revision: state.revision })
  const stored = source && state.plans.find((p) => p.id === source.id)
  const staleSource = useMemo(
    () => !!source && (!stored || (source !== stored && JSON.stringify(stored) !== JSON.stringify(source))),
    [source, stored],
  )
  const nameGroups = useMemo(() => {
    const groups = new Map<string, SavedItem[]>()
    for (const plan of state.plans) {
      const key = planNameKey(plan.name)
      const group = groups.get(key)
      if (group) group.push(plan)
      else groups.set(key, [plan])
    }
    return groups
  }, [state.plans])
  const setForm: Dispatch<SetStateAction<PlanInput>> = (update) =>
    setDraft((current) => ({
      ...current,
      form: typeof update === 'function' ? update(current.form) : update,
    }))
  const loadDraft = (plan: SavedItem | null) => {
    setDraft(plan ? { form: savedPlanForm(plan), source: plan } : newPlanDraft())
    setLoadVersion((v) => v + 1)
  }
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
  const overrides = Object.entries(form.snapshot?.overrides ?? {})
  const linkedAssets = describeBtcMultipliers(form.path, form.snapshot?.overrides)
  const actions = result?.actions ?? []
  const coveredActions = actions.filter((a) => a.required === 0)
  const visibleActions = actions
    .filter((a) => a.required !== 0)
    .sort((a, b) => (b.required ?? 0) - (a.required ?? 0))
  // A saved plan can be renamed even if its quotes are temporarily unavailable.
  const canSave = (!!result && !result.missing.length) ||
    (!!source && JSON.stringify(form) === JSON.stringify(savedPlanForm(source)))
  return (
    <div className="page-stack">
      <section className="panel">
        <div className="panel-heading plan-library-heading">
          <div className="panel-title">
            <Crosshair size={18} />
            <h2>{t('Survival target', '防强平目标')}</h2>
          </div>
          {(state.plans.length > 0 || source) && (
            <div className="plan-library-actions">
              {state.plans.length > 0 && (
                <label className="plan-choice">
                  {stored && <span>{t('Editing', '正在编辑')}</span>}
                  <select
                    aria-label={t('Load saved plan', '载入已存方案')}
                    value={stored?.id ?? ''}
                    onChange={(e) => loadDraft(state.plans.find((p) => p.id === e.target.value) ?? null)}
                  >
                    <option value="" disabled>{t('Select a plan to edit…', '选择要编辑的方案…')}</option>
                    {state.plans.map((p) => {
                      const matches = nameGroups.get(planNameKey(p.name))!
                      return (
                        <option value={p.id} key={p.id}>
                          {matches.length > 1 ? planOptionLabel(p, matches.indexOf(p)) : p.name}
                        </option>
                      )
                    })}
                  </select>
                </label>
              )}
              <button className="btn compact" onClick={() => loadDraft(null)}>
                <Plus size={14} />{t('New plan', '新建方案')}
              </button>
              {stored && (
                <button className="btn compact" disabled={staleSource} onClick={() => openDialog('delete')}>
                  <Trash2 size={14} />{t('Delete plan', '删除方案')}
                </button>
              )}
            </div>
          )}
        </div>
        {staleSource && (
          <div className="notice plan-conflict" role="status">
            {stored ? (
              <>
                {t('This plan changed in another view.', '此方案已在其他页面修改。')}
                <button className="btn compact" onClick={() => loadDraft(stored)}>
                  {t('Reload saved plan', '重新载入方案')}
                </button>
              </>
            ) : t(
              'This plan was deleted in another view. You can save your draft as a new plan.',
              '此方案已在其他页面删除。你可以将当前内容另存为新方案。',
            )}
          </div>
        )}
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
            {form.snapshot && form.target !== '' && Number(form.target) === 0 && (
              <small>
                {t('Enter a positive BTC price to calculate funding for this scenario.', '请输入大于零的 BTC 价格，以计算此情景所需的资金。')}
              </small>
            )}
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
              'The buffer extends the BTC move beyond your target. Other assets follow the selected path unless you copied a manual price target.',
              '安全缓冲会让 BTC 在目标价基础上沿原方向进一步变动。其他资产按所选路径变化，手动指定的目标价保持固定。',
            )}
          </p>
          <div className="plan-library-actions">
            {source && (
              <button className="btn" disabled={!canSave} onClick={() => openDialog('copy')}>
                {t('Save as', '另存为')}
              </button>
            )}
            <button className="btn primary" disabled={!canSave || staleSource} onClick={() => openDialog('save')}>
              <Bookmark size={14} />
              {source ? t('Save changes', '保存修改') : t('Save plan', '保存方案')}
            </button>
          </div>
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
      <section className="panel plan-assumptions" aria-label={t('Plan assumptions', '方案假设')}>
        <div className="panel-heading flex-wrap">
          <div className="panel-title">
            <h2>{t('Plan assumptions', '方案假设')}</h2>
          </div>
          {form.snapshot && (
            <button
              className="btn compact"
              onClick={() => setForm((current) => ({ ...current, snapshot: undefined }))}
            >
              {overrides.length
                ? t('Use live quotes and clear overrides', '使用实时行情并清除手动价格')
                : t('Use live quotes', '使用实时行情')}
            </button>
          )}
        </div>
        <div className="plan-assumption-body">
          <p>
            <strong>
              {form.snapshot ? t('Frozen scenario quotes', '已锁定的情景报价') : t('Live quotes', '实时行情')}
            </strong>
            {' · '}{dateTime(form.snapshot ? form.snapshot.asOf : asOf)}
            {' · '}{t('Price path', '价格路径')} <b>{pathName(form.path)}</b>
          </p>
          {linkedAssets && (
            <p>{t('BTC move multipliers', 'BTC 涨跌幅模拟倍数')} · {linkedAssets}</p>
          )}
          {!!result?.stale.length && (
            <p className="notice">
              {t('Estimated using last-known prices', '本方案使用上次获取的价格估算')} ·{' '}
              {result.stale.map(describeQuote).join(t(', ', '、'))}
            </p>
          )}
          {form.target !== '' && Number.isFinite(Number(form.target)) && (
            <p>
              {t('BTC target', 'BTC 目标价')} <b>{triggerPrice(Number(form.target))} USDT</b>
              {Number(form.bufferPct) > 0 && (
                <>
                  {' · '}{t('Buffer', '缓冲')} <b>{form.bufferPct}%</b>
                  {' · '}{t('Buffered target', '缓冲后目标价')}{' '}
                  <b>{triggerPrice(result?.bufferedBtcTarget)} USDT</b>
                </>
              )}
            </p>
          )}
          {overrides.length > 0 && (
            <p>
              {t('Manual price targets', '手动目标价')}{' · '}
              {overrides.map(([asset, value]) => asset + ' ' + cash(Number(value)) + ' USDT').join(' · ')}
            </p>
          )}
          {result && result.references.length > 0 && (
            <>
              <p className="small-text">{t('Reference → stress price (USDT)', '参考价 → 压力测试价（USDT）')}</p>
              <ul className="plan-reference-prices">
                {result.references.map(({ asset, basis, start, end }) => (
                  <li key={basis + ':' + asset}>
                    <span>{describeQuote(asset + ' ' + (basis === 'loan' ? 'loan reference' : basis))}</span>
                    <b>{triggerPrice(start)} → {triggerPrice(end)}</b>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>
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
            {(visibleActions.length > 0 || result.budgetRemaining !== null) && (
              <p className="panel-description">
                {visibleActions.length > 0 && t(
                  'Sorted by required transfer, largest first. Funds go to spot margin first, then loans, then isolated perpetuals.',
                  '按所需补资金额从高到低排列。资金优先分配给现货杠杆账户，其次是质押借币，最后是逐仓永续合约。',
                )}
                {result.budgetRemaining !== null && (
                  <> {t(
                    `Remaining external budget · ${cash(result.budgetRemaining)} USDT.`,
                    `剩余外部预算为 ${cash(result.budgetRemaining)} USDT。`,
                  )}</>
                )}
              </p>
            )}
            {visibleActions.map((action) => (
              <FundingAction key={action.accountId} action={action} />
            ))}
            {coveredActions.length > 0 && (
              <details className="covered-accounts" key={loadVersion}>
                <summary>
                  {t(`No funding needed (${coveredActions.length})`, `无需补资（${coveredActions.length}）`)}
                </summary>
                {coveredActions.map((action) => (
                  <FundingAction key={action.accountId} action={action} />
                ))}
              </details>
            )}
          </>
        )}
      </section>
      {(dialog?.action === 'save' || dialog?.action === 'copy') && (
        <PlanSaveDialog
          plans={state.plans}
          source={dialog.action === 'save' ? source : null}
          data={form}
          revision={dialog.revision}
          onClose={() => setDialog(null)}
          onSaved={(next, id) => {
            onRecords(next)
            loadDraft(next.plans.find((p) => p.id === id)!)
          }}
        />
      )}
      {dialog?.action === 'delete' && source && (
        <PlanDeleteDialog
          plan={source}
          revision={dialog.revision}
          onClose={() => setDialog(null)}
          onDeleted={(next) => {
            onRecords(next)
            loadDraft(null)
          }}
        />
      )}
    </div>
  )
}
