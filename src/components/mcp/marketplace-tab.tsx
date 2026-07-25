import {
  type ReactNode,
  type UIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Blocks,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Download,
  ExternalLink,
  FileText,
  Globe,
  Info,
  KeyRound,
  ListChecks,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  Tag,
  Terminal,
  Unlink,
  X,
} from "lucide-react";
import { Tooltip } from "@/components/ui";
import { useIsLightTheme } from "@/hooks/use-is-light-theme";
import { getConfigSummary } from "./mcp-helpers";
import type {
  McpMarketplaceInput,
  McpMarketplacePackage,
  McpMarketplaceServer,
  McpMarketplaceTransport,
  McpServerConfig,
  McpToolInfo,
  McpToolsResult,
  McpVerifyResult,
} from "@/stores";

interface MarketplaceTabProps {
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly servers: Readonly<Record<string, McpServerConfig>>;
  readonly marketplaceServers: ReadonlyArray<McpMarketplaceServer>;
  readonly marketplaceSearching: boolean;
  readonly marketplaceNextCursor: string | null;
  readonly marketplaceError: string | null;
  readonly searchMarketplace: (query?: string, append?: boolean) => Promise<void>;
  readonly lookupMarketplace: (
    query?: string,
    limit?: number,
  ) => Promise<ReadonlyArray<McpMarketplaceServer>>;
  readonly setServer: (name: string, config: McpServerConfig) => Promise<void>;
  readonly removeServer: (name: string) => Promise<void>;
  readonly verifyServer: (name: string, config: McpServerConfig) => Promise<McpVerifyResult>;
  readonly verifyStatus: Readonly<
    Record<string, { loading: boolean; result: McpVerifyResult | null }>
  >;
  readonly toolsStatus: Readonly<
    Record<string, { loading: boolean; result: McpToolsResult | null }>
  >;
  readonly listServerTools: (name: string, config: McpServerConfig) => Promise<McpToolsResult>;
}

interface InstallField {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly placeholder?: string;
  readonly secret?: boolean;
  readonly required?: boolean;
  readonly defaultValue?: string;
}

interface InstallOption {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  readonly baseServerName: string;
  readonly fields: ReadonlyArray<InstallField>;
  readonly buildConfig: (values: Record<string, string>) => McpServerConfig;
}

interface InstallState {
  readonly loading: boolean;
  readonly message?: string;
  readonly error?: string;
}

interface InstalledMarketplaceResult {
  readonly key: string;
  readonly name: string;
  readonly config: McpServerConfig;
}

interface InstalledUpdateInfo {
  readonly item: McpMarketplaceServer;
  readonly pkg: McpMarketplacePackage;
  readonly option: InstallOption;
  readonly currentVersion: string;
  readonly latestVersion: string;
}

interface McpOAuthStartResult {
  readonly authorizeUrl: string;
  readonly state: string;
  readonly browserOpened: boolean;
}

interface McpOAuthPollResult {
  readonly status: "pending" | "authorized" | "error" | string;
  readonly message?: string | null;
  readonly expiresAt?: number | null;
  readonly scopes?: string | null;
  readonly tokenType?: string | null;
}

interface McpOAuthStatusResult {
  readonly authorized: boolean;
  readonly expiresAt?: number | null;
  readonly scopes?: string | null;
  readonly tokenType?: string | null;
}

interface McpAuthInspectionResult {
  readonly mode: "none" | "oauth" | "token" | "unknown" | string;
  readonly canAuthorize: boolean;
  readonly message: string;
  readonly resource?: string | null;
  readonly scopes?: string | null;
  readonly authorizationEndpoint?: string | null;
  readonly tokenEndpoint?: string | null;
  readonly registrationEndpoint?: string | null;
}

type DetailSelection =
  | { readonly kind: "installed"; readonly name: string }
  | { readonly kind: "marketplace"; readonly key: string };

const MARKETPLACE_CATEGORY_KEYS = [
  "all",
  "developerTools",
  "design",
  "dataAnalytics",
  "aiMl",
  "cloud",
  "productivity",
  "other",
] as const;

type MarketplaceCategoryKey = (typeof MARKETPLACE_CATEGORY_KEYS)[number];

function itemKey(item: McpMarketplaceServer): string {
  return `${item.server.name}@${item.server.version}`;
}

function serverDisplayName(item: McpMarketplaceServer): string {
  return item.server.title || item.server.name.split("/").pop() || item.server.name;
}

function serverAuthor(item: McpMarketplaceServer): string {
  return item.server.name.split("/")[0] || "registry";
}

