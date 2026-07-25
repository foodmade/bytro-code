/**
 * Client-side slash commands — GUI-local implementations of CLI commands
 * that the Claude Code CLI refuses to run in headless/SDK mode.
 *
 * The CLI classifies its built-in commands: prompt-type commands (and
 * skills) run fine when forwarded verbatim, but interactive commands
 * (`/status`, `/help`, `/model`, …) reply with "isn't available in this
 * environment". For those, the host renders an equivalent answer locally
 * from data it already has, instead of forwarding to the CLI.
 *
 * Routing: the dispatcher matches SDK commands FIRST (sourced from
 * `Query.supportedCommands()` — the authoritative list of what the CLI can
 * execute headlessly), and only falls back to this client layer when the SDK
 * doesn't know the command. So if a future CLI adds headless support for
 * `/status`, the SDK path automatically wins. Codex keeps its prompt-expanded
 * `/status` for the same reason — its builtin entry matches before this layer.
 */

import { i18n } from "@/i18n";
import { useSettingsStore } from "@/stores/settings-store";
import { useAgentStatusStore, useConversationStore, useWorkspaceStore } from "@/stores";
import type { SlashCommandInfo } from "@/stores/chat-types";

export type ClientSlashCommandName = "status" | "help";

/** Metadata for the command dropdown. Descriptions resolve through i18n at
 *  call time so the palette follows the UI language. */
export function getClientSlashCommands(): ReadonlyArray<SlashCommandInfo> {
  return [
    { name: "status", description: i18n.t("clientCommands.status.name"), source: "builtin" },
    { name: "help", description: i18n.t("clientCommands.help.name"), source: "builtin" },
  ];
}

export interface ClientCommandContext {
  readonly platformId: string;
  readonly modelId: string;
  readonly modelLabel: string;
  readonly conversationId: string | null;
  readonly cwd: string;
  readonly permissionMode: string;
  /** Merged command list of the active platform — rendered by /help. */
  readonly commands: ReadonlyArray<SlashCommandInfo>;
}

function formatToggle(enabled: boolean): string {
  return enabled ? i18n.t("clientCommands.status.on") : i18n.t("clientCommands.status.off");
}

async function buildStatusMarkdown(ctx: ClientCommandContext): Promise<string> {
  const t = i18n.t.bind(i18n);
  const settings = useSettingsStore.getState();
  const agentStatus = useAgentStatusStore.getState();

  let sessionId: string | null = null;
  if (ctx.conversationId) {
    try {
      sessionId = await useConversationStore.getState().getSessionId(ctx.conversationId);
    } catch {
      sessionId = null;
    }
  }

  const isClaude = ctx.platformId === "claude";
  const claudeOpts = settings.platformModelOptions.claude;
  const ultracodeOn = isClaude && claudeOpts.ultracodeEnabled;
  const fastOn = isClaude && claudeOpts.fastEnabled;

  const effortValue = ultracodeOn
    ? t("clientCommands.status.ultracodeActive")
    : settings.reasoningLevel === "off"
      ? t("clientCommands.status.effortOff")
      : settings.reasoningLevel;

  const lines: string[] = [
    `### ${t("clientCommands.status.title")}`,
    "",
    `- **${t("clientCommands.status.model")}:** ${ctx.modelLabel} (\`${ctx.modelId}\`)`,
    `- **${t("clientCommands.status.provider")}:** ${ctx.platformId}`,
    `- **${t("clientCommands.status.session")}:** ${sessionId ? `\`${sessionId}\`` : t("clientCommands.status.sessionNone")}`,
    `- **${t("clientCommands.status.directory")}:** ${ctx.cwd || useWorkspaceStore.getState().activeWorkspace?.path || "-"}`,
    `- **${t("clientCommands.status.permissionMode")}:** ${ctx.permissionMode}`,
    `- **${t("clientCommands.status.effort")}:** ${effortValue}`,
    `- **${t("clientCommands.status.thinking")}:** ${formatToggle(settings.thinkingEnabled)}`,
  ];

  if (isClaude) {
    const cliState = agentStatus.claudeFastModeState;
    const fastStateLabel = cliState
      ? t("clientCommands.status.fastCliState", { state: cliState })
      : t("clientCommands.status.fastUnknown");
    // The Workflow tool only appears in system_init when the CLI accepted
    // ultracode (xhigh + dynamic workflows) — its presence is the ground
    // truth for whether the setting actually took effect.
    const sessionTools = agentStatus.claudeSessionTools;
    const ultracodeState = !ultracodeOn
      ? formatToggle(false)
      : sessionTools == null
        ? `${formatToggle(true)} (${t("clientCommands.status.fastUnknown")})`
        : sessionTools.includes("Workflow")
          ? `${formatToggle(true)} (${t("clientCommands.status.ultracodeVerified")})`
          : `${formatToggle(true)} (${t("clientCommands.status.ultracodeNotLoaded")})`;
    lines.push(
      `- **${t("clientCommands.status.fastMode")}:** ${formatToggle(fastOn)} (${fastStateLabel})`,
      `- **${t("clientCommands.status.ultracode")}:** ${ultracodeState}`,
    );
  }

  const usage = agentStatus.lastUsage;
  if (usage) {
    lines.push(
      `- **${t("clientCommands.status.usage")}:** ${t("clientCommands.status.usageValue", {
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
        cacheRead: usage.cacheReadTokens ?? 0,
        cacheWrite: usage.cacheCreationTokens ?? 0,
      })}`,
    );
  }

  return lines.join("\n");
}

function buildHelpMarkdown(ctx: ClientCommandContext): string {
  const t = i18n.t.bind(i18n);
  const clientNames = new Set(getClientSlashCommands().map((c) => c.name));
  const sorted = [...ctx.commands].sort((a, b) => a.name.localeCompare(b.name));

  const lines: string[] = [`### ${t("clientCommands.help.title")}`, ""];
  for (const cmd of sorted) {
    const aliases = cmd.aliases && cmd.aliases.length > 0
      ? ` (${cmd.aliases.map((a) => `/${a}`).join(", ")})`
      : "";
    const local = clientNames.has(cmd.name) ? ` — ${t("clientCommands.help.clientNote")}` : "";
    lines.push(`- \`/${cmd.name}\`${aliases} — ${cmd.description || ""}${local}`);
  }
  return lines.join("\n");
}

/** Execute a client-side command and return the markdown body to display. */
export async function executeClientSlashCommand(
  name: ClientSlashCommandName,
  ctx: ClientCommandContext,
): Promise<string> {
  switch (name) {
    case "status":
      return buildStatusMarkdown(ctx);
    case "help":
      return buildHelpMarkdown(ctx);
  }
}
