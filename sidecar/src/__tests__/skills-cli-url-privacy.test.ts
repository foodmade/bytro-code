import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";

let temporaryDirectory = "";
let cliBundle = "";

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "bytro-skills-cli-test-"));
  cliBundle = join(temporaryDirectory, "skills-cli.mjs");
  await build({
    entryPoints: [join(process.cwd(), "src", "skills-cli.ts")],
    outfile: cliBundle,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    logLevel: "silent",
  });
});

afterAll(() => {
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

describe("skills CLI repository URL privacy", () => {
  it("rejects a credential URL before logging or invoking Git", () => {
    const sentinel = "CLI_PASSWORD_SENTINEL";
    const rawUrl = `https://user:${sentinel}@github.com/example/skills`;
    const result = spawnSync(
      process.execPath,
      [cliBundle, "add", rawUrl, "--skill", "example"],
      {
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
        timeout: 10_000,
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).not.toContain(rawUrl);
    expect(output).not.toContain(sentinel);
    expect(output).toContain("Invalid Git repository URL");
  });
});
