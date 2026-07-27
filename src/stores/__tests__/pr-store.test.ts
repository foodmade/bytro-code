import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { usePrStore, type PrDetail, type PrRepoInfo } from "@/stores/pr-store";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

const repoInfo: PrRepoInfo = {
  host: "github.com",
  owner: "acme",
  repo: "widgets",
  platform: "github",
  default_branch: "main",
  allow_merge_commit: true,
  allow_squash_merge: true,
  allow_rebase_merge: true,
  delete_branch_on_merge: false,
  html_url: "https://github.com/acme/widgets",
  warning: null,
};

const detail: PrDetail = {
  number: 7,
  title: "Add widgets",
  state: "open",
  is_draft: false,
  author: "octocat",
  head_branch: "feat/widgets",
  base_branch: "main",
  html_url: "https://github.com/acme/widgets/pull/7",
  updated_at: "2026-07-27T00:00:00Z",
  created_at: "2026-07-26T00:00:00Z",
  body: "",
  head_sha: "abc123",
  mergeable: true,
  mergeable_state: "clean",
  additions: 10,
  deletions: 2,
  changed_files: 3,
  commits: 1,
};

function resetStore() {
  usePrStore.setState({
    isModalOpen: false,
    repoInfo: null,
    repoError: null,
    prs: [],
    listState: "open",
    listError: null,
    selectedPr: null,
    checks: null,
    checksError: null,
    isLoadingChecks: false,
    pendingPrNumber: null,
    lastWorkspacePath: null,
    isDetecting: false,
    isLoadingList: false,
    isLoadingDetail: false,
    isCreating: false,
    isMerging: false,
  });
}

