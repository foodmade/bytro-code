// ---------------------------------------------------------------------------
// Inbox monitor — reads teammate messages from inbox files and injects
// actual content into PromptStream (bypasses non-functional CLI delivery)
// ---------------------------------------------------------------------------

import type { TeamsAgentConfig } from "./protocol.js";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { summarizeDiagnosticText } from "./shared.js";

export interface InboxMessage {
  readonly from: string;
  readonly text: string;
  readonly summary?: string;
  readonly timestamp: string;
  readonly message_type?: string;
}

export interface InboxMonitor {
  readonly timer: ReturnType<typeof setInterval>;
  readonly seenKeys: Set<string>;
  leaderInboxName: string | null;
}

/** Max entries kept in the seenKeys set to prevent unbounded growth. */
const MAX_SEEN_KEYS = 2000;
const MAX_INBOX_BYTES = 1024 * 1024;
const MAX_INBOX_ENTRIES = 4096;
const MAX_PATH_COMPONENT_BYTES = 255;

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

/**
 * Validate every provider-owned component below HOME without following links.
 * `lstat` rejects POSIX symlinks and Windows junction/symlink reparse points.
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

/**
 * Read a provider inbox through a bounded descriptor. The pre-open lstat
 * rejects links/FIFOs; O_NOFOLLOW/O_NONBLOCK close the leaf race on POSIX;
 * post-open identity and canonical containment checks cover intermediate
 * swaps and Windows junctions before any bytes are accepted.
 */
function readBoundedInboxFile(homeDir: string, inboxDir: string, fileName: string): string | null {
  if (!isSafePathComponent(fileName) || !fileName.endsWith(".json")) return null;
  if (!isSafeDirectoryChain(homeDir, inboxDir)) return null;

  const filePath = resolve(inboxDir, fileName);
  if (!isPathInside(resolve(inboxDir), filePath)) return null;

  let pathMetadata: Stats;
  try {
    pathMetadata = lstatSync(filePath);
  } catch {
    return null;
  }
  if (!isSafeRegularFile(pathMetadata, MAX_INBOX_BYTES)) {
    return null;
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const nonBlock = fsConstants.O_NONBLOCK ?? 0;
  let fd: number | undefined;
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | noFollow | nonBlock);
    const descriptorMetadata = fstatSync(fd);
    if (!isSafeRegularFile(descriptorMetadata, MAX_INBOX_BYTES)) {
      return null;
    }

    const canonicalInboxDir = realpathSync.native(inboxDir);
    const canonicalFile = realpathSync.native(filePath);
    const expectedCanonicalFile = resolve(canonicalInboxDir, fileName);
    if (!isSamePath(canonicalFile, expectedCanonicalFile)) return null;

    const canonicalMetadata = statSync(canonicalFile);
    if (
      !isSafeRegularFile(canonicalMetadata, MAX_INBOX_BYTES) ||
      !isSameFileIdentity(descriptorMetadata, canonicalMetadata)
    ) {
      return null;
    }

    const buffer = Buffer.alloc(descriptorMetadata.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (!isSafeRegularFile(fstatSync(fd), MAX_INBOX_BYTES)) return null;
    return buffer.toString("utf8", 0, offset);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort descriptor cleanup.
      }
    }
  }
}

function discoverInboxFiles(inboxDir: string): string[] {
  const files: string[] = [];
  const directory = opendirSync(inboxDir);
  try {
    for (let inspected = 0; inspected < MAX_INBOX_ENTRIES; inspected += 1) {
      const entry = directory.readSync();
      if (!entry) break;
      if (
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        isSafePathComponent(entry.name) &&
        entry.name.endsWith(".json")
      ) {
        files.push(entry.name);
      }
    }
  } finally {
    directory.closeSync();
  }
  return files;
}

function makeInboxMessageKey(msg: InboxMessage): string {
  return createHash("sha256")
    .update(JSON.stringify([msg.from, msg.timestamp, msg.text]))
    .digest("hex");
}

function isInboxMessage(value: unknown): value is InboxMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<Record<keyof InboxMessage, unknown>>;
  return (
    typeof candidate.from === "string" &&
    isSafePathComponent(candidate.from) &&
    typeof candidate.text === "string" &&
    candidate.text.length > 0 &&
    typeof candidate.timestamp === "string" &&
    (candidate.summary === undefined || typeof candidate.summary === "string") &&
    (candidate.message_type === undefined || typeof candidate.message_type === "string")
  );
}

/** Check if a message is an idle/system notification (should be skipped). */
function isIdleOrSystemMessage(msg: InboxMessage): boolean {
  if (msg.message_type === "idle" || msg.message_type === "idle_notification") return true;
  try {
    const parsed = JSON.parse(msg.text);
    if (parsed.type === "idle" || parsed.type === "idle_notification") return true;
  } catch {
    // Not JSON — direct message
  }
  return false;
}