function marketplaceSearchText(item: McpMarketplaceServer): string {
  const repository = item.server.repository;
  return [
    item.server.name,
    item.server.title,
    item.server.description,
    repository?.url,
    repository?.source,
    repository?.subfolder,
    item.server.websiteUrl,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function inferMarketplaceCategory(item: McpMarketplaceServer): MarketplaceCategoryKey {
  const text = marketplaceSearchText(item);
  if (/(figma|design|canvas|pencil|sketch|stitch|ui|ux|image|draw|diagram)/.test(text)) {
    return "design";
  }
  if (
    /(sql|postgres|mysql|database|db|data|analytics|warehouse|bigquery|snowflake|csv)/.test(text)
  ) {
    return "dataAnalytics";
  }
  if (/(openai|anthropic|llm|ai|model|prompt|embedding|vector|rag|inference)/.test(text)) {
    return "aiMl";
  }
  if (/(aws|azure|gcp|cloud|docker|kubernetes|k8s|vercel|deploy|serverless)/.test(text)) {
    return "cloud";
  }
  if (
    /(slack|gmail|calendar|notion|linear|jira|github issue|ticket|course|student|crm)/.test(text)
  ) {
    return "productivity";
  }
  if (/(git|github|code|filesystem|file|browser|playwright|test|api|dev|terminal|cli)/.test(text)) {
    return "developerTools";
  }
  return "other";
}

function marketplaceIconSrc(item: McpMarketplaceServer, isLight: boolean): string | null {
  const icons = item.server.icons?.filter((icon) => icon.src) ?? [];
  if (icons.length === 0) return null;
  const desiredTheme = isLight ? "light" : "dark";
  return (
    icons.find((icon) => icon.theme === desiredTheme)?.src ??
    icons.find((icon) => !icon.theme)?.src ??
    icons[0]?.src ??
    null
  );
}

function safeServerName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/^mcp[-_ ]server[-_ ]/i, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "mcp-server";
}

function uniqueServerName(
  base: string,
  servers: Readonly<Record<string, McpServerConfig>>,
): string {
  if (!(base in servers)) return base;
  let index = 2;
  while (`${base}-${index}` in servers) index += 1;
  return `${base}-${index}`;
}

function optionField(input: McpMarketplaceInput, fallback: string): InstallField | null {
  const key = input.name || input.valueHint || fallback;
  const hasFixedValue = input.value !== undefined && input.value !== "";
  if (hasFixedValue) return null;
  return {
    key,
    label: input.name || input.valueHint || fallback,
    description: input.description,
    placeholder: input.placeholder,
    secret: input.isSecret,
    required: input.isRequired,
    defaultValue: input.default,
  };
}

function templateFieldKey(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || raw;
}

function fieldsFromTemplate(
  template: string | undefined,
  input: McpMarketplaceInput,
  fallback: string,
): ReadonlyArray<InstallField> {
  if (!template) return [];
  const matches = [...template.matchAll(/\{([^}]+)\}/g)];
  const seen = new Set<string>();
  return matches
    .map((match, index) => templateFieldKey(match[1] || `${fallback}-${index + 1}`))
    .filter((key) => {
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((key) => ({
      key,
      label: key,
      description: input.description,
      placeholder: input.placeholder || input.valueHint,
      secret: input.isSecret || /authorization|auth|token|secret|api[-_]?key|key/i.test(key),
      required: true,
      defaultValue: input.default,
    }));
}

function fieldsFromInput(
  input: McpMarketplaceInput,
  fallback: string,
): ReadonlyArray<InstallField> {
  const templateFields = fieldsFromTemplate(input.value, input, fallback);
  if (templateFields.length > 0) return templateFields;
  const field = optionField(input, fallback);
  return field ? [field] : [];
}

function variableFields(
  variables: Readonly<Record<string, McpMarketplaceInput>> | undefined,
): ReadonlyArray<InstallField> {
  if (!variables) return [];
  return Object.entries(variables).flatMap(([name, input]) =>
    fieldsFromInput({ ...input, name }, name),
  );
}

function inputFields(
  inputs: ReadonlyArray<McpMarketplaceInput> | undefined,
  prefix: string,
): ReadonlyArray<InstallField> {
  if (!inputs) return [];
  return inputs.flatMap((input, index) => fieldsFromInput(input, `${prefix}-${index + 1}`));
}

function replaceVariables(value: string, values: Record<string, string>): string {
  return value.replace(/\{([^}]+)\}/g, (_, key: string) => values[key] ?? "");
}

function resolveInputValue(input: McpMarketplaceInput, values: Record<string, string>): string {
  const key = input.name || input.valueHint || "";
  const value = input.value ?? values[key] ?? input.default ?? "";
  return replaceVariables(value, values).trim();
}

function argsFromInputs(
  inputs: ReadonlyArray<McpMarketplaceInput> | undefined,
  values: Record<string, string>,
): string[] {
  if (!inputs) return [];
  const args: string[] = [];
  for (const input of inputs) {
    const value = resolveInputValue(input, values);
    if (!value && !input.name) continue;
    if (input.type === "named" && input.name) {
      if (!value && !input.isRequired) continue;
      args.push(input.name);
      if (value) args.push(value);
      continue;
    }
    if (value) args.push(value);
  }
  return args;
}

function envFromInputs(
  inputs: ReadonlyArray<McpMarketplaceInput> | undefined,
  values: Record<string, string>,
): Record<string, string> | undefined {
  if (!inputs) return undefined;
  const env: Record<string, string> = {};
  for (const input of inputs) {
    if (!input.name) continue;
    const value = resolveInputValue(input, values);
    if (value || input.isRequired) env[input.name] = value;
  }
  return Object.keys(env).length ? env : undefined;
}

function normalizedBearerToken(raw: string | undefined): string | null {
  const token = raw?.trim();
  if (!token) return null;
  return /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function packageSpec(pkg: McpMarketplacePackage): string {
  if (pkg.registryType === "npm" && pkg.version && pkg.version !== "latest") {
    return `${pkg.identifier}@${pkg.version}`;
  }
  if (pkg.registryType === "pypi" && pkg.version && pkg.version !== "latest") {
    return `${pkg.identifier}==${pkg.version}`;
  }
  if (
    (pkg.registryType === "oci" || pkg.registryType === "docker") &&
    pkg.version &&
    pkg.version !== "latest"
  ) {
    return `${ociImageParts(pkg.identifier).image}:${pkg.version}`;
  }
  return pkg.identifier;
}

function ociImageParts(identifier: string): {
  readonly image: string;
  readonly version: string | null;
} {
  const slashIndex = identifier.lastIndexOf("/");
  const colonIndex = identifier.lastIndexOf(":");
  if (colonIndex > slashIndex) {
    return {
      image: identifier.slice(0, colonIndex),
      version: identifier.slice(colonIndex + 1) || null,
    };
  }
  return { image: identifier, version: null };
}

function semverParts(version: string): number[] {
  return version
    .replace(/^[^\d]*/, "")
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function compareVersions(current: string, latest: string): number {
  const a = semverParts(current);
  const b = semverParts(latest);
  for (let index = 0; index < Math.max(a.length, b.length, 3); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return current.localeCompare(latest);
}

function packageArgVersion(arg: string, identifier: string): string | null {
  if (arg === identifier) return null;
  if (arg.startsWith(`${identifier}@`)) {
    return arg.slice(identifier.length + 1) || null;
  }
  if (arg.startsWith(`${identifier}==`)) {
    return arg.slice(identifier.length + 2) || null;
  }
  return null;
}

function packageVersionFromConfig(
  config: McpServerConfig,
  pkg: McpMarketplacePackage,
): string | null | undefined {
  if (!("command" in config)) return undefined;
  const args = config.args ?? [];
  if (pkg.registryType === "oci" || pkg.registryType === "docker") {
    const latest = ociImageParts(pkg.identifier);
    const imageArg = args.find((arg) => {
      const current = ociImageParts(arg);
      return current.image === latest.image;
    });
    return imageArg ? ociImageParts(imageArg).version : undefined;
  }

  const matchingArg = args.find((arg) => {
    if (arg === pkg.identifier) return true;
    return arg.startsWith(`${pkg.identifier}@`) || arg.startsWith(`${pkg.identifier}==`);
  });
  return matchingArg === undefined ? undefined : packageArgVersion(matchingArg, pkg.identifier);
}

function latestPackageVersion(pkg: McpMarketplacePackage): string | null {
  if (pkg.version && pkg.version !== "latest") return pkg.version;
  if (pkg.registryType === "oci" || pkg.registryType === "docker") {
    return ociImageParts(pkg.identifier).version;
  }
  return null;
}

function packageLookupQuery(raw: string): string {
  if (raw.includes("==")) return raw.split("==")[0] || raw;
  const image = ociImageParts(raw);
  if (image.version) return image.image;
  if (raw.startsWith("@")) {
    const versionIndex = raw.indexOf("@", raw.indexOf("/") + 1);
    return versionIndex > 0 ? raw.slice(0, versionIndex) : raw;
  }
  const versionIndex = raw.lastIndexOf("@");
  return versionIndex > 0 ? raw.slice(0, versionIndex) : raw;
}

function installedLookupQuery(name: string, config: McpServerConfig): string {
  if (!("command" in config)) return name;
  const args = config.args ?? [];
  const candidate = args.find((arg) => {
    if (!arg || arg.startsWith("-")) return false;
    if (["run", "pull", "exec", "stdio"].includes(arg)) return false;
    return arg.includes("/") || arg.includes("@") || arg.includes("==");
  });
  return candidate ? packageLookupQuery(candidate) : name;
}

function mergedMarketplaceItems(
  visible: ReadonlyArray<McpMarketplaceServer>,
  lookups: Readonly<Record<string, ReadonlyArray<McpMarketplaceServer>>>,
): ReadonlyArray<McpMarketplaceServer> {
  const byKey = new Map<string, McpMarketplaceServer>();
  for (const item of visible) byKey.set(itemKey(item), item);
  for (const items of Object.values(lookups)) {
    for (const item of items) byKey.set(itemKey(item), item);
  }
  return Array.from(byKey.values());
}

function updatedPackageArg(arg: string, pkg: McpMarketplacePackage): string {
  const latest = latestPackageVersion(pkg);
  if (!latest) return arg;

  if (pkg.registryType === "oci" || pkg.registryType === "docker") {
    const target = ociImageParts(pkg.identifier);
    const current = ociImageParts(arg);
    return current.image === target.image ? `${target.image}:${latest}` : arg;
  }

  if (pkg.registryType === "npm") {
    return packageVersionFromArg(arg, pkg.identifier) !== undefined
      ? `${pkg.identifier}@${latest}`
      : arg;
  }

  if (pkg.registryType === "pypi") {
    return packageVersionFromArg(arg, pkg.identifier) !== undefined
      ? `${pkg.identifier}==${latest}`
      : arg;
  }

  return arg;
}

function packageVersionFromArg(arg: string, identifier: string): string | null | undefined {
  if (arg === identifier) return null;
  const version = packageArgVersion(arg, identifier);
  return version === null ? undefined : version;
}

function configWithUpdatedPackageVersion(
  config: McpServerConfig,
  pkg: McpMarketplacePackage,
): McpServerConfig | null {
  if (!("command" in config)) return null;
  let changed = false;
  const args = (config.args ?? []).map((arg) => {
    const next = updatedPackageArg(arg, pkg);
    if (next !== arg) changed = true;
    return next;
  });
  return changed ? { ...config, args } : null;
}

function installedUpdateInfo(
  config: McpServerConfig,
  registryItems: ReadonlyArray<McpMarketplaceServer>,
): InstalledUpdateInfo | null {
  let best: InstalledUpdateInfo | null = null;
  for (const item of registryItems) {
    const packages = item.server.packages ?? [];
    for (let index = 0; index < packages.length; index += 1) {
      const pkg = packages[index];
      const option = buildPackageOption(item, pkg, index);
      if (!option) continue;
      const currentVersion = packageVersionFromConfig(config, pkg);
      const latestVersion = latestPackageVersion(pkg);
      if (!currentVersion || !latestVersion || currentVersion === "latest") continue;
      if (!/\d/.test(currentVersion) || !/\d/.test(latestVersion)) continue;
      if (compareVersions(currentVersion, latestVersion) >= 0) continue;
      const candidate = {
        item,
        pkg,
        option,
        currentVersion,
        latestVersion,
      };
      if (!best || compareVersions(best.latestVersion, latestVersion) < 0) {
        best = candidate;
      }
    }
  }
  return best;
}

function commandForPackage(pkg: McpMarketplacePackage): string | null {
  if (pkg.runtimeHint) return pkg.runtimeHint;
  if (pkg.registryType === "npm") return "npx";
  if (pkg.registryType === "pypi") return "uvx";
  if (pkg.registryType === "oci" || pkg.registryType === "docker") return "docker";
  return null;
}

function buildRemoteOption(
  item: McpMarketplaceServer,
  remote: McpMarketplaceTransport,
  index: number,
): InstallOption | null {
  if (!remote.url) return null;
  const remoteType =
    remote.type === "sse" ? "sse" : remote.type === "streamable-http" ? "http" : null;
  if (!remoteType) return null;

  const fields = [
    ...fieldsFromTemplate(remote.url, { description: remote.url }, `remote-url-${index}`),
    ...variableFields(remote.variables),
    ...inputFields(remote.headers, `header-${index}`),
  ];
  const displayName = serverDisplayName(item);
  const baseServerName = safeServerName(displayName);

  return {
    id: `remote-${index}`,
    label: remoteType === "http" ? "HTTPS" : "SSE",
    summary: remote.url,
    baseServerName,
    fields,
    buildConfig: (values) => {
      const headers = { ...(envFromInputs(remote.headers, values) ?? {}) };
      return {
        type: remoteType,
        url: replaceVariables(remote.url ?? "", values),
        ...(Object.keys(headers).length ? { headers } : {}),
      };
    },
  };
}

function buildPackageOption(
  item: McpMarketplaceServer,
  pkg: McpMarketplacePackage,
  index: number,
): InstallOption | null {
  if (pkg.transport?.type && pkg.transport.type !== "stdio") return null;
  const command = commandForPackage(pkg);
  if (!command) return null;

  const fields = [
    ...inputFields(pkg.runtimeArguments, `runtime-${index}`),
    ...inputFields(pkg.packageArguments, `arg-${index}`),
    ...inputFields(pkg.environmentVariables, `env-${index}`),
  ];
  const displayName = serverDisplayName(item);
  const baseServerName = safeServerName(displayName);
  const spec = packageSpec(pkg);

  return {
    id: `package-${index}`,
    label: pkg.registryType.toUpperCase(),
    summary: `${command} ${spec}`,
    baseServerName,
    fields,
    buildConfig: (values) => {
      const args = [...argsFromInputs(pkg.runtimeArguments, values)];
      if (command === "npx" && !args.includes("-y")) args.push("-y");
      if (pkg.registryType === "oci" && command === "docker") {
        args.push("run", "-i", "--rm", spec);
      } else {
        args.push(spec);
      }
      args.push(...argsFromInputs(pkg.packageArguments, values));
      const env = envFromInputs(pkg.environmentVariables, values);
      return {
        type: "stdio",
        command,
        args,
        ...(env ? { env } : {}),
      };
    },
  };
}

function installOptions(item: McpMarketplaceServer): ReadonlyArray<InstallOption> {
  const remoteOptions = (item.server.remotes ?? [])
    .map((remote, index) => buildRemoteOption(item, remote, index))
    .filter((option): option is InstallOption => option !== null);
  const packageOptions = (item.server.packages ?? [])
    .map((pkg, index) => buildPackageOption(item, pkg, index))
    .filter((option): option is InstallOption => option !== null);
  return [...remoteOptions, ...packageOptions];
}

function hasHttpsRemote(item: McpMarketplaceServer): boolean {
  return Boolean(
    item.server.remotes?.some((remote) => remote.url?.trim().toLowerCase().startsWith("https://")),
  );
}

function sortedMarketplaceServers(
  items: ReadonlyArray<McpMarketplaceServer>,
): ReadonlyArray<McpMarketplaceServer> {
  return [...items].sort((a, b) => {
    const remoteDiff = Number(hasHttpsRemote(b)) - Number(hasHttpsRemote(a));
    if (remoteDiff !== 0) return remoteDiff;
    const officialA = a._meta?.["io.modelcontextprotocol.registry/official"]?.status === "active";
    const officialB = b._meta?.["io.modelcontextprotocol.registry/official"]?.status === "active";
    const officialDiff = Number(officialB) - Number(officialA);
    if (officialDiff !== 0) return officialDiff;
    return 0;
  });
}

function mergedInstallFields(options: ReadonlyArray<InstallOption>): ReadonlyArray<InstallField> {
  const byKey = new Map<string, InstallField>();
  for (const option of options) {
    for (const field of option.fields) {
      const existing = byKey.get(field.key);
      byKey.set(
        field.key,
        existing ? { ...existing, required: existing.required || field.required } : field,
      );
    }
  }
  return Array.from(byKey.values());
}

function hasMissingRequiredFields(
  fields: ReadonlyArray<InstallField>,
  values: Record<string, string>,
): boolean {
  return fields.some(
    (field) => field.required && !(values[field.key] ?? field.defaultValue ?? "").trim(),
  );
}

function optionCanBuild(option: InstallOption, values: Record<string, string>): boolean {
  return !hasMissingRequiredFields(option.fields, values);
}

function configMatchesOption(config: McpServerConfig, option: InstallOption): boolean {
  if ("url" in config) return option.summary.includes(config.url);
  if ("command" in config) {
    const summary = `${config.command} ${(config.args ?? []).join(" ")}`;
    return option.summary.split(" ").every((part) => summary.includes(part));
  }
  return false;
}

function installedServerEntry(
  item: McpMarketplaceServer,
  servers: Readonly<Record<string, McpServerConfig>>,
  options: ReadonlyArray<InstallOption>,
): [string, McpServerConfig] | null {
  const baseName = safeServerName(serverDisplayName(item));
  for (const [name, config] of Object.entries(servers)) {
    if (name === baseName || options.some((option) => configMatchesOption(config, option))) {
      return [name, config];
    }
  }
  return null;
}

function isAuthRequiredMessage(message?: string | null): boolean {
  if (!message) return false;
  return /(auth|oauth|unauthori[sz]ed|forbidden|401|403|token|credential|login|sign in)/i.test(
    message,
  );
}

function supportsMcpOAuth(config: McpServerConfig): boolean {
  return "url" in config && /^https?:\/\//i.test(config.url);
}

function hasManualAuthSignal(config: McpServerConfig): boolean {
  if (!("headers" in config) || !config.headers) return false;
  return Object.keys(config.headers).some((key) =>
    /authorization|token|api[-_]?key|secret/i.test(key),
  );
}

function hasAuthSignal(config: McpServerConfig): boolean {
  return hasManualAuthSignal(config);
}

function authUrlForConfig(
  config: McpServerConfig,
  item?: McpMarketplaceServer | null,
): string | null {
  if ("url" in config) return item?.server.websiteUrl ?? null;
  return item?.server.websiteUrl ?? item?.server.repository?.url ?? null;
}

function statusForInstalledServer(
  name: string,
  config: McpServerConfig,
  verifyStatus: MarketplaceTabProps["verifyStatus"],
): {
  readonly tone: "neutral" | "success" | "warning" | "danger";
  readonly labelKey: string;
  readonly defaultLabel: string;
  readonly authAction: boolean;
  readonly message?: string;
} {
  const status = verifyStatus[name];
  if (status?.loading) {
    return {
      tone: "neutral",
      labelKey: "mcp.management.checking",
      defaultLabel: "Checking",
      authAction: hasAuthSignal(config),
    };
  }
  const result = status?.result;
  if (!result) {
    if (hasManualAuthSignal(config)) {
      return {
        tone: "neutral",
        labelKey: "mcp.management.authConfigured",
        defaultLabel: "Auth configured",
        authAction: true,
      };
    }
    return {
      tone: "neutral",
      labelKey: "mcp.management.notChecked",
      defaultLabel: "Not checked",
      authAction: false,
    };
  }
  if (result.ok) {
    return {
      tone: "success",
      labelKey: hasManualAuthSignal(config)
        ? "mcp.management.authorized"
        : "mcp.management.connected",
      defaultLabel: hasManualAuthSignal(config) ? "Authorized" : "Connected",
      authAction: hasAuthSignal(config),
      message: result.message,
    };
  }
  if (isAuthRequiredMessage(result.message)) {
    return {
      tone: "warning",
      labelKey: "mcp.management.needsReauth",
      defaultLabel: "Needs authorization",
      authAction: true,
      message: result.message,
    };
  }
  return {
    tone: "danger",
    labelKey: "mcp.management.disconnected",
    defaultLabel: "Disconnected",
    authAction: hasAuthSignal(config),
    message: result.message,
  };
}

function statusClass(tone: "neutral" | "success" | "warning" | "danger"): string {
  if (tone === "success") return "bg-[var(--mcp-green-bg)] text-[var(--mcp-green-text)]";
  if (tone === "warning") return "bg-[var(--mcp-amber-bg)] text-[var(--mcp-amber)]";
  if (tone === "danger") return "bg-[var(--mcp-red-bg)] text-[var(--mcp-red)]";
  return "bg-background text-border-strong";
}

function statusDotClass(tone: "neutral" | "success" | "warning" | "danger"): string {
  if (tone === "success")
    return "bg-[var(--color-accent-green)] shadow-[0_0_0_3px_rgba(16,185,129,0.16)]";
  if (tone === "warning") return "bg-[var(--mcp-amber)] shadow-[0_0_0_3px_rgba(245,158,11,0.16)]";
  if (tone === "danger")
    return "bg-[var(--color-accent-danger)] shadow-[0_0_0_3px_rgba(239,68,68,0.16)]";
  return "bg-[var(--mcp-text-faint)]";
}

function serverIcon(config: McpServerConfig, tone?: "warning" | "danger") {
  if (tone === "warning") {
    return {
      bg: "var(--mcp-amber-bg-icon)",
      icon: <KeyRound size={19} className="text-[var(--mcp-amber-text)]" />,
    };
  }
  if ((config.type ?? "stdio") === "stdio") {
    return {
      bg: "var(--color-surface-raised)",
      icon: <Terminal size={19} className="text-accent-purple" />,
    };
  }
  return {
    bg: "var(--color-surface-raised)",
    icon: <Globe size={19} className="text-[var(--mcp-blue-text)]" />,
  };
}

function toolParamCount(tool: McpToolInfo): number | null {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
  return Object.keys(properties).length;
}

function toolParamNames(tool: McpToolInfo): string[] {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.keys(properties);
}

function findMarketplaceForInstalled(
  name: string,
  config: McpServerConfig,
  marketplaceServers: ReadonlyArray<McpMarketplaceServer>,
): McpMarketplaceServer | null {
  for (const item of marketplaceServers) {
    if (installedServerEntry(item, { [name]: config }, installOptions(item))) return item;
  }
  return null;
}

function DetailRow({
  label,
  value,
  href,
  mono,
}: {
  readonly label: string;
  readonly value?: string | null;
  readonly href?: string | null;
  readonly mono?: boolean;
}) {
  if (!value) return null;
  const text = (
    <span className={mono ? "break-all font-mono text-[12px]" : "break-words text-[12px]"}>
      {value}
    </span>
  );
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[10px] bg-background p-3">
      <span className="text-[11px] font-semibold text-border-strong">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-purple transition-colors hover:text-[var(--mcp-purple-text)]"
        >
          {text}
        </a>
      ) : (
        <span className="text-text-placeholder">{text}</span>
      )}
    </div>
  );
}

function InstalledSection({
  entries,
  selection,
  verifyStatus,
  updateInfoByName,
  updatingName,
  updateStateByName,
  collapsed,
  onCollapsedChange,
  onSelect,
  onUpdate,
}: {
  readonly entries: ReadonlyArray<readonly [string, McpServerConfig]>;
  readonly selection: DetailSelection | null;
  readonly verifyStatus: MarketplaceTabProps["verifyStatus"];
  readonly updateInfoByName: Readonly<Record<string, InstalledUpdateInfo>>;
  readonly updatingName: string | null;
  readonly updateStateByName: Readonly<Record<string, InstallState>>;
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  readonly onSelect: (selection: DetailSelection) => void;
  readonly onUpdate: (
    name: string,
    config: McpServerConfig,
    updateInfo: InstalledUpdateInfo,
  ) => void;
}) {
  const { t } = useTranslation();

  return (
    <section
      className={`flex shrink-0 flex-col rounded-[18px] border border-[var(--mcp-border)] bg-[var(--mcp-sunken)] transition-all duration-200 ${
        collapsed ? "gap-0 p-3" : "gap-3 p-3"
      }`}
    >
      <button
        type="button"
        onClick={() => onCollapsedChange(!collapsed)}
        className="group flex items-center justify-between gap-3 rounded-[12px] px-1 py-1 text-left transition-colors hover:bg-[var(--mcp-elevated)]"
        aria-expanded={!collapsed}
        title={
          collapsed ? t("mcp.management.expandInstalled") : t("mcp.management.collapseInstalled")
        }
      >
        <div className="flex items-center gap-2">
          <CircleCheck size={15} className="text-[var(--mcp-green-text)]" />
          <span className="text-[13px] font-bold text-foreground">
            {t("mcp.management.installedSection")}
          </span>
        </div>
        <span className="flex items-center gap-2">
          <span className="rounded-lg bg-[var(--mcp-green-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--mcp-green-text)]">
            {entries.length}
          </span>
          <ChevronDown
            size={15}
            className={`text-[var(--mcp-text-muted)] transition-transform duration-200 group-hover:text-[var(--mcp-text-strong)] ${
              collapsed ? "-rotate-90" : "rotate-0"
            }`}
          />
        </span>
      </button>

      {collapsed ? null : entries.length === 0 ? (
        <div className="flex min-h-[56px] items-center justify-center rounded-[14px] bg-[var(--mcp-elevated)] px-4 text-center text-[12px] text-border-strong">
          {t("mcp.installed.noServers")}
        </div>
      ) : (
        <div className="grid max-h-[108px] min-h-0 grid-cols-[repeat(auto-fill,44px)] gap-2 overflow-y-auto pr-1">
          {entries.map(([name, config]) => {
            const status = statusForInstalledServer(name, config, verifyStatus);
            const selected = selection?.kind === "installed" && selection.name === name;
            const iconInfo = serverIcon(config, status.tone === "warning" ? "warning" : undefined);
            const updateInfo = updateInfoByName[name];
            const updateState = updateStateByName[name];
            const updating = updatingName === name || Boolean(updateState?.loading);
            const tooltip = (
              <div className="flex max-w-[260px] flex-col gap-1">
                <span className="truncate text-[12px] font-bold text-foreground">{name}</span>
                <span className="truncate font-mono text-[11px] text-border-strong">
                  {config.type ?? "stdio"} · {t(status.labelKey, status.defaultLabel)}
                </span>
                <span className="truncate font-mono text-[11px] text-border-strong">
                  {getConfigSummary(config)}
                </span>
                {updateInfo && (
                  <span className="text-[11px] font-bold text-[var(--mcp-amber-text)]">
                    {t("mcp.management.updateVersion", {
                      current: updateInfo.currentVersion,
                      latest: updateInfo.latestVersion,
                    })}
                  </span>
                )}
                {updateState?.error && (
                  <span className="text-[11px] text-[var(--mcp-red-soft)]">
                    {updateState.error}
                  </span>
                )}
                {updateState?.message && (
                  <span className="text-[11px] text-[var(--mcp-green-text)]">
                    {updateState.message}
                  </span>
                )}
              </div>
            );
            return (
              <Tooltip key={name} content={tooltip} placement="bottom" maxWidth={280}>
                <div className="relative h-11 w-11">
                  <button
                    type="button"
                    onClick={() => onSelect({ kind: "installed", name })}
                    aria-label={`${t("mcp.marketplace.details")}: ${name}`}
                    className={`group flex h-11 w-11 items-center justify-center rounded-[13px] border transition-all duration-200 hover:-translate-y-px hover:bg-[var(--mcp-elevated)] hover:shadow-[0_10px_24px_rgba(0,0,0,0.22)] focus:outline-none focus:ring-2 focus:ring-accent-purple/40 ${
                      selected
                        ? "border-accent-purple/70 bg-[var(--mcp-purple-soft)] shadow-[0_0_0_3px_rgba(var(--theme-accent-rgb),0.10)]"
                        : "border-[var(--mcp-border)] bg-[var(--mcp-card)]"
                    }`}
                  >
                    <span
                      className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] transition-transform duration-200 group-hover:scale-[1.05]"
                      style={{ backgroundColor: iconInfo.bg }}
                    >
                      {iconInfo.icon}
                    </span>
                    <span
                      className={`absolute bottom-1 right-1 h-2 w-2 rounded-full ring-2 ring-[var(--mcp-card)] ${statusDotClass(status.tone)}`}
                    />
                  </button>
                  {updateInfo && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onUpdate(name, config, updateInfo);
                      }}
                      disabled={updating}
                      aria-label={`${updating ? t("mcp.management.updating") : t("mcp.management.update")}: ${name}`}
                      className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-[var(--mcp-amber-badge-border)] bg-[var(--mcp-amber-bg-icon)] text-[var(--mcp-amber-text)] shadow-[0_6px_14px_rgba(0,0,0,0.28)] transition-all duration-200 hover:scale-105 hover:bg-[var(--mcp-amber-badge-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {updating ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <RefreshCw size={11} />
                      )}
                    </button>
                  )}
                </div>
              </Tooltip>
            );
          })}
        </div>
      )}
    </section>
  );
}

