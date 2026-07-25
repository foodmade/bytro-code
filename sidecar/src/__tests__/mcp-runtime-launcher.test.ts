import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MCP_RUNTIME_LAUNCHER_SOURCE,
  projectMcpServersForRuntime,
} from "../openai-handler.js";

const temporaryDirectories: string[] = [];

function makeRuntime(): {
  readonly root: string;
  readonly launcher: string;
} {
  const root = mkdtempSync(join(tmpdir(), "bytro-mcp-launcher-test-"));
  temporaryDirectories.push(root);
  const launcher = join(root, "mcp-runtime-launcher.mjs");
  writeFileSync(launcher, MCP_RUNTIME_LAUNCHER_SOURCE, { mode: 0o600 });
  return { root, launcher };
}

function descriptorKey(env: Readonly<Record<string, string>>): string {
  const key = Object.keys(env).find((name) =>
    name.startsWith("BYTRO_MCP_SECRET_")
    && env[name].includes('"command"'),
  );
  if (!key) throw new Error("runtime descriptor was not projected");
  return key;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codex MCP runtime launcher", () => {
  it("passes only core and explicitly configured environment variables", () => {
    const { root, launcher } = makeRuntime();
    const child = join(root, "print-env.mjs");
    writeFileSync(
      child,
      'process.stdout.write(JSON.stringify(process.env));\n',
      { mode: 0o600 },
    );

    const runtimeEnv: Record<string, string> = {};
    projectMcpServersForRuntime(
      {
        private: {
          command: process.execPath,
          args: [child],
          env: { DECLARED_SECRET: "declared-sentinel" },
          env_vars: ["EXPLICIT_PASS"],
        },
      },
      runtimeEnv,
      launcher,
    );
    const key = descriptorKey(runtimeEnv);
    const result = spawnSync(process.execPath, [launcher, key], {
      encoding: "utf8",
      env: {
        ...runtimeEnv,
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? root,
        EXPLICIT_PASS: "explicit-sentinel",
        OPENAI_API_KEY: "model-key-sentinel",
        UNDECLARED_TOKEN: "ambient-token-sentinel",
        HTTPS_PROXY: "https://user:password@example.test",
      },
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    expect(childEnv.DECLARED_SECRET).toBe("declared-sentinel");
    expect(childEnv.EXPLICIT_PASS).toBe("explicit-sentinel");
    expect(childEnv.PATH).toBeDefined();
    expect(childEnv.OPENAI_API_KEY).toBeUndefined();
    expect(childEnv.UNDECLARED_TOKEN).toBeUndefined();
    expect(childEnv.HTTPS_PROXY).toBeUndefined();
    expect(
      Object.keys(childEnv).some((name) =>
        name.startsWith("BYTRO_MCP_SECRET_"),
      ),
    ).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "terminates a stdio MCP process group including grandchildren",
    async () => {
      const { root, launcher } = makeRuntime();
      const pidFile = join(root, "grandchild.pid");
      const grandchild = join(root, "grandchild.mjs");
      const child = join(root, "spawn-grandchild.mjs");
      writeFileSync(grandchild, "setInterval(() => {}, 1000);\n");
      writeFileSync(
        child,
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          "const nested = spawn(process.execPath, [process.argv[2]], { stdio: \"ignore\" });",
          "writeFileSync(process.argv[3], String(nested.pid));",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );

      const runtimeEnv: Record<string, string> = {};
      projectMcpServersForRuntime(
        {
          tree: {
            command: process.execPath,
            args: [child, grandchild, pidFile],
          },
        },
        runtimeEnv,
        launcher,
      );
      const key = descriptorKey(runtimeEnv);
      const runtime = spawn(process.execPath, [launcher, key], {
        env: {
          ...runtimeEnv,
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? root,
        },
        stdio: "ignore",
      });

      const deadline = Date.now() + 5_000;
      while (!existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(existsSync(pidFile)).toBe(true);
      const grandchildPid = Number(readFileSync(pidFile, "utf8"));

      runtime.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        runtime.once("exit", () => resolve());
        setTimeout(resolve, 7_000);
      });

      let alive = true;
      const cleanupDeadline = Date.now() + 2_000;
      while (alive && Date.now() < cleanupDeadline) {
        try {
          process.kill(grandchildPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch {
          alive = false;
        }
      }
      if (alive) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      expect(alive).toBe(false);
    },
    15_000,
  );

  it.skipIf(process.platform !== "win32")(
    "resolves an extensionless npm-style shim and preserves hostile argv",
    () => {
      const { root, launcher } = makeRuntime();
      const capture = join(root, "capture.mjs");
      const shim = join(root, "npx.cmd");
      writeFileSync(
        capture,
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
      );
      writeFileSync(
        shim,
        '@echo off\r\nnode "%~dp0capture.mjs" %*\r\n',
      );
      const hostile = [
        "space value",
        "amp&pipe|caret^percent%bang!",
        'quote"value',
        "trailing\\",
      ];
      const runtimeEnv: Record<string, string> = {};
      projectMcpServersForRuntime(
        { shim: { command: "npx", args: hostile } },
        runtimeEnv,
        launcher,
      );
      const key = descriptorKey(runtimeEnv);
      const result = spawnSync(process.execPath, [launcher, key], {
        encoding: "utf8",
        env: {
          ...runtimeEnv,
          PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
          PATHEXT: ".EXE;.CMD;.BAT",
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
          TEMP: process.env.TEMP ?? root,
        },
        timeout: 10_000,
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(hostile);
    },
    15_000,
  );
});
