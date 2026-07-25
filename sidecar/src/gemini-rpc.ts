/**
 * gemini-rpc.ts — JSON-RPC over stdio channel for Gemini CLI ACP mode
 *
 * Spawns `node <gemini-cli-path> --acp` as a child process and communicates
 * via JSON-RPC 2.0 over stdin/stdout (NDJSON).
 *
 * Message classification (same as Codex RPC):
 * - Has `id` + no `method` → Response to a client request
 * - Has `id` + has `method` → Server-initiated request (e.g. permission)
 * - No `id` + has `method` → Server notification (e.g. session/update)
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import { createLogger } from "./shared.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback for server-emitted notifications (no id). */
export type NotificationListener = (
  method: string,
  params: Record<string, unknown>,
) => void;

/** Callback for server-initiated requests (has id + method). */
export type ServerRequestListener = (
  id: number,
  method: string,
  params: Record<string, unknown>,
) => void;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly sentAt: number;
  readonly method: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

const log = createLogger("gemini-rpc");

// ---------------------------------------------------------------------------
// GeminiRpcChannel
// ---------------------------------------------------------------------------

export class GeminiRpcChannel {
  private readonly _process: ChildProcess;
  private readonly _readline: ReadlineInterface;
  private _nextId = 1;
  private readonly _pending = new Map<number, PendingRequest>();
  private readonly _notificationListeners = new Set<NotificationListener>();
  private readonly _serverRequestListeners = new Set<ServerRequestListener>();
  private _closed = false;
  private _exitCode: number | null = null;
  private _exitPromise: Promise<number>;
  private _exitResolve!: (code: number) => void;
  private readonly _spawnedAt = Date.now();
  private _firstStdoutLineReceived = false;

  constructor(
    nodePath: string,
    cliEntryPath: string,
    env: Record<string, string>,
    cwd: string,
  ) {
    this._exitPromise = new Promise<number>((resolve) => {
      this._exitResolve = resolve;
    });

    const args = [cliEntryPath, "--acp"];
    log(`Spawning: ${nodePath} ${args.join(" ")} (cwd=${cwd})`);

    this._process = spawn(nodePath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd,
      windowsHide: true,
    });

    const pid = this._process.pid;
    log(`[spawn-result] pid=${pid ?? "undefined"} stdin=${!!this._process.stdin} stdout=${!!this._process.stdout}`);