function MarketplaceCard({
  item,
  selected,
  installedEntry,
  installing,
  installState,
  onSelect,
  onInstall,
}: {
  readonly item: McpMarketplaceServer;
  readonly selected: boolean;
  readonly installedEntry: [string, McpServerConfig] | null;
  readonly installing: boolean;
  readonly installState?: InstallState;
  readonly onSelect: () => void;
  readonly onInstall: () => void;
}) {
  const { t } = useTranslation();
  const isLight = useIsLightTheme();
  const iconSrc = marketplaceIconSrc(item, isLight);
  const [iconFailed, setIconFailed] = useState(false);
  const options = useMemo(() => installOptions(item), [item]);
  const category = inferMarketplaceCategory(item);
  const updatedAt = item._meta?.["io.modelcontextprotocol.registry/official"]?.updatedAt;
  const hasRemoteOption = options.some((option) => option.id.startsWith("remote"));
  const metaSummary = installedEntry
    ? t("mcp.marketplace.alreadyInstalled")
    : item.server.remotes?.length
      ? t("mcp.marketplace.remotes", { count: item.server.remotes.length })
      : item.server.packages?.length
        ? t("mcp.marketplace.installMethods", { count: item.server.packages.length })
        : t(`mcp.marketplace.categories.${category}`);
  const rowActive = selected || Boolean(installedEntry);

  useEffect(() => {
    setIconFailed(false);
  }, [iconSrc]);

  return (
    <div className="flex flex-col gap-1">
      <article
        className={`group flex h-[82px] items-center gap-3 rounded-[14px] border px-3 transition-all duration-200 hover:-translate-y-px hover:border-[var(--mcp-border-hover)] hover:bg-[var(--mcp-elevated)] hover:shadow-[0_12px_28px_rgba(0,0,0,0.18)] ${
          rowActive
            ? "border-[var(--mcp-border-hover)] bg-[var(--mcp-elevated)] shadow-[0_12px_28px_rgba(0,0,0,0.16)]"
            : "border-transparent bg-transparent"
        }`}
      >
        <button
          type="button"
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <div
            className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] transition-all duration-200 group-hover:scale-[1.04] group-hover:shadow-[0_0_0_3px_rgba(96,165,250,0.10)]"
            style={{
              backgroundColor: installedEntry
                ? "var(--mcp-purple-icon-bg)"
                : hasRemoteOption
                  ? "var(--mcp-blue-soft)"
                  : "var(--mcp-purple-icon-bg)",
              border: installedEntry
                ? "1px solid var(--mcp-purple-border)"
                : hasRemoteOption
                  ? "1px solid var(--mcp-blue-border)"
                  : "1px solid var(--mcp-purple-border)",
            }}
          >
            {iconSrc && !iconFailed ? (
              <img
                src={iconSrc}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                className="h-6 w-6 rounded object-contain"
                onError={() => setIconFailed(true)}
              />
            ) : hasRemoteOption ? (
              <Globe size={20} className="text-[var(--mcp-blue-text)]" />
            ) : (
              <Package size={20} className="text-accent-purple" />
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[14px] font-[740] text-[var(--mcp-text-strong)] transition-colors group-hover:text-[var(--mcp-text-hover)]">
                {serverDisplayName(item)}
              </span>
              <span className="shrink-0 rounded bg-[var(--mcp-chip)] px-1.5 py-px font-mono text-[11px] font-semibold text-[var(--mcp-text-muted)]">
                v{item.server.version}
              </span>
              {installedEntry && (
                <span className="flex h-[22px] shrink-0 items-center rounded-[8px] bg-[var(--mcp-green-bg)] px-2 text-[11px] font-bold text-[var(--mcp-green-text)]">
                  {t("mcp.marketplace.alreadyInstalled")}
                </span>
              )}
            </div>
            <span className="block truncate text-[12px] font-medium text-[var(--mcp-text-muted)] transition-colors group-hover:text-[var(--mcp-text)]">
              {item.server.description}
            </span>
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono text-[11px] font-semibold text-[var(--mcp-text-faint)]">
                {item.server.name}
              </span>
              <span className="shrink-0 text-[11px] font-semibold text-[var(--mcp-text-faintest)]">
                ·
              </span>
              <span className="shrink-0 text-[11px] font-semibold text-[var(--mcp-text-faint)]">
                {metaSummary}
              </span>
              {updatedAt && (
                <>
                  <span className="hidden shrink-0 text-[11px] font-semibold text-[var(--mcp-text-faintest)] sm:inline">
                    ·
                  </span>
                  <span className="hidden shrink-0 text-[11px] font-semibold text-[var(--mcp-text-faint)] sm:inline">
                    {t("mcp.marketplace.updated", { date: updatedAt.slice(0, 10) })}
                  </span>
                </>
              )}
            </div>
          </div>
        </button>

        {installedEntry ? (
          <button
            type="button"
            onClick={onSelect}
            className="flex h-[30px] shrink-0 items-center justify-center rounded-[10px] bg-[var(--mcp-btn)] px-3 text-[13px] font-bold text-[var(--mcp-text-strong)] transition-all duration-200 hover:bg-[var(--mcp-btn-hover)] group-hover:translate-x-0.5 group-hover:text-[var(--mcp-text-hover)]"
          >
            {t("mcp.marketplace.details")}
          </button>
        ) : (
          <button
            type="button"
            onClick={onInstall}
            disabled={installing || options.length === 0}
            className="flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-[10px] bg-[var(--mcp-elevated)] px-3 text-[13px] font-bold text-[var(--mcp-text)] transition-all duration-200 hover:bg-[var(--mcp-btn)] hover:text-[var(--mcp-text-strong)] group-hover:translate-x-0.5 group-hover:bg-[var(--mcp-btn)] group-hover:text-[var(--mcp-text-hover)] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {installing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            {options.length === 0 ? t("mcp.marketplace.unsupported") : t("mcp.marketplace.install")}
          </button>
        )}
      </article>

      {installState?.error && (
        <div className="whitespace-pre-line break-words rounded-lg bg-[var(--mcp-red-bg)] px-3 py-2 text-[11px] text-[var(--mcp-red)]">
          {installState.error}
        </div>
      )}
    </div>
  );
}

function InstallFieldsForm({
  fields,
  values,
  onChange,
}: {
  readonly fields: ReadonlyArray<InstallField>;
  readonly values: Record<string, string>;
  readonly onChange: (values: Record<string, string>) => void;
}) {
  if (fields.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-2">
      {fields.map((field) => (
        <label key={field.key} className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold text-text-placeholder">
            {field.label}
            {field.required && <span className="text-[var(--mcp-red)]"> *</span>}
          </span>
          <input
            type={field.secret ? "password" : "text"}
            value={values[field.key] ?? field.defaultValue ?? ""}
            onChange={(event) => onChange({ ...values, [field.key]: event.target.value })}
            placeholder={field.placeholder || field.description || field.label}
            className="h-9 rounded-[10px] bg-background px-3 text-[12px] text-foreground outline-none transition-colors placeholder:text-border-strong focus:border-accent-purple"
            style={{ border: "1px solid var(--color-border-light)" }}
          />
          {field.description && (
            <span className="text-[10px] leading-4 text-border-strong">{field.description}</span>
          )}
        </label>
      ))}
    </div>
  );
}

function MarketplaceDetailPanel({
  item,
  servers,
  installState,
  values,
  onValuesChange,
  onInstall,
  onAuthorize,
}: {
  readonly item: McpMarketplaceServer;
  readonly servers: Readonly<Record<string, McpServerConfig>>;
  readonly installState?: InstallState;
  readonly values: Record<string, string>;
  readonly onValuesChange: (values: Record<string, string>) => void;
  readonly onInstall: () => void;
  readonly onAuthorize: () => void;
}) {
  const { t } = useTranslation();
  const isLight = useIsLightTheme();
  const options = useMemo(() => installOptions(item), [item]);
  const fields = useMemo(() => mergedInstallFields(options), [options]);
  const installedEntry = installedServerEntry(item, servers, options);
  const officialMeta = item._meta?.["io.modelcontextprotocol.registry/official"];
  const repository = item.server.repository;
  const iconSrc = marketplaceIconSrc(item, isLight);
  const [iconFailed, setIconFailed] = useState(false);
  const remotePreviewConfig = useMemo(() => {
    const remoteOption = options.find((option) => option.id.startsWith("remote"));
    if (!remoteOption || !optionCanBuild(remoteOption, values)) return null;
    return remoteOption.buildConfig(values);
  }, [options, values]);
  const [authInspection, setAuthInspection] = useState<McpAuthInspectionResult | null>(null);
  const [authInspecting, setAuthInspecting] = useState(false);
  const canAuthorizeOAuth = authInspection?.mode === "oauth" && authInspection.canAuthorize;
  const canShowAuthorizeAction =
    canAuthorizeOAuth && (!installedEntry || supportsMcpOAuth(installedEntry[1]));

  useEffect(() => {
    setIconFailed(false);
  }, [iconSrc]);

  useEffect(() => {
    let cancelled = false;
    async function inspect() {
      if (!remotePreviewConfig || !supportsMcpOAuth(remotePreviewConfig)) {
        setAuthInspection(null);
        setAuthInspecting(false);
        return;
      }
      setAuthInspecting(true);
      try {
        const next = await invoke<McpAuthInspectionResult>("mcp_auth_inspect", {
          config: remotePreviewConfig,
        });
        if (!cancelled) setAuthInspection(next);
      } catch (err) {
        if (!cancelled) {
          setAuthInspection({
            mode: "unknown",
            canAuthorize: false,
            message: `${t("mcp.management.authInspectFailed")}: ${err}`,
          });
        }
      } finally {
        if (!cancelled) setAuthInspecting(false);
      }
    }
    void inspect();
    return () => {
      cancelled = true;
    };
  }, [remotePreviewConfig, t]);

  return (
    <div
      className="flex h-full flex-col gap-5 overflow-y-auto rounded-[18px] p-6"
      style={{
        backgroundColor: "var(--color-background)",
        border: "1px solid var(--color-border-light)",
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px]"
          style={{ backgroundColor: isLight ? "#F0E6FF" : "var(--color-surface-raised)" }}
        >
          {iconSrc && !iconFailed ? (
            <img
              src={iconSrc}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="h-7 w-7 rounded object-contain"
              onError={() => setIconFailed(true)}
            />
          ) : (
            <Package size={22} className="text-accent-purple" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-[20px] font-bold text-foreground">
              {serverDisplayName(item)}
            </span>
            <span className="rounded bg-card px-1.5 py-px font-mono text-[11px] text-border-strong">
              version {item.server.version}
            </span>
            {officialMeta?.status && (
              <span className="rounded bg-[var(--mcp-green-bg)] px-1.5 py-px text-[11px] font-bold text-[var(--mcp-green-text)]">
                {officialMeta.status}
              </span>
            )}
            {officialMeta?.isLatest && (
              <span className="rounded bg-card px-1.5 py-px text-[11px] font-bold text-border-strong">
                latest
              </span>
            )}
            {installedEntry && (
              <span className="rounded bg-[var(--mcp-green-bg)] px-1.5 py-px text-[11px] font-bold text-[var(--mcp-green-text)]">
                {t("mcp.marketplace.alreadyInstalled")}
              </span>
            )}
          </div>
          <span className="mt-1 block truncate font-mono text-[12px] text-border-strong">
            {item.server.name}
          </span>
        </div>
      </div>

      <p className="text-[13px] leading-6 text-text-placeholder">{item.server.description}</p>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[13px] font-bold text-foreground">
          <FileText size={15} className="text-accent-purple" />
          {t("mcp.marketplace.detailOverview")}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <DetailRow
            label={t("mcp.marketplace.repository")}
            value={repository?.url}
            href={repository?.url}
            mono
          />
          <DetailRow
            label={t("mcp.marketplace.updatedAt")}
            value={officialMeta?.updatedAt?.slice(0, 10)}
          />
          <DetailRow label={t("mcp.marketplace.author")} value={serverAuthor(item)} />
          <DetailRow label={t("mcp.marketplace.status")} value={officialMeta?.status} />
        </div>
      </section>

      {!installedEntry && fields.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-[13px] font-bold text-foreground">
            <KeyRound size={15} className="text-accent-purple" />
            {t("mcp.marketplace.requiredConfig")}
          </div>
          <InstallFieldsForm fields={fields} values={values} onChange={onValuesChange} />
        </section>
      )}

      {installState?.error && (
        <div className="whitespace-pre-line break-words rounded-[12px] bg-[var(--mcp-red-bg)] px-3 py-2 text-[12px] text-[var(--mcp-red)]">
          {installState.error}
        </div>
      )}
      {installState?.message && (
        <div className="rounded-[12px] bg-[var(--mcp-green-bg)] px-3 py-2 text-[12px] text-[var(--mcp-green-text)]">
          {installState.message}
        </div>
      )}

      <div className="mt-auto flex items-center justify-end">
        {installedEntry ? (
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-2 rounded-[11px] bg-[var(--mcp-green-bg)] px-4 py-2 text-[13px] font-bold text-[var(--mcp-green-text)]">
              <CircleCheck size={15} />
              {t("mcp.marketplace.installedAs", { name: installedEntry[0] })}
            </span>
            {(authInspecting || canShowAuthorizeAction) && (
              <button
                type="button"
                onClick={onAuthorize}
                disabled={authInspecting || installState?.loading}
                className="flex items-center gap-2 rounded-[11px] bg-accent-purple px-4 py-2 text-[13px] font-bold text-white transition-colors hover:bg-[var(--mcp-purple-strong)] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {authInspecting || installState?.loading ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <KeyRound size={15} />
                )}
                {authInspecting
                  ? t("mcp.management.authInspectingShort")
                  : t("mcp.management.oauthLogin")}
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={canShowAuthorizeAction ? onAuthorize : onInstall}
            disabled={authInspecting || installState?.loading || options.length === 0}
            className="flex items-center gap-2 rounded-[11px] bg-accent-purple px-5 py-2.5 text-[13px] font-bold text-white transition-colors hover:bg-[var(--mcp-purple-strong)] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {authInspecting || installState?.loading ? (
              <Loader2 size={15} className="animate-spin" />
            ) : canShowAuthorizeAction ? (
              <KeyRound size={15} />
            ) : (
              <Download size={15} />
            )}
            {authInspecting
              ? t("mcp.management.authInspectingShort")
              : installState?.loading
                ? t("mcp.marketplace.installing")
                : canShowAuthorizeAction
                  ? t("mcp.marketplace.installAndAuthorize")
                  : t("mcp.marketplace.install")}
          </button>
        )}
      </div>
    </div>
  );
}

function ToolsPanel({
  serverName,
  config,
  authBlocked,
  toolsStatus,
  listServerTools,
}: {
  readonly serverName: string;
  readonly config: McpServerConfig;
  readonly authBlocked: boolean;
  readonly toolsStatus: MarketplaceTabProps["toolsStatus"];
  readonly listServerTools: MarketplaceTabProps["listServerTools"];
}) {
  const { t } = useTranslation();
  const status = toolsStatus[serverName];
  const result = status?.result;
  const loadedTools = result?.ok ? result.tools : [];
  const totalParams = loadedTools.reduce((sum, tool) => sum + (toolParamCount(tool) ?? 0), 0);

  return (
    <section className="flex flex-col gap-3 rounded-[16px] border border-[var(--mcp-border)] bg-[var(--mcp-sunken)] p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[var(--mcp-purple-soft)] text-accent-purple">
            <ListChecks size={16} />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-[13px] font-bold text-foreground">
                {t("mcp.marketplace.toolsTitle")}
              </span>
              {result?.ok && (
                <span className="rounded-full bg-[var(--mcp-purple-chip)] px-2 py-0.5 text-[10px] font-bold text-accent-purple">
                  {t("mcp.marketplace.toolsSummary", { count: loadedTools.length })}
                </span>
              )}
            </div>
            <span className="mt-0.5 block truncate text-[11px] font-medium text-[var(--mcp-text-muted)]">
              {result?.ok
                ? t("mcp.marketplace.toolsParamSummary", { count: totalParams })
                : t("mcp.marketplace.toolsReadyHint")}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => listServerTools(serverName, config)}
          disabled={status?.loading || authBlocked}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] bg-[var(--mcp-purple-soft)] px-3 text-[12px] font-bold text-accent-purple transition-all duration-200 hover:-translate-y-px hover:bg-[var(--mcp-purple-soft-hover)] hover:text-[var(--mcp-purple-text)] disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-45"
        >
          {status?.loading ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <RefreshCw size={12} />
          )}
          {t("mcp.marketplace.loadTools")}
        </button>
      </div>

      {authBlocked && (
        <div className="rounded-[12px] border border-[var(--mcp-amber-border)] bg-[var(--mcp-amber-bg)] px-3 py-2 text-[12px] text-[var(--mcp-amber-text-soft)]">
          {t("mcp.management.toolsAfterAuth")}
        </div>
      )}
      {!authBlocked && result && !result.ok && (
        <div className="rounded-[12px] border border-[var(--mcp-red-border)] bg-[var(--mcp-red-bg)] px-3 py-2 text-[12px] text-[var(--mcp-red-soft)]">
          {result.message}
        </div>
      )}
      {!authBlocked && result?.ok && result.tools.length === 0 && (
        <div className="rounded-[12px] border border-[var(--mcp-border)] bg-[var(--mcp-card)] px-3 py-3 text-center text-[12px] text-border-strong">
          {t("mcp.marketplace.noTools")}
        </div>
      )}
      {!authBlocked && result?.ok && result.tools.length > 0 && (
        <div className="flex max-h-[330px] flex-col gap-2 overflow-y-auto pr-1">
          {loadedTools.map((tool) => {
            const params = toolParamCount(tool);
            const paramNames = toolParamNames(tool);
            const visibleParams = paramNames.slice(0, 3);
            const hiddenParamCount = Math.max(0, paramNames.length - visibleParams.length);
            return (
              <article
                key={tool.name}
                className="group rounded-[13px] border border-[var(--mcp-border)] bg-[var(--mcp-card)] px-3 py-3 transition-all duration-200 hover:-translate-y-px hover:border-[var(--mcp-border-hover)] hover:bg-[var(--mcp-elevated)]"
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[13px] font-[760] text-[var(--mcp-text-strong)] group-hover:text-[var(--mcp-text-hover)]">
                        {tool.title || tool.name}
                      </span>
                      {tool.title && (
                        <span className="truncate rounded bg-[var(--mcp-chip)] px-1.5 py-px font-mono text-[10px] text-[var(--mcp-text-faint)]">
                          {tool.name}
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 line-clamp-3 text-[12px] leading-5 text-[var(--mcp-text-muted)]">
                      {tool.description || t("mcp.marketplace.toolNoDescription")}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-[var(--mcp-chip)] px-2 py-1 text-[10px] font-bold text-[var(--mcp-text-muted)]">
                    {params === null
                      ? t("mcp.marketplace.toolNoParams")
                      : t("mcp.marketplace.toolParams", { count: params })}
                  </span>
                </div>
                {visibleParams.length > 0 && (
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
                    {visibleParams.map((param) => (
                      <span
                        key={param}
                        className="max-w-[120px] truncate rounded-[8px] bg-[var(--mcp-chip)] px-2 py-1 font-mono text-[10px] font-semibold text-[var(--mcp-text-muted)]"
                      >
                        {param}
                      </span>
                    ))}
                    {hiddenParamCount > 0 && (
                      <span className="rounded-[8px] bg-[var(--mcp-purple-soft)] px-2 py-1 text-[10px] font-bold text-accent-purple">
                        {t("mcp.marketplace.toolMoreParams", { count: hiddenParamCount })}
                      </span>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      {!authBlocked && !result && !status?.loading && (
        <div className="rounded-[13px] border border-dashed border-[var(--mcp-border-hover)] bg-[var(--mcp-card)] px-3 py-4 text-center">
          <span className="text-[12px] font-medium text-[var(--mcp-text-muted)]">
            {t("mcp.marketplace.toolsReadyHint")}
          </span>
        </div>
      )}
      {!authBlocked && status?.loading && (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="h-[74px] animate-pulse rounded-[13px] border border-[var(--mcp-border)] bg-[var(--mcp-card)]"
            />
          ))}
        </div>
      )}
    </section>
  );
}

function InstalledManagementPanel({
  name,
  config,
  marketplaceItem,
  setServer,
  verifyStatus,
  toolsStatus,
  verifyServer,
  listServerTools,
  removeServer,
}: {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly marketplaceItem: McpMarketplaceServer | null;
  readonly setServer: MarketplaceTabProps["setServer"];
  readonly verifyStatus: MarketplaceTabProps["verifyStatus"];
  readonly toolsStatus: MarketplaceTabProps["toolsStatus"];
  readonly verifyServer: MarketplaceTabProps["verifyServer"];
  readonly listServerTools: MarketplaceTabProps["listServerTools"];
  readonly removeServer: MarketplaceTabProps["removeServer"];
}) {
  const { t } = useTranslation();
  const status = statusForInstalledServer(name, config, verifyStatus);
  const authUrl = authUrlForConfig(config, marketplaceItem);
  const oauthAvailable = supportsMcpOAuth(config);
  const configFingerprint = useMemo(() => JSON.stringify(config), [config]);
  const [authInspection, setAuthInspection] = useState<McpAuthInspectionResult | null>(null);
  const [authInspecting, setAuthInspecting] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const [oauthStatus, setOauthStatus] = useState<McpOAuthStatusResult | null>(null);
  const [oauthFlow, setOauthFlow] = useState<{
    readonly loading: boolean;
    readonly waiting: boolean;
    readonly message?: string;
    readonly error?: string;
  }>({ loading: false, waiting: false });
  const oauthPollTimerRef = useRef<number | null>(null);
  const oauthAuthorized = oauthStatus?.authorized === true;
  const canStartOAuth = authInspection?.mode === "oauth" && authInspection.canAuthorize;
  const showStaticAuthButton = !oauthAvailable && status.authAction && Boolean(authUrl);
  const manualTokenRequired =
    authInspection?.mode === "token" ||
    (authInspection?.mode === "oauth" && !authInspection.canAuthorize);
  const authBlocked = status.tone === "warning" && status.authAction && !oauthAuthorized;
  const toolsAuthBlocked = authBlocked && !hasManualAuthSignal(config);
  const iconInfo = serverIcon(config, authBlocked ? "warning" : undefined);
  const authRecoveryHint = authBlocked
    ? authInspecting
      ? t("mcp.management.authInspectingDesc")
      : canStartOAuth
        ? t("mcp.management.dynamicOauthSupported")
        : manualTokenRequired
          ? t("mcp.management.manualTokenDesc")
          : oauthAvailable
            ? t("mcp.management.authUnknownDesc")
            : !authUrl
              ? t("mcp.management.noAuthUrl")
              : null
    : null;

  const clearOAuthPollTimer = useCallback(() => {
    if (oauthPollTimerRef.current !== null) {
      window.clearTimeout(oauthPollTimerRef.current);
      oauthPollTimerRef.current = null;
    }
  }, []);

  const refreshOAuthStatus = useCallback(async () => {
    if (!oauthAvailable) {
      setOauthStatus(null);
      return;
    }
    try {
      const next = await invoke<McpOAuthStatusResult>("mcp_oauth_get_status", { name, config });
      setOauthStatus(next);
    } catch {
      setOauthStatus(null);
    }
  }, [configFingerprint, name, oauthAvailable]);

  const inspectAuthCapability = useCallback(async () => {
    if (!oauthAvailable) {
      setAuthInspection(null);
      setAuthInspecting(false);
      return;
    }
    setAuthInspecting(true);
    try {
      const next = await invoke<McpAuthInspectionResult>("mcp_auth_inspect", { config });
      setAuthInspection(next);
    } catch (err) {
      setAuthInspection({
        mode: "unknown",
        canAuthorize: false,
        message: `${t("mcp.management.authInspectFailed")}: ${err}`,
      });
    } finally {
      setAuthInspecting(false);
    }
  }, [configFingerprint, oauthAvailable, t]);

  const pollOAuthCompletion = useCallback(
    (state: string, attempt = 0) => {
      clearOAuthPollTimer();
      oauthPollTimerRef.current = window.setTimeout(async () => {
        try {
          const result = await invoke<McpOAuthPollResult>("mcp_oauth_complete", { state });
          if (result.status === "pending") {
            if (attempt >= 300) {
              setOauthFlow({
                loading: false,
                waiting: false,
                error: t("mcp.management.oauthTimeout"),
              });
              return;
            }
            pollOAuthCompletion(state, attempt + 1);
            return;
          }
          if (result.status === "authorized") {
            setOauthStatus({
              authorized: true,
              expiresAt: result.expiresAt,
              scopes: result.scopes,
              tokenType: result.tokenType,
            });
            setOauthFlow({
              loading: false,
              waiting: false,
              message: t("mcp.management.oauthSuccess"),
            });
            await verifyServer(name, config);
            await listServerTools(name, config);
            return;
          }
          setOauthFlow({
            loading: false,
            waiting: false,
            error: result.message || t("mcp.management.oauthFailed"),
          });
        } catch (err) {
          setOauthFlow({
            loading: false,
            waiting: false,
            error: `${t("mcp.management.oauthFailed")}: ${err}`,
          });
        }
      }, 1200);
    },
    [clearOAuthPollTimer, configFingerprint, listServerTools, name, t, verifyServer],
  );

  useEffect(() => {
    void refreshOAuthStatus();
    return clearOAuthPollTimer;
  }, [clearOAuthPollTimer, refreshOAuthStatus]);

  useEffect(() => {
    void inspectAuthCapability();
  }, [inspectAuthCapability]);

  const handleOAuthAuthorize = useCallback(async () => {
    if (!canStartOAuth) return;
    clearOAuthPollTimer();
    setOauthFlow({ loading: true, waiting: false });
    try {
      const started = await invoke<McpOAuthStartResult>("mcp_oauth_start", { name, config });
      if (!started.browserOpened) {
        openUrl(started.authorizeUrl).catch(() => {});
      }
      setOauthFlow({
        loading: false,
        waiting: true,
        message: t("mcp.management.oauthBrowserHint"),
      });
      pollOAuthCompletion(started.state);
    } catch (err) {
      setOauthFlow({
        loading: false,
        waiting: false,
        error: `${t("mcp.management.oauthStartFailed")}: ${err}`,
      });
    }
  }, [canStartOAuth, clearOAuthPollTimer, configFingerprint, name, pollOAuthCompletion, t]);

  const handleSaveManualToken = useCallback(async () => {
    if (!("url" in config)) return;
    const token = normalizedBearerToken(manualToken);
    if (!token) {
      setOauthFlow({
        loading: false,
        waiting: false,
        error: t("mcp.management.manualTokenRequired"),
      });
      return;
    }
    const nextConfig: McpServerConfig = {
      ...config,
      headers: {
        ...(config.headers ?? {}),
        Authorization: token,
      },
    };
    try {
      await setServer(name, nextConfig);
    } catch (error) {
      setOauthFlow({
        loading: false,
        waiting: false,
        error: `${t("mcp.management.manualTokenRequired")}: ${error}`,
      });
      return;
    }
    setManualToken("");
    setOauthFlow({
      loading: false,
      waiting: false,
      message: t("mcp.management.manualTokenSaved"),
    });
    await verifyServer(name, nextConfig);
    await listServerTools(name, nextConfig);
  }, [configFingerprint, listServerTools, manualToken, name, setServer, t, verifyServer]);

  const handleDisconnect = async () => {
    const ok = window.confirm(t("mcp.management.disconnectConfirm", { name }));
    if (!ok) return;
    if (oauthAvailable) {
      invoke("mcp_oauth_sign_out", { name, config }).catch(() => {});
    }
    try {
      await removeServer(name);
    } catch (error) {
      setOauthFlow({
        loading: false,
        waiting: false,
        error: String(error),
      });
    }
  };

  const handleReauthorize = () => {
    if (canStartOAuth) {
      void handleOAuthAuthorize();
      return;
    }
    if (!authUrl) return;
    openUrl(authUrl).catch(() => {});
  };

  return (
    <div
      className="flex h-full flex-col overflow-hidden rounded-[18px]"
      style={{
        backgroundColor: "var(--color-background)",
        border: "1px solid var(--color-border-light)",
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6 pb-4">
        <div className="flex items-start gap-3">
          <div
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px]"
            style={{ backgroundColor: iconInfo.bg }}
          >
            {iconInfo.icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-[20px] font-bold text-foreground">{name}</span>
              <span
                className={`rounded px-1.5 py-px text-[11px] font-bold ${statusClass(status.tone)}`}
              >
                {t(status.labelKey, status.defaultLabel)}
              </span>
            </div>
            <span className="mt-1 block truncate font-mono text-[12px] text-border-strong">
              {config.type ?? "stdio"} · {getConfigSummary(config)}
            </span>
          </div>
        </div>

        {authBlocked && (
          <div className="flex flex-col gap-3">
            <div
              className="flex items-start gap-3 rounded-[14px] bg-[var(--mcp-amber-bg)] p-4 text-[var(--mcp-amber-text)]"
              style={{ border: "1px solid var(--mcp-amber-border)" }}
            >
              <ShieldAlert size={18} className="mt-0.5 shrink-0" />
              <div className="flex flex-col gap-1">
                <span className="text-[14px] font-bold">
                  {t("mcp.management.authExpiredTitle")}
                </span>
                <span className="text-[12px] leading-5 text-[var(--mcp-amber-text-soft)]">
                  {t("mcp.management.authExpiredDesc")}
                </span>
              </div>
            </div>
            {authRecoveryHint && (
              <div
                className="rounded-[12px] bg-[var(--mcp-sunken)] px-3 py-2 text-[12px] leading-5 text-muted"
                style={{ border: "1px solid var(--color-border-light)" }}
              >
                {authRecoveryHint}
              </div>
            )}
          </div>
        )}

        {status.message && (
          <div className={`rounded-[12px] px-3 py-2 text-[12px] ${statusClass(status.tone)}`}>
            {status.message}
          </div>
        )}
        {oauthStatus?.authorized && (
          <div
            className="rounded-[12px] bg-[var(--mcp-green-bg)] px-3 py-2 text-[12px] leading-5 text-[var(--mcp-green-text)]"
            style={{ border: "1px solid var(--mcp-green-border)" }}
          >
            {t("mcp.management.oauthAuthorizedDesc")}
            {oauthStatus.scopes ? ` · ${oauthStatus.scopes}` : ""}
          </div>
        )}
        {oauthFlow.message && (
          <div
            className="rounded-[12px] bg-[var(--mcp-purple-chip)] px-3 py-2 text-[12px] leading-5 text-accent-purple"
            style={{ border: "1px solid var(--mcp-purple-border-soft)" }}
          >
            {oauthFlow.message}
          </div>
        )}
        {oauthFlow.error && (
          <div
            className="rounded-[12px] bg-[var(--mcp-red-bg)] px-3 py-2 text-[12px] leading-5 text-[var(--mcp-red-soft)]"
            style={{ border: "1px solid var(--mcp-red-border)" }}
          >
            {oauthFlow.error}
          </div>
        )}
        {manualTokenRequired && !oauthAuthorized && (
          <section
            className="flex flex-col gap-3 rounded-[14px] bg-[var(--mcp-sunken)] p-3"
            style={{ border: "1px solid var(--color-border-light)" }}
          >
            <div className="flex items-center gap-2 text-[13px] font-bold text-foreground">
              <KeyRound size={15} className="text-accent-purple" />
              {t("mcp.management.manualTokenTitle")}
            </div>
            <div className="flex gap-2">
              <input
                type="password"
                value={manualToken}
                onChange={(event) => setManualToken(event.target.value)}
                placeholder={t("mcp.management.manualTokenPlaceholder")}
                className="h-10 min-w-0 flex-1 rounded-[10px] bg-background px-3 text-[12px] text-foreground outline-none transition-colors placeholder:text-border-strong focus:border-accent-purple"
                style={{ border: "1px solid var(--color-border-light)" }}
              />
              <button
                type="button"
                onClick={handleSaveManualToken}
                className="flex h-10 shrink-0 items-center gap-1.5 rounded-[10px] bg-[var(--mcp-purple-soft)] px-3 text-[12px] font-bold text-accent-purple transition-colors hover:bg-[var(--mcp-purple-soft-hover)] hover:text-[var(--mcp-purple-text)]"
              >
                <CircleCheck size={13} />
                {t("mcp.management.saveToken")}
              </button>
            </div>
            <p className="text-[11px] leading-4 text-[var(--mcp-text-muted)]">
              {t("mcp.management.manualTokenDesc")}
            </p>
          </section>
        )}

        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-[13px] font-bold text-foreground">
            <FileText size={15} className="text-accent-purple" />
            {t("mcp.management.connectionInfo")}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <DetailRow label={t("mcp.management.transport")} value={config.type ?? "stdio"} />
            <DetailRow
              label={t("mcp.management.auth")}
              value={
                oauthAuthorized
                  ? t("mcp.management.oauthAuthorized")
                  : authInspecting
                    ? t("mcp.management.authInspecting")
                    : authInspection?.mode === "oauth"
                      ? authInspection.canAuthorize
                        ? t("mcp.management.oauthSupported")
                        : t("mcp.management.oauthUnsupported")
                      : authInspection?.mode === "token"
                        ? t("mcp.management.manualToken")
                        : authInspection?.mode === "unknown"
                          ? t("mcp.management.authUnknown")
                          : status.authAction
                            ? t("mcp.management.oauthOrToken")
                            : t("mcp.management.notRequired")
              }
            />
            <DetailRow
              label={t("mcp.management.commandOrUrl")}
              value={getConfigSummary(config)}
              href={"url" in config ? config.url : undefined}
              mono
            />
            <DetailRow
              label={t("mcp.management.source")}
              value={marketplaceItem?.server.name ?? t("mcp.management.manualSource")}
              mono
            />
          </div>
        </section>

        <ToolsPanel
          serverName={name}
          config={config}
          authBlocked={toolsAuthBlocked}
          toolsStatus={toolsStatus}
          listServerTools={listServerTools}
        />
      </div>

      <div
        className="flex shrink-0 items-center justify-between gap-3 px-5 py-4"
        style={{
          borderTop: "1px solid var(--color-border-light)",
          backgroundColor: "var(--color-background)",
        }}
      >
        <Tooltip content={t("mcp.management.disconnectTooltip")} placement="top">
          <button
            type="button"
            onClick={handleDisconnect}
            className="flex items-center gap-2 rounded-[11px] px-4 py-2 text-[13px] font-bold text-[var(--mcp-red-soft)] transition-colors hover:bg-[var(--mcp-red-bg)]"
            style={{ border: "1px solid var(--mcp-red-border)" }}
          >
            <Unlink size={15} />
            {t("mcp.management.disconnect")}
          </button>
        </Tooltip>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => verifyServer(name, config)}
            disabled={verifyStatus[name]?.loading}
            className="flex items-center gap-2 rounded-[11px] px-4 py-2 text-[13px] font-bold text-accent-purple transition-colors hover:bg-[var(--mcp-purple-chip-hover)] disabled:cursor-not-allowed disabled:opacity-45"
            style={{ backgroundColor: "var(--mcp-purple-chip)" }}
          >
            {verifyStatus[name]?.loading ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <RefreshCw size={15} />
            )}
            {t("mcp.management.testConnection")}
          </button>
          {(authInspecting || canStartOAuth || showStaticAuthButton) && (
            <Tooltip
              content={
                canStartOAuth
                  ? t("mcp.management.oauthLoginTooltip")
                  : t("mcp.management.reauthorizeTooltip")
              }
              placement="top"
            >
              <button
                type="button"
                onClick={handleReauthorize}
                disabled={
                  authInspecting ||
                  (canStartOAuth ? oauthFlow.loading || oauthFlow.waiting : !authUrl)
                }
                className="flex items-center gap-2 rounded-[11px] bg-accent-purple px-4 py-2 text-[13px] font-bold text-white transition-colors hover:bg-[var(--mcp-purple-strong)] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {authInspecting || oauthFlow.loading || oauthFlow.waiting ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : canStartOAuth ? (
                  <KeyRound size={15} />
                ) : (
                  <ExternalLink size={15} />
                )}
                {authInspecting
                  ? t("mcp.management.authInspectingShort")
                  : oauthFlow.loading || oauthFlow.waiting
                    ? t("mcp.management.oauthWaiting")
                    : canStartOAuth && !oauthAuthorized
                      ? t("mcp.management.oauthLogin")
                      : t("mcp.management.reauthorize")}
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailDrawer({
  open,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`absolute inset-y-7 right-8 z-10 w-[430px] max-w-[calc(100%-64px)] transition-all duration-300 ease-out ${
        open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-10 opacity-0"
      }`}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-border-light"
        aria-label={t("common.close", "Close")}
      >
        <X size={15} />
      </button>
      {children}
    </div>
  );
}

export function MarketplaceTab({
  searchQuery,
  onSearchQueryChange,
  servers,
  marketplaceServers,
  marketplaceSearching,
  marketplaceNextCursor,
  marketplaceError,
  searchMarketplace,
  lookupMarketplace,
  setServer,
  removeServer,
  verifyServer,
  verifyStatus,
  toolsStatus,
  listServerTools,
}: MarketplaceTabProps) {
  const { t } = useTranslation();
  const [activeCategory, setActiveCategory] = useState<MarketplaceCategoryKey>("all");
  const [selection, setSelection] = useState<DetailSelection | null>(null);
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [installStateByKey, setInstallStateByKey] = useState<Record<string, InstallState>>({});
  const [installValuesByKey, setInstallValuesByKey] = useState<
    Record<string, Record<string, string>>
  >({});
  const [installedLookupByName, setInstalledLookupByName] = useState<
    Record<string, ReadonlyArray<McpMarketplaceServer>>
  >({});
  const [updatingName, setUpdatingName] = useState<string | null>(null);
  const [updateStateByName, setUpdateStateByName] = useState<Record<string, InstallState>>({});
  const [installedCollapsed, setInstalledCollapsed] = useState(false);
  const marketplaceScrollRef = useRef<HTMLDivElement | null>(null);
  const loadingNextPageRef = useRef(false);
  const query = searchQuery.trim();
  const installedEntries = useMemo(() => Object.entries(servers), [servers]);

  useEffect(() => {
    const delay = query ? 350 : 0;
    const timer = window.setTimeout(() => {
      searchMarketplace(query, false);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [query, searchMarketplace]);

  useEffect(() => {
    if (selection?.kind === "installed" && !servers[selection.name]) {
      setSelection(null);
    }
    if (selection?.kind === "marketplace") {
      const exists = marketplaceServers.some((item) => itemKey(item) === selection.key);
      if (!exists) setSelection(null);
    }
  }, [marketplaceServers, selection, servers]);

  useEffect(() => {
    if (installedEntries.length === 0) {
      setInstalledLookupByName({});
      return;
    }

    let cancelled = false;
    const entries = installedEntries.slice(0, 24);

    async function runLookups() {
      const pairs = await Promise.all(
        entries.map(async ([name, config]) => {
          const results = await lookupMarketplace(installedLookupQuery(name, config), 10);
          return [name, results] as const;
        }),
      );
      if (!cancelled) {
        setInstalledLookupByName(Object.fromEntries(pairs));
      }
    }

    void runLookups();
    return () => {
      cancelled = true;
    };
  }, [installedEntries, lookupMarketplace]);

  const registryItemsForInstalled = useMemo(
    () => mergedMarketplaceItems(marketplaceServers, installedLookupByName),
    [installedLookupByName, marketplaceServers],
  );

  const updateInfoByName = useMemo(() => {
    const entries = installedEntries
      .map(
        ([name, config]) => [name, installedUpdateInfo(config, registryItemsForInstalled)] as const,
      )
      .filter((entry): entry is readonly [string, InstalledUpdateInfo] => entry[1] !== null);
    return Object.fromEntries(entries);
  }, [installedEntries, registryItemsForInstalled]);

  const selectedMarketplaceItem = useMemo(() => {
    if (selection?.kind !== "marketplace") return null;
    return marketplaceServers.find((item) => itemKey(item) === selection.key) ?? null;
  }, [marketplaceServers, selection]);

  const selectedInstalled = useMemo(() => {
    if (selection?.kind !== "installed") return null;
    const config = servers[selection.name];
    return config ? ([selection.name, config] as const) : null;
  }, [selection, servers]);

  const filteredServers = useMemo(() => {
    const items =
      activeCategory === "all"
        ? marketplaceServers
        : marketplaceServers.filter((item) => inferMarketplaceCategory(item) === activeCategory);
    return sortedMarketplaceServers(items);
  }, [activeCategory, marketplaceServers]);

  const loadNextMarketplacePage = useCallback(async () => {
    if (!marketplaceNextCursor || marketplaceSearching || loadingNextPageRef.current) return;
    loadingNextPageRef.current = true;
    try {
      await searchMarketplace(query, true);
    } finally {
      loadingNextPageRef.current = false;
    }
  }, [marketplaceNextCursor, marketplaceSearching, query, searchMarketplace]);

  const handleMarketplaceScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const target = event.currentTarget;
      const remaining = target.scrollHeight - target.scrollTop - target.clientHeight;
      if (remaining < 160) {
        void loadNextMarketplacePage();
      }
    },
    [loadNextMarketplacePage],
  );

  useEffect(() => {
    const target = marketplaceScrollRef.current;
    if (!target || !marketplaceNextCursor || marketplaceSearching) return;
    if (target.scrollHeight <= target.clientHeight + 16) {
      void loadNextMarketplacePage();
    }
  }, [
    filteredServers.length,
    loadNextMarketplacePage,
    marketplaceNextCursor,
    marketplaceSearching,
  ]);

  const setInstallValues = useCallback((key: string, values: Record<string, string>) => {
    setInstallValuesByKey((prev) => ({ ...prev, [key]: values }));
  }, []);

  const installMarketplaceItem = useCallback(
    async (item: McpMarketplaceServer): Promise<InstalledMarketplaceResult | null> => {
      const key = itemKey(item);
      const options = installOptions(item);
      const values = installValuesByKey[key] ?? {};
      if (options.length === 0) {
        setInstallStateByKey((prev) => ({
          ...prev,
          [key]: { loading: false, error: t("mcp.marketplace.unsupported") },
        }));
        return null;
      }

      const buildableOptions = options.filter((option) => optionCanBuild(option, values));
      if (buildableOptions.length === 0) {
        setSelection({ kind: "marketplace", key });
        setInstallStateByKey((prev) => ({
          ...prev,
          [key]: { loading: false, error: t("mcp.marketplace.missingRequiredConfig") },
        }));
        return null;
      }

      setInstallingKey(key);
      setInstallStateByKey((prev) => ({
        ...prev,
        [key]: { loading: true, message: t("mcp.marketplace.installTrying") },
      }));

      const failures: string[] = [];
      for (const option of buildableOptions) {
        const serverName = uniqueServerName(option.baseServerName, servers);
        const config = option.buildConfig(values);
        const result = await verifyServer(serverName, config);
        if (result.ok || isAuthRequiredMessage(result.message)) {
          try {
            await setServer(serverName, config);
          } catch (error) {
            failures.push(`${option.label}: ${String(error)}`);
            continue;
          }
          setSelection({ kind: "installed", name: serverName });
          setInstallingKey(null);
          setInstallStateByKey((prev) => ({
            ...prev,
            [key]: {
              loading: false,
              message: result.ok
                ? t("mcp.marketplace.installSuccess", { name: serverName })
                : t("mcp.marketplace.installNeedsAuth", { name: serverName }),
            },
          }));
          return {
            key,
            name: serverName,
            config,
          };
        }
        failures.push(`${option.label}: ${result.message}`);
      }

      setInstallingKey(null);
      setInstallStateByKey((prev) => ({
        ...prev,
        [key]: {
          loading: false,
          error: failures.length > 0 ? failures.join("\n") : t("mcp.marketplace.installFailed"),
        },
      }));
      return null;
    },
    [installValuesByKey, servers, setServer, t, verifyServer],
  );

  const startMarketplaceOAuthFlow = useCallback(
    async (installed: InstalledMarketplaceResult) => {
      setInstallingKey(installed.key);
      setInstallStateByKey((prev) => ({
        ...prev,
        [installed.key]: { loading: true, message: t("mcp.management.oauthBrowserHint") },
      }));

      try {
        const started = await invoke<McpOAuthStartResult>("mcp_oauth_start", {
          name: installed.name,
          config: installed.config,
        });
        if (!started.browserOpened) {
          openUrl(started.authorizeUrl).catch(() => {});
        }

        for (let attempt = 0; attempt <= 300; attempt += 1) {
          await delay(1200);
          const result = await invoke<McpOAuthPollResult>("mcp_oauth_complete", {
            state: started.state,
          });
          if (result.status === "pending") continue;
          if (result.status === "authorized") {
            await verifyServer(installed.name, installed.config);
            await listServerTools(installed.name, installed.config);
            setSelection({ kind: "installed", name: installed.name });
            setInstallingKey(null);
            setInstallStateByKey((prev) => ({
              ...prev,
              [installed.key]: {
                loading: false,
                message: t("mcp.management.oauthSuccess"),
              },
            }));
            return;
          }
          throw new Error(result.message || t("mcp.management.oauthFailed"));
        }

        throw new Error(t("mcp.management.oauthTimeout"));
      } catch (err) {
        setSelection({ kind: "installed", name: installed.name });
        setInstallingKey(null);
        setInstallStateByKey((prev) => ({
          ...prev,
          [installed.key]: {
            loading: false,
            error: `${t("mcp.management.oauthStartFailed")}: ${err}`,
          },
        }));
      }
    },
    [listServerTools, t, verifyServer],
  );

  const installMarketplaceOAuthItem = useCallback(
    async (item: McpMarketplaceServer): Promise<InstalledMarketplaceResult | null> => {
      const key = itemKey(item);
      const options = installOptions(item);
      const values = installValuesByKey[key] ?? {};
      const remoteOption = options.find((option) => {
        if (!option.id.startsWith("remote")) return false;
        if (!optionCanBuild(option, values)) return false;
        return supportsMcpOAuth(option.buildConfig(values));
      });

      if (!remoteOption) {
        setSelection({ kind: "marketplace", key });
        setInstallStateByKey((prev) => ({
          ...prev,
          [key]: { loading: false, error: t("mcp.marketplace.missingRequiredConfig") },
        }));
        return null;
      }

      const name = uniqueServerName(remoteOption.baseServerName, servers);
      const config = remoteOption.buildConfig(values);
      await setServer(name, config);
      setSelection({ kind: "installed", name });
      return { key, name, config };
    },
    [installValuesByKey, servers, setServer, t],
  );

  const authorizeMarketplaceItem = useCallback(
    async (item: McpMarketplaceServer) => {
      const key = itemKey(item);
      const options = installOptions(item);
      const existing = installedServerEntry(item, servers, options);
      if (existing) {
        const [name, config] = existing;
        setSelection({ kind: "installed", name });
        await startMarketplaceOAuthFlow({
          key,
          name,
          config,
        });
        return;
      }

      const installed = await installMarketplaceOAuthItem(item);
      if (!installed) return;
      await startMarketplaceOAuthFlow(installed);
    },
    [installMarketplaceOAuthItem, servers, startMarketplaceOAuthFlow],
  );

  const updateInstalledServer = useCallback(
    async (name: string, config: McpServerConfig, updateInfo: InstalledUpdateInfo) => {
      const nextConfig = configWithUpdatedPackageVersion(config, updateInfo.pkg);
      if (!nextConfig) {
        setUpdateStateByName((prev) => ({
          ...prev,
          [name]: { loading: false, error: t("mcp.management.updateFailed") },
        }));
        return;
      }

      setUpdatingName(name);
      setUpdateStateByName((prev) => ({
        ...prev,
        [name]: { loading: true, message: t("mcp.management.updating") },
      }));

      const result = await verifyServer(name, nextConfig);
      setUpdatingName(null);

      if (result.ok || isAuthRequiredMessage(result.message)) {
        try {
          await setServer(name, nextConfig);
        } catch (error) {
          setUpdateStateByName((prev) => ({
            ...prev,
            [name]: { loading: false, error: String(error) },
          }));
          return;
        }
        setUpdateStateByName((prev) => ({
          ...prev,
          [name]: {
            loading: false,
            message: t("mcp.management.updateSuccess", {
              version: updateInfo.latestVersion,
            }),
          },
        }));
        return;
      }

      setUpdateStateByName((prev) => ({
        ...prev,
        [name]: {
          loading: false,
          error: result.message || t("mcp.management.updateFailed"),
        },
      }));
    },
    [setServer, t, verifyServer],
  );

  const renderDetail = (): ReactNode => {
    if (selectedInstalled) {
      const [name, config] = selectedInstalled;
      return (
        <InstalledManagementPanel
          name={name}
          config={config}
          marketplaceItem={findMarketplaceForInstalled(name, config, registryItemsForInstalled)}
          setServer={setServer}
          verifyStatus={verifyStatus}
          toolsStatus={toolsStatus}
          verifyServer={verifyServer}
          listServerTools={listServerTools}
          removeServer={removeServer}
        />
      );
    }
    if (selectedMarketplaceItem) {
      const key = itemKey(selectedMarketplaceItem);
      return (
        <MarketplaceDetailPanel
          item={selectedMarketplaceItem}
          servers={servers}
          installState={installStateByKey[key]}
          values={installValuesByKey[key] ?? {}}
          onValuesChange={(values) => setInstallValues(key, values)}
          onInstall={() => {
            void installMarketplaceItem(selectedMarketplaceItem);
          }}
          onAuthorize={() => {
            void authorizeMarketplaceItem(selectedMarketplaceItem);
          }}
        />
      );
    }
    return null;
  };

  const detailContent = renderDetail();
  const detailOpen = detailContent !== null;

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden px-8 py-7">
      <div
        className={`flex min-h-0 w-full flex-col gap-5 transition-all duration-300 ease-out ${
          detailOpen ? "mx-0 max-w-none pr-[456px]" : "mx-auto max-w-[920px] pr-0"
        }`}
      >
        <div className="flex items-center gap-3">
          <div
            className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-[14px] px-3.5"
            style={{
              backgroundColor: "var(--mcp-input)",
            }}
          >
            <Search size={17} className="shrink-0 text-[var(--mcp-text-muted)]" />
            <input
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              placeholder={t("mcp.marketplace.searchPlaceholder")}
              className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-[var(--mcp-text-strong)] outline-none placeholder:text-[var(--mcp-text-faint)]"
            />
          </div>
          <Tooltip content={t("mcp.marketplace.filterTooltip")} placement="top">
            <button
              type="button"
              className="flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-[var(--mcp-input-hover)]"
              style={{ backgroundColor: "var(--mcp-input)" }}
            >
              <Settings2 size={17} className="text-[var(--mcp-text-muted)]" />
            </button>
          </Tooltip>
        </div>

        {marketplaceServers.length > 0 && (
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {MARKETPLACE_CATEGORY_KEYS.map((category) => (
              <button
                key={category}
                type="button"
                onClick={() => setActiveCategory(category)}
                className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-bold transition-colors hover:bg-border-light"
                style={{
                  backgroundColor:
                    activeCategory === category
                      ? "var(--color-accent-purple)"
                      : "var(--mcp-elevated)",
                  color:
                    activeCategory === category
                      ? "var(--color-on-accent)"
                      : "var(--mcp-text-muted)",
                  border:
                    activeCategory === category
                      ? "1px solid var(--color-accent-purple)"
                      : "1px solid var(--mcp-border)",
                }}
              >
                {category !== "all" && <Tag size={11} />}
                {t(`mcp.marketplace.categories.${category}`)}
              </button>
            ))}
          </div>
        )}

        {installedEntries.length > 0 && (
          <InstalledSection
            entries={installedEntries}
            selection={selection}
            verifyStatus={verifyStatus}
            updateInfoByName={updateInfoByName}
            updatingName={updatingName}
            updateStateByName={updateStateByName}
            collapsed={installedCollapsed}
            onCollapsedChange={setInstalledCollapsed}
            onSelect={setSelection}
            onUpdate={updateInstalledServer}
          />
        )}

        <div className="flex shrink-0 items-center gap-3 pt-1">
          <div className="flex items-center gap-2">
            <Package size={15} className="text-accent-purple" />
            <span className="text-[13px] font-bold text-foreground">
              {t("mcp.marketplace.sectionTitle")}
            </span>
            <span className="rounded-lg bg-[var(--mcp-purple-chip)] px-2 py-0.5 text-[11px] font-bold text-accent-purple">
              {filteredServers.length}
            </span>
          </div>
          <div className="h-px flex-1 bg-[var(--mcp-divider)]" />
          <span className="hidden text-[11px] font-medium text-[var(--mcp-text-faint)] sm:block">
            {t("mcp.marketplace.sectionHint")}
          </span>
        </div>

        <div
          ref={marketplaceScrollRef}
          onScroll={handleMarketplaceScroll}
          className="min-h-0 flex-1 overflow-y-auto pr-1"
        >
          <div className="flex flex-col gap-2">
            {marketplaceError && (
              <div className="flex items-center gap-2 rounded-[12px] bg-[var(--mcp-red-bg)] px-3 py-2 text-[12px] text-[var(--mcp-red)]">
                <CircleAlert size={14} />
                {marketplaceError}
              </div>
            )}

            {marketplaceSearching && marketplaceServers.length === 0 && (
              <div className="flex flex-col items-center justify-center py-14">
                <Loader2 size={24} className="mb-3 animate-spin text-border-strong" />
                <span className="text-[12px] text-muted">{t("mcp.marketplace.searching")}</span>
              </div>
            )}

            {!marketplaceSearching && marketplaceServers.length === 0 && !marketplaceError && (
              <div className="flex flex-col items-center justify-center py-14 text-center">
                <Blocks size={28} className="mb-3 text-border-strong" />
                <span className="text-[13px] text-muted">{t("mcp.marketplace.noServers")}</span>
                <span className="mt-1 text-[11px] text-border-strong">
                  {t("mcp.marketplace.noServersHint")}
                </span>
              </div>
            )}

            {!marketplaceSearching &&
              marketplaceServers.length > 0 &&
              filteredServers.length === 0 && (
                <div className="flex flex-col items-center justify-center py-14 text-center">
                  <Tag size={28} className="mb-3 text-border-strong" />
                  <span className="text-[13px] text-muted">
                    {t("mcp.marketplace.noCategoryServers")}
                  </span>
                  <span className="mt-1 text-[11px] text-border-strong">
                    {t("mcp.marketplace.noCategoryServersHint")}
                  </span>
                </div>
              )}

            {filteredServers.map((item) => {
              const key = itemKey(item);
              const options = installOptions(item);
              const installedEntry = installedServerEntry(item, servers, options);
              return (
                <MarketplaceCard
                  key={key}
                  item={item}
                  selected={selection?.kind === "marketplace" && selection.key === key}
                  installedEntry={installedEntry}
                  installing={installingKey === key}
                  installState={installStateByKey[key]}
                  onSelect={() =>
                    setSelection(
                      installedEntry
                        ? { kind: "installed", name: installedEntry[0] }
                        : { kind: "marketplace", key },
                    )
                  }
                  onInstall={() => installMarketplaceItem(item)}
                />
              );
            })}

            {marketplaceServers.length > 0 && (
              <div className="flex items-center justify-between gap-3 py-3">
                <div className="flex items-center gap-1.5 text-[11px] text-border-strong">
                  <Info size={14} />
                  {t("mcp.marketplace.registrySource")}
                </div>
                <div className="flex min-h-8 items-center justify-end">
                  {marketplaceSearching && marketplaceServers.length > 0 ? (
                    <span className="flex items-center gap-1.5 rounded-[10px] bg-[var(--mcp-elevated)] px-3 py-1.5 text-[11px] font-bold text-[var(--mcp-text-muted)]">
                      <Loader2 size={12} className="animate-spin" />
                      {t("mcp.marketplace.loadingMore")}
                    </span>
                  ) : marketplaceNextCursor ? (
                    <span className="text-[11px] font-medium text-[var(--mcp-text-faint)]">
                      {t("mcp.marketplace.scrollForMore")}
                    </span>
                  ) : (
                    <span className="text-[11px] font-medium text-[var(--mcp-text-faint)]">
                      {t("mcp.marketplace.noMore")}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <DetailDrawer open={detailOpen} onClose={() => setSelection(null)}>
        {detailContent}
      </DetailDrawer>
    </div>
  );
}
