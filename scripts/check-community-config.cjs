const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const readText = (file) => fs.readFileSync(path.join(root, file), "utf8");
const exists = (file) => fs.existsSync(path.join(root, file));

function collectSourceFiles(directory) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];

  const files = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (["node_modules", "target", "dist", ".git"].includes(entry.name)) continue;
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(relative));
    } else if (/\.(?:rs|ts|tsx)$/.test(entry.name)) {
      files.push(relative);
    }
  }
  return files;
}

function requireIncludes(content, expected, message) {
  if (!content.includes(expected)) {
    throw new Error(message);
  }
}

function rejectIncludes(content, forbidden, message) {
  if (content.includes(forbidden)) {
    throw new Error(message);
  }
}

const base = readJson("src-tauri/tauri.conf.json");
const mac = readJson("src-tauri/tauri.macos.conf.json");
const windows = readJson("src-tauri/tauri.windows.conf.json");

if (base.productName !== "Bytro Community Edition") {
  throw new Error("Unexpected Tauri product name");
}
if (base.identifier !== "com.bytro.community") {
  throw new Error("Unexpected Tauri bundle identifier");
}
for (const config of [base, mac, windows]) {
  for (const window of config.app?.windows ?? []) {
    if (window.title !== "Bytro Community Edition") {
      throw new Error("Unexpected Tauri window title");
    }
  }
}

const expectedScopes = [
  "$TEMP/bytro-community-openai-images/**",
  "$TEMP/bytro-community-uploads/**",
  "$PICTURE/Bytro/**",
  "$DOCUMENT/Bytro/**",
];
const scopes = base.app?.security?.assetProtocol?.scope ?? [];
for (const scope of expectedScopes) {
  if (!scopes.includes(scope)) {
    throw new Error(`Missing asset protocol scope: ${scope}`);
  }
}

const serialized = JSON.stringify({ base, mac, windows }).toLowerCase();
const legacyName = ["agent", "hub"].join("");
if (serialized.includes(legacyName)) {
  throw new Error("Legacy branding remains in Tauri configuration");
}

const productionCsp = base.app?.security?.csp;
const developmentCsp = base.app?.security?.devCsp;
if (typeof productionCsp !== "string" || productionCsp.length === 0) {
  throw new Error("Production CSP is missing");
}
if (typeof developmentCsp !== "string" || developmentCsp.length === 0) {
  throw new Error("Development CSP is missing");
}
for (const providerDomain of [
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "openrouter.ai",
]) {
  if (productionCsp.includes(providerDomain)) {
    throw new Error(`Production CSP exposes provider domain: ${providerDomain}`);
  }
}

for (const removedFile of [
  "src-tauri/src/sync_bridge.rs",
  "src/components/settings/sync-settings.tsx",
  "src/stores/sync-store.ts",
]) {
  if (exists(removedFile)) {
    throw new Error(`Removed cross-CLI synchronization file is present: ${removedFile}`);
  }
}

const sourceFiles = [
  ...collectSourceFiles("src"),
  ...collectSourceFiles("src-tauri/src"),
  ...collectSourceFiles("sidecar/src"),
];
const sourceCorpus = sourceFiles.map(readText).join("\n");
for (const removedIdentifier of [
  "sync_mcp_to_platforms",
  "mod sync_bridge",
  "install_ollama",
  "installOllama",
  "set_ollama_registry_mirror",
]) {
  rejectIncludes(
    sourceCorpus,
    removedIdentifier,
    `Removed Community Edition capability remains: ${removedIdentifier}`,
  );
}
rejectIncludes(
  sourceCorpus.toLowerCase(),
  "claude-mem",
  "claude-mem integration remains in Community Edition source",
);

const projectMemory = readText("src/stores/project-memory-store.ts");
requireIncludes(
  projectMemory,
  '".bytro-community", "memory"',
  "Project memory is not stored in the Bytro-owned project directory",
);
rejectIncludes(
  projectMemory,
  'workspacePath, ".claude"',
  "Project memory must not target a provider-owned .claude directory",
);

const teamsProduction = readText("src-tauri/src/teams.rs").split("#[cfg(test)]", 1)[0];
rejectIncludes(
  teamsProduction,
  "create_dir_all",
  "Teams integration must not create provider-owned teams or tasks directories",
);

