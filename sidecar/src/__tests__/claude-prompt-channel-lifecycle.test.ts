import { afterEach, describe, expect, it } from "vitest";
import {
  closeActivePromptChannel,
  PromptChannel,
  replaceActivePromptChannel,
} from "../claude-handler.js";
import { activePromptChannels } from "../persistent-session-registry.js";

const REQUEST_ID = "retry-lifecycle";

afterEach(() => {
  closeActivePromptChannel(REQUEST_ID);
});

describe("Claude retry prompt-channel lifecycle", () => {
  it("closes the current channel before every retry replacement", async () => {
    const initial = new PromptChannel(30_000);
    const resumeRetry = new PromptChannel(30_000);
    const freshRetry = new PromptChannel(30_000);

    replaceActivePromptChannel(REQUEST_ID, initial);
    const initialWait = initial.waitForMessage();
    replaceActivePromptChannel(REQUEST_ID, resumeRetry);
    await expect(initialWait).resolves.toBeNull();

    const resumeWait = resumeRetry.waitForMessage();
    replaceActivePromptChannel(REQUEST_ID, freshRetry);
    await expect(resumeWait).resolves.toBeNull();

    const freshWait = freshRetry.waitForMessage();
    closeActivePromptChannel(REQUEST_ID);
    await expect(freshWait).resolves.toBeNull();
    expect(activePromptChannels.has(REQUEST_ID)).toBe(false);
  });

  it("routes a post-retry follow-up into the replacement channel", async () => {
    const original = new PromptChannel(30_000);
    const retry = new PromptChannel(30_000);
    let currentPromptChannel = original;

    replaceActivePromptChannel(REQUEST_ID, currentPromptChannel);
    replaceActivePromptChannel(REQUEST_ID, retry);
    currentPromptChannel = retry;

    const registeredWarmChannel = currentPromptChannel;
    const nextMessage = registeredWarmChannel.waitForMessage();
    activePromptChannels.get(REQUEST_ID)?.push(
      "second turn after retry",
      undefined,
      REQUEST_ID,
    );

    await expect(nextMessage).resolves.toMatchObject({
      text: "second turn after retry",
      requestId: REQUEST_ID,
    });
    expect(registeredWarmChannel).toBe(retry);
  });
});
