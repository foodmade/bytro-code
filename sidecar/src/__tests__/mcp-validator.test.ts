// ---------------------------------------------------------------------------
// MCP validator tests
//
// Covers the regression that motivated the validator: a user with a malformed
// `supabase` entry in ~/.bytro-community/mcp-servers.json crashed Claude Code CLI at
// startup with code=1 ("Invalid MCP configuration"), taking down every Claude
// session. The pre-filter must drop bad entries and surface a reason so the
// good entries still reach the CLI.
//
// Run: cd sidecar && npx vitest run src/__tests__/mcp-validator.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  filterValidMcpServers,
  normalizeMcpRemoteUrl,
  validateMcpServerConfig,
} from "../mcp-validator.js";

describe("validateMcpServerConfig — stdio", () => {
  it("accepts minimal stdio config (no explicit type)", () => {
    const r = validateMcpServerConfig({ command: "npx", args: ["-y", "@supabase/mcp-server-supabase"] });
    expect(r.ok).toBe(true);
  });

  it("accepts explicit type=stdio with env", () => {
    const r = validateMcpServerConfig({
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { TOKEN: "abc" },
      alwaysLoad: true,
      timeout: 5000,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects missing command", () => {
    const r = validateMcpServerConfig({ args: ["foo"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/command/);
  });

  it("rejects empty command string", () => {
    const r = validateMcpServerConfig({ command: "   " });
    expect(r.ok).toBe(false);
  });

  it("rejects args that is not an array", () => {
    const r = validateMcpServerConfig({ command: "npx", args: "-y foo" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/args/);
  });

  it("rejects args array with non-string element", () => {
    const r = validateMcpServerConfig({ command: "npx", args: ["-y", 42] });
    expect(r.ok).toBe(false);
  });

  it("rejects env that is not a string-record", () => {
    const r = validateMcpServerConfig({ command: "npx", env: { NUM: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/env/);
  });

  it("rejects invalid alwaysLoad and timeout values before CLI startup", () => {
    const badAlwaysLoad = validateMcpServerConfig({ command: "node", alwaysLoad: "yes" });
    expect(badAlwaysLoad.ok).toBe(false);
    if (!badAlwaysLoad.ok) expect(badAlwaysLoad.reason).toMatch(/alwaysLoad/);

    const badTimeout = validateMcpServerConfig({ command: "node", timeout: "5000" });
    expect(badTimeout.ok).toBe(false);
    if (!badTimeout.ok) expect(badTimeout.reason).toMatch(/timeout/);
  });
});

describe("validateMcpServerConfig — sse / http", () => {
  it("accepts sse with url + headers", () => {
    const r = validateMcpServerConfig({
      type: "sse",
      url: "https://example.com/sse",
      headers: { Authorization: "Bearer x" },
    });
    expect(r.ok).toBe(true);
  });

  it("accepts http with url", () => {
    const r = validateMcpServerConfig({ type: "http", url: "https://example.com/mcp", alwaysLoad: true });
    expect(r.ok).toBe(true);
  });

  it("canonicalizes a credential-free HTTP(S) URL and preserves its path", () => {
    expect(normalizeMcpRemoteUrl("  https://example.com:443/a/b  "))
      .toBe("https://example.com/a/b");
  });

  it("rejects sse/http without url", () => {
    const r = validateMcpServerConfig({ type: "http" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/url/i);
  });

  it("rejects http with non-string-record headers", () => {
    const r = validateMcpServerConfig({
      type: "http",
      url: "https://example.com",
      headers: { Authorization: 123 },
    });
    expect(r.ok).toBe(false);
  });

  it.each([
    "https://user:secret@remote.example/mcp",
    "https://remote.example/mcp?token=QUERY_TOKEN_SENTINEL",
    "https://remote.example/mcp#FRAGMENT_SENTINEL",
    "https://remote.example/mcp?",
    "file:///tmp/REMOTE_URL_SENTINEL",
  ])("rejects unsafe remote URL without echoing it: %s", (url) => {
    const r = validateMcpServerConfig({ type: "http", url });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(
        /^Invalid remote MCP URL \(diagnosticId: [a-f0-9]{12}\)$/,
      );
      expect(r.reason).not.toContain(url);
      expect(r.reason).not.toContain("secret");
      expect(r.reason).not.toContain("QUERY_TOKEN_SENTINEL");
      expect(r.reason).not.toContain("FRAGMENT_SENTINEL");
    }
  });
});

describe("validateMcpServerConfig — unknown type", () => {
  it("rejects unknown type value", () => {
    const r = validateMcpServerConfig({ type: "websocket", url: "ws://x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/type/);
  });

  it("rejects non-object entry", () => {
    expect(validateMcpServerConfig(null).ok).toBe(false);
    expect(validateMcpServerConfig("npx").ok).toBe(false);
    expect(validateMcpServerConfig([]).ok).toBe(false);
  });
});

describe("filterValidMcpServers", () => {
  it("returns empty result for undefined / null / empty", () => {
    expect(filterValidMcpServers(undefined)).toEqual({ valid: {}, skipped: [] });
    expect(filterValidMcpServers(null)).toEqual({ valid: {}, skipped: [] });
    expect(filterValidMcpServers({})).toEqual({ valid: {}, skipped: [] });
  });

  it("keeps valid entries and reports invalid ones (the supabase regression)", () => {
    const { valid, skipped } = filterValidMcpServers({
      "filesystem": { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
      // The crash-trigger from the bug report: missing required `command`.
      "supabase": { transport: "stdio", env: { SUPABASE_ACCESS_TOKEN: "x" } },
      "remote-api": { type: "http", url: "https://api.example.com/mcp" },
      // Garbage shape from a copy-paste mishap.
      "broken-paste": "npx -y something",
    });

    expect(Object.keys(valid).sort()).toEqual(["filesystem", "remote-api"]);
    expect(skipped.map((s) => s.name).sort()).toEqual(["broken-paste", "supabase"]);

    const supabaseSkip = skipped.find((s) => s.name === "supabase");
    expect(supabaseSkip?.reason).toMatch(/command/);
  });

  it("preserves entry shape so Windows resolver and CLI see original config", () => {
    const original = {
      ok: { command: "node", args: ["server.js"], env: { K: "V" } },
    };
    const { valid } = filterValidMcpServers(original);
    expect(valid.ok).toEqual(original.ok);
  });
});
