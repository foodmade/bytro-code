import type { McpServerConfig } from "@/stores";

export type ServerType = "stdio" | "sse" | "http";

/* ─── Preset Template System ─── */

export interface McpPresetField {
  readonly key: string;
  readonly labelKey: string;
  readonly placeholder: string;
  readonly secret?: boolean;
  readonly required?: boolean;
  readonly defaultValue?: string;
  readonly helpKey?: string;
  readonly helpUrl?: string;
}

export interface McpPresetTemplate {
  readonly id: string;
  readonly name: string;
  readonly author: string;
  readonly descriptionKey: string;
  readonly icon: string;
  readonly iconColor: string;
  readonly iconBg: string;
  readonly iconBgLight: string;
  readonly downloads: string;
  readonly rating: string;
  readonly category: string;
  readonly npmPackage?: string;
  readonly docsUrl?: string;
  readonly userFields: ReadonlyArray<McpPresetField>;
  readonly buildConfig: ((values: Record<string, string>) => {
    readonly serverName: string;
    readonly config: McpServerConfig;
  }) | null;
}

export interface DraftServer {
  name: string;
  type: ServerType;
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
}

export const EMPTY_DRAFT: DraftServer = {
  name: "",
  type: "stdio",
  command: "",
  args: "",
  env: "",
  url: "",
  headers: "",
};

export function configFromDraft(draft: DraftServer): McpServerConfig {
  if (draft.type === "stdio") {
    const args = draft.args.trim() ? draft.args.trim().split(/\s+/) : undefined;
    const envLines = draft.env.trim().split("\n").filter(Boolean);
    const env = envLines.length > 0
      ? Object.fromEntries(envLines.map((line) => {
          const idx = line.indexOf("=");
          return idx > 0 ? [line.slice(0, idx), line.slice(idx + 1)] : [line, ""];
        }))
      : undefined;
    return { type: "stdio", command: draft.command.trim(), args, env };
  }
  const headerLines = draft.headers.trim().split("\n").filter(Boolean);
  const headers = headerLines.length > 0
    ? Object.fromEntries(headerLines.map((line) => {
        const idx = line.indexOf(":");
        return idx > 0 ? [line.slice(0, idx).trim(), line.slice(idx + 1).trim()] : [line.trim(), ""];
      }))
    : undefined;
  return { type: draft.type, url: draft.url.trim(), headers };
}

export function getConfigSummary(config: McpServerConfig): string {
  if ("command" in config) {
    const args = config.args ? " " + config.args.join(" ") : "";
    return `${config.command}${args}`;
  }
  if ("url" in config) return config.url;
  return "";
}
