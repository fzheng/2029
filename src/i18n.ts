import { useSyncExternalStore } from 'react'

export type Language = 'en' | 'zh-CN'
const preferenceKey = '2029.language'
const localeByLanguage = { en: 'en-US', 'zh-CN': 'zh-CN' } as const

function savedLanguage(): Language {
  try {
    return window.localStorage.getItem(preferenceKey) === 'zh-CN' ? 'zh-CN' : 'en'
  } catch {
    return 'en'
  }
}

let language = savedLanguage()
const listeners = new Set<() => void>()
const getLanguage = () => language
export const currentLocale = () => localeByLanguage[language]
export const translate = (english: string, chinese: string) => (language === 'en' ? english : chinese)

function updateDocument() {
  if (typeof document === 'undefined') return
  document.documentElement.lang = language
  document.title = translate('2029 · Bitget portfolio', '2029 · Bitget 投资组合')
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute(
      'content',
      translate(
        'Your local Bitget portfolio, market prices, liquidation estimates and cash plans.',
        '在本设备查看 Bitget 投资组合、市场行情、预估强平价与资金规划。',
      ),
    )
}

function applyLanguage(next: Language) {
  if (next === language) return
  language = next
  updateDocument()
  for (const notify of listeners) notify()
}

export function setLanguage(next: Language) {
  try {
    window.localStorage.setItem(preferenceKey, next)
  } catch {
    // Private or restricted storage still permits switching for this session.
  }
  applyLanguage(next)
}

function syncTabs(event: StorageEvent) {
  if (event.key === preferenceKey || event.key === null) applyLanguage(savedLanguage())
}

function subscribe(notify: () => void) {
  if (listeners.size === 0) window.addEventListener('storage', syncTabs)
  listeners.add(notify)
  return () => {
    listeners.delete(notify)
    if (listeners.size === 0) window.removeEventListener('storage', syncTabs)
  }
}

updateDocument()

export function useLanguage() {
  const active = useSyncExternalStore(subscribe, getLanguage)
  return { language: active, locale: localeByLanguage[active], t: translate, setLanguage }
}
