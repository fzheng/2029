import assert from 'node:assert/strict'
import test from 'node:test'
import { formError } from '../src/formMessages'
import { setLanguage } from '../src/i18n'

test('account validation tells the user which field and decimal limit to correct in either language', (t) => {
  t.after(() => setLanguage('en'))
  for (const [message, chinese] of [
    ['Entry price must be greater than zero.', '开仓均价必须大于零。'],
    ['Allocated margin must be a non-negative decimal.', '已分配保证金必须为非负数。'],
    ['Enter a debt amount such as 1500 or -1,500.00.', '请输入有效的欠款金额，例如 1500 或 -1,500.00。'],
  ]) {
    const error = new Error(message)
    setLanguage('en')
    assert.equal(formError(error), message)
    setLanguage('zh-CN')
    assert.equal(formError(error), chinese)
  }
})

test('storage and Bitget failures explain the recovery problem and use the operation fallback for unknown errors', (t) => {
  t.after(() => setLanguage('en'))
  setLanguage('zh-CN')
  assert.equal(formError(new DOMException('quota reached', 'QuotaExceededError')), '浏览器存储空间已满。')
  assert.equal(formError(new DOMException('access denied', 'SecurityError')), '浏览器存储不可用。')
  assert.equal(formError(new DOMException('fetch aborted', 'TimeoutError')), '请求超时。')
  assert.equal(formError('Error: Bitget returned HTTP 503'), 'Bitget 返回 HTTP 状态码 503。')
  assert.equal(formError(undefined, 'Could not read this backup.'), '无法读取此备份。')
})
