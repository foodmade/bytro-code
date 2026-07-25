// ---------------------------------------------------------------------------
// Slash command dispatcher
//
// Classifies a chat input string into one of:
//   - "sdk"         : the input is a slash command the SDK knows about
//                     (came from Query.supportedCommands()). Includes built-in
//                     commands like /compact and skills like /xlsx.
//                     The text is forwarded verbatim to the SDK; UI should NOT
//                     render it as a normal user bubble.
//   - "client"      : the input matches a host-side command whitelist (commands
//                     the SDK doesn't know about, e.g. /help, /login, /model).
//                     Currently empty — the GUI host doesn't ship REPL-style
//                     client commands yet. Reserved as the extension point.
//   - "unknown"     : starts with "/" but neither the SDK nor the whitelist
//                     recognizes the head token. Suggest the user check the
//                     command palette.
//   - "passthrough" : not a slash command. Send as a normal user message.
//
// The classification relies entirely on the SlashCommandInfo[] sourced from
// the SDK's `Query.supportedCommands()` (plumbed through by claude-handler).
// Aliases are honored — "/cost" resolves to the canonical "/usage".
// ---------------------------------------------------------------------------

import type { SlashCommandInfo } from "@/stores/chat-types";

/** Names of host-side handlers that the dispatcher can route to.
 *  Add new handler names here when implementing client-side commands. */
export type ClientHandlerName = "status" | "help";

export type SlashDispatchResult =
  | { readonly kind: "passthrough" }
  | {
      readonly kind: "sdk";
      /** The token the user typed (could be an alias). */
      readonly typedName: string;
      /** Canonical command name (after alias resolution). */
      readonly canonicalName: string;
      /** Full metadata of the matched command. */
      readonly info: SlashCommandInfo;
      /** Trailing arguments (everything after the first whitespace), unmodified. */
      readonly args: string;
    }
  | {
      readonly kind: "client";
      readonly commandName: string;
      readonly handler: ClientHandlerName;
      /** Trailing arguments (everything after the first whitespace), unmodified. */
      readonly args: string;
    }
  | { readonly kind: "unknown"; readonly commandName: string };

/** Host-side command whitelist. Maps command names → handler identifiers.
 *  Keys are bare command names (without the leading "/").
 *
 *  These are commands the CLI refuses in headless/SDK mode ("isn't available
 *  in this environment") but the GUI can answer locally. SDK commands match
 *  FIRST, so a platform that CAN execute one of these (e.g. Codex's
 *  prompt-expanded /status) keeps its own path. */
const CLIENT_COMMAND_WHITELIST: ReadonlyMap<string, ClientHandlerName> =
  new Map<string, ClientHandlerName>([
    ["status", "status"],
    ["help", "help"],
  ]);

/** Parse a chat input and decide how to route it. Pure function — no I/O.
 *  @param input        Raw chat input text (may include leading/trailing whitespace).
 *  @param sdkCommands  Slash commands available for the current platform. Caller
 *                      MUST scope these to the active platformId — the store
 *                      buckets commands per-platform and this function only sees
 *                      the active bucket. Mixing platforms here would cause
 *                      Codex/Gemini to mistakenly identify Claude-only commands. */
export function dispatchSlashCommand(
  input: string,
  sdkCommands: ReadonlyArray<SlashCommandInfo>,
): SlashDispatchResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { kind: "passthrough" };

  // Split into head token + args. The head ends at the first whitespace
  // (space, tab, or newline). A bare "/" with no name is a passthrough.
  const firstWsIdx = trimmed.search(/\s/);
  const head = firstWsIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, firstWsIdx);
  const args = firstWsIdx === -1 ? "" : trimmed.slice(firstWsIdx + 1);
  if (!head) return { kind: "passthrough" };

  // SDK match (name first, then alias). Linear scan is fine — list is ~40 items.
  for (const info of sdkCommands) {
    if (info.name === head) {
      return { kind: "sdk", typedName: head, canonicalName: info.name, info, args };
    }
    if (info.aliases && info.aliases.includes(head)) {
      return { kind: "sdk", typedName: head, canonicalName: info.name, info, args };
    }
  }

  const clientHandler = CLIENT_COMMAND_WHITELIST.get(head);
  if (clientHandler !== undefined) {
    return { kind: "client", commandName: head, handler: clientHandler, args };
  }

  return { kind: "unknown", commandName: head };
}
