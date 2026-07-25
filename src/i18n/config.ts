import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import zh from './locales/zh.json'

export const SUPPORTED_LANGUAGES = {
  en: 'English',
  zh: '中文',
} as const

export type SupportedLanguage = keyof typeof SUPPORTED_LANGUAGES

const resources = {
  en: { translation: en },
  zh: { translation: zh },
}

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: 'zh', // 默认语言
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false, // React 已经处理了 XSS
    },
    react: {
      useSuspense: false, // 避免 Suspense 边界问题
    },
  })
  .catch((err) => {
    console.error('i18n initialization failed:', err)
  })

export default i18n
