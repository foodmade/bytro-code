import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaudeSpawnEnv } from "../claude-cli-adapter.js";
import {
  findNodeExe,
  resolveWindowsMcpServer,
} from "../claude-handler.js";
import {
  buildGeminiSpawnEnv,
  resolveGeminiCliFromEnvironment,
} from "../gemini-handler.js";

describe("CLI environment isolation", () => {
  it("gives Claude only OS state and its current provider values", () => {
    const env = buildClaudeSpawnEnv({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      ANTHROPIC_API_KEY: "claude-current-provider",
      OPENAI_API_KEY: "other-provider-secret",
      GEMINI_API_KEY: "other-provider-secret",
      CLOUDFLARE_API_TOKEN: "deploy-secret",
      CODEX_HOME: "/private/codex",
      BYTRO_MCP_SECRET_0: "mcp-secret",
    });

    expect(env.PATH).toBe("/safe/bin");
    expect(env.HOME).toBe("/safe/home");
    expect(env.ANTHROPIC_API_KEY).toBe("claude-current-provider");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.BYTRO_MCP_SECRET_0).toBeUndefined();
  });

  it("does not give Gemini ambient provider, deploy, proxy, or MCP secrets", () => {
    const env = buildGeminiSpawnEnv(
      {
        GEMINI_API_KEY: "gemini-current-provider",
        GEMINI_CLI_HOME: "/private/gemini",
      },
      {
        PATH: "/safe/bin",
        HOME: "/safe/home",
        OPENAI_API_KEY: "other-provider-secret",
        ANTHROPIC_API_KEY: "other-provider-secret",
        CLOUDFLARE_API_TOKEN: "deploy-secret",
        HTTPS_PROXY: "http://user:password@proxy.invalid",
        BYTRO_MCP_SECRET_0: "mcp-secret",
      },
    );

    expect(env.PATH).toBe("/safe/bin");
    expect(env.GEMINI_API_KEY).toBe("gemini-current-provider");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.BYTRO_MCP_SECRET_0).toBeUndefined();
  });
});

describe("Gemini CLI discovery boundary", () => {
  it("uses an explicit entry point or a launcher on the original PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "bytro-gemini-boundary-"));
    const explicitEntry = join(root, "explicit.mjs");
    const pathBin = join(root, "bin");
    const pathEntry = join(
      pathBin,
      "node_modules",
      "@google",
      "gemini-cli",
      "dist",
      "index.js",
    );
    mkdirSync(join(pathBin, "node_modules", "@google", "gemini-cli", "dist"), {
      recursive: true,
    });
    writeFileSync(explicitEntry, "");
    writeFileSync(join(pathBin, "gemini.cmd"), "");
    writeFileSync(pathEntry, "");

    try {
      expect(
        resolveGeminiCliFromEnvironment({
          GEMINI_CLI_PATH: explicitEntry,
          APPDATA: join(root, "ignored-appdata"),
        }),
      ).toBe(explicitEntry);
      expect(
        resolveGeminiCliFromEnvironment(
          {
            PATH: pathBin,
            ProgramFiles: join(root, "ignored-program-files"),
            VOLTA_HOME: join(root, "ignored-volta"),
          },
          "win32",
        ),
      ).toBe(pathEntry);
      expect(
        resolveGeminiCliFromEnvironment({
          APPDATA: join(root, "ignored-appdata"),
          ProgramFiles: join(root, "ignored-program-files"),
          VOLTA_HOME: join(root, "ignored-volta"),
        }),
      ).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Windows Claude MCP Node boundary", () => {
  it("uses only BYTRO_NODE_PATH or PATH and validates the npm CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "bytro-claude-mcp-node-"));
    const explicitRoot = join(root, "explicit");
    const pathRoot = join(root, "path");
    const guessedRoot = join(root, "guessed-program-files");
    const explicitNode = join(explicitRoot, "node.exe");
    const pathNode = join(pathRoot, "node.exe");
    const npxCli = join(
      explicitRoot,
      "node_modules",
      "npm",
      "bin",
      "npx-cli.js",
    );
    mkdirSync(join(explicitRoot, "node_modules", "npm", "bin"), {
      recursive: true,
    });
    mkdirSync(pathRoot, { recursive: true });
    mkdirSync(guessedRoot, { recursive: true });
    writeFileSync(explicitNode, "");
    writeFileSync(pathNode, "");
    writeFileSync(npxCli, "");
    writeFileSync(join(guessedRoot, "node.exe"), "");

    try {
      expect(
        findNodeExe({
          BYTRO_NODE_PATH: explicitNode,
          PATH: pathRoot,
          ProgramFiles: guessedRoot,
        }),
      ).toBe(explicitNode);
      expect(
        findNodeExe({
          PATH: pathRoot,
          ProgramFiles: guessedRoot,
        }),
      ).toBe(pathNode);
      expect(
        findNodeExe({
          ProgramFiles: guessedRoot,
          APPDATA: guessedRoot,
          VOLTA_HOME: guessedRoot,
        }),
      ).toBeUndefined();

      const resolved = resolveWindowsMcpServer(
        "private-name",
        {
          command: "npx",
          args: ["private-package"],
          env: { DECLARED: "1" },
        },
        { BYTRO_NODE_PATH: explicitNode },
      );
      expect(resolved.command).toBe(explicitNode);
      expect(resolved.args).toEqual([npxCli, "private-package"]);
      expect(resolved.env).toMatchObject({
        DECLARED: "1",
        npm_config_script_shell: "powershell",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
