import { describe, expect, it, vi } from "vitest";
import { __testing__, normalizeGitUrl } from "./git-ops.js";

describe("skills Git boundary", () => {
  it("normalizes supported credential-free repository URLs", () => {
    expect(normalizeGitUrl("https://GitHub.com/OpenAI/codex")).toBe(
      "https://github.com/OpenAI/codex.git",
    );
    expect(normalizeGitUrl("git@GitHub.com:OpenAI/codex")).toBe("git@github.com:OpenAI/codex.git");
    expect(normalizeGitUrl("OpenAI/codex")).toBe("https://github.com/OpenAI/codex.git");
  });

  it("rejects userinfo, query tokens, and fragments without echoing them", () => {
    const sentinel = "raw-secret-sentinel";
    for (const unsafeUrl of [
      `https://user:${sentinel}@github.com/owner/repo`,
      `https://github.com/owner/repo?token=${sentinel}`,
      `https://github.com/owner/repo#${sentinel}`,
      `git@github.com:owner/repo?token=${sentinel}`,
    ]) {
      expect(() => normalizeGitUrl(unsafeUrl)).toThrow("Invalid Git repository URL.");
      try {
        normalizeGitUrl(unsafeUrl);
      } catch (error) {
        expect(String(error)).not.toContain(sentinel);
        expect(String(error)).not.toContain(unsafeUrl);
      }
    }
  });

  it("reduces raw Git stderr to a fixed category and bounded diagnostic id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sentinel = "raw-git-stderr-secret-sentinel";

    const error = __testing__.publicGitOperationError(
      "Git clone failed",
      `fatal: remote returned bearer ${sentinel}`,
    );

    expect(error.message).toMatch(/^Git clone failed \(diagnosticId: [a-f0-9]{12}\)$/);
    expect(error.message).not.toContain(sentinel);
    expect(warn.mock.calls.flat().join(" ")).not.toContain(sentinel);
    warn.mockRestore();
  });
});
