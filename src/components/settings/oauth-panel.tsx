// Anthropic OAuth 2.0 subscription sign-in panel.
//
// Three states:
//   signed-out  → Sign-in CTA + features list
//   pasting     → Authorize URL (always visible) + code paste box
//   signed-in   → Account info + refresh / sign-out actions
//
// Raw access / refresh tokens stay in Rust / SQLite — this component only
// ever handles the OAuthAccountInfo projection that the backend returns.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ShieldCheck,
  Check,
  Copy,
  RefreshCw,
  LogOut,
  ExternalLink,
  Loader2,
  Crown,
  Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatError } from "@/lib/format-error";

interface OAuthAccountInfo {
  provider: string;
  profileId: string;
  accountEmail?: string | null;
  accountUuid?: string | null;
  organizationUuid?: string | null;
  subscriptionTier?: string | null;
  expiresAt: number;
  scopes: string;
  tokenType: string;
}

interface OAuthStartResult {
  authorizeUrl: string;
  state: string;
  browserOpened: boolean;
}

/** One quota window from GET /api/oauth/usage (utilization is 0-100). */
interface OAuthUsageWindow {
  utilization: number;
  /** ms epoch, already normalized by parseUsage; null when absent. */
  resetsAt: number | null;
}

interface OAuthUsage {
  fiveHour?: OAuthUsageWindow;
  sevenDay?: OAuthUsageWindow;
  sevenDayOpus?: OAuthUsageWindow;
  sevenDaySonnet?: OAuthUsageWindow;
}

/** The endpoint returns `resets_at` as an ISO string; tolerate epoch seconds too. */
function parseResetsAt(value: unknown): number | null {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: epoch seconds vs epoch milliseconds.
    return value > 1e12 ? value : value * 1000;
  }
  return null;
}

function parseUsageWindow(value: unknown): OAuthUsageWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { utilization?: unknown; resets_at?: unknown };
  if (typeof raw.utilization !== "number") return undefined;
  return { utilization: raw.utilization, resetsAt: parseResetsAt(raw.resets_at) };
}

function parseUsage(value: unknown): OAuthUsage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const usage: OAuthUsage = {
    fiveHour: parseUsageWindow(raw.five_hour),
    sevenDay: parseUsageWindow(raw.seven_day),
    sevenDayOpus: parseUsageWindow(raw.seven_day_opus),
    sevenDaySonnet: parseUsageWindow(raw.seven_day_sonnet),
  };
  return usage.fiveHour || usage.sevenDay || usage.sevenDayOpus || usage.sevenDaySonnet
    ? usage
    : null;
}

// Persist the last-known quota per profile so the panel can show it immediately
// on open. A fresh value is fetched only from an explicit refresh action.
const USAGE_CACHE_PREFIX = "oauth-usage:";

function usageCacheKey(provider: string, profileId: string): string {
  return `${USAGE_CACHE_PREFIX}${provider}:${profileId}`;
}

