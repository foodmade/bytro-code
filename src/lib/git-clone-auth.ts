import type { GitPlatformId } from "@/stores/settings-store";

export interface GitAuthCredentials {
  readonly username: string | null;
  readonly password: string;
}

export interface GitRepoAccessResult {
  readonly accessible: boolean;
  readonly auth_required: boolean;
  readonly message: string | null;
}

export function isHttpGitUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return normalized.startsWith("https://") || normalized.startsWith("http://");
}

export function defaultGitUsernameFromUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    return parsed.username ? decodeURIComponent(parsed.username) : "";
  } catch {
    return "";
  }
}

export function getGitPlatformFromUrl(url: string): GitPlatformId | null {
  const host = getGitHost(url);
  if (!host) return null;
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (host === "gitee.com" || host.endsWith(".gitee.com")) return "gitee";
  if (host === "gitlab.com" || host.endsWith(".gitlab.com")) return "gitlab";
  return null;
}

export function isGitAuthFailure(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (message.includes("proxy authentication") || message.includes("407")) return false;

  return (
    message.includes("authentication") ||
    message.includes("authorization") ||
    message.includes("could not read username") ||
    message.includes("could not read password") ||
    message.includes("no suitable credentials") ||
    message.includes("terminal prompts disabled") ||
    message.includes("http basic") ||
    message.includes("access denied") ||
    message.includes("permission denied") ||
    message.includes("repository not found") ||
    message.includes("401") ||
    message.includes("403")
  );
}

export function getGitHost(url: string): string {
  const trimmed = url.trim();

  try {
    const parsed = new URL(trimmed);
    return parsed.hostname.toLowerCase();
  } catch {
    // SCP-like SSH URL: git@github.com:owner/repo.git
    const match = trimmed.match(/^[^@]+@([^:/]+)(?::|\/)/);
    return match?.[1]?.toLowerCase() ?? "";
  }
}
