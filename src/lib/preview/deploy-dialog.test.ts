import { describe, expect, it, vi } from "vitest";
import {
  createDeployOperation,
  deployDialogReducer,
  initialDeployDialogState,
  type DeployOperationPorts,
  type DeployProgress,
  type DeployResult,
} from "./deploy";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const request = {
  projectPath: "/projects/demo",
  siteId: "demo-site",
  operationId: "operation-one",
};

const result: DeployResult = {
  url: "https://demo-site.preview.example.com/",
  siteId: "demo-site",
  operationId: "operation-one",
};

function progress(operationId: string, percent: number): DeployProgress {
  return {
    operationId,
    stage: "uploading",
    message: `Uploading ${percent}%`,
    percent,
  };
}

describe("createDeployOperation", () => {
  it("registers progress before invoke and filters events by operation ID", async () => {
    const order: string[] = [];
    const received: DeployProgress[] = [];
    let emitProgress: ((value: DeployProgress) => void) | null = null;
    const unlisten = vi.fn(() => order.push("unlisten"));
    const ports: DeployOperationPorts = {
      listenProgress: async (handler) => {
        order.push("listen");
        emitProgress = handler;
        return unlisten;
      },
      invokeDeploy: async (args) => {
        order.push("invoke");
        expect(args).toEqual(request);
        emitProgress?.(progress("another-operation", 20));
        emitProgress?.(progress(request.operationId, 40));
        return result;
      },
    };

    const operation = createDeployOperation(request, ports, (value) => received.push(value));
    const outcome = await operation.run();

    expect(outcome).toEqual({ status: "success", result });
    expect(received).toEqual([progress(request.operationId, 40)]);
    expect(order).toEqual(["listen", "invoke", "unlisten"]);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("unbinds immediately on project switch or unmount and suppresses a stale result", async () => {
    const invocation = deferred<DeployResult>();
    const unlisten = vi.fn();
    const invokeDeploy = vi.fn(() => invocation.promise);
    const ports: DeployOperationPorts = {
      listenProgress: async () => unlisten,
      invokeDeploy,
    };
    const operation = createDeployOperation(request, ports, vi.fn());
    const running = operation.run();

    await vi.waitFor(() => expect(invokeDeploy).toHaveBeenCalledOnce());
    operation.cancel();
    expect(unlisten).toHaveBeenCalledOnce();

    invocation.resolve(result);
    await expect(running).resolves.toEqual({ status: "cancelled" });
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("does not invoke after cancellation while listener registration is pending", async () => {
    const registration = deferred<() => void>();
    const unlisten = vi.fn();
    const invokeDeploy = vi.fn(async () => result);
    const ports: DeployOperationPorts = {
      listenProgress: () => registration.promise,
      invokeDeploy,
    };
    const operation = createDeployOperation(request, ports, vi.fn());
    const running = operation.run();

    operation.cancel();
    registration.resolve(unlisten);

    await expect(running).resolves.toEqual({ status: "cancelled" });
    expect(unlisten).toHaveBeenCalledOnce();
    expect(invokeDeploy).not.toHaveBeenCalled();
  });
});

describe("deployDialogReducer", () => {
  it("clears result presentation on reopen while preserving the reusable site ID", () => {
    const published = deployDialogReducer(initialDeployDialogState, {
      type: "succeeded",
      result,
      message: "Published",
    });
    const reopened = deployDialogReducer(published, { type: "opened" });

    expect(reopened.siteId).toBe(result.siteId);
    expect(reopened.result).toBeNull();
    expect(reopened.progress).toBeNull();
    expect(reopened.error).toBeNull();
  });

  it("resets site identity and presentation when the project changes", () => {
    const published = deployDialogReducer(initialDeployDialogState, {
      type: "succeeded",
      result,
      message: "Published",
    });

    expect(deployDialogReducer(published, { type: "project-changed" })).toEqual(
      initialDeployDialogState,
    );
  });
});
