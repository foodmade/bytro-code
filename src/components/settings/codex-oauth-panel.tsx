import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, ExternalLink, Loader2, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { formatError } from "@/lib/format-error";
import type { CodexRateLimits, CodexRateLimitWindow } from "@/lib/platform-config";

interface CodexAuthStartedEvent {
  request_id: string;
  profile_id: string;
  login_id: string;
  auth_url?: string;
  verification_url?: string;
  user_code?: string;
}

interface CodexAuthCompletedEvent {
  request_id: string;
  profile_id: string;
  email?: string;
  plan_type?: string;
  requires_openai_auth?: boolean;
  rate_limits?: CodexRateLimits;
}

interface CodexAuthErrorEvent {
  request_id: string;
  profile_id: string;
  error: string;
}

export interface CodexOAuthAccountInfo {
  email?: string;
  planType?: string;
  rateLimits?: CodexRateLimits;
}

export interface CodexOAuthPanelProps {
  readonly profileId: string;
  readonly initialAccount?: CodexOAuthAccountInfo | null;
  readonly onSignedIn?: (info: CodexOAuthAccountInfo) => void;
  readonly onSignedOut?: () => void;
  readonly onSwitchToApiKey?: () => void;
}

type Phase = "loading" | "signedOut" | "pending" | "signedIn";

function formatPlan(plan: string | undefined): string {
  if (!plan) return "ChatGPT";
  return plan
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatResetTime(value: number | null | undefined): string {
  if (typeof value !== "number") return "--";
  const diffMs = value * 1000 - Date.now();
  if (diffMs <= 0) return "0分钟";
  const totalMinutes = Math.ceil(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}天 ${hours}小时 ${minutes}分钟`;
  if (hours > 0) return `${hours}小时 ${minutes}分钟`;
  return `${minutes}分钟`;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function remainingPercent(value: number): number {
  return clampPercent(100 - value);
}

function CodexRateLimitBar({ label, limit }: { readonly label: string; readonly limit: CodexRateLimitWindow }) {
  const used = clampPercent(limit.usedPercent);
  const remaining = remainingPercent(limit.usedPercent);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-foreground font-sans">{label}</span>
        <span className="text-[10px] text-muted font-mono">
          {used}% / {remaining}%
        </span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: "var(--color-border)" }}>
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${used}%`, backgroundColor: "var(--color-accent-green)" }}
        />
      </div>
      <div className="text-[10px] text-muted font-sans">
        {formatResetTime(limit.resetsAt)}
      </div>
    </div>
  );
}