const skills = readText("src-tauri/src/sidecar/skills.rs");
requireIncludes(
  skills,
  "crate::bytro_home::skills_dir()",
  "Managed skills are not rooted in the Bytro Community home",
);
requireIncludes(
  skills,
  'if src != "manifest"',
  "Skill mutations do not enforce Bytro-managed sources",
);
requireIncludes(
  skills,
  "is read-only in Bytro Community Edition",
  "Provider/project skills are not marked read-only",
);
for (const rustGitBoundary of [
  "parsed.username().is_empty()",
  "parsed.query().is_some()",
  "parsed.fragment().is_some()",
  "public_skill_git_error",
  "source_repo: normalized_repo_url.clone()",
]) {
  requireIncludes(
    skills,
    rustGitBoundary,
    `Rust skills Git boundary is missing: ${rustGitBoundary}`,
  );
}
rejectIncludes(
  skills,
  'format!("git clone failed: {}", stderr.trim())',
  "Rust skills clone errors still expose raw Git stderr",
);
const sidecarSkillsManifest = readText("sidecar/src/skills/manifest.ts");
for (const legacySkillsMigration of [
  "getLegacySkillsDir",
  'path.join(os.homedir(), ".bytro", "skills")',
  "copyDirectoryWithoutLinks",
]) {
  rejectIncludes(
    sidecarSkillsManifest,
    legacySkillsMigration,
    `Sidecar skills still auto-import legacy product state: ${legacySkillsMigration}`,
  );
}
const sidecarSkillsGit = readText("sidecar/src/skills/git-ops.ts");
for (const sidecarGitBoundary of [
  "parsed.username",
  "parsed.search",
  "parsed.hash",
  "publicGitOperationError",
]) {
  requireIncludes(
    sidecarSkillsGit,
    sidecarGitBoundary,
    `Sidecar skills Git boundary is missing: ${sidecarGitBoundary}`,
  );
}
requireIncludes(
  readText("sidecar/src/skills/installer.ts"),
  "sourceRepo: normalizedRepoUrl",
  "Sidecar skills manifest still stores the unnormalized repository input",
);
const sidecarSkillsCli = readText("sidecar/src/skills-cli.ts");
requireIncludes(
  sidecarSkillsCli,
  "normalizedUrl = normalizeGitUrl(url)",
  "Skills CLI logs or uses repository input before URL validation",
);
rejectIncludes(
  sidecarSkillsCli,
  "c.dim(url)",
  "Skills CLI still prints the raw repository URL",
);
rejectIncludes(
  sidecarSkillsGit,
  "Invalid git URL format: ${input}",
  "Sidecar skills URL errors still echo credential-bearing input",
);

const bytroHomeProduction = readText("src-tauri/src/bytro_home.rs").split("#[cfg(test)]", 1)[0];
for (const providerHome of ['join(".claude")', 'join(".codex")', 'join(".gemini")']) {
  rejectIncludes(
    bytroHomeProduction,
    providerHome,
    `Startup migration references provider-owned home: ${providerHome}`,
  );
}
rejectIncludes(
  bytroHomeProduction,
  "migrate_skills",
  "Startup migration still imports provider-owned skills",
);
rejectIncludes(
  bytroHomeProduction,
  "migrate_commands",
  "Startup migration still imports provider-owned commands",
);
for (const legacyImport of [
  "LEGACY_BYTRO_HOME_DIR",
  "import_legacy_home_once",
  "migrate_mcp_servers",
  "legacy_mcp_config_path",
]) {
  rejectIncludes(
    sourceCorpus,
    legacyImport,
    `Silent legacy import remains in Community Edition: ${legacyImport}`,
  );
}
requireIncludes(
  bytroHomeProduction,
  "SetNamedSecurityInfoW",
  "Windows Bytro-owned persistence does not apply a private ACL",
);
requireIncludes(
  bytroHomeProduction,
  "PROTECTED_DACL_SECURITY_INFORMATION",
  "Windows Bytro-owned persistence does not replace inherited ACL access",
);

