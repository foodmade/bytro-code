import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  nextSmoothTextLength,
  smoothTextRevealIntervalMs,
} from "../stream-text-smoothing";
import { useSmoothStreamText } from "../use-smooth-stream-text";

describe("nextSmoothTextLength", () => {
  it("advances at least one character while text remains", () => {
    expect(nextSmoothTextLength({
      currentLength: 0,
      targetLength: 10,
      elapsedMs: 16,
    })).toBe(1);
  });

  it("never overshoots the target length", () => {
    expect(nextSmoothTextLength({
      currentLength: 9,
      targetLength: 10,
      elapsedMs: 64,
      finalizing: true,
    })).toBe(10);
  });

  it("accelerates when the visible text is far behind the stream", () => {
    const shortGap = nextSmoothTextLength({
      currentLength: 0,
      targetLength: 20,
      elapsedMs: 16,
    });
    const largeGap = nextSmoothTextLength({
      currentLength: 0,
      targetLength: 800,
      elapsedMs: 16,
    });

    expect(largeGap).toBeGreaterThan(shortGap);
  });

  it("catches up faster after the network stream completes", () => {
    const streamingStep = nextSmoothTextLength({
      currentLength: 100,
      targetLength: 400,
      elapsedMs: 16,
    });
    const finalizingStep = nextSmoothTextLength({
      currentLength: 100,
      targetLength: 400,
      elapsedMs: 16,
      finalizing: true,
    });

    expect(finalizingStep).toBeGreaterThan(streamingStep);
  });

  it("updates large backlogs at frame-rate but slows down near the tail", () => {
    expect(smoothTextRevealIntervalMs({ remaining: 1600 })).toBe(16);
    expect(smoothTextRevealIntervalMs({ remaining: 800 })).toBeLessThan(
      smoothTextRevealIntervalMs({ remaining: 80 }),
    );
  });

  it("uses frame-rate updates while finalizing so completed streams catch up", () => {
    expect(smoothTextRevealIntervalMs({ remaining: 80 })).toBeGreaterThan(16);
    expect(smoothTextRevealIntervalMs({ remaining: 80, finalizing: true })).toBe(16);
  });
});

describe("useSmoothStreamText", () => {
  it("starts from existing content when a streaming message remounts", () => {
    function Probe() {
      const smooth = useSmoothStreamText("already streamed", true);
      return createElement("span", null, smooth.text);
    }

    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>already streamed</span>");
  });
});
