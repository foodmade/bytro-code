import { describe, expect, it } from "vitest";
import { ERROR_MESSAGE_MAX_LEN, formatError, truncateError } from "../format-error";

describe("formatError", () => {
  it("extracts message from Error instances", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });
  it("coerces non-Error values via String()", () => {
    expect(formatError("boom")).toBe("boom");
    expect(formatError(42)).toBe("42");
    expect(formatError(null)).toBe("null");
  });
});

describe("truncateError", () => {
  it("returns original when under limit", () => {
    expect(truncateError("hello")).toBe("hello");
  });
  it("truncates and appends ellipsis over limit", () => {
    const long = "x".repeat(ERROR_MESSAGE_MAX_LEN + 50);
    const out = truncateError(long);
    expect(out.length).toBe(ERROR_MESSAGE_MAX_LEN + 3);
    expect(out.endsWith("...")).toBe(true);
  });
  it("respects custom max", () => {
    expect(truncateError("abcdef", 3)).toBe("abc...");
  });
});
