import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyDirectoryWithoutLinks,
  readPrivateTextFile,
  requireRealDirectoryTree,
} from "./fs-safe.js";

const temporaryDirectories: string[] = [];

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bytro-skills-safe-copy-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("safe skill directory copy", () => {
  it("copies regular files and skips nested links", () => {
    const root = makeTempDirectory();
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const outside = path.join(root, "outside-secret");
    fs.mkdirSync(path.join(source, "nested"), { recursive: true });
    fs.writeFileSync(path.join(source, "SKILL.md"), "safe skill");
    fs.writeFileSync(path.join(source, "nested", "data.txt"), "safe data");
    fs.writeFileSync(outside, "must not be copied");

    if (process.platform !== "win32") {
      fs.symlinkSync(outside, path.join(source, "linked-secret"));
    }

    copyDirectoryWithoutLinks(source, destination);

    expect(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8")).toBe("safe skill");
    expect(fs.readFileSync(path.join(destination, "nested", "data.txt"), "utf8")).toBe("safe data");
    if (process.platform !== "win32") {
      expect(fs.existsSync(path.join(destination, "linked-secret"))).toBe(false);
      expect(fs.statSync(destination).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(destination, "SKILL.md")).mode & 0o777).toBe(0o600);
    }
  });

  it.runIf(process.platform !== "win32")("rejects a linked source root", () => {
    const root = makeTempDirectory();
    const realSource = path.join(root, "real-source");
    const linkedSource = path.join(root, "linked-source");
    fs.mkdirSync(realSource);
    fs.symlinkSync(realSource, linkedSource);

    expect(() =>
      copyDirectoryWithoutLinks(linkedSource, path.join(root, "destination")),
    ).toThrow(/real directory/);
  });

  it.runIf(process.platform !== "win32")("rejects hard-linked private reads and source copies", () => {
    const root = makeTempDirectory();
    const privateRoot = path.join(root, "private");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const outside = path.join(root, "outside-secret");
    fs.mkdirSync(privateRoot);
    fs.mkdirSync(source);
    fs.writeFileSync(outside, "secret");
    fs.linkSync(outside, path.join(privateRoot, "manifest.json"));
    fs.linkSync(outside, path.join(source, "SKILL.md"));

    expect(readPrivateTextFile(privateRoot, path.join(privateRoot, "manifest.json"))).toBeNull();
    copyDirectoryWithoutLinks(source, destination);
    expect(fs.existsSync(path.join(destination, "SKILL.md"))).toBe(false);
  });

  it.runIf(process.platform !== "win32")("rejects a linked intermediate source directory", () => {
    const root = makeTempDirectory();
    const cloneRoot = path.join(root, "clone");
    const outside = path.join(root, "outside");
    fs.mkdirSync(cloneRoot);
    fs.mkdirSync(path.join(outside, "skill"), { recursive: true });
    fs.symlinkSync(outside, path.join(cloneRoot, "linked"));

    expect(() =>
      requireRealDirectoryTree(cloneRoot, path.join(cloneRoot, "linked", "skill")),
    ).toThrow(/real directory/);
  });
});
