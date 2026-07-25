import { describe, expect, it } from "vitest";
import { constrainNativeContextMenuPosition, nativeMenuSeparator, type NativeContextMenuItem } from "@/lib/native-context-menu";

const menuItem = (text = "Item"): NativeContextMenuItem => ({ text });

describe("constrainNativeContextMenuPosition", () => {
  it("keeps coordinates that fit inside the viewport", () => {
    const position = constrainNativeContextMenuPosition(
      { x: 80, y: 120 },
      [menuItem(), nativeMenuSeparator(), menuItem()],
      { width: 800, height: 600 },
    );

    expect(position).toEqual({ x: 80, y: 120 });
  });

  it("moves tall menus upward before opening them", () => {
    const items = Array.from({ length: 12 }, (_, index) => menuItem(`Item ${index}`));
    const position = constrainNativeContextMenuPosition(
      { x: 120, y: 360 },
      items,
      { width: 800, height: 400 },
    );

    expect(position.y).toBeLessThan(360);
  });

  it("does not overcorrect editor-sized menus near the bottom", () => {
    const editorMenuItems = [
      ...Array.from({ length: 5 }, (_, index) => menuItem(`Navigation ${index}`)),
      nativeMenuSeparator(),
      ...Array.from({ length: 4 }, (_, index) => menuItem(`Chat ${index}`)),
      nativeMenuSeparator(),
      ...Array.from({ length: 3 }, (_, index) => menuItem(`Find ${index}`)),
      nativeMenuSeparator(),
      ...Array.from({ length: 6 }, (_, index) => menuItem(`Format ${index}`)),
      nativeMenuSeparator(),
      ...Array.from({ length: 4 }, (_, index) => menuItem(`Clipboard ${index}`)),
      nativeMenuSeparator(),
      menuItem("Command Palette"),
    ];

    const position = constrainNativeContextMenuPosition(
      { x: 300, y: 720 },
      editorMenuItems,
      { width: 1120, height: 752 },
    );

    expect(position.y).toBeGreaterThan(100);
  });

  it("pins oversized menus to the viewport padding", () => {
    const items = Array.from({ length: 30 }, (_, index) => menuItem(`Item ${index}`));
    const position = constrainNativeContextMenuPosition(
      { x: 700, y: 500 },
      items,
      { width: 500, height: 300 },
    );

    expect(position).toEqual({ x: 162, y: 8 });
  });
});
