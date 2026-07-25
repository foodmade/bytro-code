import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useUiLanguageStore, SUPPORTED_LANGUAGES } from '@/i18n'
import type { SupportedLanguage } from '@/i18n'

export function UiLanguageSelector() {
  const { t } = useTranslation()
  const uiLanguage = useUiLanguageStore((s) => s.uiLanguage)
  const setUiLanguage = useUiLanguageStore((s) => s.setUiLanguage)

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const lang = e.target.value as SupportedLanguage
      setUiLanguage(lang)
    },
    [setUiLanguage]
  )

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="ui-language" className="text-sm font-medium text-foreground">
        {t('settings.general.uiLanguage')}
      </label>
      <select
        id="ui-language"
        value={uiLanguage}
        onChange={handleChange}
        className="w-full px-3 py-2 bg-background border border-border rounded-md text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
      >
        {Object.entries(SUPPORTED_LANGUAGES).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">
        {t('settings.general.uiLanguageDescription')}
      </p>
    </div>
  )
}
