import {
  appendFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readNewInboxMessages, type InboxMonitor } from "../teams-inbox.js";
import {
  activeSubagentWatchers,
  findSubagentFilePath,
  pollSubagentFile,
  startSubagentWatcher,
  stopAllSubagentWatchers,
} from "../teams-subagent-watcher.js";
import type { TeamsAgentConfig } from "../protocol.js";
import type { EmitFn } from "../shared.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

let sandbox = "";

function useProviderHome(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

function makeInboxMonitor(leaderInboxName: string | null = null): InboxMonitor {
  const timer = setInterval(() => {}, 60_000);
  timer.unref();
  return {
    timer,
    seenKeys: new Set(),
    leaderInboxName,
  };
}

function makeAgent(name = "worker"): TeamsAgentConfig {
  return {
    name,
    role: "reviewer",
    description: "Review",
    prompt: "Review the code",
  };
}

function createInbox(home: string, teamName = "team-safe", fileName = "leader.json"): string {
  const inboxDir = join(home, ".claude", "teams", teamName, "inboxes");
  mkdirSync(inboxDir, { recursive: true });
  return join(inboxDir, fileName);
}

function assistantLine(text: string): string {
  return `${JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  })}\n`;
}

function createSubagentFile(
  home: string,
  parentSessionId = "session-safe",
  agentId = "agent-safe",
): string {
  const filePath = join(
    home,
    ".claude",
    "projects",
    "project-safe",
    parentSessionId,
    "subagents",
    `agent-${agentId}.jsonl`,
  );
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, "");
  return filePath;
}

function createDirectoryLink(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "bytro-teams-readers-test-"));
  useProviderHome(join(sandbox, "home"));
  mkdirSync(process.env.HOME!, { recursive: true });
});