    // Relay stderr for debugging
    if (this._process.stderr) {
      this._process.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8").trimEnd();
        if (text) log(`[stderr] ${text}`);
      });
    }

    // Parse stdout line-by-line as NDJSON
    this._readline = createInterface({
      input: this._process.stdout!,
      crlfDelay: Infinity,
    });
    this._readline.on("line", (line: string) => {
      if (!this._firstStdoutLineReceived) {
        this._firstStdoutLineReceived = true;
        log(`[stdout] first line received after ${Date.now() - this._spawnedAt}ms since spawn`);
      }
      this._handleLine(line);
    });

    // Process lifecycle
    this._process.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      log(`[process-error] code=${e.code ?? "unknown"} message=${e.message}`);
      this._handleProcessExit(-1);
    });
    this._process.on("exit", (code, signal) => {
      const uptime = Date.now() - this._spawnedAt;
      log(`[process-exit] code=${code} signal=${signal ?? "none"} uptime=${uptime}ms pendingCount=${this._pending.size}`);
      this._handleProcessExit(code ?? -1);
    });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Send a JSON-RPC request and wait for the matching response. */
  async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this._closed || !this.alive) {
      throw new Error(`RPC channel closed, cannot send "${method}"`);
    }

    const id = this._nextId++;
    const msg: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) msg.params = params;

    return new Promise<unknown>((resolve, reject) => {
      const sentAt = Date.now();
      const timer = setTimeout(() => {
        this._pending.delete(id);
        const diagMsg = `RPC request "${method}" timed out after ${timeoutMs}ms (pid=${this._process.pid}, alive=${this.alive}, exitCode=${this._exitCode})`;
        log(`[timeout] ${diagMsg}`);
        reject(new Error(diagMsg));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timer, sentAt, method });
      this._writeLine(msg);
    });
  }

  /** Send a JSON-RPC notification (fire-and-forget, no id). */
  notify(method: string, params?: Record<string, unknown>): void {
    if (this._closed || !this.alive) return;
    const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    this._writeLine(msg);
  }

  /** Reply to a server-initiated request (e.g. permission decision). */
  respond(id: number, result: unknown): void {
    if (this._closed || !this.alive) return;
    this._writeLine({ jsonrpc: "2.0", id, result });
  }

  /** Reply with an error to a server-initiated request. */
  respondError(id: number, code: number, message: string): void {
    if (this._closed || !this.alive) return;
    this._writeLine({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /** Register a notification listener. Returns unsubscribe function. */
  onNotification(listener: NotificationListener): () => void {
    this._notificationListeners.add(listener);
    return () => this._notificationListeners.delete(listener);
  }

  /** Register a server-request listener. Returns unsubscribe function. */
  onServerRequest(listener: ServerRequestListener): () => void {
    this._serverRequestListeners.add(listener);
    return () => this._serverRequestListeners.delete(listener);
  }

  /** Whether the underlying process is still running. */
  get alive(): boolean {
    return this._exitCode === null && !this._closed;
  }

  /** Gracefully close the channel and terminate the process. */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    try {
      this._process.stdin?.end();
    } catch {
      // ignore
    }

    // Give the process a short window to exit gracefully, then SIGTERM
    const killTimer = setTimeout(() => {
      try { this._process.kill("SIGTERM"); } catch { /* ignore */ }
    }, 3_000);

    // Force kill if SIGTERM doesn't work within 8s
    const forceKillTimer = setTimeout(() => {
      try { this._process.kill("SIGKILL"); } catch { /* ignore */ }
    }, 8_000);

    await Promise.race([
      this._exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);

    clearTimeout(killTimer);
    clearTimeout(forceKillTimer);

    this._readline.close();
    this._rejectAllPending("RPC channel closed");
  }

  /** Wait for the child process to exit. Returns exit code. */
  waitForExit(): Promise<number> {
    return this._exitPromise;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private _writeLine(msg: Record<string, unknown>): void {
    try {
      this._process.stdin!.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      log(`[write-error] method=${(msg.method as string) ?? "response"} error=${err}`);
    }
  }

  private _handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      log(`Invalid JSON line: ${trimmed.slice(0, 200)}`);
      return;
    }

    const hasId = typeof msg.id === "number";
    const hasMethod = typeof msg.method === "string";

    if (hasId && !hasMethod) {
      this._handleResponse(msg);
    } else if (hasId && hasMethod) {
      this._handleServerRequest(msg);
    } else if (!hasId && hasMethod) {
      this._handleNotification(msg);
    } else {
      log(`Unclassified message: ${trimmed.slice(0, 200)}`);
    }
  }

  private _handleResponse(msg: Record<string, unknown>): void {
    const id = msg.id as number;
    const pending = this._pending.get(id);
    if (!pending) {
      log(`No pending request for response id=${id}`);
      return;
    }
    this._pending.delete(id);
    clearTimeout(pending.timer);

    const elapsed = Date.now() - pending.sentAt;
    if (pending.method === "initialize" || pending.method === "session/new") {
      log(`[response] method=${pending.method} id=${id} elapsed=${elapsed}ms hasError=${!!msg.error}`);
    }

    if (msg.error) {
      const err = msg.error as { code?: number; message?: string };
      pending.reject(
        new Error(`RPC error ${err.code ?? -1}: ${err.message ?? "unknown"}`),
      );
    } else {
      pending.resolve(msg.result);
    }
  }

  private _handleNotification(msg: Record<string, unknown>): void {
    const method = msg.method as string;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    for (const listener of this._notificationListeners) {
      try {
        listener(method, params);
      } catch (err) {
        log(`Notification listener error for "${method}": ${err}`);
      }
    }
  }

  private _handleServerRequest(msg: Record<string, unknown>): void {
    const id = msg.id as number;
    const method = msg.method as string;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    log(`[server-request] id=${id} method=${method}`);
    for (const listener of this._serverRequestListeners) {
      try {
        listener(id, method, params);
      } catch (err) {
        log(`Server request listener error for "${method}": ${err}`);
      }
    }
  }

  private _handleProcessExit(code: number): void {
    if (this._exitCode !== null) return;
    this._exitCode = code;
    this._exitResolve(code);
    this._rejectAllPending(`Gemini ACP process exited with code ${code}`);
  }

  private _rejectAllPending(reason: string): void {
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this._pending.clear();
  }
}
