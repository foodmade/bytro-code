// ---------------------------------------------------------------------------
// Subagent session file watcher — real-time streaming from JSONL files
//
// Claude Code stores subagent session files at:
//   ~/.claude/projects/<encoded-cwd>/<parent-session-id>/subagents/agent-<agent-id>.jsonl
//
// This watcher polls each subagent's JSONL file to extract real-time text
// deltas and tool operations, providing live updates for agent cards.
// ---------------------------------------------------------------------------

import {
  constants as fsConstants,
  lstatSync,
  opendirSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { summarizeDiagnosticText, truncate } from "./shared.js";
import type { EmitFn } from "./shared.js";

interface SubagentWatcher {
  readonly timer: ReturnType<typeof setInterval>;
  readonly name: string;
  readonly filePath: string;
  offset: number;
  buffer: string;
  decoder: StringDecoder;
  discardingOversizeLine: boolean;
  fileIdentity?: string;
  inFlight?: Promise<void>;
  stopped: boolean;
}

/** Active subagent file watchers keyed by agentId. */
export const activeSubagentWatchers = new Map<string, SubagentWatcher>();

const MAX_PATH_COMPONENT_BYTES = 255;
const MAX_PROJECT_DIRECTORIES = 4096;
const MAX_SUBAGENT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_SUBAGENT_READ_BYTES = 256 * 1024;
const MAX_SUBAGENT_LINE_BYTES = 1024 * 1024;

function providerHomeDir(): string | null {
  const value = process.env.USERPROFILE ?? process.env.HOME;
  return value?.trim() ? resolve(value) : null;
}

function isSafePathComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= MAX_PATH_COMPONENT_BYTES
  );
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isSamePath(left: string, right: string): boolean {
  return relative(left, right) === "" && relative(right, left) === "";
}

