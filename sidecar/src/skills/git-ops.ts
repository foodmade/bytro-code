// ---------------------------------------------------------------------------
// Skills management — Git operations
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CLONE_TIMEOUT_MS = 60_000;
const INVALID_GIT_URL_MESSAGE =
  "Invalid Git repository URL. Use HTTPS without embedded credentials, query parameters, or fragments; configure authentication with Git credential storage.";

function validGitPath(value: string): boolean {
  const normalized = value.replace(/^\/+|\/+$/g, "");
  return (
    normalized.length > 0 &&
    normalized
      .split("/")
      .every(
        (segment) =>
          segment.length > 0 &&
          segment !== "." &&
          segment !== ".." &&
          /^[a-zA-Z0-9_.-]+$/.test(segment),
      )
  );
}

function publicGitOperationError(category: string, detail: unknown): Error {
  const raw = detail instanceof Error ? detail.message : String(detail);
  const digest = createHash("sha256").update(raw, "utf8").digest("hex");
  console.warn(
    `[skills-git] category=${category} len=${Buffer.byteLength(raw, "utf8")} sha256=${digest}`,
  );
  return new Error(`${category} (diagnosticId: ${digest.slice(0, 12)})`);
}

/**
 * Normalize a git URL input.
 * Supports:
 *   - Full HTTPS URL: https://github.com/owner/repo
 *   - Short form: owner/repo → https://github.com/owner/repo.git
 *   - Git SSH: git@github.com:owner/repo.git
 */
export function normalizeGitUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");

  if (trimmed.startsWith("https://")) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(INVALID_GIT_URL_MESSAGE);
    }
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !validGitPath(parsed.pathname)
    ) {
      throw new Error(INVALID_GIT_URL_MESSAGE);
    }
    parsed.pathname = parsed.pathname.endsWith(".git") ? parsed.pathname : `${parsed.pathname}.git`;
    return parsed.toString();
  }

  if (trimmed.startsWith("git@")) {
    const match = /^git@([a-zA-Z0-9.-]+):([a-zA-Z0-9_./-]+)$/.exec(trimmed);
    if (!match || match[1].startsWith(".") || match[1].endsWith(".") || !validGitPath(match[2])) {
      throw new Error(INVALID_GIT_URL_MESSAGE);
    }
    const repoPath = match[2].endsWith(".git") ? match[2] : `${match[2]}.git`;
    return `git@${match[1].toLowerCase()}:${repoPath}`;
  }

  // Short form: owner/repo
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}.git`;
  }

  throw new Error(INVALID_GIT_URL_MESSAGE);
}

/**
 * Shallow-clone a repository to a target directory.
 * Returns the HEAD commit hash of the cloned repo.
 *
 * Security hardening:
 * - Disables symlinks to prevent symlink-based path traversal
 * - Disables fsmonitor/protocol.file to block hook-like execution vectors
 * - Disables system-level git config and attributes
 * - Disables interactive prompts
 */
export async function cloneRepoShallow(repoUrl: string, targetDir: string): Promise<string> {
  const normalizedUrl = normalizeGitUrl(repoUrl);

  try {
    await execFileAsync(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--config",
        "core.symlinks=false",
        "--config",
        "core.fsmonitor=false",
        "--config",
        "protocol.file.allow=never",
        normalizedUrl,
        targetDir,
      ],
      {
        timeout: CLONE_TIMEOUT_MS,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
  } catch (error) {
    throw publicGitOperationError("Git clone failed", error);
  }

  return getRepoHeadHash(targetDir);
}

/** Get the HEAD commit hash of a local git repository. */
async function getRepoHeadHash(repoDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
    });
    return stdout.trim();
  } catch (error) {
    throw publicGitOperationError("Git revision check failed", error);
  }
}

export const __testing__ = {
  publicGitOperationError,
};
