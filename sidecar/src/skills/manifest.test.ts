import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockedHome = vi.hoisted(() => ({ path: "" }));

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => mockedHome.path };
});

import { MAX_PRIVATE_TEXT_BYTES } from "./fs-safe.js";
import {
  ensureSkillsDir,
  getManifestPath,
  getSkillsDir,
  readManifest,
  writeManifest,
} from "./manifest.js";
import { getSkillInfo, installSkillsFromClone } from "./installer.js";

describe("Community skills manifest storage", () => {
  beforeEach(() => {
    mockedHome.path = fs.mkdtempSync(path.join(process.cwd(), ".tmp-skills-home-"));
  });

  afterEach(() => {
    fs.rmSync(mockedHome.path, { recursive: true, force: true });
  });

  it.runIf(process.platform !== "win32")("rejects a linked managed skills directory", () => {
    const communityRoot = path.join(mockedHome.path, ".bytro-community");
    const outside = path.join(mockedHome.path, "outside");
    fs.mkdirSync(communityRoot);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(communityRoot, "skills"));

    expect(() => ensureSkillsDir()).toThrow(/non-directory Bytro path/);
  });

  it("persists a private manifest and reads it back", () => {
    const manifest = {
      version: 1 as const,
      skills: {
        example: {
          name: "example",
          description: "example skill",
          sourceRepo: "owner/repo",
          commitHash: "commit",
          installedAt: "2026-07-25T00:00:00Z",
          relativePath: "example",
        },
      },
    };

    writeManifest(manifest);

    expect(readManifest()).toEqual(manifest);
    if (process.platform !== "win32") {
      expect(fs.statSync(getManifestPath()).mode & 0o777).toBe(0o600);
    }
  });

  it("stores only the normalized repository URL in installed metadata", () => {
    const cloneDir = path.join(mockedHome.path, "clone");
    const skillDir = path.join(cloneDir, "example");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "safe skill");

    const [installed] = installSkillsFromClone(
      "OpenAI/codex",
      [
        {
          name: "example",
          description: "safe skill",
          relativePath: "example",
          frontmatter: { name: "example", description: "safe skill" },
        },
      ],
      ["example"],
      cloneDir,
      "commit",
    );

    expect(installed.sourceRepo).toBe("https://github.com/OpenAI/codex.git");
    expect(readManifest().skills.example.sourceRepo).toBe("https://github.com/OpenAI/codex.git");
  });

  it("rejects oversized and non-regular managed manifests", () => {
    ensureSkillsDir();
    const manifestPath = getManifestPath();
    const fd = fs.openSync(manifestPath, "w");
    fs.ftruncateSync(fd, MAX_PRIVATE_TEXT_BYTES + 1);
    fs.closeSync(fd);
    expect(readManifest()).toEqual({ version: 1, skills: {} });

    fs.unlinkSync(manifestPath);
    fs.mkdirSync(manifestPath);
    expect(readManifest()).toEqual({ version: 1, skills: {} });
    expect(() => writeManifest({ version: 1, skills: {} })).toThrow(/non-regular Bytro file/);
  });

  it.runIf(process.platform !== "win32")(
    "does not follow linked manifests, linked skill files, or FIFOs",
    () => {
      ensureSkillsDir();
      const outside = path.join(mockedHome.path, "outside-secret");
      fs.writeFileSync(outside, "outside-secret");
      fs.symlinkSync(outside, getManifestPath());

      expect(readManifest()).toEqual({ version: 1, skills: {} });
      expect(() => writeManifest({ version: 1, skills: {} })).toThrow(/non-regular Bytro file/);
      expect(fs.readFileSync(outside, "utf8")).toBe("outside-secret");

      fs.unlinkSync(getManifestPath());
      const skillDir = path.join(getSkillsDir(), "linked-skill");
      fs.mkdirSync(skillDir);
      fs.symlinkSync(outside, path.join(skillDir, "SKILL.md"));
      writeManifest({
        version: 1,
        skills: {
          "linked-skill": {
            name: "linked-skill",
            description: "",
            sourceRepo: "owner/repo",
            commitHash: "commit",
            installedAt: "2026-07-25T00:00:00Z",
            relativePath: "linked-skill",
          },
        },
      });
      expect(getSkillInfo("linked-skill")?.content).toBe("(SKILL.md not found)");

      fs.unlinkSync(getManifestPath());
      execFileSync("mkfifo", [getManifestPath()]);
      expect(readManifest()).toEqual({ version: 1, skills: {} });
      expect(() => writeManifest({ version: 1, skills: {} })).toThrow(/non-regular Bytro file/);
    },
  );
});
