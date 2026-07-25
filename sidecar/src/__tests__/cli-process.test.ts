import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareCliProcessInvocation } from "../cli-process.js";

describe("community CLI process launch", () => {
  it("escapes Windows npm shim arguments for two cmd parsing passes", () => {
    const executable = 'C:\\Program Files\\Bytro & Tools\\claude.cmd';
    const hostileArgs = [
      "argument with spaces",
      'quote"inside',
      "& calc.exe",
      "| whoami",
      "<input",
      ">output",
      "%PATH%",
      "!PROMPT!",
      "^caret",
    ];

    const invocation = prepareCliProcessInvocation(
      executable,
      hostileArgs,
      { PATH: "C:\\Windows\\System32" },
      "win32",
    );

    expect(invocation.executable).toBe("cmd.exe");
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.detached).toBe(false);
    expect(invocation.windowsVerbatimArguments).toBe(true);
    expect(invocation.args[3]).toContain("^&");
    expect(invocation.args[3]).toContain("^^^%");
    expect(invocation.args[3]).toContain("^^^!");
    expect(invocation.args[3]).not.toContain("& calc.exe");
    expect(invocation.args[3]).not.toContain("| whoami");
  });

  it("spawns native executables directly as process-group leaders on POSIX", () => {
    const env = { PATH: "/usr/bin" };
    const invocation = prepareCliProcessInvocation(
      "/usr/local/bin/codex",
      ["app-server"],
      env,
      "darwin",
    );

    expect(invocation).toEqual({
      executable: "/usr/local/bin/codex",
      args: ["app-server"],
      env,
      detached: true,
      windowsVerbatimArguments: false,
    });
  });

  it.skipIf(process.platform !== "win32")(
    "round-trips JSON and cmd metacharacters through a real .cmd shim",
    async () => {
      const directory = mkdtempSync(
        join(tmpdir(), "bytro-community-cmd-roundtrip-"),
      );
      const captureScript = join(directory, "capture.mjs");
      const captureFile = join(directory, "argv.json");
      const shim = join(directory, "fake claude.cmd");
      const expected = [
        captureFile,
        JSON.stringify({ agents: { reviewer: 'say "hello"' } }),
        "space value",
        'quote"inside',
        "&|<>",
        "%PATH%",
        "!PROMPT!",
        "^caret",
      ];

      writeFileSync(
        captureScript,
        "import { writeFileSync } from 'node:fs';\n" +
          "writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(2)));\n",
      );
      writeFileSync(
        shim,
        `@echo off\r\n"${process.execPath}" "${captureScript}" %*\r\n`,
      );

      try {
        const invocation = prepareCliProcessInvocation(
          shim,
          expected,
          process.env,
          "win32",
        );
        const child = spawn(
          invocation.executable,
          [...invocation.args],
          {
            env: invocation.env,
            windowsHide: true,
            windowsVerbatimArguments:
              invocation.windowsVerbatimArguments,
          },
        );
        const [code] = await once(child, "exit");
        expect(code).toBe(0);
        expect(JSON.parse(readFileSync(captureFile, "utf8"))).toEqual(
          expected,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