export function CodexOAuthPanel({
  profileId,
  initialAccount = null,
  onSignedIn,
  onSignedOut,
  onSwitchToApiKey,
}: CodexOAuthPanelProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>(initialAccount ? "signedIn" : "loading");
  const [account, setAccount] = useState<CodexOAuthAccountInfo | null>(initialAccount);
  const [authUrl, setAuthUrl] = useState("");
  const [verificationUrl, setVerificationUrl] = useState("");
  const [userCode, setUserCode] = useState("");
  const [loginId, setLoginId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [readStatus, setReadStatus] = useState<"idle" | "refreshing" | "success">("idle");
  const onSignedInRef = useRef(onSignedIn);
  const onSignedOutRef = useRef(onSignedOut);
  const readRequestIdRef = useRef<string | null>(null);
  const readRequestShowsStatusRef = useRef(false);
  const loginRequestIdRef = useRef<string | null>(null);
  const listenersReadyRef = useRef(false);
  const readStatusTimerRef = useRef<number | null>(null);

  useEffect(() => {
    onSignedInRef.current = onSignedIn;
  }, [onSignedIn]);

  useEffect(() => {
    onSignedOutRef.current = onSignedOut;
  }, [onSignedOut]);

  const hasInitialAccount = Boolean(initialAccount);

  useEffect(() => {
    setAccount(initialAccount);
    setPhase(initialAccount ? "signedIn" : "loading");
  }, [initialAccount, profileId]);

  useEffect(() => () => {
    if (readStatusTimerRef.current != null) {
      window.clearTimeout(readStatusTimerRef.current);
    }
  }, []);

  const readAccount = useCallback((refreshToken: boolean, showStatus: boolean) => {
    if (!listenersReadyRef.current) return;
    setError("");
    setReadStatus(showStatus ? "refreshing" : "idle");
    setBusy(showStatus);
    const requestId = crypto.randomUUID();
    readRequestIdRef.current = requestId;
    readRequestShowsStatusRef.current = showStatus;
    invoke("codex_auth_read", { requestId, profileId, refreshToken })
      .catch((err) => {
        if (readRequestIdRef.current === requestId) {
          readRequestIdRef.current = null;
        }
        setReadStatus("idle");
        setBusy(false);
        setError(formatError(err));
        setPhase("signedOut");
      });
  }, [profileId]);

  useEffect(() => {
    let cancelled = false;
    const unlistenList: Array<() => void> = [];
    (async () => {
      const completed = await listen<CodexAuthCompletedEvent>("codex-auth-completed", (evt) => {
        if (evt.payload.profile_id !== profileId) return;
        const isReadResponse = evt.payload.request_id === readRequestIdRef.current;
        const isLoginResponse = evt.payload.request_id === loginRequestIdRef.current;
        if (!isReadResponse && !isLoginResponse) return;
        if (isReadResponse) {
          readRequestIdRef.current = null;
          if (readRequestShowsStatusRef.current) {
            setReadStatus("success");
            if (readStatusTimerRef.current != null) {
              window.clearTimeout(readStatusTimerRef.current);
            }
            readStatusTimerRef.current = window.setTimeout(() => setReadStatus("idle"), 1600);
          } else {
            setReadStatus("idle");
          }
          readRequestShowsStatusRef.current = false;
        }
        if (isLoginResponse) {
          loginRequestIdRef.current = null;
        }
        setBusy(false);
        const next = {
          email: evt.payload.email,
          planType: evt.payload.plan_type,
          rateLimits: evt.payload.rate_limits,
        };
        if (next.email || next.planType) {
          setAccount(next);
          setPhase("signedIn");
          setError("");
          onSignedInRef.current?.(next);
        } else {
          setAccount(null);
          setPhase("signedOut");
          onSignedOutRef.current?.();
        }
      });
      const started = await listen<CodexAuthStartedEvent>("codex-auth-started", (evt) => {
        if (evt.payload.profile_id !== profileId) return;
        if (evt.payload.request_id !== loginRequestIdRef.current) return;
        setLoginId(evt.payload.login_id);
        setAuthUrl(evt.payload.auth_url ?? "");
        setVerificationUrl(evt.payload.verification_url ?? "");
        setUserCode(evt.payload.user_code ?? "");
        setPhase("pending");
        const url = evt.payload.auth_url ?? evt.payload.verification_url;
        if (url) openUrl(url).catch(() => {});
      });
      const authError = await listen<CodexAuthErrorEvent>("codex-auth-error", (evt) => {
        if (evt.payload.profile_id !== profileId) return;
        const isReadResponse = evt.payload.request_id === readRequestIdRef.current;
        const isLoginResponse = evt.payload.request_id === loginRequestIdRef.current;
        if (!isReadResponse && !isLoginResponse) return;
        if (isReadResponse) {
          readRequestIdRef.current = null;
          readRequestShowsStatusRef.current = false;
          setReadStatus("idle");
        }
        if (isLoginResponse) {
          loginRequestIdRef.current = null;
        }
        setBusy(false);
        setPhase((prev) => (prev === "loading" ? "signedOut" : prev));
        setError(evt.payload.error);
      });
      const signedOut = await listen<{ request_id: string; profile_id: string }>("codex-auth-signed-out", (evt) => {
        if (evt.payload.profile_id !== profileId) return;
        if (evt.payload.request_id !== loginRequestIdRef.current) return;
        loginRequestIdRef.current = null;
        setBusy(false);
        setAccount(null);
        setPhase("signedOut");
        setError("");
        onSignedOutRef.current?.();
      });
      unlistenList.push(completed, started, authError, signedOut);
      listenersReadyRef.current = true;
      if (!cancelled) {
        readAccount(false, hasInitialAccount);
      }
    })();
    return () => {
      cancelled = true;
      listenersReadyRef.current = false;
      unlistenList.forEach((unlisten) => unlisten());
    };
  }, [hasInitialAccount, profileId, readAccount]);

  const startSignIn = useCallback(() => {
    if (!listenersReadyRef.current) return;
    setError("");
    setBusy(true);
    setAuthUrl("");
    setVerificationUrl("");
    setUserCode("");
    setLoginId("");
    const requestId = crypto.randomUUID();
    loginRequestIdRef.current = requestId;
    invoke("codex_auth_start", { requestId, profileId })
      .catch((err) => {
        if (loginRequestIdRef.current === requestId) {
          loginRequestIdRef.current = null;
        }
        setBusy(false);
        setError(formatError(err));
      });
  }, [profileId]);

  const cancelSignIn = useCallback(() => {
    if (loginId) {
      invoke("codex_auth_cancel", { requestId: crypto.randomUUID(), profileId, loginId }).catch(() => {});
    }
    setPhase(account ? "signedIn" : "signedOut");
    setError("");
  }, [account, loginId, profileId]);

  const signOut = useCallback(() => {
    if (!listenersReadyRef.current) return;
    setError("");
    setBusy(true);
    const requestId = crypto.randomUUID();
    loginRequestIdRef.current = requestId;
    invoke("codex_auth_sign_out", { requestId, profileId })
      .catch((err) => {
        if (loginRequestIdRef.current === requestId) {
          loginRequestIdRef.current = null;
        }
        setBusy(false);
        setError(formatError(err));
      });
  }, [profileId]);

  const copyValue = useCallback(async (value: string) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, []);

  const loginUrl = authUrl || verificationUrl;
  const fiveHourLimit = account?.rateLimits?.primary?.windowDurationMins === 300
    ? account.rateLimits.primary
    : account?.rateLimits?.secondary?.windowDurationMins === 300
      ? account.rateLimits.secondary
      : undefined;
  const weeklyLimit = account?.rateLimits?.primary?.windowDurationMins === 10080
    ? account.rateLimits.primary
    : account?.rateLimits?.secondary?.windowDurationMins === 10080
      ? account.rateLimits.secondary
      : undefined;

  return (
    <div className="flex flex-col gap-3 rounded-lg p-4" style={{ backgroundColor: "var(--color-surface-alt)", border: "1px solid var(--color-border-strong)" }}>
      {phase === "loading" && (
        <div className="flex items-center gap-2 text-[12px] text-muted font-sans">
          <Loader2 size={14} className="animate-spin" />
          {t("settings.models.auth.loading")}
        </div>
      )}

      {phase === "signedOut" && (
        <>
          <div className="flex items-start gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-lg shrink-0" style={{ backgroundColor: "color-mix(in srgb, var(--color-accent-green) 14%, transparent)", color: "var(--color-accent-green)" }}>
              <ShieldCheck size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-foreground font-sans">{t("settings.models.auth.codexIntro")}</div>
              <div className="mt-1 text-[11px] text-muted font-sans">{t("settings.models.auth.codexSubtitle")}</div>
            </div>
          </div>
          <button
            onClick={startSignIn}
            disabled={busy}
            className="flex items-center justify-center gap-2 h-9 rounded-md text-[12px] font-medium font-sans transition-opacity disabled:opacity-60"
            style={{ backgroundColor: "var(--color-accent-green)", color: "var(--color-background)" }}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
            {t("settings.models.auth.codexSignIn")}
          </button>
          {onSwitchToApiKey && (
            <button onClick={onSwitchToApiKey} className="text-[11px] text-muted hover:text-foreground font-sans">
              {t("settings.models.auth.switchToApiKey")}
            </button>
          )}
        </>
      )}

      {phase === "pending" && (
        <>
          <div className="text-[12px] text-foreground font-sans">{t("settings.models.auth.codexPending")}</div>
          {loginUrl && (
            <div className="flex items-center gap-2 rounded-md px-3 py-2" style={{ backgroundColor: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
              <span className="flex-1 truncate text-[11px] font-mono text-muted">{loginUrl}</span>
              <button onClick={() => openUrl(loginUrl).catch(() => {})} className="text-muted hover:text-foreground"><ExternalLink size={13} /></button>
              <button onClick={() => copyValue(loginUrl)} className="text-muted hover:text-foreground">{copied ? <Check size={13} /> : <Copy size={13} />}</button>
            </div>
          )}
          {userCode && (
            <button
              onClick={() => copyValue(userCode)}
              className="flex items-center justify-center gap-2 rounded-md px-3 py-2 text-[18px] font-mono tracking-[0.2em]"
              style={{ backgroundColor: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-foreground)" }}
            >
              {userCode}
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          )}
          <button onClick={cancelSignIn} className="text-[11px] text-muted hover:text-foreground font-sans">
            {t("settings.models.auth.cancel")}
          </button>
        </>
      )}

      {phase === "signedIn" && account && (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-foreground font-sans truncate">
                {t("settings.models.auth.signedInAs", { email: account.email ?? formatPlan(account.planType) })}
              </div>
              <div className="mt-1 text-[11px] text-muted font-sans">
                {t("settings.models.auth.planLabel")}: {formatPlan(account.planType)}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => readAccount(true, true)}
                disabled={busy}
                title={t("settings.models.auth.refresh")}
                className="p-2 rounded-md text-muted hover:text-foreground hover:bg-border transition-colors disabled:opacity-60"
              >
                <RefreshCw size={14} className={readStatus === "refreshing" ? "animate-spin" : ""} />
              </button>
              <button onClick={signOut} disabled={busy} className="p-2 rounded-md text-muted hover:text-red-400 hover:bg-border transition-colors disabled:opacity-60">
                <LogOut size={14} />
              </button>
            </div>
          </div>
          {(fiveHourLimit || weeklyLimit) && (
            <div className="flex flex-col gap-3 rounded-md px-3 py-2.5" style={{ backgroundColor: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
              {fiveHourLimit && <CodexRateLimitBar label={t("settings.models.auth.codexFiveHourLimit")} limit={fiveHourLimit} />}
              {weeklyLimit && <CodexRateLimitBar label={t("settings.models.auth.codexWeeklyLimit")} limit={weeklyLimit} />}
            </div>
          )}
          <div className="text-[11px] text-muted font-sans">
            {readStatus === "refreshing"
              ? t("settings.models.auth.refreshing")
              : readStatus === "success"
                ? t("settings.models.auth.refreshSuccess")
                : t("settings.models.auth.codexSecured")}
          </div>
        </>
      )}

      {error && (
        <div className="rounded-md px-3 py-2 text-[11px] font-sans" style={{ color: "var(--color-voice-rec)", backgroundColor: "color-mix(in srgb, var(--color-voice-rec) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--color-voice-rec) 35%, transparent)" }}>
          {t("settings.models.auth.errorExchange", { error })}
        </div>
      )}
    </div>
  );
}