describe("usePrStore", () => {
  beforeEach(() => {
    resetStore();
    mockInvoke.mockReset();
  });

  it("detects a GitHub repo and loads open PRs", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "pr_detect_repo") return repoInfo;
      if (cmd === "pr_list") return [detail];
      throw new Error(`unexpected command: ${cmd}`);
    });

    await usePrStore.getState().detectRepo("/tmp/widgets");

    const state = usePrStore.getState();
    expect(state.repoInfo?.owner).toBe("acme");
    expect(state.prs).toHaveLength(1);
    expect(state.prs[0].number).toBe(7);
  });

  it("skips PR listing for unsupported platforms", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "pr_detect_repo") return { ...repoInfo, platform: "unsupported" };
      throw new Error(`unexpected command: ${cmd}`);
    });

    await usePrStore.getState().detectRepo("/tmp/widgets");

    expect(usePrStore.getState().repoInfo?.platform).toBe("unsupported");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("records a detection error instead of throwing", async () => {
    mockInvoke.mockRejectedValue(new Error("no network"));

    await usePrStore.getState().detectRepo("/tmp/widgets");

    const state = usePrStore.getState();
    expect(state.repoInfo).toBeNull();
    expect(state.repoError).toContain("no network");
  });

  it("loads detail and then refreshes checks for the selected PR", async () => {
    usePrStore.setState({ repoInfo });
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "pr_get_detail") return detail;
      if (cmd === "pr_get_checks") return { overall: "success", checks: [] };
      throw new Error(`unexpected command: ${cmd}`);
    });

    await usePrStore.getState().selectPr(7);
    // refreshChecks is fired without await; flush the microtask queue.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = usePrStore.getState();
    expect(state.selectedPr?.number).toBe(7);
    expect(state.checks?.overall).toBe("success");
  });

  it("discards stale checks when the selection changed mid-flight", async () => {
    usePrStore.setState({ repoInfo, selectedPr: detail });
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "pr_get_checks") {
        // Simulate the user switching PRs while the request is in flight.
        usePrStore.setState({ selectedPr: { ...detail, number: 8 } });
        return { overall: "failure", checks: [] };
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    await usePrStore.getState().refreshChecks();

    expect(usePrStore.getState().checks).toBeNull();
  });

  it("clears rows and shows loading when the filter changes", () => {
    usePrStore.setState({ repoInfo, prs: [detail], listError: "old error" });
    mockInvoke.mockReturnValue(new Promise(() => {})); // request never settles

    usePrStore.getState().setListState("closed");

    const state = usePrStore.getState();
    expect(state.listState).toBe("closed");
    expect(state.prs).toHaveLength(0);
    expect(state.listError).toBeNull();
    expect(state.isLoadingList).toBe(true);
  });

  it("discards a stale list response after the filter changed mid-flight", async () => {
    usePrStore.setState({ repoInfo });
    mockInvoke.mockImplementation(async (_cmd, args) => {
      const params = args as Record<string, unknown> | undefined;
      if (params?.state === "open") {
        // While the "open" request is in flight the user switches to "closed".
        usePrStore.setState({ listState: "closed" });
        return [detail];
      }
      return [];
    });

    await usePrStore.getState().loadPrs();

    const state = usePrStore.getState();
    expect(state.prs).toHaveLength(0);
    // The stale response must not clear the newer request's loading flag.
    expect(state.isLoadingList).toBe(true);
  });

  it("records a list error for the failure placeholder", async () => {
    usePrStore.setState({ repoInfo });
    mockInvoke.mockRejectedValue(new Error("rate limited"));

    await usePrStore.getState().loadPrs();

    const state = usePrStore.getState();
    expect(state.listError).toContain("rate limited");
    expect(state.isLoadingList).toBe(false);
  });

  it("marks the clicked row pending and drops superseded detail responses", async () => {
    usePrStore.setState({ repoInfo });
    mockInvoke.mockImplementation(async (cmd, args) => {
      const params = args as Record<string, unknown> | undefined;
      if (cmd === "pr_get_detail" && params?.number === 7) {
        // While #7 loads, the user clicks #8.
        expect(usePrStore.getState().pendingPrNumber).toBe(7);
        usePrStore.setState({ pendingPrNumber: 8 });
        return detail;
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    await usePrStore.getState().selectPr(7);

    const state = usePrStore.getState();
    expect(state.selectedPr).toBeNull();
    expect(state.pendingPrNumber).toBe(8);
  });

  it("tracks the in-flight checks request so the UI can show loading", () => {
    usePrStore.setState({ repoInfo, selectedPr: detail });
    mockInvoke.mockReturnValue(new Promise(() => {})); // request never settles

    void usePrStore.getState().refreshChecks();

    expect(usePrStore.getState().isLoadingChecks).toBe(true);
    expect(usePrStore.getState().checks).toBeNull();
  });

  it("records a checks error and keeps previously loaded checks", async () => {
    const previous = { overall: "success" as const, checks: [] };
    usePrStore.setState({ repoInfo, selectedPr: detail, checks: previous });
    mockInvoke.mockRejectedValue(new Error("rate limited"));

    await usePrStore.getState().refreshChecks();

    const state = usePrStore.getState();
    expect(state.checksError).toContain("rate limited");
    expect(state.checks).toBe(previous);
    expect(state.isLoadingChecks).toBe(false);
  });

  it("resets checks state when selecting another PR", async () => {
    usePrStore.setState({
      repoInfo,
      checks: { overall: "failure", checks: [] },
      checksError: "old error",
    });
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "pr_get_detail") return { ...detail, number: 8 };
      if (cmd === "pr_get_checks") return { overall: "success", checks: [] };
      throw new Error(`unexpected command: ${cmd}`);
    });

    await usePrStore.getState().selectPr(8);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = usePrStore.getState();
    expect(state.checksError).toBeNull();
    expect(state.checks?.overall).toBe("success");
  });

  it("requires a detected repo before creating a PR", async () => {
    await expect(
      usePrStore.getState().createPr({
        title: "x",
        body: "",
        head: "feat/x",
        base: "main",
        draft: false,
      }),
    ).rejects.toThrow("no repository detected");
  });
});
