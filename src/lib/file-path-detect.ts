// Conservative heuristic for deciding whether an inline-code token in chat
// markdown is a clickable file path. Tuned to avoid false positives on prose,
// commands, URLs and version numbers — when in doubt it returns false, and the
// click handler additionally verifies existence on disk before opening.

// Extensions accepted for a *bare* filename (no path separator). Kept to a
// curated list so tokens like "e.g", "i.e" or "U.S" are not treated as files.
const BARE_FILENAME_EXTENSIONS = new Set([
  // web / js
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "vue", "svelte",
  // markup / style
  "html", "htm", "css", "scss", "sass", "less", "md", "mdx", "txt", "csv", "log",
  // systems / backend
  "rs", "toml", "lock", "go", "py", "rb", "java", "kt", "kts", "swift",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "scala", "clj", "ex", "exs", "lua",
  // shell / config
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "yml", "yaml", "xml", "ini", "conf", "env", "properties",
  "sql", "graphql", "gql", "proto",
  // dotfiles (extension == name after the leading dot)
  "gitignore", "dockerignore", "npmrc", "editorconfig", "prettierrc", "eslintrc",
  // assets / docs
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "pdf",
]);

const ABSOLUTE_PREFIX = /^(\/|\.\/|\.\.\/|~\/)/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC = /^\\\\/;
const PROTOCOL = /^[a-z][a-z0-9+.-]*:\/\//i;
const VERSION_NUMBER = /^v?\d+(\.\d+)+$/;

/** Extract a lowercase, letter-initial extension, or null when there is none. */
function extensionOf(basename: string): string | null {
  const dot = basename.lastIndexOf(".");
  // no dot, or trailing dot ("file.") → no extension
  if (dot < 0 || dot === basename.length - 1) return null;
  const ext = basename.slice(dot + 1).toLowerCase();
  // Require the extension to start with a letter so numeric tails like the
  // ".5" of "1/2.5" are not mistaken for an extension.
  if (!/^[a-z][a-z0-9]*$/.test(ext)) return null;
  return ext;
}

/**
 * Returns true when `raw` looks like a file path worth making clickable.
 * Intended for the contents of an inline `code` span in chat markdown.
 */
export function looksLikeFilePath(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  // A path is a single token — whitespace means a command or prose snippet.
  if (/\s/.test(text)) return false;
  // URLs are already handled by the markdown link renderer.
  if (PROTOCOL.test(text)) return false;
  // Bare version numbers like 1.2.3 / v2.0.
  if (VERSION_NUMBER.test(text)) return false;

  // Explicit absolute / relative / Windows prefixes are always paths.
  if (ABSOLUTE_PREFIX.test(text) || WINDOWS_DRIVE.test(text) || WINDOWS_UNC.test(text)) {
    return true;
  }

  const hasSeparator = text.includes("/") || text.includes("\\");
  const basename = text.split(/[\\/]/).pop() ?? text;
  const ext = extensionOf(basename);

  // With separators, any real extension on the last segment is enough
  // (e.g. "src/lib/foo.ts", "@scope/pkg/index.ts"). This also excludes
  // separator tokens without an extension like "and/or" or "@scope/pkg".
  if (hasSeparator) {
    return ext !== null;
  }

  // Bare filename — require a curated extension to stay conservative.
  return ext !== null && BARE_FILENAME_EXTENSIONS.has(ext);
}