function readCachedUsage(provider: string, profileId: string): OAuthUsage | null {
  try {
    const raw = localStorage.getItem(usageCacheKey(provider, profileId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OAuthUsage;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed.fiveHour || parsed.sevenDay || parsed.sevenDayOpus || parsed.sevenDaySonnet
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function writeCachedUsage(provider: string, profileId: string, usage: OAuthUsage): void {
  try {
    localStorage.setItem(usageCacheKey(provider, profileId), JSON.stringify(usage));
  } catch {
    /* ignore quota / serialization errors */
  }
}

function clearCachedUsage(provider: string, profileId: string): void {
  try {
    localStorage.removeItem(usageCacheKey(provider, profileId));
  } catch {
    /* ignore */
  }
}

function formatResetCountdown(msEpoch: number, lang: string): string {
  const diff = msEpoch - Date.now();
  const zh = lang.startsWith("zh");
  if (diff <= 0) return zh ? "即将重置" : "soon";
  const totalMinutes = Math.ceil(diff / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return zh ? `${days} 天 ${hours} 小时` : `${days}d ${hours}h`;
  if (hours > 0) return zh ? `${hours} 小时 ${minutes} 分钟` : `${hours}h ${minutes}m`;
  return zh ? `${minutes} 分钟` : `${minutes}m`;
}

export interface OAuthPanelProps {
  /** Provider id used in oauth_* commands. Currently always "claude" in UI. */
  readonly provider: string;
  readonly profileId: string;
  readonly proxyUrl?: string;
  /** Called after a successful sign-in so the parent can stamp metadata
   *  (email / plan / expiry) onto the profile without persisting tokens. */
  readonly onSignedIn?: (info: OAuthAccountInfo) => void;
  readonly onSignedOut?: () => void;
  /** Switch the outer Auth Method tab back to "API Key". */
  readonly onSwitchToApiKey?: () => void;
}

type Phase = "loading" | "signedOut" | "pasting" | "signedIn";

const PURPLE = "var(--color-accent-purple)";

function formatExpiry(ms: number, lang: string): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "—";
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  if (days >= 1) return lang.startsWith("zh") ? `${days} 天后` : `in ${days}d`;
  if (hours >= 1) return lang.startsWith("zh") ? `${hours} 小时后` : `in ${hours}h`;
  const mins = Math.max(1, Math.floor(diff / 60_000));
  return lang.startsWith("zh") ? `${mins} 分钟后` : `in ${mins}m`;
}

function formatPlan(tier: string | null | undefined): string {
  if (!tier) return "Pro";
  const lower = tier.toLowerCase();
  if (lower.includes("max")) return "Max";
  if (lower.includes("team")) return "Team";
  if (lower.includes("enterprise")) return "Enterprise";
  if (lower.includes("pro")) return "Pro";
  return tier;
}

function UsageBar({
  label,
  window: win,
}: {
  readonly label: string;
  readonly window: OAuthUsageWindow;
}) {
  const { t, i18n } = useTranslation();
  const used = Math.max(0, Math.min(100, Math.round(win.utilization)));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-foreground font-sans">{label}</span>
        <span className="text-[10px] text-muted font-mono">
          {t("settings.models.auth.usagePercentUsed", { percent: used })}
        </span>
      </div>
      <div
        className="h-1.5 rounded-full overflow-hidden"
        style={{ backgroundColor: "var(--color-border)" }}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${used}%`, backgroundColor: PURPLE }}
        />
      </div>
      {win.resetsAt != null && (
        <div className="text-[10px] text-muted font-sans">
          {t("settings.models.auth.usageResets", {
            time: formatResetCountdown(win.resetsAt, i18n.language),
          })}
        </div>
      )}
    </div>
  );
}

export function OAuthPanel({
  provider,
  profileId,
  proxyUrl,
  onSignedIn,
  onSignedOut,
  onSwitchToApiKey,
}: OAuthPanelProps) {
  const { t, i18n } = useTranslation();

  const [phase, setPhase] = useState<Phase>("loading");
  const [account, setAccount] = useState<OAuthAccountInfo | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string>("");
  const [state, setState] = useState<string>("");
  const [browserOpened, setBrowserOpened] = useState<boolean>(false);
  const [code, setCode] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [usage, setUsage] = useState<OAuthUsage | null>(() => readCachedUsage(provider, profileId));
  const [usageState, setUsageState] = useState<"idle" | "loading" | "error">("idle");
  const usageRequestRef = useRef(0);
  // Mirrors `usage` so async callbacks can read the latest value without
  // depending on it (keeps loadUsage's identity stable).
  const usageRef = useRef<OAuthUsage | null>(usage);
  const onSignedInRef = useRef(onSignedIn);
  const onSignedOutRef = useRef(onSignedOut);

  useEffect(() => {
    onSignedInRef.current = onSignedIn;
  }, [onSignedIn]);

  useEffect(() => {
    onSignedOutRef.current = onSignedOut;
  }, [onSignedOut]);

  // Re-seed cached usage when the profile changes so we show the previous
  // value immediately instead of a blank/loading state.
  useEffect(() => {
    usageRequestRef.current += 1;
    const cached = readCachedUsage(provider, profileId);
    usageRef.current = cached;
    setUsage(cached);
  }, [provider, profileId]);

  // Load existing session on mount (and when profile changes).
  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setError("");
    invoke<OAuthAccountInfo | null>("oauth_get_token", { provider, profileId })
      .then((info) => {
        if (cancelled) return;
        if (info) {
          setAccount(info);
          setPhase("signedIn");
          onSignedInRef.current?.(info);
        } else {
          setAccount(null);
          setPhase("signedOut");
        }
      })
      .catch(() => {
        if (!cancelled) setPhase("signedOut");
      });
    return () => {
      cancelled = true;
    };
  }, [provider, profileId]);

  // Listen for background refresh events (e.g. from chat streaming auto-refresh).
  useEffect(() => {
    const unlistenList: Array<() => void> = [];
    (async () => {
      const u1 = await listen<OAuthAccountInfo>("oauth://refreshed", (evt) => {
        if (evt.payload.provider === provider && evt.payload.profileId === profileId) {
          setAccount(evt.payload);
          setPhase("signedIn");
          onSignedInRef.current?.(evt.payload);
        }
      });
      const u2 = await listen<{ provider: string; profileId: string }>("oauth://expired", (evt) => {
        if (evt.payload.provider === provider && evt.payload.profileId === profileId) {
          setPhase("signedOut");
          setAccount(null);
          setError(t("settings.models.auth.expired"));
          onSignedOutRef.current?.();
        }
      });
      unlistenList.push(u1, u2);
    })();
    return () => {
      unlistenList.forEach((u) => u());
    };
  }, [provider, profileId, t]);

  // Fetch subscription quota utilization. Failures are non-fatal — the panel
  // just shows a "usage unavailable" hint instead of the bars.
  const loadUsage = useCallback(async () => {
    const requestId = ++usageRequestRef.current;
    // Keep the previously shown bars (cached or last fetch) visible while the
    // refresh is in flight — only the refresh icon spins.
    setUsageState("loading");
    try {
      const raw = await invoke<unknown>("oauth_get_usage", {
        provider,
        profileId,
        proxyUrl: proxyUrl || undefined,
      });
      if (usageRequestRef.current !== requestId) return;
      const parsed = parseUsage(raw);
      if (parsed) {
        usageRef.current = parsed;
        setUsage(parsed);
        writeCachedUsage(provider, profileId, parsed);
        setUsageState("idle");
      } else {
        // No fresh data: keep whatever is already shown; only surface an error
        // when we have nothing to fall back on.
        setUsageState(usageRef.current ? "idle" : "error");
      }
    } catch {
      if (usageRequestRef.current !== requestId) return;
      setUsageState(usageRef.current ? "idle" : "error");
    }
  }, [provider, profileId, proxyUrl]);

  // Signing out only clears cached quota state. Signing in never fetches
  // usage automatically; that network request stays behind Refresh.
  useEffect(() => {
    if (phase !== "signedOut") return;
    usageRequestRef.current += 1;
    usageRef.current = null;
    setUsage(null);
    setUsageState("idle");
    clearCachedUsage(provider, profileId);
  }, [phase, provider, profileId]);

  const startSignIn = useCallback(async () => {
    setError("");
    setBusy(true);
    try {
      const result = await invoke<OAuthStartResult>("oauth_start", {
        provider,
        profileId,
      });
      setAuthorizeUrl(result.authorizeUrl);
      setState(result.state);
      setBrowserOpened(result.browserOpened);
      setCode("");
      setPhase("pasting");
    } catch (e) {
      setError(t("settings.models.auth.errorExchange", { error: formatError(e) }));
    } finally {
      setBusy(false);
    }
  }, [provider, profileId, t]);

  const cancelSignIn = useCallback(async () => {
    try {
      if (state) await invoke("oauth_cancel", { state });
    } catch {
      /* ignore */
    }
    setPhase(account ? "signedIn" : "signedOut");
    setAuthorizeUrl("");
    setState("");
    setCode("");
    setError("");
  }, [state, account]);

  const submitCode = useCallback(async () => {
    if (!code.trim()) return;
    setError("");
    setBusy(true);
    try {
      const info = await invoke<OAuthAccountInfo>("oauth_submit_code", {
        state,
        code: code.trim(),
        proxyUrl: proxyUrl || undefined,
      });
      setAccount(info);
      setPhase("signedIn");
      setAuthorizeUrl("");
      setState("");
      setCode("");
      onSignedInRef.current?.(info);
    } catch (e) {
      setError(t("settings.models.auth.errorExchange", { error: formatError(e) }));
    } finally {
      setBusy(false);
    }
  }, [code, state, proxyUrl, t]);

  const handleRefresh = useCallback(async () => {
    setError("");
    setRefreshing(true);
    try {
      const info = await invoke<OAuthAccountInfo>("oauth_refresh", {
        provider,
        profileId,
        proxyUrl: proxyUrl || undefined,
      });
      setAccount(info);
      onSignedInRef.current?.(info);
      await loadUsage();
    } catch (e) {
      setError(t("settings.models.auth.errorExchange", { error: formatError(e) }));
    } finally {
      setRefreshing(false);
    }
  }, [provider, profileId, proxyUrl, t, loadUsage]);

  const handleSignOut = useCallback(async () => {
    setError("");
    try {
      await invoke("oauth_sign_out", { provider, profileId });
      setAccount(null);
      setPhase("signedOut");
      onSignedOutRef.current?.();
    } catch (e) {
      setError(formatError(e));
    }
  }, [provider, profileId]);

  const copyUrl = useCallback(async () => {
    if (!authorizeUrl) return;
    try {
      await navigator.clipboard.writeText(authorizeUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, [authorizeUrl]);

  const openInBrowser = useCallback(async () => {
    if (!authorizeUrl) return;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(authorizeUrl);
    } catch {
      /* ignore — user can still copy manually */
    }
  }, [authorizeUrl]);

  const scopesList = useMemo(
    () => (account?.scopes ?? "").split(/\s+/).filter(Boolean),
    [account?.scopes],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (phase === "loading") {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 size={18} className="animate-spin" style={{ color: PURPLE }} />
      </div>
    );
  }

  if (phase === "signedIn" && account) {
    return (
      <div className="flex flex-col gap-4">
        <div
          className="flex items-start gap-3 rounded-lg p-4"
          style={{
            backgroundColor:
              "color-mix(in srgb, var(--color-accent-purple) 10%, var(--color-surface))",
            border: "1px solid color-mix(in srgb, var(--color-accent-purple) 35%, transparent)",
          }}
        >
          <div
            className="shrink-0 flex items-center justify-center w-10 h-10 rounded-full"
            style={{
              backgroundColor:
                "color-mix(in srgb, var(--color-accent-purple) 25%, var(--color-surface))",
            }}
          >
            <span className="text-[15px] font-semibold font-sans" style={{ color: PURPLE }}>
              {(account.accountEmail ?? "?").slice(0, 1).toUpperCase()}
            </span>
          </div>
          <div className="flex-1 min-w-0 flex flex-col gap-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px] font-semibold text-foreground font-sans truncate">
                {account.accountEmail ?? "—"}
              </span>
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold font-sans"
                style={{
                  backgroundColor:
                    "color-mix(in srgb, var(--color-accent-purple) 18%, transparent)",
                  color: PURPLE,
                }}
              >
                <Crown size={10} />
                {formatPlan(account.subscriptionTier)}
              </span>
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium font-sans"
                style={{
                  backgroundColor:
                    "color-mix(in srgb, var(--color-accent-success) 15%, transparent)",
                  color: "var(--color-accent-success)",
                }}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--color-accent-success)]" />
                {t("settings.models.auth.active")}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted font-sans">
              <span>
                {t("settings.models.auth.expiresAt", {
                  when: formatExpiry(account.expiresAt, i18n.language),
                })}
              </span>
              {scopesList.length > 0 && (
                <span className="truncate max-w-[280px]">
                  {t("settings.models.auth.scopesLabel")}: {scopesList.join(" · ")}
                </span>
              )}
            </div>
          </div>
        </div>

        {(usage || usageState !== "idle") && (
          <div
            className="flex flex-col gap-3 rounded-md px-3 py-2.5"
            style={{
              backgroundColor: "var(--color-surface)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted font-sans">
                {t("settings.models.auth.usageTitle")}
              </span>
              <button
                onClick={() => void loadUsage()}
                disabled={usageState === "loading"}
                title={t("settings.models.auth.usageRefresh")}
                className="p-1 rounded text-muted hover:text-foreground hover:bg-border transition-colors disabled:opacity-50"
              >
                <RefreshCw
                  size={12}
                  className={usageState === "loading" ? "animate-spin" : undefined}
                />
              </button>
            </div>
            {usage ? (
              <>
                {usage.fiveHour && (
                  <UsageBar
                    label={t("settings.models.auth.claudeSessionLimit")}
                    window={usage.fiveHour}
                  />
                )}
                {usage.sevenDay && (
                  <UsageBar
                    label={t("settings.models.auth.claudeWeeklyLimit")}
                    window={usage.sevenDay}
                  />
                )}
                {usage.sevenDayOpus && (
                  <UsageBar
                    label={t("settings.models.auth.claudeOpusLimit")}
                    window={usage.sevenDayOpus}
                  />
                )}
                {usage.sevenDaySonnet && (
                  <UsageBar
                    label={t("settings.models.auth.claudeSonnetLimit")}
                    window={usage.sevenDaySonnet}
                  />
                )}
              </>
            ) : usageState === "loading" ? (
              <div className="flex items-center gap-2 text-[11px] text-muted font-sans">
                <Loader2 size={12} className="animate-spin" />
                {t("settings.models.auth.usageLoading")}
              </div>
            ) : (
              <div className="text-[11px] text-muted font-sans">
                {t("settings.models.auth.usageUnavailable")}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-2 rounded-md text-[12px] font-medium text-foreground hover:bg-border disabled:opacity-40 transition-colors"
            style={{ border: "1px solid var(--color-border-strong)" }}
          >
            <RefreshCw
              size={13}
              className={refreshing ? "animate-spin" : undefined}
              style={{ color: PURPLE }}
            />
            {t("settings.models.auth.refresh")}
          </button>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-1.5 px-3 py-2 rounded-md text-[12px] font-medium transition-colors"
            style={{
              border: "1px solid color-mix(in srgb, #EF4444 30%, transparent)",
              color: "#EF4444",
            }}
          >
            <LogOut size={13} />
            {t("settings.models.auth.signOut")}
          </button>
        </div>

        <div className="flex items-center gap-1.5 text-[11px] text-muted font-sans">
          <Lock size={11} />
          {t("settings.models.auth.secured")}
        </div>

        {error && (
          <div
            className="flex items-start gap-1.5 rounded-md px-3 py-2"
            style={{ backgroundColor: "color-mix(in srgb, #EF4444 8%, var(--color-card))" }}
          >
            <span className="text-[11px] font-mono text-red-400 break-words whitespace-pre-wrap">
              {error}
            </span>
          </div>
        )}
      </div>
    );
  }

  if (phase === "pasting") {
    return (
      <div className="flex flex-col gap-4">
        <div
          className="flex flex-col gap-3 rounded-lg p-4"
          style={{
            backgroundColor:
              "color-mix(in srgb, var(--color-accent-purple) 6%, var(--color-surface))",
            border: "1px solid color-mix(in srgb, var(--color-accent-purple) 30%, transparent)",
          }}
        >
          <div
            className="flex items-center gap-2 text-[12px] font-medium font-sans"
            style={{ color: PURPLE }}
          >
            <ShieldCheck size={14} />
            {t("settings.models.auth.authUrl")}
          </div>
          <div className="text-[11px] text-muted font-sans leading-relaxed">
            {browserOpened
              ? t("settings.models.auth.browserOpenedHint")
              : t("settings.models.auth.browserFailedHint")}
          </div>
          <div
            className="flex items-center gap-2 rounded-md px-3 py-2 overflow-hidden"
            style={{
              backgroundColor: "var(--color-surface-alt)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            <ExternalLink size={12} className="shrink-0" style={{ color: PURPLE }} />
            <input
              readOnly
              value={authorizeUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 bg-transparent text-[11px] text-foreground font-mono outline-none min-w-0 truncate"
            />
            <button
              onClick={copyUrl}
              className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors hover:bg-border"
              style={{ color: copied ? "var(--color-accent-success)" : PURPLE }}
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
              {copied ? t("settings.models.auth.copied") : t("settings.models.auth.copyUrl")}
            </button>
            <button
              onClick={openInBrowser}
              className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors hover:bg-border text-muted"
            >
              <ExternalLink size={11} />
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-medium text-foreground font-sans">
            {t("settings.models.auth.pasteCodeHint")}
          </span>
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t("settings.models.auth.codePlaceholder")}
            rows={2}
            className="bg-transparent rounded-md px-3 py-2 text-[12px] text-foreground font-mono outline-none resize-none"
            style={{
              backgroundColor: "var(--color-surface-alt)",
              border: "1px solid var(--color-border-strong)",
            }}
          />
        </div>

        {error && (
          <div
            className="flex items-start gap-1.5 rounded-md px-3 py-2"
            style={{ backgroundColor: "color-mix(in srgb, #EF4444 8%, var(--color-card))" }}
          >
            <span className="text-[11px] font-mono text-red-400 break-words whitespace-pre-wrap">
              {error}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between">
          <button
            onClick={cancelSignIn}
            disabled={busy}
            className="px-3 py-2 rounded-md text-[12px] font-medium text-foreground hover:bg-border disabled:opacity-40 transition-colors"
            style={{ border: "1px solid var(--color-border-strong)" }}
          >
            {t("settings.models.auth.cancel")}
          </button>
          <button
            onClick={submitCode}
            disabled={busy || !code.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-md text-[12px] font-semibold text-white disabled:opacity-40 transition-colors"
            style={{ backgroundColor: PURPLE }}
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {busy ? t("settings.models.auth.exchanging") : t("settings.models.auth.submitCode")}
          </button>
        </div>
      </div>
    );
  }

  // signedOut
  return (
    <div className="flex flex-col gap-5 py-2">
      <div className="flex items-center gap-3">
        <div
          className="shrink-0 flex items-center justify-center w-12 h-12 rounded-full"
          style={{
            backgroundColor:
              "color-mix(in srgb, var(--color-accent-purple) 15%, var(--color-surface))",
            border: "1px solid color-mix(in srgb, var(--color-accent-purple) 30%, transparent)",
          }}
        >
          <ShieldCheck size={22} style={{ color: PURPLE }} />
        </div>
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <span className="text-[14px] font-semibold text-foreground font-sans">
            {t("settings.models.auth.oauthSubtitle")}
          </span>
          <span className="text-[11px] text-muted font-sans">
            {t("settings.models.auth.oauthIntro")}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {[
          t("settings.models.auth.feature1"),
          t("settings.models.auth.feature2"),
          t("settings.models.auth.feature3"),
        ].map((text) => (
          <div key={text} className="flex items-center gap-2 text-[12px] text-foreground font-sans">
            <Check size={14} style={{ color: "var(--color-accent-success)" }} />
            {text}
          </div>
        ))}
      </div>

      <button
        onClick={startSignIn}
        disabled={busy}
        className={cn(
          "flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-md text-[13px] font-semibold text-white transition-colors",
          busy && "opacity-60 cursor-not-allowed",
        )}
        style={{ backgroundColor: PURPLE }}
      >
        {busy && <Loader2 size={14} className="animate-spin" />}
        {busy ? t("settings.models.auth.exchanging") : t("settings.models.auth.signIn")}
      </button>

      {error && (
        <div
          className="flex items-start gap-1.5 rounded-md px-3 py-2"
          style={{ backgroundColor: "color-mix(in srgb, #EF4444 8%, var(--color-card))" }}
        >
          <span className="text-[11px] font-mono text-red-400 break-words whitespace-pre-wrap">
            {error}
          </span>
        </div>
      )}

      {onSwitchToApiKey && (
        <button
          onClick={onSwitchToApiKey}
          className="text-[11px] text-muted hover:text-foreground font-sans underline underline-offset-2 transition-colors"
        >
          {t("settings.models.auth.switchToApiKey")}
        </button>
      )}

      <div className="flex items-center gap-1.5 text-[11px] text-muted font-sans">
        <Lock size={11} />
        {t("settings.models.auth.secured")}
      </div>
    </div>
  );
}
