import type { SdkType } from "@/lib/platform-config";
import type { ChatMessage } from "@/stores/chat-store";

export interface ApiMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

const ASSISTANT_MESSAGE_ROLES = new Set(["claude", "codex", "chatcmpl", "gemini"]);

/**
 * Build the API message array from store messages + current user input.
 *
 * Applies a coarse character-budget trim on the frontend side so that the
 * IPC payload to the sidecar stays reasonable.
 */
const MAX_HISTORY_CHARS = 300_000;

export function buildApiMessages(
  messages: ReadonlyArray<ChatMessage>,
  userContent: string,
): ApiMessage[] {
  const history: ApiMessage[] = messages
    .filter(
      (message) =>
        (message.role === "user" || ASSISTANT_MESSAGE_ROLES.has(message.role))
        && message.content.length > 0,
    )
    .map((message) => ({
      role: message.role === "user" ? "user" : "assistant",
      content: message.content,
    }));

  // Trim history from the front (oldest first) to stay within budget
  let totalChars = 0;
  let cutIndex = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    totalChars += history[i].content.length;
    if (totalChars > MAX_HISTORY_CHARS) {
      cutIndex = i + 1;
      break;
    }
  }
  let trimmed = cutIndex > 0 ? history.slice(cutIndex) : history;

  // Ensure trimmed history starts with a user message (some APIs require this)
  if (trimmed.length > 0 && trimmed[0].role === "assistant") {
    trimmed = trimmed.slice(1);
  }

  return [...trimmed, { role: "user", content: userContent }];
}

/** Unified transport args — all platforms use the same fields. */
export interface ProviderTransportArgs {
  readonly baseUrl?: string;
  readonly apiKey?: string;
}

export function buildProviderTransportArgs(
  _sdk: SdkType,
  config: { readonly baseUrl: string; readonly apiKey: string },
): ProviderTransportArgs {
  const baseUrl = config.baseUrl.trim() || undefined;
  const apiKey = config.apiKey.trim() || undefined;
  return { baseUrl, apiKey };
}