function isSameFileIdentity(left: Stats, right: Stats): boolean {
  if (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return (
    left.size === right.size &&
    left.birthtimeMs === right.birthtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function isSafeRegularFile(metadata: Stats, maxBytes: number): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1 &&
    metadata.size <= maxBytes
  );
}

function fileIdentity(metadata: Stats): string {
  return `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`;
}

/**
 * Validate every provider-owned directory below HOME with lstat so POSIX
 * symlinks and Windows junction/symlink reparse points are never traversed.
 */
function isSafeDirectoryChain(homeDir: string, directory: string): boolean {
  const resolvedHome = resolve(homeDir);
  const resolvedDirectory = resolve(directory);
  if (!isPathInside(resolvedHome, resolvedDirectory)) return false;

  const rel = relative(resolvedHome, resolvedDirectory);
  let current = resolvedHome;
  for (const component of rel.split(sep).filter(Boolean)) {
    if (!isSafePathComponent(component)) return false;
    current = join(current, component);
    let metadata: Stats;
    try {
      metadata = lstatSync(current);
    } catch {
      return false;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
  }

  try {
    const canonicalHome = realpathSync.native(resolvedHome);
    const canonicalDirectory = realpathSync.native(resolvedDirectory);
    const expectedCanonicalDirectory = resolve(canonicalHome, rel);
    return isSamePath(canonicalDirectory, expectedCanonicalDirectory);
  } catch {
    return false;
  }
}

interface ValidatedSubagentPath {
  readonly filePath: string;
  readonly projectsDir: string;
}

/**
 * Enforce the exact provider layout and reject every linked/non-regular
 * component before a watcher is registered or a descriptor is opened.
 */
function validateSubagentFilePath(
  candidate: string,
  agentId: string,
): ValidatedSubagentPath | null {
  const homeDir = providerHomeDir();
  if (!homeDir || !isSafePathComponent(agentId)) return null;

  const projectsDir = join(homeDir, ".claude", "projects");
  if (!isSafeDirectoryChain(homeDir, projectsDir)) return null;

  const filePath = resolve(candidate);
  if (!isPathInside(resolve(projectsDir), filePath)) return null;

  const parts = relative(resolve(projectsDir), filePath).split(sep).filter(Boolean);
  if (
    parts.length !== 4 ||
    parts[2] !== "subagents" ||
    !parts.every(isSafePathComponent) ||
    parts[3] !== `agent-${agentId}.jsonl`
  ) {
    return null;
  }

  const parentDir = dirname(filePath);
  if (!isSafeDirectoryChain(homeDir, parentDir)) return null;

  let pathMetadata: Stats;
  try {
    pathMetadata = lstatSync(filePath);
  } catch {
    return null;
  }
  if (!isSafeRegularFile(pathMetadata, MAX_SUBAGENT_FILE_BYTES)) {
    return null;
  }

  try {
    const canonicalProjects = realpathSync.native(projectsDir);
    const canonicalFile = realpathSync.native(filePath);
    const expectedCanonicalFile = resolve(
      canonicalProjects,
      relative(resolve(projectsDir), filePath),
    );
    if (!isSamePath(canonicalFile, expectedCanonicalFile)) return null;
    const canonicalMetadata = statSync(canonicalFile);
    if (
      !isSafeRegularFile(canonicalMetadata, MAX_SUBAGENT_FILE_BYTES) ||
      !isSameFileIdentity(pathMetadata, canonicalMetadata)
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return { filePath, projectsDir };
}

function discoverProjectDirectories(projectsDir: string): string[] {
  const names: string[] = [];
  const directory = opendirSync(projectsDir);
  try {
    for (let inspected = 0; inspected < MAX_PROJECT_DIRECTORIES; inspected += 1) {
      const entry = directory.readSync();
      if (!entry) break;
      if (entry.isDirectory() && !entry.isSymbolicLink() && isSafePathComponent(entry.name)) {
        names.push(entry.name);
      }
    }
  } finally {
    directory.closeSync();
  }
  return names;
}

/**
 * Scan ~/.claude/projects/ to find the directory containing the parent session.
 * Returns the full path to the subagent JSONL file, or null if not found.
 */
export function findSubagentFilePath(parentSessionId: string, agentId: string): string | null {
  const homeDir = providerHomeDir();
  if (!homeDir || !isSafePathComponent(parentSessionId) || !isSafePathComponent(agentId)) {
    return null;
  }
  const projectsDir = join(homeDir, ".claude", "projects");

  try {
    if (!isSafeDirectoryChain(homeDir, projectsDir)) {
      process.stderr.write(
        "[teams-handler] provider projects directory is unavailable or unsafe\n",
      );
      return null;
    }
    const dirs = discoverProjectDirectories(projectsDir);
    for (const projectName of dirs) {
      const sessionDir = join(projectsDir, projectName, parentSessionId);
      const subagentsDir = join(sessionDir, "subagents");
      if (!isSafeDirectoryChain(homeDir, subagentsDir)) continue;

      const filePath = join(subagentsDir, `agent-${agentId}.jsonl`);
      const validated = validateSubagentFilePath(filePath, agentId);
      if (validated) {
        process.stderr.write(
          `[teams-handler] ${summarizeDiagnosticText(
            `${parentSessionId}:${agentId}`,
            "teams.subagent_file_found",
          )}\n`,
        );
        return validated.filePath;
      }
    }
    process.stderr.write(
      `[teams-handler] Session dir not found. Scanned ${dirs.length} project dirs ` +
        `${summarizeDiagnosticText(parentSessionId, "teams.subagent_session_missing")}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[teams-handler] ${summarizeDiagnosticText(String(err), "teams.subagent_scan_error")}\n`,
    );
  }
  return null;
}

/**
 * Start polling a subagent's JSONL file for new entries.
 * Emits teams_agent_delta and teams_agent_tool_* events as new content appears.
 */
export function startSubagentWatcher(
  agentId: string,
  agentName: string,
  filePath: string,
  requestId: string,
  emit: EmitFn,
): void {
  if (activeSubagentWatchers.has(agentId)) return;

  const validated = validateSubagentFilePath(filePath, agentId);
  if (!validated) return;

  const watcher: SubagentWatcher = {
    timer: setInterval(() => {
      pollSubagentFile(agentId, requestId, emit).catch(() => {});
    }, 500),
    name: agentName,
    filePath: validated.filePath,
    offset: 0,
    buffer: "",
    decoder: new StringDecoder("utf8"),
    discardingOversizeLine: false,
    stopped: false,
  };
  activeSubagentWatchers.set(agentId, watcher);
  process.stderr.write(
    `[teams-handler] ${summarizeDiagnosticText(
      `${agentId}:${validated.filePath}`,
      "teams.subagent_watcher_started",
    )}\n`,
  );
}

/** Read new content from a subagent JSONL file and emit events. */
export async function pollSubagentFile(
  agentId: string,
  requestId: string,
  emit: EmitFn,
): Promise<void> {
  const watcher = activeSubagentWatchers.get(agentId);
  if (!watcher || watcher.stopped) return;

  if (watcher.inFlight) {
    await watcher.inFlight;
    return;
  }

  const inFlight = pollSubagentFileOnce(watcher, agentId, requestId, emit).finally(() => {
    if (watcher.inFlight === inFlight) watcher.inFlight = undefined;
  });
  watcher.inFlight = inFlight;
  await inFlight;
}

function resetWatcherCursor(watcher: SubagentWatcher): void {
  watcher.offset = 0;
  watcher.buffer = "";
  watcher.decoder = new StringDecoder("utf8");
  watcher.discardingOversizeLine = false;
}

function processSubagentChunk(
  watcher: SubagentWatcher,
  chunk: Buffer,
  requestId: string,
  emit: EmitFn,
): void {
  let text = watcher.decoder.write(chunk);

  if (watcher.discardingOversizeLine) {
    const newline = text.indexOf("\n");
    if (newline < 0) return;
    text = text.slice(newline + 1);
    watcher.discardingOversizeLine = false;
  }

  const lines = `${watcher.buffer}${text}`.split("\n");
  watcher.buffer = lines.pop() ?? "";

  if (Buffer.byteLength(watcher.buffer, "utf8") > MAX_SUBAGENT_LINE_BYTES) {
    watcher.buffer = "";
    watcher.decoder = new StringDecoder("utf8");
    watcher.discardingOversizeLine = true;
  }

  for (const line of lines) {
    if (!line.trim() || Buffer.byteLength(line, "utf8") > MAX_SUBAGENT_LINE_BYTES) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      processSubagentEntry(entry, watcher.name, requestId, emit);
    } catch {
      // Skip malformed JSON lines.
    }
  }
}

async function pollSubagentFileOnce(
  watcher: SubagentWatcher,
  agentId: string,
  requestId: string,
  emit: EmitFn,
): Promise<void> {
  if (watcher.stopped || activeSubagentWatchers.get(agentId) !== watcher) return;

  const validated = validateSubagentFilePath(watcher.filePath, agentId);
  if (!validated) return;

  let fh;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const nonBlock = fsConstants.O_NONBLOCK ?? 0;
    fh = await open(validated.filePath, fsConstants.O_RDONLY | noFollow | nonBlock);
    const descriptorMetadata = await fh.stat();
    if (!isSafeRegularFile(descriptorMetadata, MAX_SUBAGENT_FILE_BYTES)) {
      return;
    }

    const canonicalProjects = await realpath(validated.projectsDir);
    const canonicalFile = await realpath(validated.filePath);
    const expectedCanonicalFile = resolve(
      canonicalProjects,
      relative(resolve(validated.projectsDir), validated.filePath),
    );
    if (!isSamePath(canonicalFile, expectedCanonicalFile)) return;

    const canonicalMetadata = await stat(canonicalFile);
    if (
      !isSafeRegularFile(canonicalMetadata, MAX_SUBAGENT_FILE_BYTES) ||
      !isSameFileIdentity(descriptorMetadata, canonicalMetadata)
    ) {
      return;
    }

    const identity = fileIdentity(descriptorMetadata);
    if (watcher.fileIdentity && watcher.fileIdentity !== identity) {
      resetWatcherCursor(watcher);
    }
    watcher.fileIdentity = identity;

    if (descriptorMetadata.size < watcher.offset) {
      resetWatcherCursor(watcher);
      watcher.fileIdentity = identity;
    }
    if (descriptorMetadata.size <= watcher.offset) return;

    const readSize = Math.min(descriptorMetadata.size - watcher.offset, MAX_SUBAGENT_READ_BYTES);
    const buf = Buffer.alloc(readSize);
    const { bytesRead } = await fh.read(buf, 0, readSize, watcher.offset);
    watcher.offset += bytesRead;

    const afterReadMetadata = await fh.stat();
    if (
      !isSafeRegularFile(afterReadMetadata, MAX_SUBAGENT_FILE_BYTES) ||
      !isSameFileIdentity(descriptorMetadata, afterReadMetadata) ||
      watcher.stopped ||
      activeSubagentWatchers.get(agentId) !== watcher
    ) {
      return;
    }
    processSubagentChunk(watcher, buf.subarray(0, bytesRead), requestId, emit);
  } catch {
    // File might not exist yet — normal during agent startup
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** Process a single JSONL entry from a subagent session file. */
function processSubagentEntry(
  entry: Record<string, unknown>,
  agentName: string,
  requestId: string,
  emit: EmitFn,
): void {
  const entryType = entry.type as string;

  if (entryType === "assistant") {
    const message = entry.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text) {
        emit({ evt: "teams_agent_delta", id: requestId, agentName, delta: b.text });
      }
      if (b.type === "tool_use") {
        emit({
          evt: "teams_agent_tool_start",
          id: requestId,
          agentName,
          toolCallId: (b.id as string) ?? "",
          toolName: (b.name as string) ?? "",
          toolInput: JSON.stringify(b.input ?? {}),
        });
      }
    }
  }

  if (entryType === "user") {
    const message = entry.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "tool_result") {
        const resultContent =
          typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        emit({
          evt: "teams_agent_tool_result",
          id: requestId,
          agentName,
          toolCallId: (b.tool_use_id as string) ?? "",
          toolName: "",
          toolInput: "",
          success: !b.is_error,
          result: truncate(resultContent),
          display: {
            status: !b.is_error ? "success" : "error",
            severity: !b.is_error ? "info" : "error",
          },
        });
      }
    }
  }
}

/** Stop polling a subagent's JSONL file. */
export function stopSubagentWatcher(agentId: string): void {
  const watcher = activeSubagentWatchers.get(agentId);
  if (watcher) {
    watcher.stopped = true;
    clearInterval(watcher.timer);
    activeSubagentWatchers.delete(agentId);
    process.stderr.write(
      `[teams-handler] ${summarizeDiagnosticText(
        `${agentId}:${watcher.name}`,
        "teams.subagent_watcher_stopped",
      )}\n`,
    );
  }
}

/** Stop all active subagent watchers (cleanup on session end). */
export function stopAllSubagentWatchers(): void {
  for (const [agentId] of activeSubagentWatchers) {
    stopSubagentWatcher(agentId);
  }
}
