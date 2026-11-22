import { translate } from './i18n'

const fieldNames = {
  'Account name': '账户名称',
  Asset: '币种',
  Quantity: '数量',
  'Holding quantity': '持仓数量',
  'Outstanding debt': '未偿还债务',
  'USDT debt': 'USDT 债务',
  'Collateral asset': '质押币种',
  'Contract asset': '合约标的',
  'Pledged quantity': '质押数量',
  'Outstanding loan debt': '借款待还金额',
  'Loan debt': '借款待还金额',
  'Warning LTV': '预警质押率（LTV）',
  'Liquidation LTV': '强平质押率（LTV）',
  'Position size': '持仓数量',
  'Entry price': '开仓均价',
  'Allocated isolated margin': '已分配逐仓保证金',
  'Allocated margin': '已分配保证金',
  'Maintenance rate': '维持保证金率',
  'Maintenance offset': '维持保证金速算扣除额',
  'Closing taker fee': '平仓吃单费率',
  'Taker fee': '吃单费率',
  'USDT action increment': '操作金额步长',
} as const

export type FieldName = keyof typeof fieldNames
export const fieldLabel = (name: FieldName) => translate(name, fieldNames[name])

const messages = {
  'Give this account a name.': '请输入账户名称。',
  'Enter a Bitget asset symbol for each holding or position.':
    '请为每项持仓输入有效的 Bitget 币种代码。',
  'Warning LTV must be below liquidation LTV, and neither can exceed 100%.':
    '预警质押率必须低于强平质押率，两者均不能超过 100%。',
  'Could not save this account.': '无法保存此账户。',
  'Could not archive this account.': '无法归档此账户。',
  'Could not export the backup.': '无法导出备份。',
  'Could not read this backup.': '无法读取此备份。',
  'Could not restore the account.': '无法恢复此账户。',
  'Could not update your portfolio.': '无法更新投资组合。',
  'Portfolio records could not be read.': '无法读取投资组合记录。',
  'Could not read the portfolio.': '无法读取投资组合。',
  'Your portfolio changed in another view. Close this dialog and reopen the latest record.':
    '投资组合已在其他页面更新。请关闭此窗口，再打开最新记录。',
  'Check the account values before saving.': '请检查账户数据后再保存。',
  'Remove the pending orders for this account before changing its contract or account type.':
    '请先移除此账户中的挂单，再修改合约标的或账户类型。',
  'Check the pending order values and account before saving.': '请检查挂单参数和所属账户后再保存。',
  'Enter a name and valid inputs before saving.': '请输入名称和有效数值后再保存。',
  'Choose a 2029 version 1 JSON backup.': '请选择 2029 第 1 版格式的 JSON 备份文件。',
  'The backup contains invalid or duplicate records. Your portfolio is unchanged.':
    '备份中有无效或重复的记录，未导入任何数据。',
  'The selected file does not contain valid JSON.': '所选文件不是有效的 JSON 文件。',
  'The change could not be saved.': '无法保存更改。',
  'Lookup failed.': '无法获取合约参数。',
  'Choose a Bitget perpetual symbol.': '请选择 Bitget 永续合约标的。',
  'Bitget data unavailable': '暂时无法获取 Bitget 数据',
  'Bitget contract settings unavailable.': '暂时无法获取 Bitget 合约参数。',
  'Incomplete Bitget tier schedule.': 'Bitget 返回的保证金档位不完整。',
  'Bitget returned no maintenance tiers for this symbol.': 'Bitget 未返回该合约的维持保证金档位。',
  'Browser storage is full.': '浏览器存储空间已满。',
  'Browser storage is unavailable.': '浏览器存储不可用。',
  'The request timed out.': '请求超时。',
} as const
type FormMessage = keyof typeof messages

export interface FormIssue {
  error: unknown
  fallback: FormMessage
}

const domErrors: Record<string, FormMessage> = {
  QuotaExceededError: 'Browser storage is full.',
  SecurityError: 'Browser storage is unavailable.',
  VersionError: 'Browser storage is unavailable.',
  TimeoutError: 'The request timed out.',
}

/** Convert domain errors only for display. The state and the backup format stay language-neutral. */
export function formError(error: unknown, fallback: FormMessage = 'The change could not be saved.') {
  const raw = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  const key = raw.replace(/^Error:\s*/, '')
  if (Object.hasOwn(messages, key)) return translate(key, messages[key as FormMessage])
  if (error instanceof Error && Object.hasOwn(domErrors, error.name)) {
    const detail = domErrors[error.name]
    return translate(detail, messages[detail])
  }

  // Decimal validation names the specific account field that needs attention.
  const numeric = /^(.+) must be (greater than zero|a non-negative decimal)\.$/.exec(key)
  if (numeric && Object.hasOwn(fieldNames, numeric[1])) {
    const name = fieldNames[numeric[1] as FieldName]
    return translate(
      key,
      name + (numeric[2] === 'greater than zero' ? '必须大于零。' : '必须为非负数。'),
    )
  }
  const http = /^Bitget returned HTTP (\d{3})$/.exec(key)
  if (http) return translate(key, 'Bitget 返回 HTTP 状态码 ' + http[1] + '。')
  return translate(fallback, messages[fallback])
}
