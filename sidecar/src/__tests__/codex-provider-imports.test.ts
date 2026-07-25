import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing__ } from "../openai-handler.js";
import { MAX_PROVIDER_IMPORT_BYTES } from "../provider-readonly.js";

let tempRoot = "";

function makeCodexRoot(): string {
  const codexRoot = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexRoot);
  return codexRoot;
}

function writeSkill(skillsRoot: string, name: string, description: string): string {
  const skillRoot = path.join(skillsRoot, name);
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(
    path.join(skillRoot, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`,
  );
  return skillRoot;
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bytro-codex-provider-import-"));
  __testing__.resetContentCache();
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("Codex provider-owned imports", () => {
  it("keeps normal bounded config and AGENTS.md imports working", () => {
    const codexRoot = makeCodexRoot();
    const config = path.join(codexRoot, "config.toml");
    fs.writeFileSync(config, 'model = "gpt-5.6-sol"\n');
    fs.writeFileSync(path.join(codexRoot, "AGENTS.md"), "User instructions");

    expect(__testing__.getCachedSanitizedConfig(config)).toContain('model = "gpt-5.6-sol"');
    expect(__testing__.getCachedAgentsMd(codexRoot)).toContain("User instructions");
  });

  it("indexes only real skill directories with bounded regular SKILL.md files", () => {
    const codexRoot = makeCodexRoot();
    const skillsRoot = path.join(codexRoot, "skills");
    fs.mkdirSync(skillsRoot);
    writeSkill(skillsRoot, "safe-skill", "safe description");

    const oversizedRoot = path.join(skillsRoot, "oversized");
    fs.mkdirSync(oversizedRoot);
    const oversized = path.join(oversizedRoot, "SKILL.md");
    const oversizedFd = fs.openSync(oversized, "w");
    fs.ftruncateSync(oversizedFd, MAX_PROVIDER_IMPORT_BYTES + 1);
    fs.closeSync(oversizedFd);

    if (process.platform !== "win32") {
      const outside = path.join(tempRoot, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(
        path.join(outside, "SKILL.md"),
        "---\nname: leaked\ndescription: secret material\n---\n",
      );
      fs.symlinkSync(outside, path.join(skillsRoot, "linked-directory"));

      const linkedLeafRoot = path.join(skillsRoot, "linked-leaf");
      fs.mkdirSync(linkedLeafRoot);
      fs.symlinkSync(path.join(outside, "SKILL.md"), path.join(linkedLeafRoot, "SKILL.md"));

      const fifoRoot = path.join(skillsRoot, "fifo");
      fs.mkdirSync(fifoRoot);
      execFileSync("mkfifo", [path.join(fifoRoot, "SKILL.md")]);
    }

    const index = __testing__.buildSkillIndex(skillsRoot);
    expect(index).toContain("safe-skill");
    expect(index).not.toContain("oversized");
    expect(index).not.toContain("secret material");
    expect(index).not.toContain("linked-leaf");
    expect(index).not.toContain("| fifo |");
  });

  it.runIf(process.platform !== "win32")("rejects linked provider roots and leaf files", () => {
    const realRoot = makeCodexRoot();
    const outside = path.join(tempRoot, "outside-secret");
    fs.writeFileSync(outside, "must not enter model context");
    fs.symlinkSync(outside, path.join(realRoot, "AGENTS.md"));
    fs.symlinkSync(outside, path.join(realRoot, "config.toml"));

    expect(__testing__.getCachedAgentsMd(realRoot)).not.toContain("must not enter model context");
    expect(__testing__.getCachedSanitizedConfig(path.join(realRoot, "config.toml"))).toBeNull();

    const linkedRoot = path.join(tempRoot, "linked-codex");
    fs.symlinkSync(realRoot, linkedRoot);
    expect(__testing__.getCachedAgentsMd(linkedRoot)).not.toContain("must not enter model context");
  });

  it("rejects oversized AGENTS.md", () => {
    const codexRoot = makeCodexRoot();
    const agents = path.join(codexRoot, "AGENTS.md");
    const fd = fs.openSync(agents, "w");
    fs.ftruncateSync(fd, MAX_PROVIDER_IMPORT_BYTES + 1);
    fs.closeSync(fd);

    expect(__testing__.getCachedAgentsMd(codexRoot).trim()).toBe("");
  });
});
