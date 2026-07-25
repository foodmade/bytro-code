import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { CodexRpcChannel } from "../codex-rpc.js";

class FakeChildProcess extends EventEmitter {
  readonly pid = 4242;
  exitCode: number | null = null;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);

  exit(code = 0): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

describe("Codex RPC process lifecycle", () => {
  let child: FakeChildProcess;
  let processKill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    child = new FakeChildProcess();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
    processKill = vi.spyOn(process, "kill").mockReturnValue(true);
  });

  afterEach(() => {
    processKill.mockRestore();
    vi.useRealTimers();
  });

  it("returns one close promise and closes idempotently", async () => {
    const cleanup = vi.fn();
    const rpc = new CodexRpcChannel(
      "codex",
      ["app-server"],
      {},
      cleanup,
    );

    const first = rpc.close();
    const second = rpc.close();
    expect(second).toBe(first);

    child.exit();
    await first;
    expect(rpc.close()).toBe(first);
    expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("reaps the saved process group when the leader exits", async () => {
    const rpc = new CodexRpcChannel("codex", ["app-server"], {});
    child.exit();

    await rpc.close();

    expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("escalates from process-group termination to force kill on timeout", async () => {
    vi.useFakeTimers();
    const rpc = new CodexRpcChannel("codex", ["app-server"], {});

    const closing = rpc.close();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGTERM");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGKILL");

    await vi.advanceTimersByTimeAsync(2_000);
    await closing;
    expect(processKill).toHaveBeenCalledTimes(2);
  });
});
