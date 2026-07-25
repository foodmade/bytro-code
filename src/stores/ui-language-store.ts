import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { load } from '@tauri-apps/plugin-store'
import i18n from '../i18n/config'
import type { SupportedLanguage } from '../i18n/config'

interface UiLanguageStore {
  readonly uiLanguage: SupportedLanguage
  readonly setUiLanguage: (lang: SupportedLanguage) => Promise<void>
}

let storeInstance: Awaited<ReturnType<typeof load>> | null = null

async function getStore() {
  if (!storeInstance) {
    storeInstance = await load('.settings.dat', { defaults: {}, autoSave: false })
  }
  return storeInstance
}

export const useUiLanguageStore = create<UiLanguageStore>()(
  persist(
    (set) => ({
      uiLanguage: 'zh',
      setUiLanguage: async (lang: SupportedLanguage) => {
        await i18n.changeLanguage(lang)
        set({ uiLanguage: lang })
        const store = await getStore()
        await store.set('uiLanguage', lang)
        await store.save()
      },
    }),
    {
      name: 'ui-language-storage',
      version: 1,
    }
  )
)

// 初始化时从持久化存储加载语言设置
export async function initUiLanguage() {
  try {
    const store = await getStore()
    const savedLang = await store.get<SupportedLanguage>('uiLanguage')
    if (savedLang && (savedLang === 'en' || savedLang === 'zh')) {
      await i18n.changeLanguage(savedLang)
      useUiLanguageStore.setState({ uiLanguage: savedLang })
    }
  } catch (err) {
    console.error('Failed to load UI language:', err)
  }
}
