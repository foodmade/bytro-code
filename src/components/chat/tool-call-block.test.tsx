import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ToolCall } from "@/stores/chat-store";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeImage: vi.fn(),
}));

vi.mock("@tauri-apps/api/image", () => ({
  Image: {
    fromPath: vi.fn(),
  },
}));

import { ToolCallList } from "./tool-call-block";

function makeCall(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: "call-1",
    toolName: "Write",
    toolInput: JSON.stringify({
      file_path: "src/example.ts",
      content: "export const value = 1;\n",
    }),
    status: "success",
    result: "Created src/example.ts",
    ...overrides,
  };
}

describe("ToolCallList", () => {
  it("keeps a single file write collapsed with diff facts on the row", () => {
    const html = renderToStaticMarkup(
      <ToolCallList toolCalls={[makeCall({})]} />,
    );

    // Collapsed by default — the row carries language + line facts; the content
    // panel only mounts when the user opens it.
    expect(html).toContain("tool-call-row-expandable");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("tool-call-row-chevron");
    expect(html).toContain('data-tool-collapse-motion="closed"');
    expect(html).toContain('data-tool-row-facts="true"');
    expect(html).toContain('data-tool-row-fact="language"');
    expect(html).toContain('data-tool-row-fact="lines"');
    expect(html).not.toContain("tool-file-change");
  });

  it("renders grouped read tools collapsed behind an expandable group header", () => {
    const calls = [
      makeCall({
        id: "read-1",
        toolName: "Read",
        toolInput: JSON.stringify({ file_path: "src/one.ts" }),
        result: "1\texport const one = 1;",
      }),
      makeCall({
        id: "read-2",
        toolName: "Read",
        toolInput: JSON.stringify({ file_path: "src/two.ts" }),
        result: "1\texport const two = 2;",
      }),
    ];

    const html = renderToStaticMarkup(<ToolCallList toolCalls={calls} />);

    expect(html).toContain("tool-group-header-row");
    expect(html).toContain("tool-group-count");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("src/one.ts");
    expect(html).toContain("src/two.ts");
    expect(html).toContain("tool-group-preview");
  });

  it("keeps grouped file changes collapsed behind the group header", () => {
    const calls = [
      makeCall({
        id: "write-1",
        toolInput: JSON.stringify({
          file_path: "src/one.ts",
          content: "export const one = 1;\n",
        }),
      }),
      makeCall({
        id: "write-2",
        toolInput: JSON.stringify({
          file_path: "src/two.ts",
          content: "export const two = 2;\n",
        }),
      }),
    ];

    const html = renderToStaticMarkup(<ToolCallList toolCalls={calls} />);

    expect(html).toContain("tool-group-header-row");
    expect(html).toContain('aria-expanded="false"');
    // No diff content mounted while collapsed.
    expect(html).not.toContain("tool-file-change");
  });

  it("collapses consecutive TaskCreate calls into one group row", () => {
    const calls = ["后端 Rust 支持手动凭证", "前端 store 与 auth 识别", "git-panel 弹窗编排", "构建验证"]
      .map((subject, index) => makeCall({
        id: `task-${index}`,
        toolName: "TaskCreate",
        toolInput: JSON.stringify({ subject, description: subject }),
        result: `Created task ${index + 1}`,
      }));

    const html = renderToStaticMarkup(<ToolCallList toolCalls={calls} />);

    // One collapsed group header instead of a row per TaskCreate call.
    expect(html.match(/tool-group-header-row/g)).toHaveLength(1);
    expect(html).toContain("tool-group-count");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("tool-group-preview");
    expect(html).toContain('data-tool-collapse-motion="closed"');
  });

  it("keeps a mixed TaskCreate/TaskUpdate sequence grouped by tool name", () => {
    const calls = [
      makeCall({
        id: "tc-1",
        toolName: "TaskCreate",
        toolInput: JSON.stringify({ subject: "任务一" }),
        result: "Created task 1",
      }),
      makeCall({
        id: "tc-2",
        toolName: "TaskCreate",
        toolInput: JSON.stringify({ subject: "任务二" }),
        result: "Created task 2",
      }),
      makeCall({
        id: "tu-1",
        toolName: "TaskUpdate",
        toolInput: JSON.stringify({ taskId: "1", status: "in_progress" }),
        result: "Updated task 1",
      }),
    ];

    const html = renderToStaticMarkup(<ToolCallList toolCalls={calls} />);

    // TaskCreate pair groups; the single trailing TaskUpdate renders alone.
    expect(html.match(/tool-group-header-row/g)).toHaveLength(1);
    expect(html.match(/tool-call-row-label/g)).toHaveLength(2);
  });

  it("folds a 3-call run into a collapsed steps container by default", () => {
    // Two writes split by a read form a 3-call steps run. The container is
    // collapsed by default — the timeline (and its file cards) only mount when
    // the user opens it, so no file content is rendered up front.
    const calls = [
      makeCall({
        id: "write-a",
        toolInput: JSON.stringify({
          file_path: "src/a.ts",
          content: "export const aaa = 1;\n",
        }),
        result: "Created src/a.ts",
      }),
      makeCall({
        id: "read-mid",
        toolName: "Read",
        toolInput: JSON.stringify({ file_path: "src/mid.ts" }),
        result: "1\texport const mid = 0;",
      }),
      makeCall({
        id: "write-b",
        toolInput: JSON.stringify({
          file_path: "src/b.ts",
          content: "export const bbb = 2;\n",
        }),
        result: "Created src/b.ts",
      }),
    ];

    const html = renderToStaticMarkup(<ToolCallList toolCalls={calls} />);

    expect(html).toContain('data-tool-steps-container="collapsed"');
    expect(html).toContain('aria-expanded="false"');
    // Collapsed body is not mounted — neither file card's content shows.
    expect(html).not.toContain('data-tool-file-card="true"');
    expect(html).not.toContain("bbb");
    expect(html).not.toContain("aaa");
  });

  it("collapses a completed steps run into a summary row", () => {
    const calls = [
      makeCall({
        id: "read-1",
        toolName: "Read",
        toolInput: JSON.stringify({ file_path: "src/one.ts" }),
        result: "1\texport const one = 1;",
      }),
      makeCall({
        id: "grep-1",
        toolName: "Grep",
        toolInput: JSON.stringify({ pattern: "one", path: "src" }),
        result: "Found 1 file\nsrc/one.ts",
      }),
      makeCall({
        id: "write-1",
        toolInput: JSON.stringify({
          file_path: "src/two.ts",
          content: "export const two = 2;\n",
        }),
        result: "Created src/two.ts",
      }),
    ];

    const html = renderToStaticMarkup(<ToolCallList toolCalls={calls} />);

    // Turn is over (not streaming) → container folds to the summary header.
    expect(html).toContain('data-tool-steps-container="collapsed"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-tool-steps-chips="true"');
    expect(html).toContain('data-tool-steps-chip="reads"');
    expect(html).toContain('data-tool-steps-chip="edits"');
    expect(html).toContain('data-tool-steps-chip="searches"');
    // Collapsed body content is not mounted.
    expect(html).not.toContain("data-tool-file-card");
  });

  it("stays collapsed while running but shows the live tool label", () => {
    const calls = [
      makeCall({
        id: "read-1",
        toolName: "Read",
        toolInput: JSON.stringify({ file_path: "src/one.ts" }),
        result: "1\texport const one = 1;",
      }),
      makeCall({
        id: "read-2",
        toolName: "Read",
        toolInput: JSON.stringify({ file_path: "src/two.ts" }),
        result: "1\texport const two = 2;",
      }),
      makeCall({
        id: "shell-1",
        toolName: "Bash",
        toolInput: JSON.stringify({ command: "npm run lint" }),
        status: "running",
        result: undefined,
      }),
    ];

    const html = renderToStaticMarkup(<ToolCallList toolCalls={calls} />);

    // Collapsed by default, even mid-run — the header carries the live status.
    expect(html).toContain('data-tool-steps-container="collapsed"');
    // Running header shows the live tool label instead of the summary chips.
    expect(html).not.toContain('data-tool-steps-chips="true"');
    expect(html).toContain("npm run lint");
  });

  it("renders non-MCP shell command tools with the command output panel", () => {
    const html = renderToStaticMarkup(
      <ToolCallList
        toolCalls={[
          makeCall({
            id: "shell-1",
            toolName: "run_shell_command",
            toolInput: JSON.stringify({ command: "npm run test -- src/example.test.ts" }),
            status: "running",
            result: "RUN src/example.test.ts\n",
          }),
        ]}
      />,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-tool-command-panel="true"');
    expect(html).toContain('data-tool-command-status="running"');
    expect(html).toContain('data-tool-row-fact="output-lines"');
    expect(html).toContain("npm run test -- src/example.test.ts");
  });

  it("keeps replace tools collapsed with edit diff facts on the row", () => {
    const html = renderToStaticMarkup(
      <ToolCallList
        toolCalls={[
          makeCall({
            id: "replace-1",
            toolName: "replace",
            toolInput: JSON.stringify({
              path: "src/example.ts",
              old_string: "export const value = 1;\n",
              new_string: "export const value = 2;\n",
            }),
            status: "success",
            result: "Updated src/example.ts",
          }),
        ]}
      />,
    );

    // Collapsed by default — diff facts stay on the row, the diff body waits.
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-tool-row-fact="language"');
    expect(html).toContain('data-tool-row-fact="line-delta"');
    expect(html).toContain('data-tool-row-fact="net-change"');
    expect(html).not.toContain('data-tool-file-card="true"');
    expect(html).not.toContain("tool-file-change-diff-row-removed");
  });

  it("keeps delete tools collapsed by default", () => {
    const html = renderToStaticMarkup(
      <ToolCallList
        toolCalls={[
          makeCall({
            id: "delete-1",
            toolName: "Delete",
            toolInput: JSON.stringify({
              file_path: "src/old-card.tsx",
            }),
            status: "success",
            result: "Deleted src/old-card.tsx",
          }),
        ]}
      />,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-tool-file-card="true"');
  });

  it("keeps file search results collapsed with count facts on the row", () => {
    const html = renderToStaticMarkup(
      <ToolCallList
        toolCalls={[
          makeCall({
            id: "grep-1",
            toolName: "Grep",
            toolInput: JSON.stringify({
              pattern: "tool-file-change",
              path: "src/components/chat",
              output_mode: "files_with_matches",
            }),
            status: "success",
            result: [
              "Found 2 files",
              "src/components/chat/tool-call-block.tsx",
              "src/components/chat/tool-renderers/tool-result-display.tsx",
            ].join("\n"),
          }),
        ]}
      />,
    );

    // Process tools stay collapsed on success — facts answer "found how many".
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-tool-row-fact="files"');
    expect(html).not.toContain('data-tool-file-search-panel');
  });

  it("keeps grep content results collapsed with match count facts", () => {
    const html = renderToStaticMarkup(
      <ToolCallList
        toolCalls={[
          makeCall({
            id: "grep-content-1",
            toolName: "Grep",
            toolInput: JSON.stringify({
              pattern: "tool-card",
              path: "src",
              output_mode: "content",
            }),
            status: "success",
            result: [
              "src/App.css:10:.tool-card { color: red; }",
              "src/components/chat/tool-call-block.tsx:42:export function ToolCallList() {}",
            ].join("\n"),
          }),
        ]}
      />,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-tool-row-fact="matches"');
    expect(html).not.toContain('data-tool-content-search-panel');
  });

  it("keeps directory listings collapsed with entry count facts", () => {
    const html = renderToStaticMarkup(
      <ToolCallList
        toolCalls={[
          makeCall({
            id: "directory-1",
            toolName: "list_directory",
            toolInput: JSON.stringify({ path: "src/components/chat" }),
            status: "success",
            result: "tool-renderers/\nchat-message.tsx\ntool-call-block.tsx",
          }),
        ]}
      />,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-tool-row-fact="entries"');
    expect(html).not.toContain('data-tool-directory-panel');
  });

  it("keeps web search results collapsed with source count facts", () => {
    const html = renderToStaticMarkup(
      <ToolCallList
        toolCalls={[
          makeCall({
            id: "web-search-1",
            toolName: "WebSearch",
            toolInput: JSON.stringify({ query: "agent chat UI" }),
            status: "success",
            result: [
              "Web search results for query: agent chat UI",
              "Links: [{\"title\":\"Codex\",\"url\":\"https://openai.com/codex/\"}]",
              "",
              "Search summary",
            ].join("\n"),
          }),
        ]}
      />,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-tool-row-fact="sources"');
    expect(html).not.toContain('data-tool-web-search-panel');
  });

  it("auto-expands plan output into a structured plan panel", () => {
    const html = renderToStaticMarkup(
      <ToolCallList
        toolCalls={[
          makeCall({
            id: "plan-1",
            toolName: "ExitPlanMode",
            toolInput: JSON.stringify({}),
            status: "success",
            result: "### Plan\n\n1. Refine cards\n2. Verify preview",
          }),
        ]}
      />,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-tool-plan-panel="true"');
    expect(html).toContain("Refine cards");
  });
});
