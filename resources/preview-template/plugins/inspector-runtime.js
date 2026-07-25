/**
 * Bytro DOM Inspector Runtime
 *
 * Injected into the preview project by the Vite inspector plugin.
 * Enables hover-to-highlight and click-to-select DOM elements,
 * then sends element info to the parent Bytro window via postMessage.
 */
;(function () {
  "use strict"

  let active = false
  let hoveredEl = null
  const trustedParent = resolveTrustedParent()

  function resolveTrustedParent() {
    if (window.parent === window) return null

    const ancestorOrigin =
      window.location.ancestorOrigins &&
      window.location.ancestorOrigins.length > 0
        ? window.location.ancestorOrigins[0]
        : ""
    const candidate = document.referrer || ancestorOrigin || ""

    if (candidate.startsWith("tauri://localhost")) {
      // Custom-scheme origins are opaque, so browsers require "*" as the
      // target. Both sides additionally verify the exact WindowProxy source.
      return { expectedOrigin: "null", targetOrigin: "*" }
    }

    try {
      const url = new URL(candidate)
      const isTauriHost =
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.hostname === "tauri.localhost"
      const isDevHost =
        url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
        url.port === "1420"

      if (isTauriHost || isDevHost) {
        return { expectedOrigin: url.origin, targetOrigin: url.origin }
      }
    } catch {
      // A missing or malformed referrer leaves the inspector disabled.
    }

    return null
  }

  function postToTrustedParent(message) {
    if (!trustedParent) return
    window.parent.postMessage(message, trustedParent.targetOrigin)
  }

  // Overlay element for hover highlight (avoids mutating target element styles)
  const overlay = document.createElement("div")
  overlay.id = "__bytro-inspector-overlay"
  Object.assign(overlay.style, {
    position: "fixed",
    pointerEvents: "none",
    border: "2px solid #3b82f6",
    backgroundColor: "rgba(59, 130, 246, 0.08)",
    borderRadius: "2px",
    zIndex: "2147483647",
    display: "none",
    transition: "all 0.05s ease-out",
  })

  // Label showing tag + class info
  const label = document.createElement("div")
  Object.assign(label.style, {
    position: "fixed",
    pointerEvents: "none",
    backgroundColor: "#3b82f6",
    color: "#fff",
    fontSize: "11px",
    fontFamily: "monospace",
    padding: "2px 6px",
    borderRadius: "2px",
    zIndex: "2147483647",
    display: "none",
    whiteSpace: "nowrap",
    maxWidth: "300px",
    overflow: "hidden",
    textOverflow: "ellipsis",
  })

  document.documentElement.appendChild(overlay)
  document.documentElement.appendChild(label)

  // ─── Listen for commands from parent window ───────────────────────

  window.addEventListener("message", function (e) {
    if (!trustedParent || e.source !== window.parent) return
    if (e.origin !== trustedParent.expectedOrigin) return
    if (!e.data || typeof e.data.type !== "string") return

    if (e.data.type === "toggle-inspector") {
      active = !!e.data.active
      document.body.style.cursor = active ? "crosshair" : ""
      if (!active) {
        hideOverlay()
        hoveredEl = null
      }
    }
  })

  // ─── Hover highlight ─────────────────────────────────────────────

  document.addEventListener(
    "mousemove",
    function (e) {
      if (!active) return
      var target = e.target
      if (target === overlay || target === label) return
      if (target === hoveredEl) return
      hoveredEl = target
      positionOverlay(target)
    },
    true
  )

  document.addEventListener(
    "mouseout",
    function (e) {
      if (!active) return
      if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
        hideOverlay()
        hoveredEl = null
      }
    },
    true
  )

  // ─── Click to select ─────────────────────────────────────────────

  document.addEventListener(
    "click",
    function (e) {
      if (!active) return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()

      var el = e.target
      if (el === overlay || el === label) return

      // Serialize element info and send to parent
      postToTrustedParent(
        {
          type: "element-selected",
          payload: {
            outerHTML: truncate(el.outerHTML, 8000),
            tagName: el.tagName.toLowerCase(),
            id: el.id || "",
            className:
              typeof el.className === "string" ? el.className : "",
            textContent: truncate((el.textContent || "").trim(), 500),
            xpath: getXPath(el),
            computedStyles: getRelevantStyles(el),
            rect: getRect(el),
          },
        }
      )

      // Deactivate after selection
      active = false
      document.body.style.cursor = ""
      hideOverlay()
      hoveredEl = null
    },
    true
  )

  // ─── Overlay positioning ──────────────────────────────────────────

  function positionOverlay(el) {
    var rect = el.getBoundingClientRect()
    Object.assign(overlay.style, {
      display: "block",
      top: rect.top + "px",
      left: rect.left + "px",
      width: rect.width + "px",
      height: rect.height + "px",
    })

    // Build label text: tag#id.class1.class2
    var text = el.tagName.toLowerCase()
    if (el.id) text += "#" + el.id
    if (typeof el.className === "string" && el.className.trim()) {
      text +=
        "." +
        el.className
          .trim()
          .split(/\s+/)
          .slice(0, 3)
          .join(".")
    }

    label.textContent = text
    Object.assign(label.style, {
      display: "block",
      top: Math.max(0, rect.top - 20) + "px",
      left: rect.left + "px",
    })
  }

  function hideOverlay() {
    overlay.style.display = "none"
    label.style.display = "none"
  }

  // ─── XPath generator ─────────────────────────────────────────────

  function getXPath(el) {
    if (el.id) return '//*[@id="' + el.id + '"]'

    var parts = []
    var current = el
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      var index = 1
      var sibling = current.previousElementSibling
      while (sibling) {
        if (sibling.tagName === current.tagName) index++
        sibling = sibling.previousElementSibling
      }
      var tag = current.tagName.toLowerCase()
      parts.unshift(tag + "[" + index + "]")
      current = current.parentElement
    }
    return "/" + parts.join("/")
  }

  // ─── Computed style extraction ────────────────────────────────────

  function getRelevantStyles(el) {
    var computed = window.getComputedStyle(el)
    var keys = [
      "display",
      "position",
      "width",
      "height",
      "padding",
      "margin",
      "color",
      "backgroundColor",
      "fontSize",
      "fontWeight",
      "fontFamily",
      "lineHeight",
      "textAlign",
      "borderRadius",
      "border",
      "boxShadow",
      "opacity",
      "overflow",
      "flexDirection",
      "justifyContent",
      "alignItems",
      "gap",
      "gridTemplateColumns",
    ]
    var result = {}
    for (var i = 0; i < keys.length; i++) {
      var val = computed.getPropertyValue(keys[i])
      if (val && val !== "none" && val !== "normal" && val !== "auto") {
        result[keys[i]] = val
      }
    }
    return result
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  function getRect(el) {
    var r = el.getBoundingClientRect()
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    }
  }

  function truncate(str, max) {
    if (!str) return ""
    return str.length > max ? str.slice(0, max) + "..." : str
  }

  // ─── Notify parent that inspector is ready ────────────────────────

  postToTrustedParent({ type: "inspector-ready" })
})()
