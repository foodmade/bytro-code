import { describe, expect, it } from "vitest";
import { resolvePaneZone } from "@/lib/split-drag-target";

const paneRect = {
  left: 0,
  top: 0,
  right: 400,
  bottom: 300,
  width: 400,
  height: 300,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} satisfies DOMRect;

describe("resolvePaneZone", () => {
  it("does not return center by default even at the pane midpoint", () => {
    expect(resolvePaneZone(200, 150, paneRect)).toBe("right");
  });

  it("returns center only when explicitly enabled for pane swapping", () => {
    expect(resolvePaneZone(200, 150, paneRect, { allowCenter: true })).toBe("center");
  });

  it("returns top when the pointer is near the top edge", () => {
    expect(resolvePaneZone(200, 12, paneRect)).toBe("top");
  });

  it("returns bottom when the pointer is near the bottom edge", () => {
    expect(resolvePaneZone(200, 288, paneRect)).toBe("bottom");
  });

  it("allows left and right splits before reaching the extreme edge", () => {
    expect(resolvePaneZone(78, 150, paneRect)).toBe("left");
    expect(resolvePaneZone(322, 150, paneRect)).toBe("right");
  });

  it("allows top and bottom splits before reaching the extreme edge", () => {
    expect(resolvePaneZone(200, 64, paneRect)).toBe("top");
    expect(resolvePaneZone(200, 236, paneRect)).toBe("bottom");
  });

  it("uses the dominant normalized axis in the corners", () => {
    expect(resolvePaneZone(22, 8, paneRect)).toBe("top");
    expect(resolvePaneZone(32, 110, paneRect)).toBe("left");
  });
});
