import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Decimal } from 'decimal.js'
import { Link2, Wallet, X } from 'lucide-react'
import type { CashSpotAccount, PlanInput, PledgeInput } from './model'
import { walletHoldings, type PledgeResult } from './engine'
import { fetchPledgeTerms } from './market'
import { useLanguage } from './i18n'
import { cash, triggerPrice } from './shared'

type SetPlan = Dispatch<SetStateAction<PlanInput>>
type Choice = { accountId: string; name: string; asset: string; quantity: string }
const sourceKey = (p: Pick<PledgeInput, 'accountId' | 'asset'>) => JSON.stringify([p.accountId, p.asset])

function PledgeRow({
  item,
  source,
  result,
  update,
  remove,
}: {
  item: PledgeInput
  source?: Choice
  result?: PledgeResult
  update: (patch: Partial<PledgeInput>) => void
  remove: () => void
}) {
  const { t } = useLanguage()
  const [looking, setLooking] = useState(false),
    [failed, setFailed] = useState(false)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const lookup = async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLooking(true)
    setFailed(false)
    try {
      const terms = await fetchPledgeTerms(item.asset, controller.signal)
      if (!controller.signal.aborted) update(terms)
    } catch {
      if (!controller.signal.aborted) setFailed(true)
    } finally {
      if (!controller.signal.aborted) setLooking(false)
    }
  }
  const fields = [
    ['quantity', t('Pledge quantity', '计划质押数量'), item.asset],
    ['borrowLtvPct', t('Initial LTV', '初始质押率'), '%'],
    ['liquidationLtvPct', t('Liquidation LTV', '强平质押率'), '%'],
  ] as const
  const hasLimits =
    item.minBorrowUsdt !== undefined ||
    item.maxBorrowUsdt !== undefined ||
    item.minCollateralUsdt !== undefined ||
    item.maxCollateralUsdt !== undefined
  return (
    <article className="pledge-row">
      <div className="pledge-heading">
        <div>
          <strong>
            {source?.name ?? t('Unavailable wallet', '不可用的现货账户')} · {item.asset}
          </strong>
          {source && (
            <small>
              {t('Available', '可用数量')} {source.quantity} {item.asset}
            </small>
          )}
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={remove}
          aria-label={t('Remove collateral', '移除此项质押')}
        >
          <X size={15} />
        </button>
      </div>
      <div className="pledge-fields">
        {fields.map(([field, label, unit]) => (
          <label className="field" key={field}>
            {label}
            <span className="unit-input">
              <input
                type="number"
                step="any"
                min="0"
                aria-label={label}
                disabled={!source || looking || (hasLimits && field !== 'quantity')}
                value={item[field]}
                onChange={(e) => update({ [field]: e.target.value })}
              />
              <span>{unit}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="terms-tools">
        <button type="button" className="btn compact" disabled={!source || looking} onClick={lookup}>
          <Link2 size={13} />
          {looking
            ? t('Loading…', '正在读取…')
            : hasLimits
              ? t('Refresh Bitget loan terms', '刷新 Bitget 借币条件')
              : t('Load Bitget loan terms', '读取 Bitget 借币条件')}
        </button>
        {hasLimits ? (
          <>
            <small>
              {t('Borrowing limits', '借款限额')} {item.minBorrowUsdt ?? '0'}–{item.maxBorrowUsdt ?? '∞'}{' '}
              USDT · {t('Collateral value limits', '质押价值限额')} {item.minCollateralUsdt ?? '0'}–
              {item.maxCollateralUsdt ?? '∞'} USDT
            </small>
            <button
              type="button"
              className="text-button"
              disabled={looking}
              onClick={() =>
                update({
                  minBorrowUsdt: undefined,
                  maxBorrowUsdt: undefined,
                  minCollateralUsdt: undefined,
                  maxCollateralUsdt: undefined,
                })
              }
            >
              {t('Use custom terms', '切换为自定义条件')}
            </button>
          </>
        ) : (
          <small>
            {t('Or enter the LTVs shown for your order.', '也可手动填写订单显示的初始和强平质押率。')}
          </small>
        )}
      </div>
      {failed && (
        <p className="alert-text" role="status">
          {t(
            'No public terms could be loaded for this pair. Check eligibility and enter the terms from your order.',
            '未能获取该币对的公开条件。请核实币种是否可质押，并填写订单提供的条件。',
          )}
        </p>
      )}
      {result && (
        <div className="pledge-result">
          <dl className="action-values">
            {[
              [t('Borrowing capacity at target', '目标价下可借上限'), cash(result.capacity) + ' USDT'],
              [
                t('Planned collateral', '计划锁定'),
                (result.borrowed > 0 ? item.quantity : '0') + ' ' + item.asset,
              ],
              [t('New loan principal', '新增借款本金'), cash(result.borrowed) + ' USDT'],
              [
                t('Collateral index at buffered target', '缓冲目标价下的抵押币指数价'),
                triggerPrice(result.targetPrice) + ' USDT / ' + item.asset,
              ],
              [
                t('LTV at buffered target', '缓冲目标价下的质押率'),
                result.targetLtv == null ? '—' : triggerPrice(result.targetLtv * 100) + '%',
              ],
              [
                t('New loan liquidation price', '新借款强平价'),
                result.liquidationPrice == null
                  ? '—'
                  : triggerPrice(result.liquidationPrice) + ' USDT / ' + item.asset,
              ],
              ...(result.unspentProceeds > 0
                ? [[t('Unused loan proceeds', '剩余借款资金'), cash(result.unspentProceeds) + ' USDT']]
                : []),
            ].map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {result.unavailableReason && (
            <p className="small-text">
              {result.unavailableReason === 'collateralLimit'
                ? t('Collateral value falls outside the order limits.', '质押价值超出订单限额。')
                : result.unavailableReason === 'borrowMinimum'
                  ? t(
                      'The safe borrowing limit is below the minimum loan size.',
                      '可安全借出的金额低于最低借款额。',
                    )
                  : t(
                      'This collateral cannot fund a loan at the selected target.',
                      '在所选目标价下，这笔质押无法提供资金。',
                    )}
            </p>
          )}
        </div>
      )}
    </article>
  )
}

export default function SpotFunding({
  wallets,
  form,
  setForm,
  results,
}: {
  wallets: CashSpotAccount[]
  form: PlanInput
  setForm: SetPlan
  results: PledgeResult[]
}) {
  const { t } = useLanguage()
  const holdings = wallets.flatMap((wallet) =>
    walletHoldings(wallet).map((h) => ({ ...h, accountId: wallet.id, name: wallet.name })),
  )
  const usdt = holdings
    .filter((h) => h.asset === 'USDT')
    .reduce((sum, h) => sum.plus(h.quantity), new Decimal(0))
  const inputs = form.pledges ?? []
  const available = holdings.filter(
    (h) =>
      h.asset !== 'USDT' &&
      new Decimal(h.quantity).gt(0) &&
      !inputs.some((p) => sourceKey(p) === sourceKey(h)),
  )
  const change = (key: string, patch: Partial<PledgeInput>) =>
    setForm((current) => ({
      ...current,
      pledges: (current.pledges ?? []).map((p) => (sourceKey(p) === key ? { ...p, ...patch } : p)),
    }))
  return (
    <section className="panel funding-sources" aria-label={t('Spot funding sources', '现货资金来源')}>
      <div className="panel-heading">
        <div className="panel-title">
          <Wallet size={17} />
          <h2>{t('Spot funding sources', '现货资金来源')}</h2>
        </div>
      </div>
      <div className="funding-controls">
        <label className="wallet-cash-toggle">
          <input
            type="checkbox"
            checked={!!form.useSpotUsdt}
            onChange={(e) => {
              const enabled = e.target.checked
              setForm((current) => ({ ...current, useSpotUsdt: enabled }))
            }}
          />
          <span>{t('Use available spot USDT first', '优先使用现货账户中的 USDT')}</span>
          <b>{cash(usdt.toNumber())} USDT</b>
        </label>
        <label className="field">
          {t('Borrow USDT against spot crypto', '质押现货借入 USDT')}
          <select
            value=""
            aria-label={t('Add collateral source', '添加质押来源')}
            disabled={!available.length}
            onChange={(e) => {
              const source = available.find((h) => sourceKey(h) === e.target.value)
              if (source)
                setForm((current) => ({
                  ...current,
                  pledges: [
                    ...(current.pledges ?? []),
                    {
                      accountId: source.accountId,
                      asset: source.asset,
                      quantity: '',
                      borrowLtvPct: '',
                      liquidationLtvPct: '',
                    },
                  ],
                }))
            }}
          >
            <option value="">
              {available.length
                ? t('Select a wallet and asset…', '选择现货账户和币种…')
                : t('No other available collateral', '暂无其他可选的质押资产')}
            </option>
            {available.map((h) => (
              <option value={sourceKey(h)} key={sourceKey(h)}>
                {h.name} · {h.quantity} {h.asset}
              </option>
            ))}
          </select>
        </label>
        {inputs.length > 0 && (
          <p className="small-text">
            {t(
              'A used loan locks the entered quantity and creates new debt. Capacity uses the Bitget index at today’s price and the buffered target. Estimates exclude future interest.',
              '方案动用某笔借款时，将锁定填写的质押数量，并形成新负债。额度按当前与缓冲目标价下的 Bitget 指数价核算，未计入后续利息。',
            )}
          </p>
        )}
      </div>
      {inputs.map((item) => {
        const key = sourceKey(item)
        return (
          <PledgeRow
            key={key}
            item={item}
            source={holdings.find((h) => sourceKey(h) === key)}
            result={results.find((p) => sourceKey(p) === key)}
            update={(patch) => change(key, patch)}
            remove={() =>
              setForm((current) => ({
                ...current,
                pledges: (current.pledges ?? []).filter((p) => sourceKey(p) !== key),
              }))
            }
          />
        )
      })}
    </section>
  )
}
