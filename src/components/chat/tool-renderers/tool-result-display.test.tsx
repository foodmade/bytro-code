import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  InlineBashContent,
  InlineDeleteContent,
  InlineDiffContent,
  InlineDirectoryListContent,
  InlineFileSearchContent,
  InlinePlanContent,
  InlineWebSearchContent,
  InlineWebFetchContent,
  InlineWriteContent,
  ResultContent,
  TodoContent,
  AskUserQuestionContent,
} from "./tool-result-display";

describe("tool result display", () => {
  it("wraps plain text output in a structured output panel", () => {
    const html = renderToStaticMarkup(
      <ResultContent result={"first line\nsecond line"} toolName="UnknownTool" />,
    );

    expect(html).toContain('data-tool-output-panel="true"');
    expect(html).toContain('data-tool-action="copy-output"');
    expect(html).toContain("tool-output-pre");
    expect(html).toContain("first line");
  });

  it("renders JSON output with a scan summary and full code preview", () => {
    const html = renderToStaticMarkup(
      <ResultContent
        result={JSON.stringify({
          status: "ready",
          files: ["src/App.css", "src/components/chat/tool-call-block.tsx"],
          metrics: { changed: 2 },
        })}
        toolName="UnknownTool"
      />,
    );

    expect(html).toContain('data-tool-output-panel="true"');
    expect(html).toContain('data-tool-json-panel="true"');
    expect(html).toContain('data-tool-json-kind="object"');
    expect(html).toContain('data-tool-json-summary="true"');
    expect(html).toContain('data-tool-json-chip="kind"');
    expect(html).toContain('data-tool-json-chip="count"');
    expect(html).toContain('data-tool-json-chip="keys"');
    expect(html).toContain('data-tool-json-code="true"');
    expect(html).toContain('data-tool-code-preview="true"');
    expect(html).toContain("status, files, metrics");
    expect(html).toContain("changed");
  });

  it("renders agent markdown with a quick-scan summary before the full output", () => {
    const html = renderToStaticMarkup(
      <ResultContent
        toolName="Agent"
        result={JSON.stringify([
          {
            type: "text",
            text: [
              "### Sub-agent review summary",
              "",
              "The interaction layer has clearer streaming and tool output boundaries.",
              "",
              "- File writes now show structured artifact previews.",
              "- Search results are grouped by source file.",
              "- Long markdown stays available in full.",
            ].join("\n"),
          },
        ])}
      />,
    );

    expect(html).toContain('data-tool-agent-output="true"');
    expect(html).toContain('data-tool-agent-scan="true"');
    expect(html).toContain('data-tool-agent-metric="findings"');
    expect(html).toContain('data-tool-agent-metric="sections"');
    expect(html).toContain('data-tool-agent-findings="true"');
    expect(html).toContain('data-tool-agent-finding="true"');
    expect(html).toContain('data-tool-agent-markdown="true"');
    expect(html).toContain("Sub-agent review summary");
    expect(html).toContain("File writes now show structured artifact previews");
  });

  it("decodes escaped agent content blocks before rendering markdown", () => {
    const contentBlocks = JSON.stringify([
      {
        type: "text",
        text: [
          "（再次忽略 TaskCreate 提醒——纯审查任务）信息已经充分。",
          "",
          "# 代码审查报告：聊天消息渲染重构",
          "",
          "## 严重问题（必须修复）",
          "",
          "1. chat-message-segments.ts:19-22 — fence 计数误判内联反引号代码",
        ].join("\n"),
      },
    ]);
    const escapedWithoutOuterQuotes = JSON.stringify(contentBlocks).slice(1, -1);

    const html = renderToStaticMarkup(
      <ResultContent
        toolName="Agent"
        result={escapedWithoutOuterQuotes}
      />,
    );

    expect(html).toContain('data-tool-agent-output="true"');
    expect(html).toContain('data-tool-agent-markdown="true"');
    expect(html).toContain("代码审查报告：聊天消息渲染重构");
    expect(html).toContain("fence 计数误判内联反引号代码");
    expect(html).not.toContain('data-tool-json-panel="true"');
    expect(html).not.toContain("[{\\&quot;type\\&quot;");
  });

  it("salvages text from a content-block array truncated mid-string", () => {
    const full = JSON.stringify([
      {
        type: "text",
        text: [
          "## Summary of Chat Message Persistence",
          "",
          "Messages are stored in SQLite via the memory module.",
          "The conversations table tracks message_count and previous_session_ids.",
        ].join("\n"),
      },
    ]);
    // Simulate an older sidecar slicing through the JSON mid-string and
    // appending a truncation marker (breaks JSON.parse).
    const truncated = full.slice(0, full.length - 25) + "\n...(truncated)";

    const html = renderToStaticMarkup(
      <ResultContent toolName="Task" result={truncated} />,
    );

    expect(html).toContain('data-tool-agent-output="true"');
    expect(html).toContain('data-tool-agent-markdown="true"');
    expect(html).toContain("Summary of Chat Message Persistence");
    expect(html).toContain("Messages are stored in SQLite");
    // The raw broken JSON must NOT be rendered verbatim.
    expect(html).not.toContain("&quot;type&quot;");
    expect(html).not.toContain('data-tool-json-panel="true"');
  });

  it("renders read file output as a structured file preview card", () => {
    const html = renderToStaticMarkup(
      <ResultContent
        toolName="Read"
        toolInput={JSON.stringify({ file_path: "src/components/chat/chat-message.tsx" })}
        result={"1\timport { memo } from \"react\";\n2\texport const value = 1;"}
      />,
    );

    expect(html).toContain('data-tool-file-card="true"');
    expect(html).toContain('data-tool-read-card="true"');
    expect(html).toContain('data-tool-file-kind="read"');
    expect(html).toContain('data-tool-file-path="src/components/chat/chat-message.tsx"');
    expect(html).toContain('data-tool-action="open"');
    expect(html).toContain('data-tool-action="copy"');
    expect(html).toContain("tool-file-change-pre");
    expect(html).toContain('data-tool-code-preview="true"');
    expect(html).toContain('data-tool-code-line="2"');
    expect(html).toContain("chat-message.tsx");
    expect(html).toContain("language-typescript");
    expect(html).toContain("value =");
  });

  it("renders read_many_files output as a structured multi-file panel", () => {
    const html = renderToStaticMarkup(
      <ResultContent
        toolName="read_many_files"
        toolInput={JSON.stringify({
          paths: [
            "src/components/chat/chat-message.tsx",
            "src/components/chat/tool-call-block.tsx",
          ],
        })}
        result={[
          "src/components/chat/chat-message.tsx",
          "export const Message = null;",
          "",
          "src/components/chat/tool-call-block.tsx",
          "export const ToolCallBlock = null;",
        ].join("\n")}
      />,
    );

    expect(html).toContain('data-tool-read-many-card="true"');
    expect(html).toContain('data-tool-read-many-list="true"');
    expect(html).toContain('data-tool-read-many-row="true"');
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-tool-read-many-summary="true"');
    expect(html).toContain('data-tool-read-many-preview-list="true"');
    expect(html).toContain('data-tool-read-many-preview="true"');
    expect(html).toContain('data-tool-read-many-selected-preview="true"');
    expect(html).toContain('data-tool-read-many-selected-path="src/components/chat/chat-message.tsx"');
    expect(html).toContain('data-tool-file-kind="read-many"');
    expect(html).toContain('data-tool-file-path="src/components/chat/chat-message.tsx"');
    expect(html).toContain('data-tool-action="copy-output"');
    expect(html).toContain('data-tool-action="open-selected-file"');
    expect(html).toContain('data-tool-code-preview="true"');
    expect(html).toContain('data-tool-code-line="1"');
    expect(html).toContain("chat-message.tsx");
    expect(html).toContain("tool-call-block.tsx");
    expect(html).not.toContain("ToolCallBlock = null");
  });

  it("wraps fetched markdown output in a structured output panel", () => {
    const html = renderToStaticMarkup(
      <InlineWebFetchContent result={"# Title\n\nFetched body"} />,
    );

    expect(html).toContain('data-tool-output-panel="true"');
    expect(html).toContain("tool-output-markdown");
    expect(html).toContain("Title");
  });

  it("renders web search results as structured source and summary panels", () => {
    const html = renderToStaticMarkup(
      <InlineWebSearchContent
        result={[
          "Web search results for query: agent UI",
          "Links: [{\"title\":\"Codex\",\"url\":\"https://openai.com/codex/\"},{\"title\":\"Cursor\",\"url\":\"https://cursor.com/features\"}]",
          "",
          "### Summary",
          "",
          "- Tool results should be easy to scan.",
        ].join("\n")}
      />,
    );

    expect(html).toContain('data-tool-web-search-panel="true"');
    expect(html).toContain('data-tool-web-source-row="true"');
    expect(html).toContain('data-tool-web-source-url="https://openai.com/codex/"');
    expect(html).toContain('data-tool-web-summary="true"');
    expect(html).toContain("tool-web-source-title");
    expect(html).toContain("tool-output-panel");
  });

  it("renders plan output in a structured plan panel", () => {
    const html = renderToStaticMarkup(
      <InlinePlanContent result={"### Plan\n\n1. Audit\n2. Refine\n3. Verify"} />,
    );

    expect(html).toContain('data-tool-plan-panel="true"');
    expect(html).toContain("tool-plan-panel-header");
    expect(html).toContain("tool-plan-panel-body");
    expect(html).toContain("Audit");
  });

  it("renders todo results as a structured checklist panel", () => {
    const html = renderToStaticMarkup(
      <TodoContent
        toolName="TodoWrite"
        toolInput={JSON.stringify({
          todos: [
            { content: "Audit streaming", status: "completed" },
            { content: "Polish cards", status: "in_progress" },
            { content: "Run desktop validation", status: "pending" },
          ],
        })}
      />,
    );

    expect(html).toContain('data-tool-todo-panel="true"');
    expect(html).toContain('data-tool-todo-status="completed"');
    expect(html).toContain('data-tool-todo-status="in_progress"');
    expect(html).toContain('data-tool-todo-status="pending"');
    expect(html).toContain("Audit streaming");
    expect(html).toContain("Polish cards");
  });

  it("renders bash commands as a compact command and output panel", () => {
    const html = renderToStaticMarkup(
      <InlineBashContent
        toolInput={JSON.stringify({ command: "npm run test -- --run" })}
        result={"RUN tests\n\u001b[32mok\u001b[0m"}
        status="running"
      />,
    );

    expect(html).toContain('data-tool-command-panel="true"');
    expect(html).toContain('data-tool-command-status="running"');
    expect(html).toContain('data-tool-action="copy-command"');
    expect(html).toContain('data-tool-action="copy-output"');
    expect(html).toContain('data-tool-bash-output-lines="true"');
    expect(html).toContain('data-tool-bash-output-line="2"');
    expect(html).toContain("tool-command-panel-pre");
    expect(html).toContain("tool-bash-output-pre");
    // command is syntax-highlighted (hljs may split tokens into spans)
    expect(html).toContain("language-bash");
    expect(html).toContain("npm run");
    expect(html).toContain("--run");
    expect(html).toContain("RUN tests");
  });

  it("marks write file output as a structured file card", () => {
    const html = renderToStaticMarkup(
      <InlineWriteContent
        toolInput={JSON.stringify({
          file_path: "src/components/new-card.tsx",
          content: "export function NewCard() {\n  return null;\n}\n",
        })}
        result="Created src/components/new-card.tsx"
      />,
    );

    expect(html).toContain('data-tool-file-card="true"');
    expect(html).toContain('data-tool-file-kind="created"');
    expect(html).toContain('data-tool-file-path="src/components/new-card.tsx"');
    expect(html).toContain('data-tool-file-preview="true"');
    expect(html).toContain("tool-file-change-stat-added");
    expect(html).toContain("tool-file-change-lang");
    expect(html).toContain('data-tool-code-preview="true"');
    expect(html).toContain('data-tool-code-line="3"');
    expect(html).toContain("NewCard");
    // simplified: no redundant artifact-summary metadata rail
    expect(html).not.toContain("data-tool-file-artifact-summary");
  });

  it("keeps high-signal tool content available inside scrollable panels instead of line-clamping it", () => {
    const longText = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");

    const writeHtml = renderToStaticMarkup(
      <InlineWriteContent
        toolInput={JSON.stringify({
          file_path: "src/components/long-card.txt",
          content: longText,
        })}
      />,
    );
    const readManyHtml = renderToStaticMarkup(
      <ResultContent
        toolName="read_many_files"
        toolInput={JSON.stringify({ paths: ["src/one.ts", "src/two.ts"] })}
        result={longText}
      />,
    );
    const bashHtml = renderToStaticMarkup(
      <InlineBashContent
        toolInput={JSON.stringify({ command: "printf lines" })}
        result={longText}
        status="success"
      />,
    );
    const webFetchHtml = renderToStaticMarkup(
      <InlineWebFetchContent result={longText} />,
    );
    const agentHtml = renderToStaticMarkup(
      <ResultContent
        toolName="Agent"
        result={JSON.stringify([{ type: "text", text: longText }])}
      />,
    );

    expect(writeHtml).toContain("line 20");
    expect(readManyHtml).toContain("line 20");
    expect(bashHtml).toContain("line 20");
    expect(webFetchHtml).toContain("line 20");
    expect(agentHtml).toContain("line 20");
    expect(agentHtml).toContain('data-tool-agent-output="true"');
    expect(agentHtml).toContain('data-tool-output-panel-body="longform"');
    expect(agentHtml).not.toContain("more lines");
  });

  it("marks edit file output as a structured file card with a unified diff", () => {
    const html = renderToStaticMarkup(
      <InlineDiffContent
        toolName="Edit"
        toolInput={JSON.stringify({
          file_path: "src/App.css",
          old_string: ".tool-card {\n  opacity: 1;\n}\n",
          new_string: ".tool-card {\n  opacity: 1;\n  transform: translateY(0);\n}\n",
        })}
        result="Updated src/App.css"
      />,
    );

    expect(html).toContain('data-tool-file-card="true"');
    expect(html).toContain('data-tool-file-kind="edited"');
    expect(html).toContain('data-tool-file-path="src/App.css"');
    expect(html).toContain('data-tool-diff-line="3"');
    expect(html).toContain("tool-file-change-stat-added");
    expect(html).toContain("tool-file-change-stat-removed");
    expect(html).toContain("tool-file-change-diff-line-number");
    // removed + added lines render together in one continuous color-coded block
    expect(html).toContain("tool-file-change-diff-row-removed");
    expect(html).toContain("tool-file-change-diff-row-added");
    // simplified: no separate before/after panels, no metadata rail
    expect(html).not.toContain("data-tool-diff-section");
    expect(html).not.toContain("data-tool-file-artifact-summary");
  });

  it("marks delete file output as a structured file card", () => {
    const html = renderToStaticMarkup(
      <InlineDeleteContent
        toolInput={JSON.stringify({
          file_path: "src/components/old-card.tsx",
        })}
        result="Deleted src/components/old-card.tsx"
      />,
    );

    expect(html).toContain('data-tool-file-card="true"');
    expect(html).toContain('data-tool-file-kind="deleted"');
    expect(html).toContain('data-file-change-kind="deleted"');
    expect(html).toContain('data-tool-file-path="src/components/old-card.tsx"');
    expect(html).toContain('data-tool-action="copy-path"');
    expect(html).toContain("old-card.tsx");
    expect(html).toContain("Deleted src/components/old-card.tsx");
  });

  it("renders file search results as a structured file list panel", () => {
    const html = renderToStaticMarkup(
      <InlineFileSearchContent
        result={[
          "Found 3 files",
          "src/App.css",
          "src/components/chat/tool-call-block.tsx",
          "README.md",
        ].join("\n")}
      />,
    );

    expect(html).toContain('data-tool-file-search-panel="true"');
    expect(html).toContain('data-tool-file-search-row="true"');
    expect(html).toContain('data-tool-file-path="src/App.css"');
    expect(html).toContain('data-tool-file-path="src/components/chat/tool-call-block.tsx"');
    expect(html).toContain("tool-file-search-name");
    expect(html).toContain("tool-file-search-dir");
  });

  it("renders directory listings as a structured folder panel", () => {
    const html = renderToStaticMarkup(
      <InlineDirectoryListContent
        toolInput={JSON.stringify({ path: "src/components/chat" })}
        result={[
          "tool-renderers/",
          "chat-message.tsx",
          "-rw-r--r--  1 user  staff  42 Jan 1 12:00 code-block.tsx",
        ].join("\n")}
      />,
    );

    expect(html).toContain('data-tool-directory-panel="true"');
    expect(html).toContain('data-tool-directory-path="src/components/chat"');
    expect(html).toContain('data-tool-directory-row="true"');
    expect(html).toContain('data-tool-directory-kind="directory"');
    expect(html).toContain('data-tool-directory-path="src/components/chat/tool-renderers"');
    expect(html).toContain('data-tool-directory-path="src/components/chat/code-block.tsx"');
    expect(html).toContain("tool-directory-name");
    expect(html).toContain("tool-directory-summary");
  });

  it("renders grep content results as grouped match panels", () => {
    const html = renderToStaticMarkup(
      <InlineFileSearchContent
        result={[
          "src/App.css:10:.tool-card { color: red; }",
          "src/App.css:11:.tool-card:hover { color: blue; }",
          "src/components/chat/tool-call-block.tsx:42:export function ToolCallList() {}",
        ].join("\n")}
      />,
    );

    expect(html).toContain('data-tool-content-search-panel="true"');
    expect(html).toContain('data-tool-content-search-count="3"');
    expect(html).toContain('data-tool-content-search-file="true"');
    expect(html).toContain('data-tool-content-search-match="true"');
    expect(html).toContain('data-tool-content-search-line="10"');
    expect(html).toContain('data-tool-file-path="src/App.css"');
    expect(html).toContain('data-tool-file-path="src/components/chat/tool-call-block.tsx"');
    expect(html).toContain(".tool-card:hover");
  });
});

