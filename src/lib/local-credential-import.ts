import type { PlatformConfig, PlatformId } from "@/lib/platform-config";
import {
  filterUnimportedCredentials,
  mergeCredentials,
  type ScannedCredential,
} from "@/lib/credential-merge";

export interface LocalCredentialImportResult {
  readonly platforms: Record<PlatformId, PlatformConfig>;
  readonly importedCount: number;
}

type CredentialScanner = () => Promise<readonly ScannedCredential[]>;

/**
 * Read provider credentials only after the caller handles an explicit user
 * action, then copy new known-platform API keys into Bytro-owned settings.
 */
export async function scanAndMergeLocalCredentials(
  platforms: Record<PlatformId, PlatformConfig>,
  importedProfileLabel: string,
  scan: CredentialScanner,
): Promise<LocalCredentialImportResult> {
  const scanned = await scan();
  const selected = filterUnimportedCredentials(platforms, scanned).filter((credential) =>
    Object.prototype.hasOwnProperty.call(platforms, credential.platformId),
  );
  if (selected.length === 0) {
    return { platforms, importedCount: 0 };
  }
  return {
    platforms: mergeCredentials(platforms, selected, importedProfileLabel),
    importedCount: selected.length,
  };
}
