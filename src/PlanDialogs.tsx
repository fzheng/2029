import { useRef, useState } from 'react'
import { Save, Trash2 } from 'lucide-react'
import { formError } from './formMessages'
import { useLanguage } from './i18n'
import type { PlanInput } from './model'
import { Dialog, pathName, triggerPrice } from './shared'
import { deletePlan, planNameKey, savePlan, type PortfolioState, type SavedItem } from './storage'

function planSummary(plan: SavedItem) {
  const { target, path } = plan.data as PlanInput
  return 'BTC ' + triggerPrice(Number(target)) + ' USDT · ' + pathName(path)
}

export function planOptionLabel(plan: SavedItem, index: number) {
  return plan.name + ' · ' + planSummary(plan) + ' · #' + (index + 1)
}

function usePlanWrite() {
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function write(action: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  return { busy, error, write, clearError: () => setError(null) }
}

export function PlanSaveDialog({
  plans, source, data, revision, onSaved, onClose,
}: {
  plans: SavedItem[]
  source: SavedItem | null
  data: PlanInput
  revision: number
  onSaved: (state: PortfolioState, id: string) => void
  onClose: () => void
}) {
  const { t } = useLanguage()
  // A cross-tab refresh must not change the plan or revision being confirmed.
  const [draft] = useState(() => ({
    plans, source, data, revision, id: source?.id ?? crypto.randomUUID(),
  }))
  const [name, setName] = useState(draft.source?.name ?? '')
  const [overwriteId, setOverwriteId] = useState<string | null>(null)
  const { busy, error, write, clearError } = usePlanWrite()
  const nameKey = planNameKey(name)
  const matches = draft.plans.filter((plan) => planNameKey(plan.name) === nameKey)
  const target = matches.find((p) => p.id === overwriteId)
  const confirming = overwriteId !== null
  const sourceIndex = matches.findIndex((plan) => plan.id === draft.source?.id)
  const sourceLabel = sourceIndex >= 0 && matches.length > 1
    ? planOptionLabel(matches[sourceIndex], sourceIndex)
    : draft.source?.name

  function cancel() {
    if (busy) return
    if (confirming) {
      setOverwriteId(null)
      clearError()
    } else {
      onClose()
    }
  }

  function save() {
    if (busy || !nameKey) return
    if (!confirming && matches.length) {
      const preferred = matches.find((p) => p.id === draft.source?.id)
      setOverwriteId(preferred?.id ?? (matches.length === 1 ? matches[0].id : ''))
      return
    }
    if (confirming && !target) return
    void write(async () => {
      const item = { id: draft.id, name: name.trim(), data: draft.data }
      const state = await savePlan(item, draft.revision, { overwriteId: target?.id })
      onSaved(state, target?.id ?? item.id)
      onClose()
    })
  }

  const title = confirming
    ? t('Overwrite saved plan?', '覆盖已存方案？')
    : draft.source
      ? t('Edit saved plan', '编辑已存方案')
      : t('Save target plan', '保存目标方案')
  return (
    <Dialog key={confirming ? 'confirm' : 'name'} title={title} onClose={cancel}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        {confirming ? (
          <>
            {matches.length > 1 && (
              <label className="field">
                {t('Plan to overwrite', '要覆盖的方案')}
                <select
                  value={overwriteId}
                  onChange={(e) => setOverwriteId(e.target.value)}
                  disabled={busy}
                >
                  <option value="" disabled>{t('Choose a saved plan', '选择一个已存方案')}</option>
                  {matches.map((plan, index) => (
                    <option key={plan.id} value={plan.id}>
                      {planOptionLabel(plan, index)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {target && (
              <>
                <p>
                  {t(
                    `Replace the saved settings for “${target.name}” with this draft?`,
                    `用当前方案的设置覆盖「${target.name}」吗？`,
                  )}
                </p>
                <p className="small-text">{planSummary(target)}</p>
                {draft.source && draft.source.id !== target.id && (
                  <p>
                    {t(
                      `The original entry “${sourceLabel}” will also be removed.`,
                      `原方案「${sourceLabel}」也将从列表中移除。`,
                    )}
                  </p>
                )}
              </>
            )}
          </>
        ) : (
          <label className="field">
            {t('Name', '名称')}
            <input
              autoFocus
              required
              maxLength={100}
              value={name}
              disabled={busy}
              onChange={(e) => {
                setName(e.target.value)
                clearError()
              }}
            />
          </label>
        )}
        {error != null && <p role="alert" className="alert-text">{formError(error)}</p>}
        <div className="dialog-actions">
          <button type="button" autoFocus={confirming} className="btn" onClick={cancel} disabled={busy}>
            {t('Cancel', '取消')}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !nameKey || (confirming && !target)}>
            <Save size={15} />
            {confirming ? t('Overwrite', '确认覆盖') : t('Save', '保存')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function PlanDeleteDialog({
  plan, revision, onDeleted, onClose,
}: {
  plan: SavedItem
  revision: number
  onDeleted: (state: PortfolioState) => void
  onClose: () => void
}) {
  const { t } = useLanguage()
  const [selection] = useState(() => ({ plan, revision }))
  const { busy, error, write } = usePlanWrite()
  function remove() {
    void write(async () => {
      const state = await deletePlan(selection.plan.id, selection.revision)
      onDeleted(state)
      onClose()
    })
  }
  function cancel() {
    if (!busy) onClose()
  }
  return (
    <Dialog title={t('Delete saved plan?', '删除已存方案？')} onClose={cancel}>
      <p>
        {t(
          `Delete “${selection.plan.name}” from your saved plans?`,
          `从已保存的防强平方案中删除「${selection.plan.name}」吗？`,
        )}
      </p>
      <p className="small-text">{planSummary(selection.plan)}</p>
      {error != null && <p role="alert" className="alert-text">{formError(error)}</p>}
      <div className="dialog-actions">
        <button type="button" autoFocus className="btn" onClick={cancel} disabled={busy}>
          {t('Cancel', '取消')}
        </button>
        <button type="button" className="btn pf-danger" disabled={busy} onClick={remove}>
          <Trash2 size={15} /> {t('Delete', '确认删除')}
        </button>
      </div>
    </Dialog>
  )
}