describe("ask user question replay", () => {
  const TWO_QUESTIONS = JSON.stringify({
    questions: [
      {
        question: "Which root cause matches?",
        header: "Diagnosis",
        multiSelect: false,
        options: [
          { label: "Full reload overwrites tabs", description: "loadConversations replaces everything" },
          { label: "Only the running indicator is missing", description: "aggregation logic differs" },
        ],
      },
      {
        question: "Should I fix it now?",
        header: "Next step",
        multiSelect: false,
        options: [
          { label: "Fix now", description: "apply the incremental update" },
          { label: "Plan only", description: "write the plan first" },
        ],
      },
    ],
  });

  it("highlights the chosen option per question and reveals its description", () => {
    const result =
      'Your questions have been answered: "Which root cause matches?"="Full reload overwrites tabs", "Should I fix it now?"="Plan only". You can now continue with these answers in mind.';
    const html = renderToStaticMarkup(
      <AskUserQuestionContent toolInput={TWO_QUESTIONS} result={result} />,
    );

    expect(html).toContain('data-ask-user-replay="true"');
    expect(html).toContain("Which root cause matches?");
    expect(html).toContain("Should I fix it now?");
    expect(html).toContain("Diagnosis");
    // Chosen options are selected and their descriptions become visible.
    expect(html).toContain('data-selected="true"');
    expect(html).toContain("loadConversations replaces everything");
    expect(html).toContain("write the plan first");
    // Descriptions of non-chosen options stay hidden to reduce noise.
    expect(html).not.toContain("aggregation logic differs");
    expect(html).not.toContain("apply the incremental update");
    // Fully answered → no status banner.
    expect(html).not.toContain("data-ask-user-status");
  });

  it("shows a timeout banner and selects nothing when the tool timed out", () => {
    const html = renderToStaticMarkup(
      <AskUserQuestionContent toolInput={TWO_QUESTIONS} result="AskUserQuestion timed out" />,
    );

    expect(html).toContain('data-ask-user-status="timeout"');
    expect(html).toContain("Which root cause matches?");
    expect(html).not.toContain('data-selected="true"');
    expect(html).not.toContain("loadConversations replaces everything");
  });

  it("renders a free-text answer that is not one of the listed options", () => {
    const input = JSON.stringify({
      questions: [
        {
          question: "Pick a colour",
          header: "Colour",
          multiSelect: false,
          options: [
            { label: "Red", description: "the red one" },
            { label: "Blue", description: "the blue one" },
          ],
        },
      ],
    });
    const result =
      'Your questions have been answered: "Pick a colour"="Chartreuse, please". You can now continue with these answers in mind.';
    const html = renderToStaticMarkup(
      <AskUserQuestionContent toolInput={input} result={result} />,
    );

    expect(html).toContain('data-ask-user-custom="true"');
    expect(html).toContain("Chartreuse, please");
    expect(html).not.toContain('data-selected="true"');
  });

  it("selects every chosen option for a multi-select question", () => {
    const input = JSON.stringify({
      questions: [
        {
          question: "Pick toppings",
          header: "Toppings",
          multiSelect: true,
          options: [
            { label: "Cheese", description: "extra cheese" },
            { label: "Olives", description: "green olives" },
            { label: "Mushroom", description: "button mushroom" },
          ],
        },
      ],
    });
    const result =
      'Your questions have been answered: "Pick toppings"="Cheese, Mushroom". You can now continue with these answers in mind.';
    const html = renderToStaticMarkup(
      <AskUserQuestionContent toolInput={input} result={result} />,
    );

    expect(html).toContain("extra cheese");
    expect(html).toContain("button mushroom");
    expect(html).not.toContain("green olives");
  });

  it("falls back to the plain output panel when the input is not valid JSON", () => {
    const html = renderToStaticMarkup(
      <AskUserQuestionContent toolInput="not-json" result="some raw output" />,
    );

    expect(html).toContain('data-tool-output-panel="true"');
    expect(html).toContain("some raw output");
    expect(html).not.toContain('data-ask-user-replay="true"');
  });
});
