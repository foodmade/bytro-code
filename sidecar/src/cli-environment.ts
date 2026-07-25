/**
 * Build the environment for a user-installed CLI without inheriting unrelated
 * application credentials or runtime projections.
 */

export const SAFE_OS_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "USER",
  "USERNAME",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

export function buildMinimalCliEnvironment(
  explicit: Record<string, string | undefined>,
  providerKeys: ReadonlyArray<string>,
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of SAFE_OS_ENV_KEYS) {
    const value = explicit[key] ?? ambient[key];
    if (value !== undefined) result[key] = value;
  }
  for (const key of providerKeys) {
    const value = explicit[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
