import { describe, it, expect } from "vitest";
import { cn } from "../utils";

describe("cn", () => {
  it("merges simple class names", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("handles conditional classes via clsx", () => {
    const isHidden = false;
    expect(cn("base", isHidden && "hidden", "active")).toBe("base active");
  });

  it("deduplicates conflicting Tailwind classes via twMerge", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("handles undefined and null inputs", () => {
    expect(cn("foo", undefined, null, "bar")).toBe("foo bar");
  });

  it("handles empty string inputs", () => {
    expect(cn("", "foo", "")).toBe("foo");
  });

  it("handles array inputs", () => {
    expect(cn(["foo", "bar"], "baz")).toBe("foo bar baz");
  });

  it("handles object inputs", () => {
    expect(cn({ hidden: true, visible: false })).toBe("hidden");
  });

  it("returns empty string when no valid classes", () => {
    expect(cn("", undefined, null, false)).toBe("");
  });

  it("merges complex Tailwind conflict scenarios", () => {
    expect(cn("rounded-lg", "rounded-md")).toBe("rounded-md");
    expect(cn("bg-[#1A1A1A]", "bg-surface")).toBe("bg-surface");
  });
});
