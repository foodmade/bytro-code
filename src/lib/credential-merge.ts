// src/lib/credential-merge.ts
//
// Pure merge logic for applying locally-scanned provider credentials to the
// Settings draft. Kept separate from the modal component so the rules can be
// unit-tested without rendering React.

import { ALL_PLATFORM_IDS, CHANNEL_BASE_URLS, PLATFORM_REGISTRY } from "@/lib/platform-config";
import type { PlatformConfig, PlatformId, ProfileConfig } from "@/lib/platform-config";

/** Shape emitted by the Rust `scan_local_credentials` Tauri command. */
export interface ScannedCredential {
  readonly platformId: string;
  readonly source: "env" | "config_file";
  readonly sourceLabel: string;
  readonly baseUrl?: string | null;
  readonly apiKey: string;
  readonly apiKeyMasked: string;
  readonly configPath?: string | null;
}

const KNOWN_PLATFORM_IDS: ReadonlySet<string> = new Set(ALL_PLATFORM_IDS);

function isKnownPlatform(id: string): id is PlatformId {
  return KNOWN_PLATFORM_IDS.has(id);
}

function newProfileId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for very old environments.
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The baseUrl currently stored is considered "safe to overwrite" when it's
 *  empty or matches one of the platform's system-generated defaults (either the
 *  top-level default or any per-SDK channel default) — meaning the user hasn't
 *  customized it, so a scanned value is an upgrade, not a regression. */
function isOverridableBaseUrl(platformId: PlatformId, currentBaseUrl: string): boolean {
  const trimmed = currentBaseUrl.trim();
  if (trimmed === "") return true;
  if (trimmed === PLATFORM_REGISTRY[platformId].defaultBaseUrl.trim()) return true;
  const channelDefaults = CHANNEL_BASE_URLS[platformId];
  if (channelDefaults) {
    for (const url of Object.values(channelDefaults)) {
      if (url && trimmed === url.trim()) return true;
    }
  }
  return false;
}

function resolveBaseUrl(
  platformId: PlatformId,
  currentBaseUrl: string,
  scannedBaseUrl: string | null | undefined,
): string {
  const trimmedScanned = (scannedBaseUrl ?? "").trim();
  if (trimmedScanned && isOverridableBaseUrl(platformId, currentBaseUrl)) {
    return trimmedScanned;
  }
  return currentBaseUrl;
}

function buildImportedProfileName(importedProfileLabel: string): string {
  return importedProfileLabel;
}

/**
 * Returns the updated platforms map after applying the selected scanned credentials.
 * Rules:
 *  - For each scanned credential, locate the active profile of its platform.
 *  - If the active profile has no apiKey: fill in-place (baseUrl only overwritten
 *    when currently empty or equal to the default).
 *  - Otherwise: append a new profile named via `importedProfileLabel`, set it active.
 *  - Multiple credentials for the same platform: the first follows the rule above;
 *    subsequent ones are always appended as new profiles.
 *  - Unknown platform IDs are skipped (defensive against Rust/TS drift).
 */
export function mergeCredentials(
  draftPlatforms: Record<PlatformId, PlatformConfig>,
  selected: readonly ScannedCredential[],
  importedProfileLabel: string,
): Record<PlatformId, PlatformConfig> {
  if (selected.length === 0) return draftPlatforms;

  // Shallow-clone the outer map so we don't mutate the caller's draft.
  const next: Record<PlatformId, PlatformConfig> = { ...draftPlatforms };
  // Track which platforms have already consumed their in-place slot.
  const consumedInPlace = new Set<PlatformId>();

  for (const cred of selected) {
    if (!isKnownPlatform(cred.platformId)) continue;
    const platformId = cred.platformId;
    const current = next[platformId];
    if (!current) continue;

    const activeProfile =
      current.profiles.find((p) => p.id === current.activeProfileId) ?? current.profiles[0];

    // Ollama stores "ollama" as the placeholder key — treat it as "empty" so
    // scanned credentials can upgrade an untouched default.
    const activeKeyEmpty =
      activeProfile.apiKey.trim() === "" ||
      (platformId === "ollama" && activeProfile.apiKey === "ollama");

    const canFillInPlace = activeKeyEmpty && !consumedInPlace.has(platformId);

    if (canFillInPlace) {
      const nextBaseUrl = resolveBaseUrl(platformId, activeProfile.baseUrl, cred.baseUrl);
      const updatedProfiles = current.profiles.map((p) =>
        p.id === activeProfile.id
          ? { ...p, baseUrl: nextBaseUrl, apiKey: cred.apiKey, testPassed: false }
          : p,
      );
      next[platformId] = { ...current, profiles: updatedProfiles };
      consumedInPlace.add(platformId);
    } else {
      const meta = PLATFORM_REGISTRY[platformId];
      const newId = newProfileId();
      const newProfile: ProfileConfig = {
        id: newId,
        name: buildImportedProfileName(importedProfileLabel),
        baseUrl: (cred.baseUrl ?? "").trim() || meta.defaultBaseUrl,
        apiKey: cred.apiKey,
        testPassed: false,
      };
      next[platformId] = {
        ...next[platformId],
        profiles: [...next[platformId].profiles, newProfile],
        activeProfileId: newId,
      };
    }
  }

  return next;
}

/** Remove scanned entries whose apiKey already exists on any profile of the
 *  same platform. Explicit imports use this to avoid duplicate profiles.
 *  Unknown platforms are kept — the caller decides what to do with them. */
export function filterUnimportedCredentials(
  platforms: Record<PlatformId, PlatformConfig>,
  scanned: readonly ScannedCredential[],
): readonly ScannedCredential[] {
  return scanned.filter((cred) => {
    if (!isKnownPlatform(cred.platformId)) return true;
    const platform = platforms[cred.platformId];
    if (!platform) return true;
    return !platform.profiles.some((p) => p.apiKey === cred.apiKey);
  });
}
