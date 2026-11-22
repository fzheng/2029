import { useEffect, useId, useState, type FormEvent } from 'react'
import { ClipboardList, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  isAssetSymbol,
  isDecimalAmount,
  type Account,
  type PendingOrder,
  type PerpAccount,
  type SpotAccount,
} from './model'
import type { FillError } from './orderFills'
import { formError } from './formMessages'
import { useLanguage } from './i18n'
import { accountTypeName, Dialog, majors } from './shared'
import { removePendingOrders, savePendingOrder, type PortfolioState } from './storage'
import './pending-orders.css'

type OrderAccount = SpotAccount | PerpAccount
const isOrderAccount = (a: Account): a is OrderAccount =>
  !a.archived && (a.kind === 'spot' || a.kind === 'perp')

const errorsByCode = {
  invalidOrder: ['Check the asset, quantity, price and fee.', '请检查币种、数量、限价及手续费。'],
  insufficientUsdt: ['Insufficient USDT for this fill.', '可用 USDT 不足以成交。'],
  insufficientAsset: [
    'The sell quantity exceeds the available holding.',
    '卖出数量超过该账户的可用持仓。',
  ],
  insufficientMargin: [
    'The realized loss and fee exceed the isolated margin.',
    '已实现亏损和手续费超过该仓位的逐仓保证金。',
  ],
  unavailableAccount: ['This account is unavailable.', '该账户不可用。'],
} as const satisfies Record<FillError, readonly [string, string]>