afterEach(() => {
  stopAllSubagentWatchers();
  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe.sequential("teams inbox provider reader boundary", () => {
  it("reads a bounded regular inbox once and rejects unsafe team components", () => {
    const inboxFile = createInbox(process.env.HOME!);
    writeFileSync(
      inboxFile,
      JSON.stringify([
        null,
        {
          from: "worker",
          text: "review complete",
          timestamp: "1",
        },
      ]),
    );
    const monitor = makeInboxMonitor();

    try {
      expect(readNewInboxMessages(monitor, "team-safe", [makeAgent()])).toMatchObject([
        { text: "review complete" },
      ]);
      expect([...monitor.seenKeys].every((key) => key.length === 64)).toBe(true);
      expect(readNewInboxMessages(monitor, "team-safe", [makeAgent()])).toEqual([]);
      expect(
        readNewInboxMessages(makeInboxMonitor("leader"), "../team-safe", [makeAgent()]),
      ).toEqual([]);
    } finally {
      clearInterval(monitor.timer);
    }
  });

  it("rejects oversized inbox files without reading them", () => {
    const inboxFile = createInbox(process.env.HOME!);
    writeFileSync(inboxFile, Buffer.alloc(1024 * 1024 + 1, 0x20));
    const monitor = makeInboxMonitor("leader");
    try {
      expect(readNewInboxMessages(monitor, "team-safe", [makeAgent()])).toEqual([]);
    } finally {
      clearInterval(monitor.timer);
    }
  });

  it("rejects linked provider root, intermediate team, and file leaves", () => {
    const rootLinkHome = join(sandbox, "root-link-home");
    const rootTarget = join(sandbox, "root-target");
    mkdirSync(rootLinkHome, { recursive: true });
    const rootTargetInbox = createInbox(rootTarget);
    writeFileSync(
      rootTargetInbox,
      JSON.stringify({ from: "worker", text: "root secret", timestamp: "1" }),
    );
    createDirectoryLink(join(rootTarget, ".claude"), join(rootLinkHome, ".claude"));
    useProviderHome(rootLinkHome);
    const rootMonitor = makeInboxMonitor("leader");
    expect(readNewInboxMessages(rootMonitor, "team-safe", [makeAgent()])).toEqual([]);
    clearInterval(rootMonitor.timer);

    const teamLinkHome = join(sandbox, "team-link-home");
    const externalTeam = join(sandbox, "external-team");
    mkdirSync(join(teamLinkHome, ".claude", "teams"), { recursive: true });
    mkdirSync(join(externalTeam, "inboxes"), { recursive: true });
    writeFileSync(
      join(externalTeam, "inboxes", "leader.json"),
      JSON.stringify({ from: "worker", text: "team secret", timestamp: "1" }),
    );
    createDirectoryLink(externalTeam, join(teamLinkHome, ".claude", "teams", "team-safe"));
    useProviderHome(teamLinkHome);
    const teamMonitor = makeInboxMonitor("leader");
    expect(readNewInboxMessages(teamMonitor, "team-safe", [makeAgent()])).toEqual([]);
    clearInterval(teamMonitor.timer);

    if (process.platform !== "win32") {
      const leafLinkHome = join(sandbox, "leaf-link-home");
      const otherInbox = createInbox(leafLinkHome, "team-other");
      writeFileSync(
        otherInbox,
        JSON.stringify({ from: "worker", text: "cross-team secret", timestamp: "1" }),
      );
      const currentInbox = createInbox(leafLinkHome, "team-safe");
      symlinkSync(otherInbox, currentInbox);
      useProviderHome(leafLinkHome);
      const leafMonitor = makeInboxMonitor("leader");
      expect(readNewInboxMessages(leafMonitor, "team-safe", [makeAgent()])).toEqual([]);
      clearInterval(leafMonitor.timer);

      const hardLinkHome = join(sandbox, "hard-link-home");
      const outsideInbox = join(sandbox, "outside-inbox.json");
      writeFileSync(
        outsideInbox,
        JSON.stringify({
          from: "worker",
          text: "hard-link secret",
          timestamp: "1",
        }),
      );
      linkSync(outsideInbox, createInbox(hardLinkHome));
      useProviderHome(hardLinkHome);
      const hardLinkMonitor = makeInboxMonitor("leader");
      expect(readNewInboxMessages(hardLinkMonitor, "team-safe", [makeAgent()])).toEqual([]);
      clearInterval(hardLinkMonitor.timer);
    }
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO inbox without blocking", () => {
    const inboxFile = createInbox(process.env.HOME!);
    execFileSync("mkfifo", [inboxFile]);
    const monitor = makeInboxMonitor("leader");
    const startedAt = Date.now();
    try {
      expect(readNewInboxMessages(monitor, "team-safe", [makeAgent()])).toEqual([]);
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      clearInterval(monitor.timer);
    }
  });
});

describe.sequential("teams subagent provider reader boundary", () => {
  it("streams growth once, coalesces concurrent polls, and resets after truncate", async () => {
    const agentId = "agent-safe";
    const filePath = createSubagentFile(process.env.HOME!, "session-safe", agentId);
    writeFileSync(filePath, assistantLine("a".repeat(1024)));

    expect(findSubagentFilePath("session-safe", agentId)).toBe(filePath);

    const events: Array<Record<string, unknown>> = [];
    const emit = ((event: Record<string, unknown>) => {
      events.push(event);
    }) as EmitFn;
    startSubagentWatcher(agentId, "worker", filePath, "request-safe", emit);
    const watcher = activeSubagentWatchers.get(agentId);
    expect(watcher).toBeDefined();
    clearInterval(watcher!.timer);

    await Promise.all([
      pollSubagentFile(agentId, "request-safe", emit),
      pollSubagentFile(agentId, "request-safe", emit),
    ]);
    expect(events.filter((event) => event.evt === "teams_agent_delta")).toHaveLength(1);

    appendFileSync(filePath, assistantLine("second"));
    await pollSubagentFile(agentId, "request-safe", emit);
    expect(events.filter((event) => event.evt === "teams_agent_delta")).toHaveLength(2);

    writeFileSync(filePath, assistantLine("reset"));
    await pollSubagentFile(agentId, "request-safe", emit);
    expect(
      events.filter((event) => event.evt === "teams_agent_delta").map((event) => event.delta),
    ).toEqual(["a".repeat(1024), "second", "reset"]);
  });

  it("drops an oversized residual line and resumes at the next JSONL line", async () => {
    const agentId = "agent-oversize";
    const filePath = createSubagentFile(process.env.HOME!, "session-oversize", agentId);
    writeFileSync(filePath, "x".repeat(1024 * 1024 + 128));

    const events: Array<Record<string, unknown>> = [];
    const emit = ((event: Record<string, unknown>) => {
      events.push(event);
    }) as EmitFn;
    startSubagentWatcher(agentId, "worker", filePath, "request-safe", emit);
    const watcher = activeSubagentWatchers.get(agentId);
    expect(watcher).toBeDefined();
    clearInterval(watcher!.timer);

    for (let i = 0; i < 5; i++) {
      await pollSubagentFile(agentId, "request-safe", emit);
    }
    appendFileSync(filePath, `\n${assistantLine("after oversize")}`);
    await pollSubagentFile(agentId, "request-safe", emit);

    expect(
      events.filter((event) => event.evt === "teams_agent_delta").map((event) => event.delta),
    ).toEqual(["after oversize"]);
  });

  it("rejects unsafe IDs and root, intermediate, and file links", () => {
    const safeHome = process.env.HOME!;
    const regularFile = createSubagentFile(safeHome);
    expect(findSubagentFilePath("../session-safe", "agent-safe")).toBeNull();
    expect(findSubagentFilePath("session-safe", "../agent-safe")).toBeNull();
    expect(regularFile).toContain("agent-agent-safe.jsonl");

    const rootLinkHome = join(sandbox, "subagent-root-link-home");
    const rootTarget = join(sandbox, "subagent-root-target");
    mkdirSync(rootLinkHome, { recursive: true });
    createSubagentFile(rootTarget);
    createDirectoryLink(join(rootTarget, ".claude"), join(rootLinkHome, ".claude"));
    useProviderHome(rootLinkHome);
    expect(findSubagentFilePath("session-safe", "agent-safe")).toBeNull();

    const intermediateHome = join(sandbox, "subagent-intermediate-home");
    const externalProject = join(sandbox, "external-project");
    mkdirSync(join(intermediateHome, ".claude", "projects"), { recursive: true });
    const externalFile = join(
      externalProject,
      "session-safe",
      "subagents",
      "agent-agent-safe.jsonl",
    );
    mkdirSync(join(externalFile, ".."), { recursive: true });
    writeFileSync(externalFile, assistantLine("secret"));
    createDirectoryLink(
      externalProject,
      join(intermediateHome, ".claude", "projects", "project-safe"),
    );
    useProviderHome(intermediateHome);
    expect(findSubagentFilePath("session-safe", "agent-safe")).toBeNull();

    if (process.platform !== "win32") {
      const leafLinkHome = join(sandbox, "subagent-leaf-link-home");
      const leafPath = createSubagentFile(leafLinkHome);
      const outsideFile = join(sandbox, "outside-subagent.jsonl");
      writeFileSync(outsideFile, assistantLine("outside secret"));
      rmSync(leafPath);
      symlinkSync(outsideFile, leafPath);
      useProviderHome(leafLinkHome);
      expect(findSubagentFilePath("session-safe", "agent-safe")).toBeNull();

      const hardLinkHome = join(sandbox, "subagent-hard-link-home");
      const hardLinkPath = createSubagentFile(hardLinkHome);
      const outsideHardLinkFile = join(sandbox, "outside-hard-link.jsonl");
      writeFileSync(outsideHardLinkFile, assistantLine("hard-link secret"));
      rmSync(hardLinkPath);
      linkSync(outsideHardLinkFile, hardLinkPath);
      useProviderHome(hardLinkHome);
      expect(findSubagentFilePath("session-safe", "agent-safe")).toBeNull();
    }
  });

  it("rejects a sparse oversized subagent file", () => {
    const agentId = "agent-large";
    const filePath = createSubagentFile(process.env.HOME!, "session-large", agentId);
    truncateSync(filePath, 256 * 1024 * 1024 + 1);
    expect(findSubagentFilePath("session-large", agentId)).toBeNull();

    const emit = (() => {}) as EmitFn;
    startSubagentWatcher(agentId, "worker", filePath, "request-safe", emit);
    expect(activeSubagentWatchers.has(agentId)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO subagent file without blocking", () => {
    const agentId = "agent-fifo";
    const filePath = createSubagentFile(process.env.HOME!, "session-fifo", agentId);
    rmSync(filePath);
    execFileSync("mkfifo", [filePath]);
    const startedAt = Date.now();
    expect(findSubagentFilePath("session-fifo", agentId)).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(500);

    startSubagentWatcher(agentId, "worker", filePath, "request-safe", (() => {}) as EmitFn);
    expect(activeSubagentWatchers.has(agentId)).toBe(false);
  });
});
