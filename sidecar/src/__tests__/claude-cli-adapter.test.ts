import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDimensionPromptInstructions,
  buildClaudeSpawnEnv,
  cleanupStaleClaudeRuntimeDirs,
  prepareClaudeLaunch,
  query,
  type Options,
  type SDKUserMessage,
} from "../claude-cli-adapter.js";

function optionValue(args: ReadonlyArray<string>, flag: string): string {
  const index = args.indexOf(flag);
  expect(index).toBeGreaterThanOrEqual(0);
  return args[index + 1] ?? "";
}

function writeFakeClaudeCli(
  directory: string,
  source: string,
): string {
  const executable = join(directory, "fake-claude.mjs");
  writeFileSync(
    executable,
    `#!/usr/bin/env node\n${source}`,
  );
  chmodSync(executable, 0o700);
  return executable;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for fake Claude CLI state");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("community Claude CLI launch boundary", () => {
  it("fails closed instead of placing custom-agent prompts in argv", () => {
    const sentinel = "SECRET_SENTINEL custom agent system prompt";

    expect(() =>
      prepareClaudeLaunch({
        agents: {
          reviewer: {
            description: "Review changes",
            prompt: sentinel,
          },
        },
      }),
    ).toThrow("cannot be passed securely");
  });

  it("keeps MCP, settings, and system prompt secrets out of argv", () => {
    const mcpSecret = "sentinel-mcp-secret";
    const settingsSecret = "sentinel-settings-secret";
    const promptSecret = "sentinel-system-prompt";
    const launch = prepareClaudeLaunch({
      systemPrompt: promptSecret,
      mcpServers: {
        private: {
          type: "http",
          url: "https://example.test/mcp",
          headers: { Authorization: `Bearer ${mcpSecret}` },
        },
      },
      extraArgs: {
        settings: JSON.stringify({ apiKey: settingsSecret }),
      },
    });

    try {
      const argv = launch.args.join("\u0000");
      expect(argv).not.toContain(mcpSecret);
      expect(argv).not.toContain(settingsSecret);
      expect(argv).not.toContain(promptSecret);

      const mcpPath = optionValue(launch.args, "--mcp-config");
      const settingsPath = optionValue(launch.args, "--settings");
      const promptPath = optionValue(launch.args, "--system-prompt-file");
      expect(readFileSync(mcpPath, "utf8")).toContain(mcpSecret);
      expect(readFileSync(settingsPath, "utf8")).toContain(settingsSecret);
      expect(readFileSync(promptPath, "utf8")).toContain(promptSecret);

      if (process.platform !== "win32") {
        expect(statSync(mcpPath).mode & 0o777).toBe(0o600);
        expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
        expect(statSync(promptPath).mode & 0o777).toBe(0o600);
      }

      launch.cleanup();
      expect(existsSync(mcpPath)).toBe(false);
      expect(existsSync(settingsPath)).toBe(false);
      expect(existsSync(promptPath)).toBe(false);
    } finally {
      launch.cleanup();
    }
  });

  it("forces updater and nonessential telemetry off", () => {
    const env = buildClaudeSpawnEnv({
      PATH: "/usr/bin",
      DISABLE_AUTOUPDATER: "0",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0",
      DISABLE_TELEMETRY: "0",
      DISABLE_ERROR_REPORTING: "0",
      DISABLE_BUG_COMMAND: "0",
    });

    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(env.DISABLE_TELEMETRY).toBe("1");
    expect(env.DISABLE_ERROR_REPORTING).toBe("1");
    expect(env.DISABLE_BUG_COMMAND).toBe("1");
  });

  it("safely degrades default permissions and gates dangerous flags", () => {
    const safe = prepareClaudeLaunch({ permissionMode: "default" });
    const explicitBypass: Options = {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    };
    const dangerous = prepareClaudeLaunch(explicitBypass);

    try {
      expect(optionValue(safe.args, "--permission-mode")).toBe("dontAsk");
      expect(safe.permissionModeDegraded).toBe(true);
      expect(safe.args).not.toContain("--dangerously-skip-permissions");

      expect(optionValue(dangerous.args, "--permission-mode")).toBe(
        "bypassPermissions",
      );
      expect(dangerous.permissionModeDegraded).toBe(false);
      expect(dangerous.args).toContain(
        "--allow-dangerously-skip-permissions",
      );
      expect(dangerous.args).toContain("--dangerously-skip-permissions");

      const resumed = prepareClaudeLaunch({
        permissionMode: "dontAsk",
        resume: "session-id",
        forkSession: true,
        resumeSessionAt: "assistant-uuid",
      });
      try {
        expect(optionValue(resumed.args, "--resume")).toBe("session-id");
        expect(resumed.args).toContain("--fork-session");
        expect(optionValue(resumed.args, "--resume-session-at")).toBe(
          "assistant-uuid",
        );
      } finally {
        resumed.cleanup();
      }
    } finally {
      safe.cleanup();
      dangerous.cleanup();
    }
  });

  it("documents that health-check prompts are inlined before CLI execution", () => {
    const sentinel = "FULL_DIMENSION_PROMPT_SENTINEL";
    const instructions = buildDimensionPromptInstructions({
      "安全性体检": `${sentinel}: inspect authentication and dependency boundaries`,
    });

    expect(instructions).toContain(sentinel);
    expect(instructions).toContain("copy that entry's complete prompt");
    expect(instructions).toContain("Stream observers cannot rewrite tool calls");
  });

  it("accepts only inline JSON or an existing settings file", () => {
    expect(() =>
      prepareClaudeLaunch({
        extraArgs: { settings: "not-json-and-not-a-file" },
      }),
    ).toThrow("valid JSON or an existing file path");

    const directory = mkdtempSync(join(tmpdir(), "bytro-settings-test-"));
    const settingsFile = join(directory, "settings.json");
    const sourceSecret = "sentinel-source-credential";
    const launchSecret = "sentinel-launch-credential";
    const originalBytes = JSON.stringify({
      env: { ANTHROPIC_API_KEY: sourceSecret },
      permissions: { allow: ["Read"] },
    });
    writeFileSync(settingsFile, originalBytes);
    const launch = prepareClaudeLaunch({
      extraArgs: { settings: settingsFile },
      env: { ANTHROPIC_API_KEY: launchSecret },
    });

    try {
      const privateSettingsPath = optionValue(launch.args, "--settings");
      const argv = launch.args.join("\u0000");
      expect(privateSettingsPath).not.toBe(settingsFile);
      expect(argv).not.toContain(sourceSecret);
      expect(argv).not.toContain(launchSecret);
      expect(readFileSync(settingsFile, "utf8")).toBe(originalBytes);
      const privateSettings = readFileSync(privateSettingsPath, "utf8");
      expect(privateSettings).not.toContain(sourceSecret);
      expect(privateSettings).not.toContain(launchSecret);
      expect(privateSettings).toContain('"Read"');
    } finally {
      launch.cleanup();
      expect(readFileSync(settingsFile, "utf8")).toBe(originalBytes);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes only stale runtime directories from dead adapter processes", () => {
    const stale = mkdtempSync(
      join(tmpdir(), "bytro-community-claude-2147483647-"),
    );
    const active = mkdtempSync(
      join(tmpdir(), `bytro-community-claude-${process.pid}-`),
    );
    const secretFile = join(stale, "mcp-secret.json");
    writeFileSync(secretFile, "SECRET_SENTINEL orphaned bearer token");
    const old = new Date(Date.now() - 10_000);
    utimesSync(stale, old, old);
    utimesSync(active, old, old);

    try {
      cleanupStaleClaudeRuntimeDirs();
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(secretFile)).toBe(false);
      expect(existsSync(active)).toBe(true);
    } finally {
      rmSync(stale, { recursive: true, force: true });
      rmSync(active, { recursive: true, force: true });
    }
  });

  it("streams fragmented NDJSON for every stdin turn and ignores malformed lines", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "bytro-community-fake-claude-"),
    );
    const executable = writeFakeClaudeCli(
      directory,
      `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const messages = input.trim().split(/\\r?\\n/).filter(Boolean).map(JSON.parse);
  process.stdout.write("malformed output\\n");
  const first = JSON.stringify({ type: "assistant", sequence: 1, received: messages[0]?.message?.content });
  const second = JSON.stringify({ type: "assistant", sequence: 2, received: messages[1]?.message?.content });
  process.stdout.write(first.slice(0, 9));
  setTimeout(() => {
    process.stdout.write(first.slice(9) + "\\n");
    process.stdout.write(second + "\\n");
    process.exit(0);
  }, 10);
});
`,
    );
    const diagnostics: string[] = [];
    async function* prompts(): AsyncIterable<SDKUserMessage> {
      for (const [index, content] of ["first turn", "second turn"].entries()) {
        yield {
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
          session_id: "session",
          uuid: `message-${index}`,
        };
      }
    }

    try {
      const messages: Array<Record<string, unknown>> = [];
      for await (const message of query({
        prompt: prompts(),
        options: {
          pathToClaudeCodeExecutable: executable,
          permissionMode: "dontAsk",
          stderr: (message) => diagnostics.push(message),
        },
      })) {
        messages.push(message);
      }

      expect(messages.map((message) => message.sequence)).toEqual([1, 2]);
      expect(messages.map((message) => message.received)).toEqual([
        "first turn",
        "second turn",
      ]);
      expect(diagnostics.join("\n")).toContain(
        "Ignoring non-JSON Claude output",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("sends complete health-check dimension prompts through stdin, never argv", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "bytro-community-fake-dimensions-"),
    );
    const sentinel =
      "FULL_DIMENSION_PROMPT_SENTINEL inspect auth, storage, and process boundaries";
    const executable = writeFakeClaudeCli(
      directory,
      `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const messages = input.trim().split(/\\r?\\n/).filter(Boolean).map(JSON.parse);
  process.stdout.write(JSON.stringify({
    type: "assistant",
    received: messages[0]?.message?.content,
    argv: process.argv,
  }) + "\\n");
});
`,
    );

    try {
      const messages: Array<Record<string, unknown>> = [];
      for await (const message of query({
        prompt: "开始项目体检",
        options: {
          pathToClaudeCodeExecutable: executable,
          permissionMode: "dontAsk",
          dimensionPrompts: {
            "安全性体检": sentinel,
          },
        },
      })) {
        messages.push(message);
      }

      const received = JSON.stringify(messages[0]?.received);
      const argv = JSON.stringify(messages[0]?.argv);
      expect(received).toContain(sentinel);
      expect(received).toContain("安全性体检");
      expect(received).toContain("开始项目体检");
      expect(argv).not.toContain(sentinel);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not pretend to bridge canUseTool into the local CLI", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "bytro-community-fake-permissions-"),
    );
    const executable = writeFakeClaudeCli(
      directory,
      `
process.stdin.resume();
process.stdout.write(JSON.stringify({
  type: "assistant",
  message: {
    content: [{
      type: "tool_use",
      id: "tool-1",
      name: "Write",
      input: { file_path: "example.txt", content: "x" },
    }],
  },
}) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", result: "done" }) + "\\n");
`,
    );
    let canUseToolCalled = false;
    const options = {
      pathToClaudeCodeExecutable: executable,
      permissionMode: "default" as const,
      canUseTool: async () => {
        canUseToolCalled = true;
        return {
          behavior: "allow" as const,
          updatedInput: {},
        };
      },
    } as Options & {
      canUseTool: () => Promise<{
        behavior: "allow";
        updatedInput: Record<string, unknown>;
      }>;
    };

    try {
      const messages: Array<Record<string, unknown>> = [];
      for await (const message of query({ prompt: "test", options })) {
        messages.push(message);
      }

      expect(canUseToolCalled).toBe(false);
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: "system",
          status: "permission_mode_degraded",
        }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("propagates asynchronous spawn errors without hanging", async () => {
    const result = query({
      prompt: "hello",
      options: {
        pathToClaudeCodeExecutable:
          "/definitely/missing/bytro-community-claude",
        permissionMode: "dontAsk",
      },
    });

    await expect(
      (async () => {
        for await (const _message of result) {
          // No messages are expected from a failed spawn.
        }
      })(),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it(
    "aborts the process group, escalates to force kill, and cleans runtime files",
    async () => {
      const directory = mkdtempSync(
        join(tmpdir(), "bytro-community-fake-abort-"),
      );
      const signalFile = join(directory, "signals.txt");
      const pidFile = join(directory, "pid.txt");
      const executable = writeFakeClaudeCli(
        directory,
        `
import { appendFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {
  appendFileSync(${JSON.stringify(signalFile)}, "SIGTERM\\n");
});
process.stdout.write(JSON.stringify({ type: "system", subtype: "ready" }) + "\\n");
setInterval(() => {}, 1000);
`,
      );
      const runtimePrefix = `bytro-community-claude-${process.pid}-`;
      const runtimeBefore = new Set(
        readdirSync(tmpdir()).filter((name) => name.startsWith(runtimePrefix)),
      );
      const abortController = new AbortController();

      try {
        const result = query({
          prompt: "wait",
          options: {
            pathToClaudeCodeExecutable: executable,
            permissionMode: "dontAsk",
            abortController,
          },
        });
        expect((await result.next()).value).toMatchObject({
          type: "system",
          subtype: "ready",
        });

        abortController.abort();
        expect((await result.next()).done).toBe(true);
        await waitUntil(() => existsSync(signalFile));
        const childPid = Number(readFileSync(pidFile, "utf8"));
        await waitUntil(() => {
          try {
            process.kill(childPid, 0);
            return false;
          } catch {
            return true;
          }
        });
        await waitUntil(() =>
          readdirSync(tmpdir())
            .filter((name) => name.startsWith(runtimePrefix))
            .every((name) => runtimeBefore.has(name)),
        );

        expect(readFileSync(signalFile, "utf8")).toContain("SIGTERM");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
