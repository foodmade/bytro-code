import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FolderOpen,
  GitBranch,
  ArrowLeft,
  Link,
  Folder,
  Download,
  Loader,
  CheckCircle2,
  ShieldAlert,
  Info,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useOnboardingStore } from "@/stores/onboarding-store";
import {
  defaultGitUsernameFromUrl,
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
import { GitCloneAuthDialog } from "@/components/git/git-clone-auth-dialog";

type OnboardingView = "select" | "clone";
type AccessStatus = "idle" | "checking" | "accessible" | "authRequired" | "denied";

function looksLikeGitUrl(url: string): boolean {
  const trimmed = url.trim();
  return /^(https?|git|ssh):\/\/.+/i.test(trimmed) || /^.+@.+:.+/i.test(trimmed);
}

/* ── Project Select View (NnU5P) ─────────────────────────────────── */

function ProjectSelectView({
  onOpenProject,
  onGitClone,
}: {
  readonly onOpenProject: () => void;
  readonly onGitClone: () => void;
}) {
  const { t } = useTranslation();

  const cardStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    width: 280,
    height: 220,
    borderRadius: 16,
    backgroundColor: "var(--color-card)",
    border: "1px solid var(--color-border)",
    padding: 24,
    cursor: "pointer",
    transition: "border-color 0.2s ease, background-color 0.2s ease",
  };

  return (
    <div
      className="flex-1 flex items-center justify-center"
      style={{ flexDirection: "column", gap: 40 }}
    >
      {/* Title section */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
        <h1
          style={{
            fontSize: 28,
            fontWeight: 700,
            fontFamily: "var(--font-sans)",
            color: "var(--color-foreground)",
            margin: 0,
          }}
        >
          {t("onboarding.getStarted", "Get Started")}
        </h1>
        <p
          style={{
            fontSize: 13,
            fontFamily: "var(--font-sans)",
            color: "var(--color-muted)",
            margin: 0,
          }}
        >
          {t("onboarding.selectHow", "Select how you'd like to begin")}
        </p>
      </div>

      {/* Cards row */}
      <div style={{ display: "flex", gap: 20 }}>
        {/* Open Project card */}
        <button
          type="button"
          onClick={onOpenProject}
          style={
            {
              ...cardStyle,
              "--native-hover-border-color": "var(--color-border-strong)",
            } as React.CSSProperties
          }
          className="native-css-hover"
        >
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              backgroundColor: "rgba(66, 133, 244, 0.08)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <FolderOpen size={24} style={{ color: "#4285F4" }} />
          </div>
          <span
            style={{
              fontSize: 15,
              fontWeight: 600,
              fontFamily: "var(--font-sans)",
              color: "var(--color-foreground)",
            }}
          >
            {t("onboarding.openProject", "Open Project")}
          </span>
          <span
            style={{
              fontSize: 12,
              fontFamily: "var(--font-sans)",
              color: "var(--color-muted)",
              textAlign: "center",
              lineHeight: 1.5,
            }}
          >
            {t("onboarding.openProjectDesc", "Browse and open a local\nproject folder")}
          </span>
        </button>

        {/* Git Clone card */}
        <button
          type="button"
          onClick={onGitClone}
          style={
            {
              ...cardStyle,
              "--native-hover-border-color": "var(--color-border-strong)",
            } as React.CSSProperties
          }
          className="native-css-hover"
        >
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              backgroundColor: "rgba(var(--theme-accent-rgb),0.08)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <GitBranch size={24} style={{ color: "var(--color-accent-purple)" }} />
          </div>
          <span
            style={{
              fontSize: 15,
              fontWeight: 600,
              fontFamily: "var(--font-sans)",
              color: "var(--color-foreground)",
            }}
          >
            {t("onboarding.gitClone", "Git Clone")}
          </span>
          <span
            style={{
              fontSize: 12,
              fontFamily: "var(--font-sans)",
              color: "var(--color-muted)",
              textAlign: "center",
              lineHeight: 1.5,
            }}
          >
            {t("onboarding.gitCloneDesc", "Clone a repository from\nGitHub or other remote")}
          </span>
        </button>
      </div>

      {/* Footer */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Info size={12} style={{ color: "var(--color-muted)" }} />
        <span
          style={{
            fontSize: 11,
            fontFamily: "var(--font-sans)",
            color: "var(--color-muted)",
          }}
        >
          {t("onboarding.footerHint", "You can always change your project later from the sidebar")}
        </span>
      </div>
    </div>
  );
}

/* ── Git Clone View (XKFVo) ──────────────────────────────────────── */

function GitCloneView({ onBack }: { readonly onBack: () => void }) {
  const { t } = useTranslation();
  const urlInputRef = useRef<HTMLInputElement>(null);

  const [repoUrl, setRepoUrl] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [branch, setBranch] = useState("");
  const [isCloning, setIsCloning] = useState(false);
  const [error, setError] = useState("");
  const [accessStatus, setAccessStatus] = useState<AccessStatus>("idle");
  const [authCredentials, setAuthCredentials] = useState<GitAuthCredentials | null>(null);
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [authError, setAuthError] = useState("");
  const [isVerifyingAuth, setIsVerifyingAuth] = useState(false);
  const checkIdRef = useRef(0);
  const promptedAuthUrlRef = useRef("");

  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const completeOnboarding = useOnboardingStore((s) => s.completeOnboarding);

  const derivedName =
    repoUrl
      .trim()
      .replace(/\/$/, "")
      .split("/")
      .pop()
      ?.replace(/\.git$/, "") ?? "";

  // Focus URL input on mount
  useEffect(() => {
    setTimeout(() => urlInputRef.current?.focus(), 100);
  }, []);

  // Debounced repo access check
  useEffect(() => {
    const url = repoUrl.trim();
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
        if (id !== checkIdRef.current) return;
        if (result.accessible) {
          setAccessStatus("accessible");
          setError("");
          return;
        }
        if (result.auth_required) {
          setAccessStatus("authRequired");
          setError(t("onboarding.cloneAuthRequired", "Authentication required"));
          if (isHttpGitUrl(url) && !authCredentials && promptedAuthUrlRef.current !== url) {
            promptedAuthUrlRef.current = url;
            setAuthDialogOpen(true);
          }
          return;
        }
        setAccessStatus("denied");
        if (!result.accessible) {
          setError(
            t("onboarding.cloneNotPublic", "This is not a public repository or the URL is invalid"),
          );
        }
      } catch {
        if (id !== checkIdRef.current) return;
        setAccessStatus("denied");
        setError(t("onboarding.cloneCheckFailed", "Unable to verify repository access"));
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [authCredentials, repoUrl, t]);

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
      setError(t("onboarding.cloneDirRequired", "Please select a target directory"));
      return;
    }

    setIsCloning(true);
    setError("");

    try {
      const clonedPath = await invoke<string>("git_clone_repo", {
        url,
        targetDir: targetDir.trim(),
        name: null,
        branch: branch.trim() || null,
        gitTokens: buildGitTokensMap(),
        credentials: authCredentials,
      });
      await addWorkspace(clonedPath);
      await completeOnboarding();
      setActiveView("workspace");
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
    branch,
    addWorkspace,
    completeOnboarding,
    setActiveView,
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

  // Handle Enter key to trigger clone
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && canClone) {
        handleClone();
      }
    },
    [canClone, handleClone],
  );

  const urlBorderColor =
    accessStatus === "accessible"
      ? "var(--color-accent-green)"
      : accessStatus === "authRequired"
        ? "var(--color-accent-amber)"
        : accessStatus === "denied"
          ? "#EF4444"
          : "var(--color-border-strong)";

  const inputContainerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    height: 40,
    borderRadius: 10,
    backgroundColor: "var(--color-background)",
    padding: "0 14px",
    border: "1px solid var(--color-border-strong)",
    width: "100%",
  };

  const inputFieldStyle: React.CSSProperties = {
    flex: 1,
    background: "none",
    border: "none",
    outline: "none",
    fontSize: 13,
    fontFamily: "var(--font-sans)",
    color: "var(--color-foreground)",
    minWidth: 0,
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    fontFamily: "var(--font-sans)",
    color: "var(--color-foreground)",
    opacity: 0.85,
  };

  return (
    <div
      className="flex-1 flex items-center justify-center"
      style={{ flexDirection: "column", gap: 32 }}
    >
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          type="button"
          onClick={onBack}
          disabled={isCloning}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 12px",
            borderRadius: 8,
            backgroundColor: "var(--color-border)",
            border: "none",
            cursor: isCloning ? "not-allowed" : "pointer",
            opacity: isCloning ? 0.5 : 1,
          }}
        >
          <ArrowLeft size={14} style={{ color: "var(--color-muted-foreground)" }} />
          <span
            style={{
              fontSize: 12,
              fontWeight: 500,
              fontFamily: "var(--font-sans)",
              color: "var(--color-muted-foreground)",
            }}
          >
            {t("onboarding.back", "Back")}
          </span>
        </button>
        <h2
          style={{
            fontSize: 20,
            fontWeight: 700,
            fontFamily: "var(--font-sans)",
            color: "var(--color-foreground)",
            margin: 0,
          }}
        >
          {t("onboarding.cloneRepository", "Clone Repository")}
        </h2>
      </div>

      {/* Form card */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 20,
          width: 520,
          padding: 28,
          borderRadius: 16,
          backgroundColor: "var(--color-card)",
          border: "1px solid var(--color-border)",
        }}
        onKeyDown={handleKeyDown}
      >
        {/* Repository URL */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
          <span style={labelStyle}>{t("onboarding.repoUrl", "Repository URL")}</span>
          <div
            style={{
              ...inputContainerStyle,
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
              placeholder="https://github.com/user/repository.git"
              style={inputFieldStyle}
            />
            {accessStatus === "checking" && (
              <Loader
                size={14}
                className="animate-spin"
                style={{ color: "var(--color-muted)", flexShrink: 0 }}
              />
            )}
            {accessStatus === "accessible" && (
              <CheckCircle2
                size={14}
                style={{ color: "var(--color-accent-green)", flexShrink: 0 }}
              />
            )}
            {accessStatus === "authRequired" && (
              <ShieldAlert
                size={14}
                style={{ color: "var(--color-accent-amber)", flexShrink: 0 }}
              />
            )}
            {accessStatus === "denied" && (
              <ShieldAlert size={14} style={{ color: "#EF4444", flexShrink: 0 }} />
            )}
          </div>
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
                fontSize: 11,
                fontFamily: "var(--font-sans)",
                fontWeight: 600,
              }}
            >
              {t("gitClone.auth.enterCredentials", "Enter credentials")}
            </button>
          )}
        </div>

        {/* Local Path */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
          <span style={labelStyle}>{t("onboarding.localPath", "Local Path")}</span>
          <div style={{ display: "flex", gap: 8, width: "100%" }}>
            <div style={{ ...inputContainerStyle, flex: 1 }}>
              <Folder size={14} style={{ color: "var(--color-muted)", flexShrink: 0 }} />
              <input
                type="text"
                value={targetDir}
                onChange={(e) => {
                  setTargetDir(e.target.value);
                  setError("");
                }}
                placeholder={derivedName ? `~/Projects/${derivedName}` : "~/Projects"}
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
                height: 40,
                padding: "0 16px",
                borderRadius: 10,
                backgroundColor: "var(--color-border)",
                border: "1px solid var(--color-border-strong)",
                cursor: "pointer",
                flexShrink: 0,
                fontSize: 13,
                fontWeight: 500,
                fontFamily: "var(--font-sans)",
                color: "var(--color-muted-foreground)",
              }}
            >
              {t("onboarding.browse", "Browse")}
            </button>
          </div>
        </div>

        {/* Branch (optional) */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
          <span style={labelStyle}>{t("onboarding.branch", "Branch (optional)")}</span>
          <div style={inputContainerStyle}>
            <GitBranch size={14} style={{ color: "var(--color-muted)", flexShrink: 0 }} />
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              style={inputFieldStyle}
            />
          </div>
        </div>

        {/* Error message */}
        {error && (
          <span
            style={{
              fontSize: 12,
              fontFamily: "var(--font-sans)",
              color: "#EF4444",
              lineHeight: 1.4,
              wordBreak: "break-word",
            }}
          >
            {error}
          </span>
        )}

        {/* Divider */}
        <div style={{ height: 1, backgroundColor: "var(--color-border)", width: "100%" }} />

        {/* Clone button */}
        <button
          type="button"
          onClick={handleClone}
          disabled={!canClone}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            width: "100%",
            height: 42,
            borderRadius: 10,
            background: canClone
              ? "linear-gradient(180deg, #A855F7 0%, #7C3AED 100%)"
              : "linear-gradient(180deg, #A855F7 0%, #7C3AED 100%)",
            border: "none",
            cursor: canClone ? "pointer" : "not-allowed",
            opacity: canClone ? 1 : 0.5,
            transition: "opacity 0.2s ease",
          }}
        >
          {isCloning ? (
            <Loader size={16} className="animate-spin" style={{ color: "#FFFFFF" }} />
          ) : (
            <Download size={16} style={{ color: "#FFFFFF" }} />
          )}
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              fontFamily: "var(--font-sans)",
              color: "#FFFFFF",
            }}
          >
            {isCloning
              ? t("onboarding.cloning", "Cloning...")
              : t("onboarding.cloneRepo", "Clone Repository")}
          </span>
        </button>
      </div>

      {/* Tip row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Info size={12} style={{ color: "var(--color-muted)" }} />
        <span
          style={{
            fontSize: 11,
            fontFamily: "var(--font-sans)",
            color: "var(--color-muted)",
          }}
        >
          {t(
            "onboarding.cloneTip",
            "Supports HTTPS and SSH URLs from GitHub, GitLab, Bitbucket, and more",
          )}
        </span>
      </div>
      <GitCloneAuthDialog
        open={authDialogOpen}
        repoUrl={repoUrl.trim()}
        defaultUsername={defaultGitUsernameFromUrl(repoUrl)}
        canRemember={getGitPlatformFromUrl(repoUrl) !== null}
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

/* ── Main OnboardingPage ─────────────────────────────────────────── */

export function OnboardingPage() {
  const [view, setView] = useState<OnboardingView>("select");
  const [animDir, setAnimDir] = useState<"forward" | "backward">("forward");
  const [animKey, setAnimKey] = useState(0);

  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const completeOnboarding = useOnboardingStore((s) => s.completeOnboarding);

  const handleOpenProject = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        await addWorkspace(selected as string);
        await completeOnboarding();
        setActiveView("workspace");
      }
    } catch {
      // User cancelled
    }
  }, [addWorkspace, completeOnboarding, setActiveView]);

  const handleGitClone = useCallback(() => {
    setAnimDir("forward");
    setAnimKey((k) => k + 1);
    setView("clone");
  }, []);

  const handleBack = useCallback(() => {
    setAnimDir("backward");
    setAnimKey((k) => k + 1);
    setView("select");
  }, []);

  return (
    <div
      className="flex-1 flex flex-col relative overflow-hidden"
      style={{ backgroundColor: "var(--color-background)" }}
    >
      {/* Glow background */}
      <div
        style={{
          position: "absolute",
          top: "15%",
          left: "50%",
          transform: "translateX(-50%)",
          width: 800,
          height: 500,
          borderRadius: "50%",
          background:
            "radial-gradient(ellipse, rgba(var(--theme-accent-rgb),0.08) 0%, rgba(99, 102, 241, 0.04) 50%, transparent 100%)",
          pointerEvents: "none",
          filter: "blur(20px)",
        }}
      />

      {/* Content with slide animation */}
      <div
        key={`view-${view}-${animKey}`}
        className={`flex-1 flex flex-col ob-step-slide ob-step-slide-${animDir}`}
      >
        {view === "select" ? (
          <ProjectSelectView onOpenProject={handleOpenProject} onGitClone={handleGitClone} />
        ) : (
          <GitCloneView onBack={handleBack} />
        )}
      </div>
    </div>
  );
}
