import { describe, expect, it } from "vitest";
import {
  clampContentMotionFollowDuration,
  getBottomGap,
  getBottomScrollTop,
  isNearBottom,
} from "../use-auto-scroll";

describe("auto scroll helpers", () => {
  it("targets the maximum legal scrollTop instead of raw scrollHeight", () => {
    expect(getBottomScrollTop({
      scrollHeight: 1200,
      clientHeight: 500,
    })).toBe(700);
  });

  it("does not return a negative bottom target for short content", () => {
    expect(getBottomScrollTop({
      scrollHeight: 320,
      clientHeight: 500,
    })).toBe(0);
  });

  it("computes the remaining gap below the viewport", () => {
    expect(getBottomGap({
      scrollHeight: 1200,
      scrollTop: 650,
      clientHeight: 500,
    })).toBe(50);
  });

  it("treats the last padded region as near bottom", () => {
    expect(isNearBottom({
      scrollHeight: 1200,
      scrollTop: 1050,
      clientHeight: 20,
    })).toBe(true);
    expect(isNearBottom({
      scrollHeight: 1200,
      scrollTop: 900,
      clientHeight: 20,
    })).toBe(false);
  });

  it("clamps explicit content-motion follow windows", () => {
    expect(clampContentMotionFollowDuration(-40)).toBe(0);
    expect(clampContentMotionFollowDuration(260)).toBe(260);
    expect(clampContentMotionFollowDuration(5000)).toBe(1000);
    expect(clampContentMotionFollowDuration(Number.NaN)).toBe(260);
  });
});
