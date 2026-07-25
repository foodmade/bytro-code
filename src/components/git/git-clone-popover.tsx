import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GitBranch,
  X,
  Link,
  Folder,
  FolderOpen,
  TextCursorInput,
  Download,
  Loader,
  CheckCircle2,
  ShieldAlert,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useClickOutside } from "@/hooks";
import {
  defaultGitUsernameFromUrl,
  getGitHost,
  getGitPlatformFromUrl,
  isGitAuthFailure,
  isHttpGitUrl,
  type GitAuthCredentials,
  type GitRepoAccessResult,
} from "@/lib/git-clone-auth";
import { buildGitTokensMap } from "@/stores/git-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores";
import { useAppStore } from "@/stores";
import { GitCloneAuthDialog } from "./git-clone-auth-dialog";

type AccessStatus = "idle" | "checking" | "accessible" | "authRequired" | "denied";

/** Minimal git-URL shape check (https://, git://, ssh://, or user@host:path) */
function looksLikeGitUrl(url: string): boolean {
  const trimmed = url.trim();
  return /^(https?|git|ssh):\/\/.+/i.test(trimmed) || /^.+@.+:.+/i.test(trimmed);
}

interface GitClonePopoverProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly anchorRef: React.RefObject<HTMLElement | null>;
}

