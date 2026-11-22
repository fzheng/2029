import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import Decimal from 'decimal.js'
import { Archive, ArrowDownUp, CircleDollarSign, Layers3, Plus, Trash2, Wallet, X } from 'lucide-react'
import type { Account, PerpAccount } from './model'
import { isDecimalAmount } from './model'
import { fetchContractTerms, popularSymbols } from './market'
import { saveAccount } from './storage'
import type { PortfolioState } from './storage'
import { fieldLabel, formError, type FieldName, type FormIssue } from './formMessages'
import { useLanguage } from './i18n'
import { accountTypeName, assetName } from './shared'
import './forms.css'

export function PortfolioDialog({
  title,
  onClose,
  children,
  icon,
  busy,
  focusKey,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  icon?: ReactNode
  busy?: boolean
  focusKey?: string
}) {
  const { t } = useLanguage()
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog?.showModal()
    return () => {
      dialog?.close()
      if (opener?.isConnected && !dialog?.contains(opener)) opener.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-initial-focus]')?.focus({ preventScroll: true })
  }, [focusKey])
  return (
    <dialog
      className="pf-dialog"
      ref={ref}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      aria-label={title}
      aria-busy={busy || undefined}
    >
      <header className="pf-dialog-head">
        <div className="pf-dialog-title">
          {icon}
          <h2>{title}</h2>
        </div>
        <button
          className="pf-icon-button"
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label={t('Close ' + title, '关闭“' + title + '”')}
        >
          <X size={19} />
        </button>
      </header>
      {children}
    </dialog>
  )
}

function Field({
  label,
  value,
  onChange,
  required,
  numeric,
  unit,
  list,
  autoFocus,
}: {
  label: FieldName
  value: string
  onChange: (value: string) => void
  required?: boolean
  numeric?: boolean
  unit?: string
  list?: string
  autoFocus?: boolean
}) {
  const { t } = useLanguage()
  const input = useRef<HTMLInputElement>(null)
  const translatedLabel = fieldLabel(label)
  const requiredMessage = t('Please fill in this field.', '请填写此字段。')
  useEffect(() => {
    input.current?.setCustomValidity(required && !value ? requiredMessage : '')
  }, [required, value, requiredMessage])
  return (
    <label className="pf-field">
      <span>{translatedLabel}</span>
      <span className="pf-input-wrap">
        <input
          ref={input}
          type="text"
          value={value}
          required={required}
          onChange={(event) => onChange(event.target.value)}
          inputMode={numeric ? 'decimal' : 'text'}
          className={numeric ? 'pf-number' : ''}
          list={list}
          data-initial-focus={autoFocus || undefined}
          aria-label={translatedLabel}
          aria-description={unit ? t('Unit: ' + unit, '单位：' + unit) : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        {unit && <small>{unit}</small>}
      </span>
    </label>
  )
}

const accountTypes = [
  { kind: 'spot', Icon: Layers3 },
  { kind: 'cashSpot', Icon: Wallet },
  { kind: 'perp', Icon: ArrowDownUp },
  { kind: 'loan', Icon: CircleDollarSign },
] as const

const toPercent = (value: string) => new Decimal(value).mul(100).toFixed()
function amount(value: string, field: FieldName, positive = false) {
  value = value.trim()
  if (!isDecimalAmount(value, positive)) {
    throw new Error(
      field + (positive ? ' must be greater than zero.' : ' must be a non-negative decimal.'),
    )
  }
  return value
}

function parseDebt(value: string) {
  const magnitude = value.trim().replace(/^[-−]/, '')
  if (magnitude.includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(magnitude)) return ''
  const digits = magnitude.replaceAll(',', '')
  return isDecimalAmount(digits) ? digits : ''
}

function displayDebt(value: string, locale: string) {
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole || '0').toLocaleString(locale) + '.' + fraction.padEnd(2, '0')
}
function symbol(value: string) {
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z0-9]{1,30}$/.test(normalized))
    throw new Error('Enter a Bitget asset symbol for each holding or position.')
  return normalized
}
function ratio(value: string, label: FieldName, positive = false) {
  return new Decimal(amount(value, label, positive)).div(100).toFixed()
}

interface EditorProps {
  account?: Account
  revision: number
  onClose: () => void
  onSaved: (state: PortfolioState) => void
}