/**
 * Read the leader's inbox file and return NEW messages not yet seen.
 * The leader's inbox is identified as the inbox file whose name does NOT
 * match any known teammate agent name (including dynamically spawned ones).
 */
export function readNewInboxMessages(
  monitor: InboxMonitor,
  teamName: string,
  agents: ReadonlyArray<TeamsAgentConfig>,
  dynamicAgentNames?: ReadonlySet<string>,
): InboxMessage[] {
  const homeDir = providerHomeDir();
  if (!homeDir || !isSafePathComponent(teamName)) return [];
  const inboxDir = join(homeDir, ".claude", "teams", teamName, "inboxes");
  // Merge initial agent names + dynamically discovered agent names
  const allAgentNames = new Set(agents.map((a) => a.name));
  if (dynamicAgentNames) {
    for (const name of dynamicAgentNames) {
      allAgentNames.add(name);
    }
  }

  try {
    if (!isSafeDirectoryChain(homeDir, inboxDir)) return [];

    // Discover leader's inbox name: any file NOT matching a teammate name
    if (!monitor.leaderInboxName) {
      const files = discoverInboxFiles(inboxDir);
      process.stderr.write(
        `[inbox-monitor] Discovery: files=${files.length}, ` +
          `knownAgents=${allAgentNames.size}\n`,
      );
      for (const f of files) {
        const name = f.replace(".json", "");
        if (!allAgentNames.has(name)) {
          monitor.leaderInboxName = name;
          process.stderr.write(
            `[inbox-monitor] ${summarizeDiagnosticText(name, "teams-inbox.leader")}\n`,
          );
          break;
        }
      }
    }

    if (!monitor.leaderInboxName || !isSafePathComponent(monitor.leaderInboxName)) {
      return [];
    }

    const content = readBoundedInboxFile(homeDir, inboxDir, `${monitor.leaderInboxName}.json`);
    if (content === null) return [];

    let messages: unknown[];
    try {
      const parsed = JSON.parse(content);
      messages = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // JSON.parse failed — try JSONL format (one JSON object per line)
      messages = [];
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          messages.push(obj);
        } catch {
          // skip unparseable lines
        }
      }
      if (messages.length === 0) {
        process.stderr.write(
          `[inbox-monitor] Could not parse inbox file (tried JSON + JSONL). ` +
            `${summarizeDiagnosticText(content, "teams-inbox.parse-failure")}\n`,
        );
        return [];
      }
      process.stderr.write(
        `[inbox-monitor] Parsed ${messages.length} message(s) using JSONL fallback\n`,
      );
    }

    const newMessages: InboxMessage[] = [];
    for (const value of messages) {
      if (!isInboxMessage(value)) continue;
      const msg = value;
      const key = makeInboxMessageKey(msg);
      if (monitor.seenKeys.has(key)) {
        continue;
      }
      monitor.seenKeys.add(key);

      // Prune oldest entries when the set exceeds the cap
      if (monitor.seenKeys.size > MAX_SEEN_KEYS) {
        const it = monitor.seenKeys.values();
        monitor.seenKeys.delete(it.next().value as string);
      }

      // Only include messages from known teammates (initial + dynamic)
      if (!allAgentNames.has(msg.from)) {
        process.stderr.write(
          `[inbox-monitor] ${summarizeDiagnosticText(
            String(msg.from),
            "teams-inbox.unknown-sender",
          )} knownAgents=${allAgentNames.size}\n`,
        );
        continue;
      }
      // Skip idle notifications (noise)
      if (isIdleOrSystemMessage(msg)) continue;

      newMessages.push(msg);
    }

    return newMessages;
  } catch (outerErr) {
    process.stderr.write(
      `[inbox-monitor] ${summarizeDiagnosticText(String(outerErr), "teams-inbox.read-error")}\n`,
    );
    return [];
  }
}

/** Format inbox messages for injection into the leader's PromptStream. */
export function formatInboxMessages(messages: ReadonlyArray<InboxMessage>): string {
  const parts = messages.map((msg) => {
    const summaryHint = msg.summary ? ` (summary: ${msg.summary})` : "";
    return (
      `--- Message from teammate "${msg.from}"${summaryHint} ---\n` +
      `${msg.text}\n` +
      `--- End of message from "${msg.from}" ---`
    );
  });
  return (
    `You have received ${messages.length} new message(s) from your teammates:\n\n` +
    parts.join("\n\n") +
    `\n\nPlease read and process these messages. Respond to teammates as needed using SendMessage.`
  );
}
