import { useState, useEffect } from "react";
import { useSettingsStore } from "@/stores";

/**
 * Reactive hook that returns whether the current resolved theme is "light".
 *
 * Single source of truth = `document.documentElement.dataset.theme`, which
 * App.tsx writes after resolving every mode (including "system", resolved via
 * the native `win.theme()` API). Reading that attribute — instead of each
 * consumer independently probing `prefers-color-scheme` — keeps every component
 * perfectly in sync with the real painted theme.
 *
 * Why this matters (the bug this fixes): on first launch `theme` defaults to
 * "system". The old hook derived light/dark from
 * `matchMedia("(prefers-color-scheme: dark)")`, but the WebView can momentarily
 * report light before Tauri applies the OS appearance — and App.css has no
 * `prefers-color-scheme` rules, so the page itself renders dark by default.
 * The card's light-gradient variant then painted on top of a dark page and
 * never corrected (the hook's effect re-read the same stale media query), until
 * the user manually toggled the theme. Observing `data-theme` fixes this: once
 * App.tsx writes the authoritative resolved theme, the value self-corrects.
 */
function readIsLight(): boolean {
  const attr = document.documentElement.dataset.theme;
  if (attr === "light") return true;
  if (attr === "dark") return false;
  // data-theme not written yet (earliest render, before App's first layout
  // effect). The page's CSS variables fall back to the @theme dark defaults
  // here, so render dark unless an explicit light/dark preference is persisted.
  // "system" (incl. fresh installs) stays dark to match the page until App
  // resolves it via win.theme() and writes data-theme — the observer then syncs.
  return useSettingsStore.getState().theme === "light";
}

export function useIsLightTheme(): boolean {
  const [isLight, setIsLight] = useState(readIsLight);

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setIsLight(readIsLight());
    // Align with whatever App.tsx wrote in its (post-render) layout effect,
    // then track every subsequent theme change — including OS switches while
    // in "system" mode, which App.tsx reflects onto data-theme.
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return isLight;
}