function OrderEditor({
  accounts,
  defaultAccountId,
  original,
  revision,
  onClose,
  onRecords,
}: {
  accounts: OrderAccount[]
  defaultAccountId: string
  original?: PendingOrder
  revision: number
  onClose: () => void
  onRecords: (s: PortfolioState) => void
}) {
  const { t } = useLanguage()
  const suggestions = useId()
  const [accountId, setAccountId] = useState(defaultAccountId)
  const [side, setSide] = useState<PendingOrder['side']>(original?.side ?? 'buy')
  const [asset, setAsset] = useState(original?.asset ?? '')
  const [quantity, setQuantity] = useState(original?.quantity ?? '')
  const [limitPrice, setLimitPrice] = useState(original?.limitPrice ?? '')
  const [fee, setFee] = useState(original?.feeUsdt ?? '')
  const [borrow, setBorrow] = useState(original?.autoBorrow ?? false)
  const [repay, setRepay] = useState(original?.autoRepay ?? false)
  const [issue, setIssue] = useState<'asset' | 'amount' | 'fee' | 'account' | null>(null)
  const [saveError, setSaveError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const account = accounts.find((a) => a.id === accountId)
  const symbol = account?.kind === 'perp' ? account.asset : asset.trim().toUpperCase()
  const sideLabel = t('Side', '方向')
  const assetLabel = t('Asset', '币种')
  const numericFields = [
    { key: 'quantity', label: t('Quantity', '数量'), unit: symbol, text: quantity, change: setQuantity },
    {
      key: 'price',
      label: t('Limit price', '限价'),
      unit: 'USDT',
      text: limitPrice,
      change: setLimitPrice,
    },
    {
      key: 'fee',
      label: t('Fee (USDT)', '手续费（USDT）'),
      unit: 'USDT',
      text: fee,
      change: setFee,
      optional: true,
    },
  ]
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setSaveError(null)
    if (!account) return setIssue('account')
    if (!isAssetSymbol(symbol) || symbol === 'USDT') return setIssue('asset')
    if (!isDecimalAmount(quantity.trim(), true) || !isDecimalAmount(limitPrice.trim(), true))
      return setIssue('amount')
    if (fee.trim() && !isDecimalAmount(fee.trim())) return setIssue('fee')
    setIssue(null)
    setBusy(true)
    try {
      const order: PendingOrder = {
        id: original?.id ?? crypto.randomUUID(),
        accountId,
        asset: symbol,
        side,
        quantity: quantity.trim(),
        limitPrice: limitPrice.trim(),
        ...(fee.trim() && { feeUsdt: fee.trim() }),
        ...(account.kind === 'spot' && side === 'buy' && borrow && { autoBorrow: true }),
        ...(account.kind === 'spot' && side === 'sell' && repay && { autoRepay: true }),
      }
      onRecords(await savePendingOrder(order, revision))
      onClose()
    } catch (error) {
      setSaveError(error)
      setBusy(false)
    }
  }
  const issues = {
    account: t(
      'Choose an active spot margin or perpetual account.',
      '请选择使用中的现货杠杆账户或逐仓永续仓位。',
    ),
    asset: t('Enter a base asset for the USDT pair.', '请输入 USDT 交易对的基础币种。'),
    amount: t('Enter a positive quantity and limit price.', '数量和限价必须为大于零的数值。'),
    fee: t('Enter a nonnegative fee in USDT.', '手续费须为非负数，以 USDT 计价。'),
  }
  return (
    <Dialog
      title={original ? t('Edit limit order', '编辑限价挂单') : t('Add limit order', '添加限价挂单')}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form noValidate onSubmit={save}>
        <fieldset className="order-form-grid" disabled={busy}>
          <label className="field order-form-wide">
            {t('Account', '账户')}
            <select
              aria-label={t('Account', '账户')}
              value={accountId}
              disabled={!!original}
              onChange={(e) => setAccountId(e.target.value)}
              autoFocus={!original}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {accountTypeName(a.kind)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {sideLabel}
            <select
              aria-label={sideLabel}
              value={side}
              onChange={(e) => setSide(e.target.value as PendingOrder['side'])}
            >
              <option value="buy">{t('Buy', '买入')}</option>
              <option value="sell">{t('Sell', '卖出')}</option>
            </select>
          </label>
          <label className="field">
            {assetLabel}
            <input
              value={account?.kind === 'perp' ? account.asset : asset}
              aria-label={assetLabel}
              readOnly={account?.kind === 'perp'}
              list={account?.kind === 'spot' ? suggestions : undefined}
              maxLength={30}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setAsset(e.target.value.toUpperCase())}
              placeholder="BTC"
              required
            />
          </label>
          {account?.kind === 'spot' && (
            <datalist id={suggestions}>
              {[...new Set([...account.holdings.map((h) => h.asset), ...majors])]
                .filter((a) => a !== 'USDT')
                .map((a) => (
                  <option key={a} value={a} />
                ))}
            </datalist>
          )}
          {numericFields.map((f) => (
            <label key={f.key} className={'field' + (f.optional ? ' order-form-wide' : '')}>
              {f.label}
              <span className="unit-input">
                <input
                  aria-label={f.label}
                  inputMode="decimal"
                  autoComplete="off"
                  value={f.text}
                  onChange={(e) => f.change(e.target.value)}
                  placeholder={f.optional ? '0' : undefined}
                  required={!f.optional}
                />
                {f.unit && <span>{f.unit}</span>}
              </span>
            </label>
          ))}
          {account?.kind === 'spot' ? (
            <>
              <label className="order-form-check order-form-wide">
                {side === 'buy' ? (
                  <>
                    <input
                      type="checkbox"
                      checked={borrow}
                      onChange={(e) => setBorrow(e.target.checked)}
                    />
                    {t('Borrow missing USDT', '缺少的 USDT 以借款补足')}
                  </>
                ) : (
                  <>
                    <input
                      type="checkbox"
                      checked={repay}
                      onChange={(e) => setRepay(e.target.checked)}
                    />
                    {t('Repay USDT debt', '卖出所得优先偿还 USDT 债务')}
                  </>
                )}
              </label>
              {side === 'sell' && (
                <p className="small-text order-form-wide">
                  {t(
                    'Sell quantity is limited to the assets held in this account.',
                    '卖出数量以此账户持有的币数为限。',
                  )}
                </p>
              )}
            </>
          ) : (
            account?.kind === 'perp' && (
              <p className="small-text order-form-wide">
                {t(
                  'Buy and sell fills net against this isolated position. The preview keeps its existing margin and applies realized P&L and fees.',
                  '买卖按单向持仓合并，可加仓、减仓或反向开仓。试算使用已有逐仓保证金，并计入已实现盈亏和手续费。',
                )}
              </p>
            )
          )}
        </fieldset>
        {issue && (
          <p role="alert" className="alert-text">
            {issues[issue]}
          </p>
        )}
        {saveError != null && (
          <p role="alert" className="alert-text">
            {formError(saveError)}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t('Cancel', '取消')}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {t('Save order', '保存挂单')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

interface PanelProps {
  state: PortfolioState
  selectedIds: ReadonlySet<string>
  errors: ReadonlyMap<string, FillError>
  filledIds: ReadonlySet<string>
  onToggle: (id: string) => void
  onClear: () => void
  onRecords: (s: PortfolioState) => void
  addForAccountId?: string | null
  onAddHandled?: () => void
}

export function PendingOrders({
  state,
  selectedIds,
  errors,
  filledIds,
  onToggle,
  onClear,
  onRecords,
  addForAccountId,
  onAddHandled,
}: PanelProps) {
  const { t } = useLanguage()
  const eligible = state.accounts.filter(isOrderAccount)
  const byId = new Map(eligible.map((a) => [a.id, a]))
  const orders = (state.pendingOrders ?? []).filter((o) => byId.has(o.accountId))
  const selected = orders.filter((o) => selectedIds.has(o.id))
  const [editor, setEditor] = useState<{
    original?: PendingOrder
    accountId: string
    revision: number
  } | null>(null)
  const [removal, setRemoval] = useState<{ ids: string[]; revision: number } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<unknown>(null)
  useEffect(() => {
    if (!addForAccountId) return
    if (state.accounts.some((a) => a.id === addForAccountId && isOrderAccount(a)))
      setEditor({ accountId: addForAccountId, revision: state.revision })
    onAddHandled?.()
  }, [addForAccountId, onAddHandled, state.accounts, state.revision])
  function requestRemoval(ids: string[]) {
    setDeleteError(null)
    setRemoval({ ids, revision: state.revision })
  }
  async function remove() {
    if (!removal || deleting) return
    setDeleting(true)
    try {
      onRecords(await removePendingOrders(removal.ids, removal.revision))
      setRemoval(null)
    } catch (error) {
      setDeleteError(error)
    } finally {
      setDeleting(false)
    }
  }
  return (
    <section className="panel pending-orders" aria-label={t('Pending orders', '挂单')}>
      <div className="panel-heading">
        <div className="panel-title">
          <ClipboardList size={17} />
          <h2>{t('Pending orders', '挂单')}</h2>
          {orders.length > 0 && <span className="count">{orders.length}</span>}
        </div>
        <button
          type="button"
          className="btn compact"
          disabled={!eligible.length}
          onClick={() => setEditor({ accountId: eligible[0].id, revision: state.revision })}
        >
          <Plus size={14} />
          {t('Add limit order', '添加限价挂单')}
        </button>
      </div>
      {orders.length === 0 ? (
        <p className="panel-description">
          {eligible.length
            ? t(
                'Add a limit order, then select it to preview a fill.',
                '添加限价挂单后，可勾选试算成交结果。',
              )
            : t(
                'Add a spot cross margin account or isolated perpetual position to enter limit orders.',
                '添加现货全仓杠杆账户或逐仓永续仓位后即可录入限价挂单。',
              )}
        </p>
      ) : (
        <>
          <div className="order-toolbar">
            <p className="small-text">
              {t(
                'Select orders to simulate fills at their limit prices, in the order shown.',
                '勾选挂单，按列表顺序、以各自的限价试算成交。',
              )}
            </p>
            <div className="order-tools">
              <button
                type="button"
                className="btn compact"
                disabled={!selected.length}
                onClick={onClear}
              >
                {t('Clear fill assumptions', '清除成交试算')}
              </button>
              <button
                type="button"
                className="text-button order-delete"
                onClick={() => requestRemoval(orders.map((o) => o.id))}
              >
                {t('Delete listed orders', '删除列表挂单')}
              </button>
            </div>
          </div>
          <ul className="orders-list">
            {orders.map((o) => {
              const account = byId.get(o.accountId)!
              const sideText = o.side === 'buy' ? t('Buy', '买入') : t('Sell', '卖出')
              const description =
                account.name +
                ' · ' +
                sideText +
                ' ' +
                o.quantity +
                ' ' +
                o.asset +
                ' @ ' +
                o.limitPrice +
                ' USDT'
              const selected = selectedIds.has(o.id),
                applied = filledIds.has(o.id),
                error = errors.get(o.id)
              const status = error
                ? t('Fill failed', '成交试算失败')
                : applied
                  ? t('Assumed filled', '假设已成交')
                  : t('Account preview blocked', '此账户试算未计入')
              return (
                <li key={o.id} className="order-row">
                  <label className="order-choice">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => onToggle(o.id)}
                      aria-label={t('Assume filled: ' + description, '假设成交 · ' + description)}
                    />
                    <span className="order-info">
                      <strong>
                        {account.name}{' '}
                        <span className="order-kind">{accountTypeName(account.kind)}</span>
                      </strong>
                      <span className="order-terms">
                        <b className={'order-side ' + o.side}>{sideText}</b> {o.quantity} {o.asset}{' '}
                        <span>@</span> {o.limitPrice} USDT
                      </span>
                      {(o.autoBorrow || o.autoRepay || Number(o.feeUsdt) > 0) && (
                        <small>
                          {[
                            o.autoBorrow && t('Borrow missing USDT', '缺额借入 USDT'),
                            o.autoRepay && t('Repay USDT debt', '卖出优先还款'),
                            Number(o.feeUsdt) > 0 &&
                              t('Fee ' + o.feeUsdt + ' USDT', '手续费 ' + o.feeUsdt + ' USDT'),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </small>
                      )}
                    </span>
                  </label>
                  <div className="order-controls">
                    {selected && (
                      <span className={'tag ' + (applied ? 'warm' : error ? 'danger' : 'neutral')}>
                        {status}
                      </span>
                    )}
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t('Edit order · ' + description, '编辑挂单 · ' + description)}
                      title={t('Edit order', '编辑挂单')}
                      onClick={() =>
                        setEditor({ original: o, accountId: o.accountId, revision: state.revision })
                      }
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-button order-delete"
                      aria-label={t('Delete order · ' + description, '删除挂单 · ' + description)}
                      title={t('Delete order', '删除挂单')}
                      onClick={() => requestRemoval([o.id])}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  {selected && error && (
                    <p className="order-error" role="status">
                      {t(errorsByCode[error][0], errorsByCode[error][1])}{' '}
                      {t('Fills in this account have been withheld.', '此账户勾选的挂单均未计入试算。')}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
      {editor && (
        <OrderEditor
          accounts={eligible}
          defaultAccountId={editor.accountId}
          original={editor.original}
          revision={editor.revision}
          onRecords={onRecords}
          onClose={() => setEditor(null)}
        />
      )}
      {removal && (
        <Dialog
          title={t('Delete pending orders?', '删除挂单？')}
          onClose={() => {
            if (!deleting) setRemoval(null)
          }}
        >
          <p className="small-text">
            {t(
              'Delete ' +
                removal.ids.length +
                ' saved ' +
                (removal.ids.length === 1 ? 'order' : 'orders') +
                ' from this dashboard?',
              '从看板删除这 ' + removal.ids.length + ' 笔已保存的挂单？',
            )}
          </p>
          {deleteError != null && (
            <p className="alert-text" role="alert">
              {formError(deleteError)}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn" disabled={deleting} onClick={() => setRemoval(null)}>
              {t('Cancel', '取消')}
            </button>
            <button
              type="button"
              className="btn order-confirm-delete"
              disabled={deleting}
              onClick={() => void remove()}
            >
              {t('Delete orders', '删除挂单')}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  )
}

export default PendingOrders
