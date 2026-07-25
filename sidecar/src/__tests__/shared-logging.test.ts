import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendPrivateLogFile,
  publicSidecarErrorMessage,
  summarizeDiagnosticText,
  type LogLevel,
} from "../shared.js";
import { __testing__ as codexTesting } from "../openai-handler.js";

describe("private sidecar diagnostics", () => {
  it.each<LogLevel>(["info", "trace"])(
    "never includes raw content at %s level",
    (level) => {
      const secret =
        'raw prompt token=sk-secret mcpArgs={"Authorization":"Bearer secret"}';
      const summary = summarizeDiagnosticText(
        secret,
        "turn.input",
        level,
      );

      expect(summary).toContain("event=turn.input");
      expect(summary).toContain(
        `len=${Buffer.byteLength(secret, "utf8")}`,
      );
      expect(summary).toMatch(/sha256=[a-f0-9]{64}$/);
      expect(summary).not.toContain("raw prompt");
      expect(summary).not.toContain("sk-secret");
      expect(summary).not.toContain("Authorization");
    },
  );

  it("never returns raw handler failures to the UI", () => {
    const secret = "SECRET_SENTINEL api_key=sk-private /Users/private/project";

    expect(publicSidecarErrorMessage(new Error(secret))).toBe(
      "Provider request failed",
    );
    expect(publicSidecarErrorMessage(new Error(`timeout ${secret}`))).toBe(
      "Provider request timed out",
    );
    expect(publicSidecarErrorMessage(new Error(`ENOENT ${secret}`))).toBe(
      "Required provider CLI is unavailable",
    );
    for (const message of [
      publicSidecarErrorMessage(new Error(secret)),
      publicSidecarErrorMessage(new Error(`timeout ${secret}`)),
      publicSidecarErrorMessage(new Error(`ENOENT ${secret}`)),
    ]) {
      expect(message).not.toContain(secret);
      expect(message).not.toContain("sk-private");
      expect(message).not.toContain("/Users/private");
    }
  });

  it("sanitizes Codex status RPC failures before rendering them", () => {
    const secret =
      "SECRET_STATUS_SENTINEL Authorization=Bearer-private /Users/private/project";

    const rendered = codexTesting.statusRpcError("thread/read", {
      error: `timeout ${secret}`,
    });

    expect(rendered).toBe("- thread/read: Provider request timed out");
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain("Bearer-private");
    expect(rendered).not.toContain("/Users/private");
  });

  it("creates and hardens diagnostic files with owner-only permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "bytro-log-test-"));
    const logPath = join(directory, "sidecar.log");

    try {
      appendPrivateLogFile(logPath, "safe metadata\n");
      expect(readFileSync(logPath, "utf8")).toBe("safe metadata\n");
      if (process.platform !== "win32") {
        expect(statSync(logPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "refuses to follow a diagnostic-log symlink",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "bytro-log-link-test-"));
      const target = join(directory, "target.log");
      const link = join(directory, "sidecar.log");
      writeFileSync(target, "sentinel");
      symlinkSync(target, link);

      try {
        expect(() => appendPrivateLogFile(link, "should-not-write")).toThrow();
        expect(readFileSync(target, "utf8")).toBe("sentinel");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
