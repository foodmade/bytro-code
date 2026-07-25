import { describe, expect, it } from "vitest";
import {
  mapApprovalPolicy,
  mapSandboxMode,
  shouldAutoAcceptCodexApproval,
} from "../openai-handler.js";

describe("Codex permission boundary", () => {
  it("grants full automation only for an explicit bypassPermissions mode", () => {
    expect(mapApprovalPolicy("bypassPermissions")).toBe("never");
    expect(mapSandboxMode("bypassPermissions")).toBe("danger-full-access");
  });

  it.each(["auto", "default", "plan", "planning", "deep", "acceptEdits"])(
    "keeps %s out of the dangerous full-auto policy",
    (mode) => {
      expect(mapApprovalPolicy(mode)).not.toBe("never");
      expect(mapSandboxMode(mode)).not.toBe("danger-full-access");
    },
  );

  it.each(["plan", "planning", "deep"])(
    "keeps %s read-only and denies side effects before plan approval",
    (mode) => {
      expect(mapSandboxMode(mode)).toBe("read-only");
      expect(
        shouldAutoAcceptCodexApproval(
          mode,
          "item/commandExecution/requestApproval",
          false,
        ),
      ).toBe(false);
      expect(
        shouldAutoAcceptCodexApproval(
          mode,
          "item/fileChange/requestApproval",
          false,
        ),
      ).toBe(false);
      expect(
        shouldAutoAcceptCodexApproval(
          mode,
          "item/commandExecution/requestApproval",
          true,
        ),
      ).toBe(true);
    },
  );
});
