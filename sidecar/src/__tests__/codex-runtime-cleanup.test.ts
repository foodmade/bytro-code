import {
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupStaleCodexRuntimeDirectories,
  shouldRemoveCodexRuntimeDirectory,
} from "../openai-handler.js";

describe("Codex runtime directory cleanup", () => {
  it("fails closed when ownership, age, or process state is unsafe", () => {
    const base = {
      ownerPid: 1234,
      ownerUid: 501,
      currentPid: 5678,
      currentUid: 501,
      mtimeMs: 0,
      now: 48 * 60 * 60 * 1000,
      ownerProcessAlive: false,
    };

    expect(shouldRemoveCodexRuntimeDirectory(base)).toBe(true);
    expect(
      shouldRemoveCodexRuntimeDirectory({
        ...base,
        currentUid: undefined,
      }),
    ).toBe(false);
    expect(
      shouldRemoveCodexRuntimeDirectory({
        ...base,
        currentUid: undefined,
        allowMissingUid: true,
      }),
    ).toBe(true);
    expect(
      shouldRemoveCodexRuntimeDirectory({ ...base, ownerUid: 502 }),
    ).toBe(false);
    expect(
      shouldRemoveCodexRuntimeDirectory({
        ...base,
        ownerProcessAlive: true,
      }),
    ).toBe(false);
    expect(
      shouldRemoveCodexRuntimeDirectory({
        ...base,
        mtimeMs: base.now - 60_000,
      }),
    ).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "removes only stale dead-owner directories and never follows symlinks",
    () => {
      const root = mkdtempSync(join(tmpdir(), "bytro-codex-cleanup-test-"));
      const deadPid = 2_147_483_647;
      const stale = mkdtempSync(
        join(root, `bytro-community-codex-${deadPid}-`),
      );
      const active = mkdtempSync(
        join(root, `bytro-community-codex-${process.pid}-`),
      );
      const fresh = mkdtempSync(
        join(root, `bytro-community-codex-${deadPid}-`),
      );
      const target = join(root, "unrelated-target");
      const link = join(
        root,
        `bytro-community-codex-${deadPid}-symlink`,
      );
      writeFileSync(target, "sentinel");
      symlinkSync(target, link);
      const now = Date.now();
      const old = new Date(now - 48 * 60 * 60 * 1000);
      utimesSync(stale, old, old);
      utimesSync(active, old, old);

      try {
        expect(cleanupStaleCodexRuntimeDirectories(root, now)).toBe(1);
        expect(existsSync(stale)).toBe(false);
        expect(existsSync(active)).toBe(true);
        expect(existsSync(fresh)).toBe(true);
        expect(existsSync(link)).toBe(true);
        expect(existsSync(target)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("cleans the trusted per-user temp root when Windows has no uid API", () => {
    const root = mkdtempSync(
      join(tmpdir(), "bytro-codex-windows-cleanup-test-"),
    );
    const deadPid = 2_147_483_647;
    const stale = mkdtempSync(
      join(root, `bytro-community-codex-${deadPid}-`),
    );
    const now = Date.now();
    const old = new Date(now - 48 * 60 * 60 * 1000);
    utimesSync(stale, old, old);

    try {
      expect(
        cleanupStaleCodexRuntimeDirectories(root, now, {
          platform: "win32",
          trustedUserTempRoot: root,
          getCurrentUid: () => undefined,
        }),
      ).toBe(1);
      expect(existsSync(stale)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