const mcpPersistence = readText("src-tauri/src/sidecar/mcp.rs");
requireIncludes(
  mcpPersistence,
  "crate::bytro_home::ensure_private_dir(parent)",
  "MCP persistence does not secure its managed parent directory",
);
requireIncludes(
  mcpPersistence,
  "crate::bytro_home::harden_private_file(path)",
  "MCP persistence does not secure the final config file",
);
requireIncludes(
  mcpPersistence,
  "crate::provider_readonly::read_bounded_text",
  "MCP persistence does not use bounded no-follow reads",
);
for (const rustRemoteUrlBoundary of [
  "normalize_mcp_remote_url",
  "parsed.username().is_empty()",
  "parsed.query().is_some()",
  "parsed.fragment().is_some()",
  "sanitize_mcp_servers(servers)",
]) {
  requireIncludes(
    mcpPersistence,
    rustRemoteUrlBoundary,
    `Rust remote MCP URL boundary is missing: ${rustRemoteUrlBoundary}`,
  );
}
if ((mcpPersistence.match(/normalize_mcp_remote_url\(url\)\?/g) ?? []).length < 2) {
  throw new Error("MCP verify/list paths do not both validate the remote URL");
}
requireIncludes(
  readText("src-tauri/src/sidecar/mcp_oauth.rs"),
  "super::mcp::normalize_mcp_remote_url(raw)",
  "MCP OAuth does not use the shared remote URL validator",
);

const sidecarMcpValidator = readText("sidecar/src/mcp-validator.ts");
for (const sidecarRemoteUrlBoundary of [
  "normalizeMcpRemoteUrl",
  "parsed.username",
  'parsed.href.includes("?")',
  'parsed.href.includes("#")',
  "urlAuthorityHasUserinfo",
]) {
  requireIncludes(
    sidecarMcpValidator,
    sidecarRemoteUrlBoundary,
    `Sidecar remote MCP URL boundary is missing: ${sidecarRemoteUrlBoundary}`,
  );
}
const openaiHandler = readText("sidecar/src/openai-handler.ts");
requireIncludes(
  openaiHandler,
  "normalizeMcpRemoteUrl(cfg.url)",
  "Codex MCP TOML does not validate remote URLs",
);
requireIncludes(
  openaiHandler,
  "normalizeMcpRemoteUrl(config.url)",
  "Codex MCP runtime projection does not validate remote URLs",
);
const mcpStore = readText("src/stores/mcp-store.ts");
rejectIncludes(
  mcpStore,
  "setTimeout",
  "MCP persistence must not be deferred past the explicit user action",
);
requireIncludes(
  readText("src/components/mcp-config-dialog.tsx"),
  "await setServer(name, config)",
  "MCP add flow closes before the private configuration is durable",
);
requireIncludes(
  mcpStore,
  "loadError: MCP_CONFIG_READ_ERROR",
  "Unreadable MCP configuration is still treated as an empty successful load",
);
requireIncludes(
  mcpStore,
  "if (!get().loaded || get().loadError)",
  "MCP writes are not blocked while the persisted configuration is unreadable",
);

const sidecarProviderReadonly = readText("sidecar/src/provider-readonly.ts");
for (const providerReadBoundary of [
  "class ProviderDirectoryGuard",
  "metadata.nlink === 1n",
  "MAX_PROVIDER_DIRECTORY_ENTRIES",
  "guard.revalidate()",
]) {
  requireIncludes(
    sidecarProviderReadonly,
    providerReadBoundary,
    `Sidecar provider reads are missing the identity/bounds guard: ${providerReadBoundary}`,
  );
}

const ollamaProduction = readText("src-tauri/src/ollama.rs").split("#[cfg(test)]", 1)[0];
for (const globalTerminator of [
  'Command::new("taskkill")',
  'Command::new("pkill")',
  'Command::new("killall")',
]) {
  rejectIncludes(
    ollamaProduction,
    globalTerminator,
    `Ollama integration globally terminates provider processes: ${globalTerminator}`,
  );
}
requireIncludes(
  ollamaProduction,
  "managed_ollama_process().lock().await.take()",
  "Ollama stop is not restricted to a Bytro-launched process handle",
);

