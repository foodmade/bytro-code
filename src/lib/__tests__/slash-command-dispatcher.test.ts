import { describe, expect, it } from "vitest";
import { dispatchSlashCommand } from "@/lib/slash-command-dispatcher";
import type { SlashCommandInfo } from "@/stores/chat-types";

const SDK_COMMANDS: ReadonlyArray<SlashCommandInfo> = [
  { name: "compact", description: "Compact context", source: "builtin" },
  { name: "usage", description: "Show usage", aliases: ["cost"], source: "builtin" },
  // Simulates Codex's prompt-expanded /status — must win over the client layer.
  { name: "status", description: "Ask Codex to report status", source: "builtin" },
];

describe("dispatchSlashCommand", () => {
  it("routes non-slash input as passthrough", () => {
    expect(dispatchSlashCommand("hello", SDK_COMMANDS).kind).toBe("passthrough");
  });

  it("matches SDK commands and aliases", () => {
    const byName = dispatchSlashCommand("/compact keep decisions", SDK_COMMANDS);
    expect(byName).toMatchObject({ kind: "sdk", canonicalName: "compact", args: "keep decisions" });

    const byAlias = dispatchSlashCommand("/cost", SDK_COMMANDS);
    expect(byAlias).toMatchObject({ kind: "sdk", canonicalName: "usage", typedName: "cost" });
  });

  it("prefers the SDK match over the client layer for the same name", () => {
    expect(dispatchSlashCommand("/status", SDK_COMMANDS)).toMatchObject({
      kind: "sdk",
      canonicalName: "status",
    });
  });

  it("falls back to client handlers when the SDK doesn't know the command", () => {
    expect(dispatchSlashCommand("/status", [])).toMatchObject({
      kind: "client",
      handler: "status",
      args: "",
    });
    expect(dispatchSlashCommand("/help", SDK_COMMANDS)).toMatchObject({
      kind: "client",
      handler: "help",
    });
  });

  it("reports unknown slash commands", () => {
    expect(dispatchSlashCommand("/nonexistent", SDK_COMMANDS)).toMatchObject({
      kind: "unknown",
      commandName: "nonexistent",
    });
  });
});