export function GitClonePopover({ open: isOpen, onClose, anchorRef }: GitClonePopoverProps) {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [isVisible, setIsVisible] = useState(false);

  const [repoUrl, setRepoUrl] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [projectName, setProjectName] = useState("");
  const [isCloning, setIsCloning] = useState(false);
  const [error, setError] = useState("");
  const [accessStatus, setAccessStatus] = useState<AccessStatus>("idle");
  const [authCredentials, setAuthCredentials] = useState<GitAuthCredentials | null>(null);
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [authError, setAuthError] = useState("");
  const [isVerifyingAuth, setIsVerifyingAuth] = useState(false);

  // Track the latest check to ignore stale results
  const checkIdRef = useRef(0);
  const promptedAuthUrlRef = useRef("");

  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const setActiveView = useAppStore((s) => s.setActiveView);

  useClickOutside(popoverRef, onClose, isOpen && !authDialogOpen);

  // Derive default project name from URL
  const derivedName =
    repoUrl
      .trim()
      .replace(/\/$/, "")
      .split("/")
      .pop()
      ?.replace(/\.git$/, "") ?? "";

  // ── Debounced repo access check ──────────────────────────────────
  useEffect(() => {
    const url = repoUrl.trim();

    // Reset when empty or not a valid-looking URL
    if (!url || !looksLikeGitUrl(url)) {
      setAccessStatus("idle");
      setError("");
      return;
    }

    setAccessStatus("checking");
    setError("");

    const id = ++checkIdRef.current;
    const timer = setTimeout(async () => {
      try {
        const result = await invoke<GitRepoAccessResult>("git_check_repo_access_details", {
          url,
          gitTokens: buildGitTokensMap(),
          credentials: authCredentials,
        });
        // Ignore if a newer check has been queued
        if (id !== checkIdRef.current) return;
        if (result.accessible) {
          setAccessStatus("accessible");
          setError("");
          return;
        }
        if (result.auth_required) {
          setAccessStatus("authRequired");
          setError(t("gitClone.auth.required", "Authentication required"));
          if (isHttpGitUrl(url) && !authCredentials && promptedAuthUrlRef.current !== url) {
            promptedAuthUrlRef.current = url;
            setAuthDialogOpen(true);
          }
          return;
        }
        setAccessStatus("denied");
        if (!result.accessible) {
          setError(
            t("gitClone.notPublicRepo", "This is not a public repository or the URL is invalid"),
          );
        }
      } catch {
        if (id !== checkIdRef.current) return;
        setAccessStatus("denied");
        setError(t("gitClone.checkFailed", "Unable to verify repository access"));
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [authCredentials, repoUrl, t]);

  // ── Position calculation ─────────────────────────────────────────
  useLayoutEffect(() => {
    if (!isOpen || !anchorRef.current || !popoverRef.current) return;

    const rect = anchorRef.current.getBoundingClientRect();
    const popoverHeight = popoverRef.current.offsetHeight;
    const popoverWidth = 320;
    const gap = 8;

    let top = rect.bottom - popoverHeight;
    const left = rect.right + gap;

    if (top < 10) top = 10;
    if (top + popoverHeight > window.innerHeight - 10) {
      top = window.innerHeight - popoverHeight - 10;
    }

    const maxLeft = window.innerWidth - popoverWidth - 10;
    setPosition({
      top: Math.max(10, top),
      left: Math.min(left, maxLeft),
    });
  }, [isOpen, anchorRef]);

  // Fade-in animation
  useEffect(() => {
    if (!isOpen) {
      setIsVisible(false);
      return;
    }
    requestAnimationFrame(() => setIsVisible(true));
    return () => setIsVisible(false);
  }, [isOpen]);

  // Focus URL input on open
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => urlInputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !authDialogOpen) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [authDialogOpen, isOpen, onClose]);

  // Reset state when closed
  useEffect(() => {
    if (!isOpen) {
      setRepoUrl("");
      setTargetDir("");
      setProjectName("");
      setError("");
      setIsCloning(false);
      setAccessStatus("idle");
      setAuthCredentials(null);
      setAuthDialogOpen(false);
      setAuthError("");
      setIsVerifyingAuth(false);
      promptedAuthUrlRef.current = "";
      checkIdRef.current++;
    }
  }, [isOpen]);

  const handleBrowseDir = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        setTargetDir(selected as string);
      }
    } catch {
      // User cancelled
    }
  }, []);

  const canClone = accessStatus === "accessible" && !isCloning;

  const handleClone = useCallback(async () => {
    if (!canClone) return;
    const url = repoUrl.trim();
    if (!targetDir.trim()) {
      setError(t("gitClone.errorDirRequired", "Please select a target directory"));
      return;
    }

    setIsCloning(true);
    setError("");

    try {
      const clonedPath = await invoke<string>("git_clone_repo", {
        url,
        targetDir: targetDir.trim(),
        name: projectName.trim() || null,
        branch: null,
        gitTokens: buildGitTokensMap(),
        credentials: authCredentials,
      });
      await addWorkspace(clonedPath);
      setActiveView("workspace");
      onClose();
    } catch (err) {
      if (isHttpGitUrl(url) && isGitAuthFailure(err)) {
        setAccessStatus("authRequired");
        setAuthError(
          t(
            "gitClone.auth.cloneFailed",
            "Authentication failed. Check your username and password or token.",
          ),
        );
        setAuthDialogOpen(true);
        return;
      }
      setError(String(err));
    } finally {
      setIsCloning(false);
    }
  }, [
    authCredentials,
    canClone,
    repoUrl,
    targetDir,
    projectName,
    addWorkspace,
    setActiveView,
    onClose,
    t,
  ]);

  const handleAuthSubmit = useCallback(
    async (credentials: GitAuthCredentials, remember: boolean) => {
      const url = repoUrl.trim();
      if (!url) return;

      setIsVerifyingAuth(true);
      setAuthError("");

      try {
        const result = await invoke<GitRepoAccessResult>("git_check_repo_access_details", {
          url,
          gitTokens: buildGitTokensMap(),
          credentials,
        });

        if (!result.accessible) {
          setAccessStatus(result.auth_required ? "authRequired" : "denied");
          setAuthError(
            result.auth_required
              ? t("gitClone.auth.invalid", "Unable to authenticate with these credentials.")
              : result.message ||
                  t("gitClone.auth.invalid", "Unable to authenticate with these credentials."),
          );
          return;
        }

        if (remember) {
          const platform = getGitPlatformFromUrl(url);
          if (platform) {
            useSettingsStore.getState().setGitToken(platform, credentials.password);
            if (credentials.username) {
              useSettingsStore.getState().setGitUsername(platform, credentials.username);
            }
          } else {
            // Self-hosted host (GitLab/GitHub/Gitea on a custom domain): save
            // host-keyed credentials so later clone/push/pull can reuse them.
            const host = getGitHost(url);
            if (host) {
              useSettingsStore
                .getState()
                .setGitHostCredential(host, credentials.username ?? "", credentials.password);
            }
          }
        }

        setAuthCredentials(credentials);
        setAccessStatus("accessible");
        setError("");
        setAuthDialogOpen(false);
      } catch (err) {
        setAuthError(String(err));
      } finally {
        setIsVerifyingAuth(false);
      }
    },
    [repoUrl, t],
  );

  if (!isOpen) return null;

  // ── URL input border colour based on access status ───────────────
  const urlBorderColor =
    accessStatus === "accessible"
      ? "var(--color-accent-green)"
      : accessStatus === "authRequired"
        ? "var(--color-accent-amber)"
        : accessStatus === "denied"
          ? "#EF4444"
          : "var(--color-border-strong)";

  const inputStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    height: 34,
    borderRadius: 8,
    backgroundColor: "var(--color-border)",
    padding: "0 10px",
    border: "1px solid var(--color-border-strong)",
    width: "100%",
  };

  const inputFieldStyle: React.CSSProperties = {
    flex: 1,
    background: "none",
    border: "none",
    outline: "none",
    fontSize: 12,
    fontFamily: "var(--font-sans)",
    color: "var(--color-foreground)",
    minWidth: 0,
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 500,
    fontFamily: "var(--font-sans)",
    color: "var(--color-muted-foreground)",
  };

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="false"
      aria-label="Clone Repository"
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        width: 320,
        zIndex: 100,
        borderRadius: 14,
        display: "flex",
        flexDirection: "column",
        background: "var(--color-card)",
        border: "1px solid color-mix(in srgb, #ffffff 3%, transparent)",
        boxShadow: "var(--popup-shadow)",
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? "translateY(0)" : "translateY(8px)",
        transition: "opacity 0.2s ease, transform 0.2s ease",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 44,
          padding: "0 16px",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <GitBranch size={16} style={{ color: "var(--color-accent-purple)" }} />
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "var(--font-sans)",
              color: "var(--color-foreground)",
            }}
          >
            {t("gitClone.title", "Clone Repository")}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            width: 22,
            height: 22,
            border: "none",
            background: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            borderRadius: 4,
          }}
          className="hover:bg-hover-overlay/[0.08]"
        >
          <X size={14} style={{ color: "var(--color-muted)" }} />
        </button>
      </div>

      {/* Divider */}
      <div style={{ height: 1, backgroundColor: "var(--color-border)", flexShrink: 0 }} />

      {/* Body */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 14,
          padding: "14px 16px",
        }}
      >
        {/* URL field */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={labelStyle}>{t("gitClone.repoUrl", "仓库地址")}</span>
          <div
            style={{
              ...inputStyle,
              borderColor: urlBorderColor,
              transition: "border-color 0.2s ease",
            }}
          >
            <Link size={14} style={{ color: "var(--color-muted)", flexShrink: 0 }} />
            <input
              ref={urlInputRef}
              type="text"
              value={repoUrl}
              onChange={(e) => {
                setRepoUrl(e.target.value);
                setAuthCredentials(null);
                setAuthError("");
                promptedAuthUrlRef.current = "";
                setError("");
              }}
              placeholder="https://github.com/user/repo.git"
              style={{
                ...inputFieldStyle,
                color: repoUrl ? "var(--color-foreground)" : undefined,
              }}
            />
            {/* Status indicator */}
            {accessStatus === "checking" && (
              <Loader
                size={13}
                className="animate-spin"
                style={{ color: "var(--color-muted)", flexShrink: 0 }}
              />
            )}
            {accessStatus === "accessible" && (
              <CheckCircle2
                size={13}
                style={{ color: "var(--color-accent-green)", flexShrink: 0 }}
              />
            )}
            {accessStatus === "authRequired" && (
              <ShieldAlert
                size={13}
                style={{ color: "var(--color-accent-amber)", flexShrink: 0 }}
              />
            )}
            {accessStatus === "denied" && (
              <ShieldAlert size={13} style={{ color: "#EF4444", flexShrink: 0 }} />
            )}
          </div>
          {/* Access status hint */}
          {accessStatus === "checking" && (
            <span
              style={{ fontSize: 10, fontFamily: "var(--font-sans)", color: "var(--color-muted)" }}
            >
              {t("gitClone.checking", "正在检测仓库可访问性...")}
            </span>
          )}
          {accessStatus === "accessible" && (
            <span
              style={{
                fontSize: 10,
                fontFamily: "var(--font-sans)",
                color: "var(--color-accent-green)",
              }}
            >
              {t("gitClone.repoAccessible", "仓库可访问")}
            </span>
          )}
          {accessStatus === "authRequired" && (
            <button
              type="button"
              onClick={() => {
                setAuthError("");
                setAuthDialogOpen(true);
              }}
              style={{
                alignSelf: "flex-start",
                padding: 0,
                border: "none",
                background: "transparent",
                color: "var(--color-accent-amber)",
                cursor: "pointer",
                fontSize: 10,
                fontFamily: "var(--font-sans)",
                fontWeight: 600,
              }}
            >
              {t("gitClone.auth.enterCredentials", "Enter credentials")}
            </button>
          )}
        </div>

        {/* Directory field */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={labelStyle}>{t("gitClone.localDir", "本地目录")}</span>
          <div style={{ display: "flex", gap: 6 }}>
            <div style={{ ...inputStyle, flex: 1 }}>
              <Folder size={14} style={{ color: "var(--color-muted)", flexShrink: 0 }} />
              <input
                type="text"
                value={targetDir}
                onChange={(e) => {
                  setTargetDir(e.target.value);
                  setError("");
                }}
                placeholder="~/Projects"
                style={inputFieldStyle}
              />
            </div>
            <button
              type="button"
              onClick={handleBrowseDir}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: 34,
                padding: "0 10px",
                borderRadius: 8,
                backgroundColor: "var(--color-border)",
                border: "1px solid var(--color-border-strong)",
                cursor: "pointer",
                flexShrink: 0,
              }}
              className="hover:bg-hover-overlay/[0.08]"
            >
              <FolderOpen size={14} style={{ color: "var(--color-muted-foreground)" }} />
            </button>
          </div>
        </div>

        {/* Project name field */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={labelStyle}>{t("gitClone.projectName", "项目名称")}</span>
          <div style={inputStyle}>
            <TextCursorInput size={14} style={{ color: "var(--color-muted)", flexShrink: 0 }} />
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder={derivedName || "repo"}
              style={inputFieldStyle}
            />
          </div>
          <span
            style={{
              fontSize: 10,
              fontFamily: "var(--font-sans)",
              color: "var(--color-muted)",
            }}
          >
            {t("gitClone.nameHint", "默认使用仓库名称")}
          </span>
        </div>

        {/* Error message */}
        {error && (
          <span
            style={{
              fontSize: 11,
              fontFamily: "var(--font-sans)",
              color: "#EF4444",
              lineHeight: 1.4,
              wordBreak: "break-word",
            }}
          >
            {error}
          </span>
        )}
      </div>

      {/* Divider */}
      <div style={{ height: 1, backgroundColor: "var(--color-border)", flexShrink: 0 }} />

      {/* Footer */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 8,
          height: 48,
          padding: "0 16px",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={onClose}
          disabled={isCloning}
          style={{
            height: 30,
            padding: "0 14px",
            borderRadius: 7,
            backgroundColor: "transparent",
            border: "1px solid var(--color-border-strong)",
            cursor: isCloning ? "not-allowed" : "pointer",
            fontSize: 12,
            fontWeight: 500,
            fontFamily: "var(--font-sans)",
            color: "var(--color-muted-foreground)",
            opacity: isCloning ? 0.5 : 1,
          }}
          className="hover:bg-hover-overlay/[0.06]"
        >
          {t("gitClone.cancel", "取消")}
        </button>
        <button
          type="button"
          onClick={handleClone}
          disabled={!canClone}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            height: 30,
            padding: "0 14px",
            borderRadius: 7,
            backgroundColor: "var(--color-accent-purple)",
            border: "none",
            cursor: canClone ? "pointer" : "not-allowed",
            fontSize: 12,
            fontWeight: 600,
            fontFamily: "var(--font-sans)",
            color: "#FFFFFF",
            opacity: canClone ? 1 : 0.5,
          }}
        >
          {isCloning ? (
            <Loader size={13} className="animate-spin" style={{ color: "#FFFFFF" }} />
          ) : (
            <Download size={13} style={{ color: "#FFFFFF" }} />
          )}
          <span>
            {isCloning ? t("gitClone.cloning", "Cloning...") : t("gitClone.clone", "Clone")}
          </span>
        </button>
      </div>
      <GitCloneAuthDialog
        open={authDialogOpen}
        repoUrl={repoUrl.trim()}
        defaultUsername={defaultGitUsernameFromUrl(repoUrl)}
        canRemember={isHttpGitUrl(repoUrl.trim())}
        error={authError}
        isSubmitting={isVerifyingAuth}
        onCancel={() => {
          if (isVerifyingAuth) return;
          setAuthDialogOpen(false);
          setAuthError("");
        }}
        onSubmit={handleAuthSubmit}
      />
    </div>
  );
}
