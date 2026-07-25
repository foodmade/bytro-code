import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_PROVIDER_IMPORT_BYTES,
  listProviderDirectory,
  readProviderTextFile,
} from "./provider-readonly.js";

const temporaryDirectories: string[] = [];

function makeProviderRoot(): string {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bytro-provider-readonly-"));
  temporaryDirectories.push(temp);
  const root = path.join(temp, ".codex");
  fs.mkdirSync(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("provider-owned configuration imports", () => {
  it("reads normal small files", () => {
    const providerRoot = makeProviderRoot();
    const config = path.join(providerRoot, "config.toml");
    fs.writeFileSync(config, 'model = "gpt-5.6-sol"');

    expect(readProviderTextFile(providerRoot, config)?.content).toBe('model = "gpt-5.6-sol"');
  });

  it("rejects oversized files", () => {
    const providerRoot = makeProviderRoot();
    const config = path.join(providerRoot, "config.toml");
    const fd = fs.openSync(config, "w");
    fs.ftruncateSync(fd, MAX_PROVIDER_IMPORT_BYTES + 1);
    fs.closeSync(fd);

    expect(readProviderTextFile(providerRoot, config)).toBeNull();
  });

  it.runIf(process.platform !== "win32")("rejects hard-linked provider files", () => {
    const providerRoot = makeProviderRoot();
    const outside = path.join(path.dirname(providerRoot), "outside-secret");
    const linked = path.join(providerRoot, "config.toml");
    fs.writeFileSync(outside, "secret");
    fs.linkSync(outside, linked);

    expect(readProviderTextFile(providerRoot, linked)).toBeNull();
  });

  it.runIf(process.platform !== "win32")("rejects linked roots, intermediates, and leaves", () => {
    const providerRoot = makeProviderRoot();
    const temp = path.dirname(providerRoot);
    const outsideRoot = path.join(temp, "outside-provider");
    fs.mkdirSync(path.join(outsideRoot, "skill"), { recursive: true });
    const outsideFile = path.join(outsideRoot, "secret");
    fs.writeFileSync(outsideFile, "secret");

    const linkedLeaf = path.join(providerRoot, "AGENTS.md");
    fs.symlinkSync(outsideFile, linkedLeaf);
    expect(readProviderTextFile(providerRoot, linkedLeaf)).toBeNull();

    const linkedIntermediate = path.join(providerRoot, "linked");
    fs.symlinkSync(outsideRoot, linkedIntermediate);
    expect(
      readProviderTextFile(providerRoot, path.join(linkedIntermediate, "skill", "secret")),
    ).toBeNull();
    expect(listProviderDirectory(providerRoot, path.join(linkedIntermediate, "skill"))).toBeNull();

    const linkedRoot = path.join(temp, "linked-codex");
    fs.symlinkSync(outsideRoot, linkedRoot);
    expect(readProviderTextFile(linkedRoot, path.join(linkedRoot, "secret"))).toBeNull();
  });

  it.runIf(process.platform !== "win32")("rejects FIFOs without blocking", () => {
    const providerRoot = makeProviderRoot();
    const fifo = path.join(providerRoot, "AGENTS.md");
    execFileSync("mkfifo", [fifo]);

    expect(readProviderTextFile(providerRoot, fifo)).toBeNull();
  });
});