const settingsStore = readText("src/stores/settings-store.ts");
requireIncludes(settingsStore, "autoSave: false", "Settings store must use explicit durable saves");
requireIncludes(
  settingsStore,
  "await store.save()",
  "Settings store changes are not saved durably",
);
requireIncludes(
  settingsStore,
  'invoke("harden_settings_store")',
  "Settings persistence is not permission-hardened",
);
requireIncludes(
  readText("src-tauri/src/lib.rs"),
  "bytro_home::harden_windows_private_acl(path, false)",
  "Windows settings/API-key persistence does not apply a private ACL",
);
requireIncludes(
  settingsStore,
  "export async function flushSettingsPersistence",
  "Settings UI cannot wait for queued persistence before closing",
);
requireIncludes(
  settingsStore,
  "failSettingsRead()",
  "Settings read failures are still treated as missing/default settings",
);
requireIncludes(
  settingsStore,
  'settingsReadState !== "ready"',
  "Settings writes are not blocked while the saved state is unreadable",
);
requireIncludes(
  readText("src/components/settings/settings-modal.tsx"),
  "await flushSettingsPersistence()",
  "Settings modal closes before queued configuration writes are durable",
);
requireIncludes(
  readText("src-tauri/src/lib.rs"),
  "harden_settings_store,",
  "Settings permission hardening command is not registered",
);

const appSource = readText("src/App.tsx");
rejectIncludes(
  appSource,
  "scan_local_credentials",
  "App startup must not silently import provider credentials",
);
rejectIncludes(
  appSource,
  "mergeCredentials",
  "App startup must not silently persist scanned provider credentials",
);
const credentialScanCallers = collectSourceFiles("src").filter((file) =>
  readText(file).includes('"scan_local_credentials"'),
);
if (
  credentialScanCallers.length !== 1 ||
  credentialScanCallers[0] !== "src/components/settings/models-panel.tsx"
) {
  throw new Error(
    `Provider credentials must be scanned only from the explicit Models action: ${credentialScanCallers.join(", ")}`,
  );
}
const modelsPanel = readText("src/components/settings/models-panel.tsx");
requireIncludes(
  modelsPanel,
  "onClick={handleImportLocalCredentials}",
  "Models settings does not expose an explicit local credential import action",
);
requireIncludes(
  modelsPanel,
  "settings.setPlatforms(result.platforms)",
  "Explicit local credential import is not persisted in Bytro settings",
);

const remoteModelsHook = readText("src/hooks/use-remote-models.ts");
rejectIncludes(
  remoteModelsHook,
  "useEffect",
  "Remote model catalogs must not be fetched automatically on mount or provider changes",
);
requireIncludes(
  modelsPanel,
  "onClick={remoteModelsResult.refresh}",
  "Remote model catalogs do not have an explicit refresh action",
);

const oauthPanel = readText("src/components/settings/oauth-panel.tsx");
rejectIncludes(
  oauthPanel,
  'if (phase === "signedIn")',
  "OAuth usage must not be fetched automatically when the panel becomes signed in",
);
requireIncludes(
  oauthPanel,
  "await loadUsage()",
  "OAuth usage refresh is not attached to the explicit Refresh action",
);

const workspaceStore = readText("src/stores/workspace-store.ts");
rejectIncludes(
  sourceCorpus,
  "discover_workspace_sessions",
  "Hidden provider-session discovery command remains in Community Edition",
);
rejectIncludes(
  sourceCorpus,
  "workspace-sessions-discovered",
  "Provider-session discovery event plumbing remains in Community Edition",
);
rejectIncludes(
  sourceCorpus,
  "import_jsonl_sessions",
  "Provider-session metadata import helper remains in Community Edition",
);
rejectIncludes(
  sourceCorpus,
  "get_or_create_project_id",
  "Workspace identity must not create a .bytro-community marker file",
);
rejectIncludes(
  sourceCorpus,
  "PROJECT_MARKER_FILE",
  "Workspace identity marker constants remain in Community Edition",
);

