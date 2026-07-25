import { useEffect, useCallback, useState, type RefObject } from "react"

export interface SelectedElement {
  outerHTML: string
  tagName: string
  id: string
  className: string
  textContent: string
  xpath: string
  computedStyles: Record<string, string>
  rect: { x: number; y: number; width: number; height: number }
}

function resolveTargetOrigin(src: string | null, baseUrl: string): string | null {
  if (!src) return null

  try {
    const origin = new URL(src, baseUrl).origin
    return origin === "null" ? null : origin
  } catch {
    return null
  }
}

/**
 * Hook for DOM inspector communication with the preview iframe.
 *
 * Sends toggle-inspector commands to the iframe via postMessage,
 * and listens for element-selected responses.
 */
export function useInspector(iframeRef: RefObject<HTMLIFrameElement | null>) {
  const [active, setActive] = useState(false)
  const [selected, setSelected] = useState<SelectedElement | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return

      // Validate origin — Tauri WebView2 may report different origins
      const origin = event.origin
      const isValid =
        origin === "null" ||
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1") ||
        origin === "https://tauri.localhost"

      if (!isValid) return
      if (!event.data || typeof event.data.type !== "string") return

      if (event.data.type === "element-selected") {
        setSelected(event.data.payload as SelectedElement)
        setActive(false)
      } else if (event.data.type === "inspector-ready") {
        setReady(true)
      }
    }

    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [iframeRef])

  const toggle = useCallback(() => {
    const next = !active
    setActive(next)
    const iframe = iframeRef.current
    const targetOrigin = resolveTargetOrigin(
      iframe?.getAttribute("src") ?? null,
      window.location.href,
    )
    if (!iframe?.contentWindow || !targetOrigin) return

    iframe.contentWindow.postMessage(
      { type: "toggle-inspector", active: next },
      targetOrigin,
    )
  }, [active, iframeRef])

  const clearSelected = useCallback(() => setSelected(null), [])

  return { active, selected, ready, toggle, clearSelected }
}

export const __testing__ = { resolveTargetOrigin }

/**
 * Format a selected element into an AI-friendly prompt snippet.
 */
export function formatElementPrompt(el: SelectedElement): string {
  const lines: string[] = []
  lines.push(`\nI want to modify this element (xpath: \`${el.xpath}\`):`)
  lines.push("```html")
  lines.push(el.outerHTML.slice(0, 2000))
  lines.push("```")

  // Add key computed styles
  const styleEntries = Object.entries(el.computedStyles)
  if (styleEntries.length > 0) {
    lines.push("\nCurrent key styles:")
    lines.push("```json")
    lines.push(JSON.stringify(el.computedStyles, null, 2))
    lines.push("```")
  }

  return lines.join("\n")
}
