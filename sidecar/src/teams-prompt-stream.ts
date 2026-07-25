// ---------------------------------------------------------------------------
// PromptStream — AsyncIterable that mirrors SDK V2 Session's Stream pattern
// ---------------------------------------------------------------------------

import type { SDKUserMessage } from "./claude-cli-adapter.js";
import { summarizeDiagnosticText } from "./shared.js";

/**
 * A push-based async iterable for the SDK's `query()` prompt parameter.
 *
 * CRITICAL: The SDK has two modes based on the `prompt` parameter type:
 *   - `prompt: string`          → isSingleUserTurn = true  → stdin closes after first result
 *   - `prompt: AsyncIterable`   → isSingleUserTurn = false → stdin stays open for multi-turn
 *
 * This class mimics the SDK's internal `Stream` class (used by V2 SessionImpl)
 * rather than an async generator. The V2 Session uses:
 *   this.inputStream = new Stream();
 *   this.query.streamInput(this.inputStream);
 *   this.inputStream.enqueue(userMessage);
 *
 * We replicate that pattern: push messages via `enqueue()`, the SDK's
 * `streamInput()` for-await loop reads them via `next()`.
 *
 * Message format matches the SDK's own string-prompt format:
 *   content: [{ type: "text", text: msg }]   (ARRAY, not string!)
 */
export class PromptStream {
  private queue: SDKUserMessage[] = [];
  private readResolve: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private _isDone = false;
  private started = false;
  /** Monotonic counter for diagnostic logging. */
  private enqueueSeq = 0;
  private nextSeq = 0;

  /** Expose done state for external diagnostic logging. */
  get isDoneFlag(): boolean { return this._isDone; }

  /** Push a user message into the stream. Wakes up any pending next() call. */
  enqueue(
    text: string,
    sessionId = "",
    images?: ReadonlyArray<{ media_type: string; data: string }>,
  ): void {
    if (this._isDone) {
      process.stderr.write(
        `[PromptStream] enqueue REJECTED — stream is done; ` +
          `${summarizeDiagnosticText(text, "prompt-stream.rejected")}\n`,
      );
      return;
    }
    this.enqueueSeq++;
    const seq = this.enqueueSeq;
    const imageCount = images?.length ?? 0;
    const msg = PromptStream.buildUserMessage(text, sessionId, images);
    const hasPendingReader = !!this.readResolve;
    process.stderr.write(
      `[PromptStream] enqueue #${seq} (${imageCount} images, sessionPresent=${sessionId.length > 0}, ` +
      `pendingReader=${hasPendingReader}, queueLen=${this.queue.length}) ` +
      `${summarizeDiagnosticText(text, "prompt-stream.enqueue")}\n`,
    );
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = null;
      resolve({ done: false, value: msg });
    } else {
      this.queue.push(msg);
    }
  }

  /** Signal that no more messages will be sent. */
  done(): void {
    this._isDone = true;
    process.stderr.write(
      `[PromptStream] done() called — closing stream. enqueueSeq=${this.enqueueSeq}, ` +
      `nextSeq=${this.nextSeq}, queueLen=${this.queue.length}, pendingReader=${!!this.readResolve}\n`,
    );
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = null;
      resolve({ done: true, value: undefined as unknown as SDKUserMessage });
    }
  }

  /** Build a properly formatted SDKUserMessage matching SDK's internal format. */
  private static buildUserMessage(
    text: string,
    sessionId: string,
    images?: ReadonlyArray<{ media_type: string; data: string }>,
  ): SDKUserMessage {
    const content: Array<Record<string, unknown>> = [];

    // Add image blocks first so Claude sees them before the text
    if (images && images.length > 0) {
      for (const img of images) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.media_type,
            data: img.data,
          },
        });
      }
    }

    content.push({ type: "text", text });

    return {
      type: "user",
      session_id: sessionId,
      message: {
        role: "user",
        content,
      },
      parent_tool_use_id: null,
    } as unknown as SDKUserMessage;
  }

  // --- AsyncIterator protocol (consumed by SDK's streamInput for-await loop) ---

  [Symbol.asyncIterator](): PromptStream {
    if (this.started) {
      throw new Error("PromptStream can only be iterated once");
    }
    this.started = true;
    return this;
  }

  next(): Promise<IteratorResult<SDKUserMessage>> {
    this.nextSeq++;
    const seq = this.nextSeq;
    // Return queued message immediately if available
    if (this.queue.length > 0) {
      const msg = this.queue.shift()!;
      process.stderr.write(
        `[PromptStream] next() #${seq} → immediate (queueLen was ${this.queue.length + 1})\n`,
      );
      return Promise.resolve({ done: false, value: msg });
    }
    // Stream is finished
    if (this._isDone) {
      process.stderr.write(`[PromptStream] next() #${seq} → done (stream closed)\n`);
      return Promise.resolve({ done: true, value: undefined as unknown as SDKUserMessage });
    }
    // Block until next enqueue() or done()
    process.stderr.write(`[PromptStream] next() #${seq} → blocking (waiting for enqueue)...\n`);
    return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
      this.readResolve = resolve;
    });
  }

  return(): Promise<IteratorResult<SDKUserMessage>> {
    process.stderr.write(
      `[PromptStream] return() called — SDK broke out of streamInput loop. ` +
      `enqueueSeq=${this.enqueueSeq}, nextSeq=${this.nextSeq}\n`,
    );
    this._isDone = true;
    return Promise.resolve({ done: true, value: undefined as unknown as SDKUserMessage });
  }
}