for (const removedFile of [
  "src-tauri/tauri.debug.conf.json",
  "sidecar/scripts/watch.js",
  "sidecar/src/request-trace.ts",
]) {
  if (exists(removedFile)) {
    throw new Error(`Private debug entry remains: ${removedFile}`);
  }
}
for (const forbidden of [
  "restart_sidecar",
  "BYTRO_REQUEST_TRACE",
  "BYTRO_THINKING_DISPLAY",
  "BYTRO_FORWARD_SUBAGENT_TEXT",
  "BYTRO_SUBAGENT_DEBUG",
  "BYTRO_IMAGES_DEBUG",
  "__testNotification",
  "[split-drag]",
  "split-drag-logger",
  "DEBUG-THINKING",
  "[计时]",
  "[PERF]",
]) {
  rejectIncludes(sourceCorpus, forbidden, `Private diagnostic entry remains: ${forbidden}`);
}
const rootPackage = readJson("package.json");
const sidecarPackage = readJson("sidecar/package.json");
if (rootPackage.scripts?.["build:debug"] || rootPackage.scripts?.["build:debug-frontend"]) {
  throw new Error("Private debug build scripts remain");
}
if (sidecarPackage.scripts?.["dev:watch"]) {
  throw new Error("Private sidecar watcher script remains");
}
rejectIncludes(readText("src-tauri/Cargo.toml"), 'devtools = ["tauri/devtools"]', "Tauri devtools feature remains");
rejectIncludes(readText("scripts/parallel-build.cjs"), "--debug", "Parallel build still exposes a debug branch");

const teamsSource = readText("src-tauri/src/teams.rs");
rejectIncludes(
  readText("src-tauri/src/lib.rs"),
  "teams::start_watching_teams(&handle",
  "Teams provider directories are watched automatically at startup",
);
requireIncludes(
  readText("src/components/teams/TeamsView.tsx"),
  'invoke("watch_teams")',
  "Teams watcher is not started from the explicit Teams view",
);
requireIncludes(
  teamsSource,
  "if watcher_guard.is_some()",
  "Teams watcher startup is not idempotent",
);

const endpointValidation = readText("sidecar/src/endpoint-validation.ts");
requireIncludes(endpointValidation, "validateProviderBaseUrl", "Provider base URL validator is missing");
requireIncludes(endpointValidation, "validateProxyUrl", "Provider proxy URL validator is missing");
for (const file of [
  "sidecar/src/credential-strategy.ts",
  "sidecar/src/chatcmpl-handler.ts",
  "sidecar/src/gemini-handler.ts",
  "sidecar/src/openai-handler.ts",
]) {
  requireIncludes(readText(file), "endpoint-validation.js", `Provider endpoint validation is not used by ${file}`);
}
requireIncludes(
  readText("src-tauri/src/anthropic.rs"),
  "validate_api_base_url",
  "Rust provider base URL validation is missing",
);

const gitOperations = readText("src-tauri/src/git/operations.rs");
requireIncludes(gitOperations, "validate_http_clone_url(url)?", "HTTP clone URLs are not validated");
requireIncludes(gitOperations, "safe_git_url_for_display", "Git remote URLs are returned without sanitization");
requireIncludes(gitOperations, "Diagnostic ID:", "Git network errors lack safe diagnostic IDs");

const openAiHandler = readText("sidecar/src/openai-handler.ts");
rejectIncludes(openAiHandler, "env.BYTRO_IMAGES_DEBUG", "Image MCP debug environment is still forwarded");
for (const property of ["command,", "args,", "env,", "tool_timeout_sec: 600", "startup_timeout_sec: startupTimeoutSec"]) {
  requireIncludes(openAiHandler, property, `Image MCP runtime structure lost ${property}`);
}

requireIncludes(
  readText("src-tauri/src/memory/commands.rs"),
  "codex_session_deletion_root_is_bytro_owned",
  "Codex session deletion root has no Bytro-owned regression test",
);

const modelSelector = readText("src/components/chat/model-selector.tsx");
for (const formalTriggerElement of [
  "PLATFORM_ICONS",
  "EffortTimelinePopover",
  "triggerModeSummary",
  "effortBtnRef",
  'className="flex min-w-0 max-w-[240px] items-center overflow-hidden rounded"',
  "const platformIcon = PLATFORM_ICONS[platformId]",
  'className="flex h-[26px] w-[26px] shrink-0 items-center justify-center overflow-hidden rounded-md"',
  'className="h-4 w-4 object-contain"',
]) {
  requireIncludes(
    modelSelector,
    formalTriggerElement,
    `Formal model trigger structure is missing: ${formalTriggerElement}`,
  );
}
for (const privateModelSelectorState of [
  "useAuthStore",
  "OfficialModelsConfig",
  "OFFICIAL_PLATFORM_ID",
  "bytroIcon",
]) {
  rejectIncludes(
    modelSelector,
    privateModelSelectorState,
    `Private model selector state was restored: ${privateModelSelectorState}`,
  );
}

process.stdout.write("Community Tauri configuration is valid.\n");
