import { spawn, type ChildProcess } from "node:child_process";

export interface CliProcessInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly detached: boolean;
  readonly windowsVerbatimArguments: boolean;
}

// Equivalent to cross-spawn's battle-tested cmd.exe escaping. A `.cmd`/`.bat`
// launcher is parsed once by cmd.exe and then again by the batch shim, so
// argument metacharacters require two escaping passes.
const WINDOWS_CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function escapeWindowsCmdCommand(value: string): string {
  return value.replace(WINDOWS_CMD_META_CHARS, "^$1");
}

export function escapeWindowsCmdArgument(value: string): string {
  let escaped = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(WINDOWS_CMD_META_CHARS, "^$1");
  return escaped.replace(WINDOWS_CMD_META_CHARS, "^$1");
}

/**
 * Prepare a user-installed CLI for direct spawning.
 *
 * Windows npm launchers are `.cmd`/`.bat` files and cannot be executed with
 * `shell: false`. Escape the exact command line ahead of time and ask Node not
 * to quote it a second time.
 */
export function prepareCliProcessInvocation(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): CliProcessInvocation {
  if (
    platform !== "win32" ||
    !/\.(?:cmd|bat)$/i.test(executable)
  ) {
    return {
      executable,
      args: [...args],
      env,
      detached: platform !== "win32",
      windowsVerbatimArguments: false,
    };
  }

  const shellCommand = [
    escapeWindowsCmdCommand(executable),
    ...args.map(escapeWindowsCmdArgument),
  ].join(" ");

  return {
    executable: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    env,
    detached: false,
    windowsVerbatimArguments: true,
  };
}

export interface ProcessTreeTarget {
  readonly pid?: number;
  readonly startedAtMs?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Keep the original process-group/tree identity after the leader exits. */
export function captureProcessTree(
  child: ProcessTreeTarget,
): ProcessTreeTarget {
  const pid = child.pid;
  return {
    pid,
    startedAtMs: Date.now(),
    kill: (signal) => child.kill(signal),
  };
}

const WINDOWS_KILL_TREE_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$rootProcessId = [int]$args[0]",
  "$capturedAtMs = [int64]$args[1]",
  "$force = $args[2] -eq '1'",
  "$capturedAt = [DateTimeOffset]::FromUnixTimeMilliseconds($capturedAtMs).UtcDateTime",
  "$minimumCreatedAt = $capturedAt.AddSeconds(-10)",
  "$maximumRootCreatedAt = $capturedAt.AddSeconds(10)",
  "$all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate)",
  "function CreatedAtUtc($process) {",
  "  if ($null -eq $process.CreationDate) { return [DateTime]::MinValue }",
  "  if ($process.CreationDate -is [DateTime]) { return $process.CreationDate.ToUniversalTime() }",
  "  return [Management.ManagementDateTimeConverter]::ToDateTime([string]$process.CreationDate).ToUniversalTime()",
  "}",
  "$currentRoot = $all | Where-Object { [int]$_.ProcessId -eq $rootProcessId } | Select-Object -First 1",
  "if ($null -ne $currentRoot) {",
  "  $rootCreatedAt = CreatedAtUtc $currentRoot",
  "  if ($rootCreatedAt -lt $minimumCreatedAt -or $rootCreatedAt -gt $maximumRootCreatedAt) { exit 0 }",
  "}",
  "$childrenByParent = @{}",
  "foreach ($process in $all) {",
  "  if ((CreatedAtUtc $process) -lt $minimumCreatedAt) { continue }",
  "  $parentKey = [string][int]$process.ParentProcessId",
  "  if (-not $childrenByParent.ContainsKey($parentKey)) { $childrenByParent[$parentKey] = @() }",
  "  $childrenByParent[$parentKey] += [int]$process.ProcessId",
  "}",
  "$queue = [System.Collections.Generic.Queue[int]]::new()",
  "$queue.Enqueue($rootProcessId)",
  "$visited = [System.Collections.Generic.HashSet[int]]::new()",
  "$descendants = [System.Collections.Generic.List[int]]::new()",
  "while ($queue.Count -gt 0) {",
  "  $parentProcessId = $queue.Dequeue()",
  "  if (-not $childrenByParent.ContainsKey([string]$parentProcessId)) { continue }",
  "  foreach ($childProcessId in $childrenByParent[[string]$parentProcessId]) {",
  "    if ($childProcessId -eq $rootProcessId -or -not $visited.Add($childProcessId)) { continue }",
  "    $descendants.Add($childProcessId)",
  "    $queue.Enqueue($childProcessId)",
  "  }",
  "}",
  "for ($index = $descendants.Count - 1; $index -ge 0; $index--) {",
  "  Stop-Process -Id $descendants[$index] -Force:$force -ErrorAction SilentlyContinue",
  "}",
  "if ($null -ne $currentRoot) {",
  "  $taskkillArgs = @('/PID', [string]$rootProcessId, '/T')",
  "  if ($force) { $taskkillArgs += '/F' }",
  "  & taskkill.exe @taskkillArgs *> $null",
  "}",
].join("\n");

/**
 * Signal an entire CLI process tree.
 *
 * POSIX children are spawned as detached process-group leaders. On Windows,
 * taskkill follows the npm launcher to its app-server and MCP descendants.
 */
export function signalProcessTree(
  child: ProcessTreeTarget,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): void {
  if (child.pid === undefined) return;

  if (platform === "win32") {
    const startedAtMs = child.startedAtMs ?? Date.now();
    try {
      const killer: ChildProcess = spawn("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WINDOWS_KILL_TREE_SCRIPT,
        String(child.pid),
        String(startedAtMs),
        signal === "SIGKILL" ? "1" : "0",
      ], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5_000,
      });
      killer.once("error", () => {
        try {
          child.kill(signal);
        } catch {
          // The original process may already be gone.
        }
      });
      killer.unref();
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The original process may already be gone.
      }
    }
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * Reap descendants after the CLI leader exits or errors.
 *
 * A detached POSIX process group remains addressable by its original leader
 * PID after that leader is gone. On Windows, CIM supplies the retained
 * ParentProcessId graph; creation-time checks prevent acting on a reused PID.
 */
export function reapExitedProcessTree(
  target: ProcessTreeTarget,
  platform: NodeJS.Platform = process.platform,
  forceAfterMs = 1_500,
): void {
  if (target.pid === undefined) return;
  signalProcessTree(target, "SIGTERM", platform);
  const forceTimer = setTimeout(() => {
    signalProcessTree(target, "SIGKILL", platform);
  }, forceAfterMs);
  forceTimer.unref();
}
