import { describe, expect, it } from "vitest";
import { looksLikeFilePath } from "../file-path-detect";

describe("looksLikeFilePath", () => {
  it("accepts absolute, relative and home-prefixed paths", () => {
    expect(looksLikeFilePath("/Users/x/project/a.ts")).toBe(true);
    expect(looksLikeFilePath("./src/b.tsx")).toBe(true);
    expect(looksLikeFilePath("../c.rs")).toBe(true);
    expect(looksLikeFilePath("~/dotfiles/d.py")).toBe(true);
  });

  it("accepts Windows drive and UNC paths", () => {
    expect(looksLikeFilePath("C:\\Users\\x\\y.ts")).toBe(true);
    expect(looksLikeFilePath("C:/Users/x/y.ts")).toBe(true);
    expect(looksLikeFilePath("\\\\server\\share\\f.txt")).toBe(true);
  });

  it("accepts relative paths with separators and a real extension", () => {
    expect(looksLikeFilePath("src/lib/foo.ts")).toBe(true);
    expect(looksLikeFilePath("a/b/c.json")).toBe(true);
    expect(looksLikeFilePath("@scope/pkg/index.ts")).toBe(true);
  });

  it("accepts bare filenames with a known extension", () => {
    expect(looksLikeFilePath("README.md")).toBe(true);
    expect(looksLikeFilePath("package.json")).toBe(true);
    expect(looksLikeFilePath("vite.config.ts")).toBe(true);
    expect(looksLikeFilePath(".gitignore")).toBe(true);
    expect(looksLikeFilePath(".env")).toBe(true);
  });

  it("trims surrounding whitespace before testing", () => {
    expect(looksLikeFilePath("  src/a.ts  ")).toBe(true);
  });

  it("rejects empty or whitespace-only input", () => {
    expect(looksLikeFilePath("")).toBe(false);
    expect(looksLikeFilePath("   ")).toBe(false);
  });

  it("rejects commands and prose containing spaces", () => {
    expect(looksLikeFilePath("npm run dev")).toBe(false);
    expect(looksLikeFilePath("hello world.txt")).toBe(false);
  });

  it("rejects URLs", () => {
    expect(looksLikeFilePath("http://example.com/a.js")).toBe(false);
    expect(looksLikeFilePath("https://x.com")).toBe(false);
    expect(looksLikeFilePath("file:///etc/hosts")).toBe(false);
  });

  it("rejects version numbers", () => {
    expect(looksLikeFilePath("1.2.3")).toBe(false);
    expect(looksLikeFilePath("v2.0.1")).toBe(false);
  });

  it("rejects separator tokens without a file extension", () => {
    expect(looksLikeFilePath("and/or")).toBe(false);
    expect(looksLikeFilePath("TCP/IP")).toBe(false);
    expect(looksLikeFilePath("@anthropic-ai/claude")).toBe(false);
  });

  it("rejects bare identifiers and abbreviations", () => {
    expect(looksLikeFilePath("useState")).toBe(false);
    expect(looksLikeFilePath("e.g")).toBe(false);
    expect(looksLikeFilePath("i.e")).toBe(false);
    expect(looksLikeFilePath("foo.")).toBe(false);
  });

  it("does not treat a numeric tail as an extension", () => {
    expect(looksLikeFilePath("1/2.5")).toBe(false);
  });
});
