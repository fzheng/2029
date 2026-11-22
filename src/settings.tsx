import { useRef, useState } from 'react'
import { ArchiveRestore, Download, FolderArchive, HardDrive, Trash2, Upload } from 'lucide-react'
import { PortfolioDialog } from './AccountEditor'
import {
  clearPortfolio,
  exportBackup,
  importBackup,
  loadPortfolio,
  parseBackup,
  saveAccount,
} from './storage'
import type { Backup, PortfolioState } from './storage'
import type { Account } from './model'
import { formError, type FormIssue } from './formMessages'
import { useLanguage } from './i18n'
import { accountTypeName } from './shared'
import './forms.css'

type Confirmation =
  | { action: 'clear'; revision: number }
  | { action: 'import'; revision: number; backup: Backup }

export default function Settings({
  state,
  onClose,
  onChange,
}: {
  state: PortfolioState
  onClose: () => void
  onChange: (state: PortfolioState) => void
}) {
  const { t, locale } = useLanguage()
  const input = useRef<HTMLInputElement>(null)
  const [confirm, setConfirm] = useState<Confirmation>()
  const [message, setMessage] = useState<FormIssue | null>(null)
  const [busy, setBusy] = useState(false)
  const archived = state.accounts.filter((account) => account.archived)

  const download = async () => {
    setMessage(null)
    try {
      const url = URL.createObjectURL(
        new Blob([exportBackup(await loadPortfolio())], { type: 'application/json' }),
      )
      const link = document.createElement('a')
      link.href = url
      link.download = '2029-portfolio-' + new Date().toISOString().slice(0, 10) + '.json'
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      setMessage({ error: e, fallback: 'Could not export the backup.' })
    }
  }
  const chooseFile = async (file?: File) => {
    if (!file) return
    setMessage(null)
    try {
      const backup = parseBackup(await file.text())
      setConfirm({ action: 'import', revision: state.revision, backup })
    } catch (e) {
      setMessage({ error: e, fallback: 'Could not read this backup.' })
    }
    if (input.current) input.current.value = ''
  }
  const restore = async (account: Account) => {
    setBusy(true)
    setMessage(null)
    try {
      onChange(await saveAccount({ ...account, archived: false }, state.revision))
    } catch (e) {
      setMessage({ error: e, fallback: 'Could not restore the account.' })
    } finally {
      setBusy(false)
    }
  }
  const accept = async () => {
    if (!confirm) return
    setBusy(true)
    setMessage(null)
    try {
      const next =
        confirm.action === 'clear'
          ? await clearPortfolio(confirm.revision)
          : await importBackup(confirm.backup, confirm.revision)
      onChange(next)
      onClose()
    } catch (e) {
      setMessage({ error: e, fallback: 'Could not update your portfolio.' })
    } finally {
      setBusy(false)
    }
  }

  if (confirm) {
    const goBack = () => {
      setConfirm(undefined)
      setMessage(null)
    }
    return (
      <PortfolioDialog
        title={
          confirm.action === 'clear'
            ? t('Clear all portfolio data?', '清除全部投资组合数据？')
            : t('Replace portfolio with backup?', '使用备份替换投资组合？')
        }
        focusKey={confirm.action}
        onClose={goBack}
        busy={busy}
      >
        <div className="pf-content">
          {confirm.action === 'clear' ? (
            <p className="pf-body-copy">
              {t(
                'This permanently removes all 2029 portfolio records on this device, including active and archived accounts, positions, loans, saved scenarios and target plans.',
                '此操作将永久删除本设备上的全部 2029 投资组合记录，包括使用中和已归档的账户、持仓、借款、已保存的模拟情景及目标计划。',
              )}
              {!!state.pendingOrders?.length &&
                ' ' + t('Saved pending orders will also be deleted.', '已保存的挂单也会一起删除。')}
            </p>
          ) : (
            <p className="pf-body-copy">
              {t(
                `Import ${confirm.backup.accounts.length.toLocaleString(locale)} account records, ${confirm.backup.scenarios.length.toLocaleString(locale)} saved scenarios and ${confirm.backup.plans.length.toLocaleString(locale)} target plans from this backup. These replace the existing portfolio on this device.`,
                `将从备份导入 ${confirm.backup.accounts.length.toLocaleString(locale)} 条账户记录、${confirm.backup.scenarios.length.toLocaleString(locale)} 个已保存的模拟情景和 ${confirm.backup.plans.length.toLocaleString(locale)} 个目标计划，替换本设备上现有的投资组合。`,
              )}
              {' ' +
                t(
                  `Pending orders in this backup: ${confirm.backup.pendingOrders?.length ?? 0}.`,
                  `此备份含 ${confirm.backup.pendingOrders?.length ?? 0} 笔挂单。`,
                )}
            </p>
          )}
          {message && (
            <p className="pf-error" role="alert">
              {formError(message.error, message.fallback)}
            </p>
          )}
        </div>
        <footer className="pf-footer">
          <button
            type="button"
            className="pf-button"
            data-initial-focus
            onClick={goBack}
            disabled={busy}
          >
            {t('Cancel', '取消')}
          </button>
          <button
            type="button"
            className={'pf-button ' + (confirm.action === 'clear' ? 'pf-danger' : 'pf-primary')}
            onClick={accept}
            disabled={busy}
          >
            {confirm.action === 'clear'
              ? t('Confirm clear all', '确认全部清除')
              : t('Import backup', '导入备份')}
          </button>
        </footer>
      </PortfolioDialog>
    )
  }
  return (
    <PortfolioDialog
      title={t('Portfolio settings', '投资组合设置')}
      onClose={onClose}
      icon={<HardDrive size={20} />}
    >
      <div className="pf-content pf-settings">
        <section>
          <h3>{t('Portfolio backup', '投资组合备份')}</h3>
          <p className="pf-body-copy">
            {t(
              'Export accounts, pending orders, saved scenarios and target plans as JSON, or restore a backup on this device.',
              '可将账户、挂单、已保存的情景和资金规划导出为 JSON 文件，也可以在本设备上恢复备份。',
            )}
          </p>
          <div className="pf-actions">
            <button type="button" className="pf-button" onClick={download}>
              <Download size={15} />
              {t('Export JSON', '导出 JSON')}
            </button>
            <button type="button" className="pf-button" onClick={() => input.current?.click()}>
              <Upload size={15} />
              {t('Import JSON', '导入 JSON')}
            </button>
          </div>
          <input
            ref={input}
            type="file"
            className="pf-file"
            accept=".json,application/json"
            aria-label={t('Select JSON backup', '选择 JSON 备份')}
            onChange={(e) => void chooseFile(e.target.files?.[0])}
          />
        </section>
        <section>
          <div className="pf-settings-heading">
            <h3>{t('Archived accounts', '已归档账户')}</h3>
            <span>{archived.length.toLocaleString(locale)}</span>
          </div>
          {archived.length ? (
            <ul className="pf-records">
              {archived.map((a) => (
                <li key={a.id}>
                  <div>
                    <strong>{a.name}</strong>
                    <span>{accountTypeName(a.kind)}</span>
                  </div>
                  <button
                    type="button"
                    className="pf-button"
                    disabled={busy}
                    onClick={() => restore(a)}
                    aria-label={t('Restore ' + a.name, '恢复“' + a.name + '”')}
                  >
                    <ArchiveRestore size={15} />
                    {t('Restore', '恢复')}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pf-muted-line">
              <FolderArchive size={16} />
              {t('No archived accounts', '暂无已归档账户')}
            </p>
          )}
        </section>
        <section>
          <h3>{t('Device storage', '设备存储')}</h3>
          <p className="pf-body-copy">
            {t(
              'Your records are saved in this browser. Clearing them affects every open 2029 tab on this device.',
              '记录保存在此浏览器中。清除后，本设备上所有已打开的 2029 标签页都会同步清空。',
            )}
          </p>
          <button
            type="button"
            className="pf-button pf-danger-outline"
            onClick={() => {
              setMessage(null)
              setConfirm({ action: 'clear', revision: state.revision })
            }}
          >
            <Trash2 size={15} />
            {t('Clear all portfolio data', '清除全部投资组合数据')}
          </button>
        </section>
        {message && (
          <p className="pf-error" role="alert">
            {formError(message.error, message.fallback)}
          </p>
        )}
      </div>
    </PortfolioDialog>
  )
}