export default function AccountEditor({ account, revision, onClose, onSaved }: EditorProps) {
  const { t, locale } = useLanguage()
  const [openedAt] = useState(revision)
  const [id] = useState(() => account?.id ?? crypto.randomUUID())
  const [kind, setKind] = useState<Account['kind']>(account?.kind ?? 'spot')
  const [name, setName] = useState(account?.name ?? '')
  const [holdings, setHoldings] = useState(
    account && 'holdings' in account && account.holdings.length
      ? account.holdings
      : [{ asset: '', quantity: '' }],
  )
  const [debt, setDebt] = useState(account && 'debt' in account ? account.debt : '')
  const parsedDebt = parseDebt(debt)
  const [asset, setAsset] = useState(account && 'asset' in account ? account.asset : '')
  const [increment, setIncrement] = useState(
    (account && 'increment' in account ? account.increment : undefined) ?? '0.01',
  )
  const [collateral, setCollateral] = useState(account?.kind === 'loan' ? account.collateral : '')
  const [warning, setWarning] = useState(account?.kind === 'loan' ? toPercent(account.warningLtv) : '85')
  const [liquidation, setLiquidation] = useState(
    account?.kind === 'loan' ? toPercent(account.liquidationLtv) : '91',
  )
  const perp = account?.kind === 'perp' ? account : undefined
  const [side, setSide] = useState<PerpAccount['side']>(perp?.side ?? 'long')
  const [size, setSize] = useState(perp?.size ?? '')
  const [entry, setEntry] = useState(perp?.entry ?? '')
  const [margin, setMargin] = useState(perp?.margin ?? '')
  const [rate, setRate] = useState(perp ? toPercent(perp.maintenanceRate) : '')
  const [fee, setFee] = useState(perp ? toPercent(perp.takerFee) : '')
  const [offset, setOffset] = useState(perp?.maintenanceOffset ?? '0')
  const [tiers, setTiers] = useState<PerpAccount['tiers']>(perp?.tiers)
  const [lookup, setLookup] = useState(false)
  const [termsMessage, setTermsMessage] = useState<'loaded' | FormIssue | null>(null)
  const requestId = useRef(0)
  const [error, setError] = useState<FormIssue | null>(null)
  const [saving, setSaving] = useState(false)

  const changeAsset = (value: string) => {
    requestId.current += 1
    setAsset(value.toUpperCase())
    setTiers(undefined)
    setRate('')
    setFee('')
    setOffset('0')
    setTermsMessage(null)
    setLookup(false)
  }
  const lookupTerms = async () => {
    const request = ++requestId.current
    setLookup(true)
    setTermsMessage(null)
    try {
      const terms = await fetchContractTerms(symbol(asset))
      if (request !== requestId.current) return
      if (!terms.tiers.length) throw new Error('Bitget returned no maintenance tiers for this symbol.')
      setTiers(terms.tiers)
      setRate(toPercent(terms.tiers[0].rate))
      setOffset('0')
      setFee(toPercent(terms.takerFee))
      setTermsMessage('loaded')
    } catch (error) {
      if (request === requestId.current) setTermsMessage({ error, fallback: 'Lookup failed.' })
    } finally {
      if (request === requestId.current) setLookup(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setSaving(true)
    try {
      const common = {
        id,
        name: name.trim(),
        updatedAt: new Date().toISOString(),
        archived: account?.archived ?? false,
        ...(kind === 'cashSpot' ? {} : { increment: amount(increment, 'USDT action increment', true) }),
      }
      if (!common.name) throw new Error('Give this account a name.')
      const recordedDebt = kind === 'spot' && !debt.trim() ? '0' : parsedDebt
      if ((kind === 'spot' || kind === 'loan') && !recordedDebt) {
        throw new Error('Enter a debt amount such as 1500 or -1,500.00.')
      }
      let record: Account
      if (kind === 'spot' || kind === 'cashSpot') {
        const entries = holdings
          .filter((h) => h.asset.trim() || h.quantity.trim())
          .map((h) => ({
            asset: symbol(h.asset),
            quantity: amount(h.quantity, 'Holding quantity'),
          }))
        record =
          kind === 'cashSpot'
            ? { ...common, kind, holdings: entries }
            : { ...common, kind, holdings: entries, debt: recordedDebt }
      } else if (kind === 'loan') {
        const warningLtv = ratio(warning, 'Warning LTV', true)
        const liquidationLtv = ratio(liquidation, 'Liquidation LTV', true)
        if (new Decimal(warningLtv).gte(liquidationLtv) || new Decimal(liquidationLtv).gt(1)) {
          throw new Error('Warning LTV must be below liquidation LTV, and neither can exceed 100%.')
        }
        record = {
          ...common,
          kind,
          asset: symbol(asset),
          collateral: amount(collateral, 'Pledged quantity', true),
          debt: recordedDebt,
          warningLtv,
          liquidationLtv,
        }
      } else {
        record = {
          ...common,
          kind,
          side,
          asset: symbol(asset),
          size: amount(size, 'Position size', true),
          margin: amount(margin, 'Allocated margin'),
          entry: amount(entry, 'Entry price', true),
          maintenanceRate: ratio(rate, 'Maintenance rate', true),
          takerFee: ratio(fee, 'Taker fee'),
          maintenanceOffset: amount(offset, 'Maintenance offset'),
          ...(tiers ? { tiers } : {}),
        }
      }
      const state = await saveAccount(record, openedAt)
      onSaved(state)
      onClose()
    } catch (e) {
      setError({ error: e, fallback: 'Could not save this account.' })
    } finally {
      setSaving(false)
    }
  }

  const archive = async () => {
    if (!account) return
    setSaving(true)
    try {
      onSaved(await saveAccount({ ...account, archived: true }, openedAt))
      onClose()
    } catch (e) {
      setError({ error: e, fallback: 'Could not archive this account.' })
    } finally {
      setSaving(false)
    }
  }

  const formattedDebt = parsedDebt && displayDebt(parsedDebt, locale)
  const debtField = (
    <>
      <Field
        label={kind === 'loan' ? 'Outstanding loan debt' : 'Outstanding debt'}
        unit="USDT"
        numeric
        required={kind === 'loan'}
        value={debt}
        onChange={(value) => {
          setDebt(value)
          setError(null)
        }}
      />
      <p className="pf-hint" role="status">
        {formattedDebt
          ? t('Recorded as ' + formattedDebt + ' USDT owed', '将记为欠款 ' + formattedDebt + ' USDT')
          : t('Include accrued interest in the debt balance.', '债务余额应包含应计利息。')}
      </p>
    </>
  )

  return (
    <PortfolioDialog
      title={account ? t('Edit account', '编辑账户') : t('Add account', '添加账户')}
      onClose={onClose}
      busy={saving}
      icon={<Wallet size={20} />}
    >
      <form onSubmit={submit}>
        <div className="pf-content">
          {!account && (
            <fieldset className="pf-fieldset">
              <legend>{t('Account type', '账户类型')}</legend>
              <div className="pf-type-options">
                {accountTypes.map(({ kind: type, Icon }) => (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={kind === type}
                    className={'pf-type' + (kind === type ? ' selected' : '')}
                    onClick={() => {
                      setKind(type)
                      setError(null)
                    }}
                  >
                    <Icon size={17} />
                    {accountTypeName(type)}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          {account && <p className="pf-type-label">{accountTypeName(kind)} · Bitget</p>}
          <Field label="Account name" value={name} onChange={setName} required autoFocus />
          <datalist id="pf-asset-list">
            {[...popularSymbols, 'USDT'].map((asset) => (
              <option key={asset} value={asset} label={assetName(asset)} />
            ))}
          </datalist>
          {kind === 'spot' || kind === 'cashSpot' ? (
            <>
              <fieldset className="pf-fieldset pf-section">
                <legend>{t('Holdings', '持仓')}</legend>
                {holdings.map((row, i) => (
                  <div
                    className="pf-holding"
                    key={i}
                    role="group"
                    aria-label={t('Holding ' + (i + 1), '持仓 ' + (i + 1))}
                  >
                    <Field
                      label="Asset"
                      value={row.asset}
                      list="pf-asset-list"
                      onChange={(value) =>
                        setHoldings(
                          holdings.map((h, j) => (i === j ? { ...h, asset: value.toUpperCase() } : h)),
                        )
                      }
                    />
                    <Field
                      label="Quantity"
                      value={row.quantity}
                      numeric
                      onChange={(value) =>
                        setHoldings(holdings.map((h, j) => (i === j ? { ...h, quantity: value } : h)))
                      }
                    />
                    <button
                      type="button"
                      className="pf-icon-button pf-remove"
                      aria-label={t('Remove holding ' + (i + 1), '移除持仓 ' + (i + 1))}
                      onClick={() => setHoldings(holdings.filter((_, j) => i !== j))}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="pf-link-button"
                  onClick={() => setHoldings([...holdings, { asset: '', quantity: '' }])}
                >
                  <Plus size={15} />
                  {t('Add holding', '添加持仓')}
                </button>
              </fieldset>
              {kind === 'cashSpot' ? (
                <p className="pf-hint">
                  {t(
                    'Enter each free, unpledged balance once. Record margin and pledged collateral in their respective accounts.',
                    '仅录入本钱包可用、未质押的余额，每项余额只计一次。保证金和已质押资产分别记在对应账户中。',
                  )}
                </p>
              ) : (
                debtField
              )}
            </>
          ) : (
            <>
              <div className="pf-grid">
                <Field
                  label={kind === 'loan' ? 'Collateral asset' : 'Contract asset'}
                  value={asset}
                  onChange={changeAsset}
                  list="pf-asset-list"
                  required
                />
                {kind === 'perp' ? (
                  <label className="pf-field">
                    <span>{t('Direction', '持仓方向')}</span>
                    <select
                      value={side}
                      onChange={(e) => setSide(e.target.value as PerpAccount['side'])}
                    >
                      <option value="long">{t('Long', '做多')}</option>
                      <option value="short">{t('Short', '做空')}</option>
                    </select>
                  </label>
                ) : (
                  <Field
                    label="Pledged quantity"
                    numeric
                    value={collateral}
                    onChange={setCollateral}
                    required
                  />
                )}
              </div>
              {kind === 'loan' ? (
                <>
                  {debtField}
                  <div className="pf-grid">
                    <Field
                      label="Warning LTV"
                      unit="%"
                      value={warning}
                      onChange={setWarning}
                      numeric
                      required
                    />
                    <Field
                      label="Liquidation LTV"
                      unit="%"
                      value={liquidation}
                      onChange={setLiquidation}
                      numeric
                      required
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="pf-grid">
                    <Field
                      label="Position size"
                      unit={asset}
                      value={size}
                      numeric
                      onChange={setSize}
                      required
                    />
                    <Field
                      label="Entry price"
                      unit="USDT"
                      value={entry}
                      numeric
                      onChange={setEntry}
                      required
                    />
                  </div>
                  <Field
                    label="Allocated isolated margin"
                    unit="USDT"
                    value={margin}
                    numeric
                    onChange={setMargin}
                    required
                  />
                  <fieldset className="pf-fieldset pf-section">
                    <legend>{t('Contract terms', '合约参数')}</legend>
                    <button
                      type="button"
                      className="pf-button"
                      disabled={!asset.trim() || lookup}
                      onClick={lookupTerms}
                    >
                      {lookup
                        ? t('Loading terms…', '正在获取合约参数…')
                        : t('Load Bitget terms', '获取 Bitget 合约参数')}
                    </button>
                    {termsMessage && (
                      <p className="pf-hint" role="status">
                        {termsMessage === 'loaded'
                          ? t(
                              'Loaded Bitget maintenance tiers and public taker fee.',
                              '已获取 Bitget 维持保证金档位和公开吃单费率。',
                            )
                          : formError(termsMessage.error, termsMessage.fallback) +
                            t(
                              ' Enter the terms from your Bitget position.',
                              '请手动填写 Bitget 仓位显示的参数。',
                            )}
                      </p>
                    )}
                    {tiers ? (
                      <div className="pf-tier-info">
                        <span>
                          {t(
                            tiers.length + ' maintenance tiers',
                            tiers.length.toLocaleString(locale) + ' 个维持保证金档位',
                          )}{' '}
                          · {asset}/USDT
                        </span>
                        <button
                          type="button"
                          className="pf-link-button"
                          onClick={() => {
                            setTiers(undefined)
                            setRate('')
                            setOffset('0')
                            setTermsMessage(null)
                          }}
                        >
                          {t('Enter manually', '手动输入')}
                        </button>
                      </div>
                    ) : (
                      <div className="pf-grid">
                        <Field
                          label="Maintenance rate"
                          unit="%"
                          value={rate}
                          onChange={setRate}
                          numeric
                          required
                        />
                        <Field
                          label="Maintenance offset"
                          unit="USDT"
                          value={offset}
                          onChange={setOffset}
                          numeric
                          required
                        />
                      </div>
                    )}
                    <Field
                      label="Closing taker fee"
                      unit="%"
                      value={fee}
                      numeric
                      onChange={setFee}
                      required
                    />
                    <p className="pf-hint">
                      {t(
                        'Use the maintenance tier and closing fee that apply to this position.',
                        '请使用此仓位适用的维持保证金档位和平仓费率。',
                      )}
                    </p>
                  </fieldset>
                </>
              )}
            </>
          )}
          {kind !== 'cashSpot' && (
            <details className="pf-details">
              <summary>{t('Planner settings', '规划设置')}</summary>
              <Field
                label="USDT action increment"
                unit="USDT"
                value={increment}
                numeric
                onChange={setIncrement}
              />
            </details>
          )}
          {error && (
            <p className="pf-error" role="alert">
              {formError(error.error, error.fallback)}
            </p>
          )}
        </div>
        <footer className="pf-footer">
          {account && (
            <button
              className="pf-link-button pf-archive"
              type="button"
              onClick={archive}
              disabled={saving}
            >
              <Archive size={16} />
              {t('Archive', '归档')}
            </button>
          )}
          <button className="pf-button" type="button" onClick={onClose} disabled={saving}>
            {t('Cancel', '取消')}
          </button>
          <button
            className="pf-button pf-primary"
            type="submit"
            disabled={saving || (kind === 'perp' && lookup)}
          >
            {saving ? t('Saving…', '正在保存…') : t('Save account', '保存账户')}
          </button>
        </footer>
      </form>
    </PortfolioDialog>
  )
}
