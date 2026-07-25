import type { Plugin } from 'vite'

/**
 * Bytro Safe CSS Plugin
 *
 * Intelligently handles CSS @apply errors during AI-driven development.
 *
 * Problem: AI writes CSS with `@apply from-custom-color` BEFORE updating
 * tailwind.config.js. Vite HMR compiles CSS immediately, Tailwind can't
 * resolve the class, and the error overlay blocks the preview.
 *
 * Strategy (Deferred Error Display):
 * 1. When an @apply "class does not exist" error occurs, suppress the overlay
 *    and start a grace-period timer.
 * 2. If ANY file in the project changes during the grace period, reset the
 *    timer — the AI is still actively writing code.
 * 3. If tailwind.config.* changes, additionally invalidate all CSS modules
 *    and trigger a full reload (CSS will recompile with the new config).
 * 4. If the grace period expires with NO file changes, show the error overlay
 *    — the code is genuinely broken, not just a timing issue.
 */
export function safeCssPlugin(): Plugin {
  return {
    name: 'bytro-safe-css',
    apply: 'serve',

    configureServer(server) {
      // Grace period: how long to wait after last file change before showing error
      const GRACE_PERIOD_MS = 8_000

      let suppressedError: any = null
      let graceTimer: ReturnType<typeof setTimeout> | null = null

      const originalSend = server.ws.send.bind(server.ws)

      // ── 1. Intercept error overlay for @apply class errors ──
      server.ws.send = function (payload: any, ...rest: any[]) {
        if (isCssClassError(payload)) {
          const firstLine = payload.err.message.split('\n')[0]
          console.log(
            '\x1b[33m[safe-css]\x1b[0m Deferred @apply error:',
            firstLine,
          )

          suppressedError = payload
          resetGraceTimer()
          return
        }

        // If Vite sends a successful update for CSS, clear any pending error
        if (
          suppressedError &&
          payload?.type === 'update' &&
          payload?.updates?.some((u: any) =>
            /\.(css|scss|less|pcss|postcss)/i.test(u?.path ?? ''),
          )
        ) {
          clearPendingError()
        }

        return originalSend(payload, ...rest)
      } as typeof server.ws.send

      // ── 2. Watch file changes ──
      const tailwindConfigNames = new Set([
        'tailwind.config.js',
        'tailwind.config.ts',
        'tailwind.config.cjs',
        'tailwind.config.mjs',
      ])

      server.watcher.on('change', (filePath: string) => {
        const normalized = filePath.replace(/\\/g, '/')
        const fileName = normalized.split('/').pop() ?? ''

        // Any file change during grace period → reset timer (AI still writing)
        if (suppressedError) {
          resetGraceTimer()
        }

        // Tailwind config change → recompile CSS + full reload
        if (tailwindConfigNames.has(fileName)) {
          console.log(
            '\x1b[36m[safe-css]\x1b[0m Tailwind config changed — reloading CSS…',
          )

          clearPendingError()

          for (const mod of server.moduleGraph.idToModuleMap.values()) {
            if (
              mod.file &&
              /\.(css|scss|less|pcss|postcss)$/i.test(mod.file)
            ) {
              server.moduleGraph.invalidateModule(mod)
            }
          }

          setTimeout(() => {
            originalSend({ type: 'full-reload', path: '*' })
          }, 150)
        }
      })

      // Also reset timer on new file creation (AI adding files)
      server.watcher.on('add', () => {
        if (suppressedError) {
          resetGraceTimer()
        }
      })

      // ── Helpers ──
      function resetGraceTimer() {
        if (graceTimer) clearTimeout(graceTimer)
        graceTimer = setTimeout(() => {
          if (suppressedError) {
            console.log(
              '\x1b[31m[safe-css]\x1b[0m Grace period expired — showing error overlay',
            )
            originalSend(suppressedError)
            suppressedError = null
          }
          graceTimer = null
        }, GRACE_PERIOD_MS)
      }

      function clearPendingError() {
        suppressedError = null
        if (graceTimer) {
          clearTimeout(graceTimer)
          graceTimer = null
        }
      }
    },
  }
}

/**
 * Check whether a WebSocket payload is a CSS @apply "class does not exist" error.
 *
 * Matches: [plugin:vite:css] [postcss] …: The `xxx` class does not exist.
 */
function isCssClassError(payload: any): boolean {
  if (!payload || typeof payload !== 'object') return false
  if (payload.type !== 'error') return false

  const msg: string = payload.err?.message ?? ''
  return /class does not exist/i.test(msg) && /postcss/i.test(msg)
}
