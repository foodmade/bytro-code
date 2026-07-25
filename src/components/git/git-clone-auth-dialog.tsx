import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, KeyRound, Loader2, X } from "lucide-react";
import type { GitAuthCredentials } from "@/lib/git-clone-auth";

interface GitCloneAuthDialogProps {
  readonly open: boolean;
  readonly repoUrl: string;
  readonly defaultUsername: string;
  readonly canRemember: boolean;
  readonly error: string;
  readonly isSubmitting: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (credentials: GitAuthCredentials, remember: boolean) => void;
}

export function GitCloneAuthDialog({
  open,
  repoUrl,
  defaultUsername,
  canRemember,
  error,
  isSubmitting,
  onCancel,
  onSubmit,
}: GitCloneAuthDialogProps) {
  const { t } = useTranslation();
  const [username, setUsername] = useState(defaultUsername);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUsername(defaultUsername);
    setPassword("");
    setRemember(false);
    setShowPassword(false);
  }, [defaultUsername, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSubmitting) {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isSubmitting, onCancel, open]);

  if (!open) return null;

  const trimmedPassword = password.trim();
  const canSubmit = trimmedPassword.length > 0 && !isSubmitting;
  const hostLabel = getHostLabel(repoUrl);

  return createPortal(
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 500,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "color-mix(in srgb, var(--color-background) 62%, transparent)",
        backdropFilter: "blur(8px)",
        padding: 20,
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={t("gitClone.auth.title", "Git Authentication")}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          onSubmit(
            {
              username: username.trim() || null,
              password: trimmedPassword,
            },
            remember && canRemember,
          );
        }}
        style={{
          width: "min(420px, 100%)",
          borderRadius: 12,
          backgroundColor: "var(--color-card)",
          border: "1px solid var(--color-border)",
          boxShadow: "var(--popup-shadow)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            minHeight: 48,
            padding: "0 16px",
            borderBottom: "1px solid var(--color-border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <KeyRound size={16} style={{ color: "var(--color-accent-purple)", flexShrink: 0 }} />
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--color-foreground)",
                }}
              >
                {t("gitClone.auth.title", "Git Authentication")}
              </span>
              {hostLabel && (
                <span
                  style={{
                    fontFamily: "var(--font-sans)",
                    fontSize: 11,
                    color: "var(--color-muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {hostLabel}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            style={{
              width: 28,
              height: 28,
              border: "none",
              borderRadius: 6,
              backgroundColor: "transparent",
              color: "var(--color-muted)",
              cursor: isSubmitting ? "not-allowed" : "pointer",
              opacity: isSubmitting ? 0.5 : 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <X size={15} />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: 16 }}>
          <p
            style={{
              margin: 0,
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              lineHeight: 1.5,
              color: "var(--color-muted-foreground)",
            }}
          >
            {t(
              "gitClone.auth.description",
              "This repository requires HTTPS credentials. Enter your account password or a personal access token.",
            )}
          </p>

          <label style={fieldStyle}>
            <span style={labelStyle}>{t("gitClone.auth.username", "Username")}</span>
            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={t("gitClone.auth.usernamePlaceholder", "Optional username")}
              autoComplete="username"
              style={inputStyle}
            />
          </label>

          <label style={fieldStyle}>
            <span style={labelStyle}>{t("gitClone.auth.password", "Password or token")}</span>
            <div style={{ ...inputStyle, display: "flex", alignItems: "center", padding: 0 }}>
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t("gitClone.auth.passwordPlaceholder", "Password or access token")}
                autoComplete="current-password"
                autoFocus
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: "100%",
                  padding: "0 12px",
                  border: "none",
                  outline: "none",
                  backgroundColor: "transparent",
                  color: "var(--color-foreground)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 13,
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                style={{
                  width: 34,
                  height: 34,
                  border: "none",
                  backgroundColor: "transparent",
                  color: "var(--color-muted)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </label>

          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              opacity: canRemember ? 1 : 0.55,
              cursor: canRemember ? "pointer" : "not-allowed",
            }}
          >
            <input
              type="checkbox"
              checked={remember && canRemember}
              disabled={!canRemember || isSubmitting}
              onChange={(event) => setRemember(event.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 12,
                lineHeight: 1.4,
                color: "var(--color-muted-foreground)",
              }}
            >
              {canRemember
                ? t("gitClone.auth.remember", "Save to Git settings for this platform")
                : t(
                    "gitClone.auth.rememberUnsupported",
                    "Saving is available for GitHub, Gitee, and GitLab URLs only",
                  )}
            </span>
          </label>

          {error && (
            <div
              style={{
                borderRadius: 8,
                padding: "8px 10px",
                backgroundColor: "color-mix(in srgb, var(--color-accent-danger) 10%, transparent)",
                color: "var(--color-accent-danger)",
                fontFamily: "var(--font-sans)",
                fontSize: 12,
                lineHeight: 1.4,
                wordBreak: "break-word",
              }}
            >
              {error}
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 16px",
            borderTop: "1px solid var(--color-border)",
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            style={secondaryButtonStyle(isSubmitting)}
          >
            {t("gitClone.auth.cancel", "Cancel")}
          </button>
          <button type="submit" disabled={!canSubmit} style={primaryButtonStyle(canSubmit)}>
            {isSubmitting && <Loader2 size={14} className="animate-spin" />}
            {isSubmitting
              ? t("gitClone.auth.submitting", "Verifying...")
              : t("gitClone.auth.submit", "Use Credentials")}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--color-foreground)",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 36,
  borderRadius: 8,
  border: "1px solid var(--color-border-strong)",
  backgroundColor: "var(--color-background)",
  padding: "0 12px",
  outline: "none",
  color: "var(--color-foreground)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
};

function secondaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    height: 32,
    padding: "0 14px",
    borderRadius: 7,
    border: "1px solid var(--color-border-strong)",
    backgroundColor: "transparent",
    color: "var(--color-muted-foreground)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    fontWeight: 600,
  };
}

function primaryButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    height: 32,
    padding: "0 14px",
    borderRadius: 7,
    border: "none",
    backgroundColor: "var(--color-accent-purple)",
    color: "#ffffff",
    cursor: enabled ? "pointer" : "not-allowed",
    opacity: enabled ? 1 : 0.5,
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    gap: 6,
  };
}

function getHostLabel(repoUrl: string): string {
  try {
    const parsed = new URL(repoUrl.trim());
    return parsed.host;
  } catch {
    return repoUrl.trim();
  }
}
