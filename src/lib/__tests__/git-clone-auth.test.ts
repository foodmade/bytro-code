import { describe, expect, it } from "vitest";
import {
  defaultGitUsernameFromUrl,
  getGitPlatformFromUrl,
  isGitAuthFailure,
  isHttpGitUrl,
} from "@/lib/git-clone-auth";

describe("git-clone-auth helpers", () => {
  it("detects HTTP(S) git URLs", () => {
    expect(isHttpGitUrl("https://github.com/a/b.git")).toBe(true);
    expect(isHttpGitUrl("http://gitlab.example.com/a/b.git")).toBe(true);
    expect(isHttpGitUrl("git@github.com:a/b.git")).toBe(false);
    expect(isHttpGitUrl("ssh://git@github.com/a/b.git")).toBe(false);
  });

  it("extracts a default username from HTTPS URLs", () => {
    expect(defaultGitUsernameFromUrl("https://alice@github.com/a/b.git")).toBe("alice");
    expect(defaultGitUsernameFromUrl("https://github.com/a/b.git")).toBe("");
    expect(defaultGitUsernameFromUrl("git@github.com:a/b.git")).toBe("");
  });

  it("maps official Git hosts to settings platforms", () => {
    expect(getGitPlatformFromUrl("https://github.com/a/b.git")).toBe("github");
    expect(getGitPlatformFromUrl("https://gitee.com/a/b.git")).toBe("gitee");
    expect(getGitPlatformFromUrl("https://gitlab.com/a/b.git")).toBe("gitlab");
    expect(getGitPlatformFromUrl("git@github.com:a/b.git")).toBe("github");
    expect(getGitPlatformFromUrl("https://git.example.com/a/b.git")).toBeNull();
  });

  it("recognizes common Git authentication failures", () => {
    expect(isGitAuthFailure("fatal: Authentication failed")).toBe(true);
    expect(isGitAuthFailure("could not read Username: terminal prompts disabled")).toBe(true);
    expect(isGitAuthFailure("remote: Repository not found.")).toBe(true);
    expect(isGitAuthFailure("fatal: Remote branch missing not found in upstream origin")).toBe(
      false,
    );
    expect(isGitAuthFailure("fatal: Proxy Authentication Required 407")).toBe(false);
    expect(isGitAuthFailure("fatal: unable to access: Connection timed out")).toBe(false);
  });
});
