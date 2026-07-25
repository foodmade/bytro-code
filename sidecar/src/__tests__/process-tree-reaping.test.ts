import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { query } from "../claude-cli-adapter.js";
import { CodexRpcChannel } from "../codex-rpc.js";

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, `#!/usr/bin/env node\n${source}`);
  chmodSync(path, 0o700);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for process-tree cleanup");
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function makeCrashTree(root: string): {
  readonly leader: string;
  readonly descendant: string;
  readonly pidFile: string;
} {
  const descendant = join(root, "descendant.mjs");
  const leader = join(root, "leader.mjs");
  const pidFile = join(root, "descendant.pid");
  writeFileSync(descendant, "setInterval(() => {}, 1000);\n");
  writeFileSync(
    leader,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const child = spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "setTimeout(() => process.exit(23), 50);",
      "",
    ].join("\n"),
  );
  return { leader, descendant, pidFile };
}

describe(
  "detached CLI process-tree reaping",
  () => {
    it("reaps Codex descendants when the app-server leader crashes", async () => {
      const root = mkdtempSync(join(tmpdir(), "bytro-codex-crash-tree-"));
      const tree = makeCrashTree(root);
      let descendantPid = 0;
      try {
        const rpc = new CodexRpcChannel(
          process.execPath,
          [tree.leader],
          { ...process.env } as Record<string, string>,
        );
        expect(await rpc.waitForExit()).toBe(23);
        await waitUntil(() => existsSync(tree.pidFile));
        descendantPid = Number(readFileSync(tree.pidFile, "utf8"));
        await waitUntil(() => !isAlive(descendantPid));
        await rpc.close();
      } finally {
        if (descendantPid && isAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("reaps Claude descendants when the CLI leader crashes", async () => {
      const root = mkdtempSync(join(tmpdir(), "bytro-claude-crash-tree-"));
      const script = join(root, "fake-claude.mjs");
      const executable =
        process.platform === "win32"
          ? join(root, "fake-claude.cmd")
          : script;
      const tree = makeCrashTree(root);
      writeExecutable(
        script,
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          `const child = spawn(process.execPath, [${JSON.stringify(tree.descendant)}], { stdio: "ignore" });`,
          `writeFileSync(${JSON.stringify(tree.pidFile)}, String(child.pid));`,
          "setTimeout(() => process.exit(19), 50);",
        ].join("\n"),
      );
      if (process.platform === "win32") {
        writeFileSync(
          executable,
          `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
        );
      }
      let descendantPid = 0;
      try {
        const result = query({
          prompt: "crash",
          options: {
            pathToClaudeCodeExecutable: executable,
            permissionMode: "dontAsk",
          },
        });
        await expect(
          (async () => {
            for await (const _message of result) {
              // The fake CLI exits before producing messages.
            }
          })(),
        ).rejects.toThrow("Claude CLI exited with code 19");
        await waitUntil(() => existsSync(tree.pidFile));
        descendantPid = Number(readFileSync(tree.pidFile, "utf8"));
        await waitUntil(() => !isAlive(descendantPid));
      } finally {
        if (descendantPid && isAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        rmSync(root, { recursive: true, force: true });
      }
    });
  },
);
