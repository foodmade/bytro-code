import { Terminal } from "lucide-react";
import { formatRelativeTime } from "./message-config";
import type { CommandInvocationMeta } from "@/stores/chat-store";

// ---------------------------------------------------------------------------
// CommandInvocationCard — compact card for slash-command invocations
//
// Replaces the standard user bubble when a message was classified as an SDK
// slash command (e.g. /compact, /init, /xlsx). Mirrors the terminal Claude
// Code experience where slash commands don't appear as user-typed text but
// rather as a brief command-execution indicator.
// ---------------------------------------------------------------------------

interface CommandInvocationCardProps {
  readonly invocation: CommandInvocationMeta;
  readonly timestamp?: number;
}

export function CommandInvocationCard({
  invocation,
  timestamp,
}: CommandInvocationCardProps) {
  const accent = "var(--color-accent-purple)";

  return (
    <div
      className="flex min-w-0"
      style={{ maxWidth: "min(760px, 90%)", marginLeft: "auto" }}
    >
      <div
        className="flex flex-col min-w-0 overflow-hidden w-full"
        style={{
          backgroundColor:
            "color-mix(in srgb, var(--color-accent-purple) 10%, transparent)",
          borderRadius: 6,
          borderLeft: `3px solid ${accent}`,
          padding: "10px 14px",
          gap: 6,
        }}
      >
        {/* Header row: terminal icon + command name (typed form) + arg hint + timestamp */}
        <div className="flex items-center gap-2 min-w-0">
          <Terminal
            size={12}
            style={{ color: accent }}
            className="shrink-0"
          />
          <span
            className="font-mono font-semibold shrink-0"
            style={{ fontSize: 12, color: accent }}
          >
            /{invocation.typedName}
          </span>
          {invocation.canonicalName !== invocation.typedName && (
            <span
              className="font-mono shrink-0"
              style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
              title={`alias of /${invocation.canonicalName}`}
            >
              → /{invocation.canonicalName}
            </span>
          )}
          {invocation.argumentHint && !invocation.args && (
            <span
              className="font-mono shrink-0"
              style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
            >
              {invocation.argumentHint}
            </span>
          )}
          <div className="flex-1" />
          {timestamp && (
            <span
              className="font-mono shrink-0"
              style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
            >
              {formatRelativeTime(timestamp)}
            </span>
          )}
        </div>

        {/* Description (from SDK supportedCommands) */}
        {invocation.description && (
          <p
            className="font-sans whitespace-pre-wrap break-words"
            style={{
              fontSize: 12,
              lineHeight: 1.4,
              color: "var(--color-muted-foreground)",
              margin: 0,
            }}
          >
            {invocation.description}
          </p>
        )}

        {/* User-supplied args, if any */}
        {invocation.args && (
          <p
            className="font-mono whitespace-pre-wrap break-words"
            style={{
              fontSize: 12,
              lineHeight: 1.45,
              color: "var(--color-foreground)",
              margin: 0,
            }}
          >
            {invocation.args}
          </p>
        )}
      </div>
    </div>
  );
}
