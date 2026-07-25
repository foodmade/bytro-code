/**
 * codex-rpc.ts — JSON-RPC over stdio channel for Codex App Server
 *
 * Spawns `codex app-server` as a child process and communicates via
 * JSON-RPC 2.0 over stdin/stdout (JSONL).
 *
 * Message classification:
 * - Has `id` + no `method` → Response to a client request
 * - Has `id` + has `method` → Server-initiated request (e.g. approval)
 * - No `id` + has `method` → Server notification (e.g. turn/started)
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import { createLogger, summarizeDiagnosticText } from "./shared.js";
import {
  captureProcessTree,
  prepareCliProcessInvocation,
  reapExitedProcessTree,
  signalProcessTree,
  type ProcessTreeTarget,
} from "./cli-process.js";

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

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RPC_TRACE_LIMIT = 200;
const RPC_IMPORTANT_TRACE_LIMIT = 500;
const RPC_TRACE_PREVIEW_LIMIT = 4_000;
const RPC_IMPORTANT_TRACE_PREVIEW_LIMIT = 2_000;

const log = createLogger("codex-rpc");

export function summarizeRpcTraceBody(
  msg: Record<string, unknown>,
): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(msg);
  } catch {
    serialized = String(msg);
  }
  return summarizeDiagnosticText(serialized, "rpc.body");
}

interface RpcTraceEntry {
  readonly ts: string;
  readonly direction: "in" | "out";
  readonly kind: "request" | "response" | "notification" | "server_request" | "unclassified";
  readonly id?: number;
  readonly method?: string;
  readonly preview: string;
}

// ---------------------------------------------------------------------------
// CodexRpcChannel
// ---------------------------------------------------------------------------

export class CodexRpcChannel {
  private readonly _process: ChildProcess;
  private readonly _processTree: ProcessTreeTarget;
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
  private readonly _trace: RpcTraceEntry[] = [];
  private readonly _importantTrace: RpcTraceEntry[] = [];
  private _closePromise: Promise<void> | undefined;
  private _cleanupComplete = false;

  constructor(
    codexBinaryPath: string,
    args: readonly string[],
    env: Record<string, string>,
    private readonly _onProcessClosed?: () => void,
  ) {
    this._exitPromise = new Promise<number>((resolve) => {
      this._exitResolve = resolve;
    });

    log(`Spawning: ${codexBinaryPath} ${args.join(" ")}`);
    log(`[spawn-diag] platform=${process.platform} arch=${process.arch} nodeVersion=${process.version}`);
    log(`[spawn-diag] env.HOME=${env.HOME ?? "(unset)"} env.USERPROFILE=${env.USERPROFILE ?? "(unset)"}`);

    const invocation = prepareCliProcessInvocation(
      codexBinaryPath,
      args,
      env,
    );
    this._process = spawn(invocation.executable, [...invocation.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: invocation.env,
      detached: invocation.detached,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    this._processTree = captureProcessTree(this._process);

    const pid = this._process.pid;
    log(`[spawn-result] pid=${pid ?? "undefined"} stdin=${!!this._process.stdin} stdout=${!!this._process.stdout} stderr=${!!this._process.stderr}`);
    if (pid === undefined) {
      log(`[spawn-result] WARNING: pid is undefined — process may have failed to start`);
    }

    // Relay stderr for debugging
    if (this._process.stderr) {
      this._process.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8").trimEnd();
        if (text) log(`[stderr] ${text}`);
      });
    }

    // Parse stdout line-by-line as JSONL
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
      log(`[process-error] code=${e.code ?? "unknown"} message=${e.message} stack=${e.stack ?? "none"}`);
      this._handleProcessExit(-1);
    });
    this._process.on("exit", (code, signal) => {
      const uptime = Date.now() - this._spawnedAt;
      const pendingMethods = [...this._pending.values()].map(p => p.method).join(",");
      log(`[process-exit] code=${code} signal=${signal ?? "none"} uptime=${uptime}ms pendingCount=${this._pending.size} pendingMethods=[${pendingMethods}]`);
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
    const msg: Record<string, unknown> = { id, method };
    if (params !== undefined) msg.params = params;

    return new Promise<unknown>((resolve, reject) => {
      const sentAt = Date.now();
      const timer = setTimeout(() => {
        this._pending.delete(id);
        const uptime = Date.now() - this._spawnedAt;
        const pendingMethods = [...this._pending.values()].map(p => p.method).join(",");
        const diagMsg = `RPC request "${method}" timed out after ${timeoutMs}ms (pid=${this._process.pid}, alive=${this.alive}, exitCode=${this._exitCode}, firstStdout=${this._firstStdoutLineReceived}, uptime=${uptime}ms, pendingCount=${this._pending.size}, pendingMethods=[${pendingMethods}])`;
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
    const msg: Record<string, unknown> = { method };
    if (params !== undefined) msg.params = params;
    this._writeLine(msg);
  }

  /** Reply to a server-initiated request (e.g. approval decision). */
  respond(id: number, result: unknown): void {
    if (this._closed || !this.alive) return;
    this._writeLine({ id, result });
  }

  /** Reply with an error to a server-initiated request. */
  respondError(id: number, code: number, message: string): void {
    if (this._closed || !this.alive) return;
    this._writeLine({ id, error: { code, message } });
  }

  /** 把最近的 JSON-RPC 收发轨迹写入 sidecar 调试日志。 */
  dumpRecentTrace(reason: string, limit: number = 80): void {
    const lines = this.getRecentTraceLines(limit);
    log(`[rpc-trace] ===== ${reason} recent ${lines.length}/${this._trace.length} messages =====`);
    for (const line of lines) log(`[rpc-trace] ${line}`);
    log(`[rpc-trace] ===== end ${reason} =====`);
  }

  /** 返回最近的 JSON-RPC 轨迹文本行，用于直接显示在聊天会话中。 */
  getRecentTraceLines(limit: number = 80): string[] {
    return this._trace.slice(-limit).map((entry) => this._formatTraceEntry(entry));
  }

  /** 把不会被 outputDelta 刷掉的关键 JSON-RPC 轨迹写入 sidecar 调试日志。 */
  dumpImportantTrace(reason: string, limit: number = 160): void {
    const lines = this.getImportantTraceLines(limit);
    log(`[rpc-important-trace] ===== ${reason} important ${lines.length}/${this._importantTrace.length} messages =====`);
    for (const line of lines) log(`[rpc-important-trace] ${line}`);
    log(`[rpc-important-trace] ===== end ${reason} =====`);
  }

  /** 返回关键 JSON-RPC 轨迹文本行，用于直接显示在聊天会话中。 */
  getImportantTraceLines(limit: number = 160): string[] {
    return this._importantTrace.slice(-limit).map((entry) => this._formatTraceEntry(entry));
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
  close(): Promise<void> {
    if (!this._closePromise) {
      this._closePromise = this._close();
    }
    return this._closePromise;
  }

  private async _close(): Promise<void> {
    this._closed = true;

    // Close stdin to signal the child process
    try {
      this._process.stdin?.end();
    } catch {
      // ignore
    }

    // Give the process a short window to exit gracefully, then SIGTERM
    const killTimer = setTimeout(() => {
      try {
        signalProcessTree(this._processTree, "SIGTERM");
      } catch {
        // ignore
      }
    }, 3_000);

    // Force kill if SIGTERM doesn't work within 8s
    const forceKillTimer = setTimeout(() => {
      try {
        signalProcessTree(this._processTree, "SIGKILL");
      } catch {
        // ignore
      }
    }, 8_000);

    // Don't block forever — race with a hard timeout
    await Promise.race([
      this._exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);

    clearTimeout(killTimer);
    clearTimeout(forceKillTimer);

    this._readline.close();
    this._rejectAllPending("RPC channel closed");
    this._runProcessCleanup();
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
      this._recordTrace("out", this._classifyOutgoing(msg), msg);
      this._process.stdin!.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      log(`[write-error] method=${msg.method ?? "response"} error=${err}`);
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
      // Response to a client request
      this._handleResponse(msg);
    } else if (hasId && hasMethod) {
      // 服务端主动请求，例如权限确认。
      this._recordTrace("in", "server_request", msg);
      this._handleServerRequest(msg);
    } else if (!hasId && hasMethod) {
      // 服务端通知。
      this._recordTrace("in", "notification", msg);
      this._handleNotification(msg);
    } else {
      this._recordTrace("in", "unclassified", msg);
      log(`Unclassified message: ${trimmed.slice(0, 200)}`);
    }
  }

  private _classifyOutgoing(msg: Record<string, unknown>): RpcTraceEntry["kind"] {
    if (typeof msg.id === "number" && typeof msg.method === "string") return "request";
    if (typeof msg.id === "number" && typeof msg.method !== "string") return "response";
    if (typeof msg.method === "string") return "notification";
    return "unclassified";
  }

  private _recordTrace(
    direction: RpcTraceEntry["direction"],
    kind: RpcTraceEntry["kind"],
    msg: Record<string, unknown>,
    methodOverride?: string,
  ): void {
    const entry: RpcTraceEntry = {
      ts: new Date().toISOString(),
      direction,
      kind,
      id: typeof msg.id === "number" ? msg.id : undefined,
      method: methodOverride ?? (typeof msg.method === "string" ? msg.method : undefined),
      preview: this._renderTracePreview(msg, RPC_TRACE_PREVIEW_LIMIT),
    };

    this._trace.push(entry);
    if (this._trace.length > RPC_TRACE_LIMIT) {
      this._trace.splice(0, this._trace.length - RPC_TRACE_LIMIT);
    }

    if (this._isImportantTraceEntry(entry)) {
      this._importantTrace.push({
        ...entry,
        preview: this._renderTracePreview(msg, RPC_IMPORTANT_TRACE_PREVIEW_LIMIT),
      });
      if (this._importantTrace.length > RPC_IMPORTANT_TRACE_LIMIT) {
        this._importantTrace.splice(0, this._importantTrace.length - RPC_IMPORTANT_TRACE_LIMIT);
      }
    }
  }

  private _renderTracePreview(
    msg: Record<string, unknown>,
    _limit: number,
  ): string {
    return summarizeRpcTraceBody(msg);
  }

  private _isImportantTraceEntry(entry: RpcTraceEntry): boolean {
    const method = entry.method ?? "";
    if (entry.kind === "server_request" || entry.kind === "response") return true;
    if (entry.direction === "out" && entry.kind === "request") {
      return method.startsWith("turn/")
        || method.startsWith("thread/")
        || method === "initialize";
    }
    if (entry.direction !== "in" || entry.kind !== "notification") return false;
    if (method === "error") return true;
    if (method === "thread/status/changed") return true;
    if (method.startsWith("turn/") && !method.endsWith("/delta")) return true;
    return method === "item/started"
      || method === "item/completed"
      || method === "item/commandExecution/terminalInteraction";
  }

  private _formatTraceEntry(entry: RpcTraceEntry): string {
    return `${entry.ts} ${entry.direction} ${entry.kind} id=${entry.id ?? "none"} method=${entry.method ?? "none"} ${entry.preview}`;
  }

  private _handleResponse(msg: Record<string, unknown>): void {
    const id = msg.id as number;
    const pending = this._pending.get(id);
    this._recordTrace("in", "response", msg, pending?.method);
    if (!pending) {
      log(`No pending request for response id=${id}`);
      return;
    }
    this._pending.delete(id);
    clearTimeout(pending.timer);

    const elapsed = Date.now() - pending.sentAt;
    if (pending.method === "initialize" || pending.method === "thread/start") {
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
    log(`[server-request-rpc] id=${id} method=${method} listenerCount=${this._serverRequestListeners.size}`);
    for (const listener of this._serverRequestListeners) {
      try {
        listener(id, method, params);
      } catch (err) {
        log(`Server request listener error for "${method}": ${err}`);
      }
    }
  }

  private _handleProcessExit(code: number): void {
    if (this._exitCode !== null) return; // already handled
    this._exitCode = code;
    reapExitedProcessTree(this._processTree);
    this._exitResolve(code);
    this._rejectAllPending(`App Server process exited with code ${code}`);
    this._runProcessCleanup();
  }

  private _runProcessCleanup(): void {
    if (this._cleanupComplete) return;
    this._cleanupComplete = true;
    try {
      this._onProcessClosed?.();
    } catch (error) {
      log(
        `[cleanup-error] ${summarizeDiagnosticText(String(error), "codex.cleanup")}`,
      );
    }
  }

  private _rejectAllPending(reason: string): void {
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this._pending.clear();
  }
}
