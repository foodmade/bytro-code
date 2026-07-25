import { describe, expect, it } from "vitest";
import {
  getWarmSession,
  hashCredentials,
  killWarmSession,
  metadataMatches,
  registerWarmSession,
  removeWarmSession,
  type WarmSessionEntry,
} from "../persistent-session-registry.js";
import type { QueryCommand } from "../protocol.js";

function makeEntry(overrides: Partial<WarmSessionEntry> = {}): WarmSessionEntry {
  return {
    conversationId: "conv-1",
    requestId: "req-1",
    channel: { push: () => {}, close: () => {} },
    abortController: new AbortController(),
    model: "claude-opus-4-8",
    platform: "claude",
    cwd: "/workspace",
    credentialHash: hashCredentials("key", "https://api.anthropic.com", "apiKey", "", ""),
    permissionMode: "default",
    mcpServerKeys: "",
    thinkingEnabled: true,
    reasoningLevel: "medium",
    ultracode: false,
    fastMode: false,
    cavemanMode: "off",
    agent: "claude",
    lastActivityMs: Date.now(),
    ...overrides,
  };
}

function makeCommand(overrides: Partial<QueryCommand> = {}): QueryCommand {
  return {
    cmd: "query",
    id: "req-2",
    agent: "claude",
    prompt: "你好",
    model: "claude-opus-4-8",
    systemPrompt: "",
    permissionMode: "default",
    cwd: "/workspace",
    sessionId: null,
    apiKey: "key",
    baseUrl: "https://api.anthropic.com",
    authMode: "apiKey",
    platform: "claude",
    thinkingEnabled: true,
    reasoningLevel: "medium",
    cavemanMode: "off",
    ...overrides,
  };
}

describe("metadataMatches Claude warm-session options", () => {
  it("keeps matching Claude sessions warm when startup options are unchanged", () => {
    expect(metadataMatches(makeEntry(), makeCommand())).toBe(true);
  });

  it("invalidates Claude sessions when effort or fast mode changes", () => {
    expect(metadataMatches(makeEntry(), makeCommand({ reasoningLevel: "high" }))).toBe(false);
    expect(metadataMatches(makeEntry(), makeCommand({ fastMode: true }))).toBe(false);
  });
});

describe("warm-session lifecycle", () => {
  it("preserves register, remove, close, and abort behavior without diagnostic identifiers", () => {
    const removable = makeEntry({ conversationId: "conv-remove" });
    registerWarmSession(removable);
    expect(getWarmSession("conv-remove")).toBe(removable);
    removeWarmSession("conv-remove");
    expect(getWarmSession("conv-remove")).toBeUndefined();

    let closed = false;
    const abortController = new AbortController();
    const killable = makeEntry({
      conversationId: "conv-kill",
      channel: { push: () => {}, close: () => { closed = true; } },
      abortController,
    });
    registerWarmSession(killable);
    killWarmSession("conv-kill");

    expect(closed).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(getWarmSession("conv-kill")).toBeUndefined();
  });
});
