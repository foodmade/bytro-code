import { describe, it, expect } from "vitest";
import { parseMentionTrigger } from "../input-parsers";

describe("parseMentionTrigger", () => {
  it("returns null when no @ is present", () => {
    expect(parseMentionTrigger("hello world", 11)).toBeNull();
  });

  it("detects @ at the start of text", () => {
    const result = parseMentionTrigger("@src", 4);
    expect(result).toEqual({ atIndex: 0, query: "src" });
  });

  it("detects @ after a space", () => {
    const result = parseMentionTrigger("hello @file", 11);
    expect(result).toEqual({ atIndex: 6, query: "file" });
  });

  it("detects @ after a newline", () => {
    const result = parseMentionTrigger("line1\n@foo", 10);
    expect(result).toEqual({ atIndex: 6, query: "foo" });
  });

  it("detects @ after a tab", () => {
    const result = parseMentionTrigger("text\t@bar", 9);
    expect(result).toEqual({ atIndex: 5, query: "bar" });
  });

  it("detects @ even when not preceded by whitespace", () => {
    // @ can appear anywhere — no whitespace-before requirement
    const result = parseMentionTrigger("email@test", 10);
    expect(result).toEqual({ atIndex: 5, query: "test" });
  });

  it("returns null when query contains a space (mention closed)", () => {
    expect(parseMentionTrigger("@hello world", 12)).toBeNull();
  });

  it("returns empty query when cursor is right after @", () => {
    const result = parseMentionTrigger("@", 1);
    expect(result).toEqual({ atIndex: 0, query: "" });
  });

  it("uses cursor position to limit query", () => {
    const result = parseMentionTrigger("@src/file.ts extra", 12);
    expect(result).toEqual({ atIndex: 0, query: "src/file.ts" });
  });

  it("finds the nearest @ when multiple exist", () => {
    const result = parseMentionTrigger("@first text @second", 19);
    expect(result).toEqual({ atIndex: 12, query: "second" });
  });

  it("trims trailing non-breaking space (\\u00A0) from query", () => {
    const result = parseMentionTrigger("@chat-input\u00A0", 12);
    expect(result).toEqual({ atIndex: 0, query: "chat-input" });
  });

  it("trims multiple trailing non-breaking spaces", () => {
    const result = parseMentionTrigger("@file\u00A0\u00A0", 7);
    expect(result).toEqual({ atIndex: 0, query: "file" });
  });

  it("returns null when query contains internal non-breaking space", () => {
    expect(parseMentionTrigger("@hello\u00A0world", 12)).toBeNull();
  });
});
