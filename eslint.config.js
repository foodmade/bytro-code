import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";

const sharedRules = {
  "@typescript-eslint/no-unused-vars": [
    "error",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
  ],
  "no-console": ["warn", { allow: ["warn", "error"] }],
};

const sidecarGlobals = {
  AbortController: "readonly",
  Buffer: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  fetch: "readonly",
  process: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  URL: "readonly",
};

const workerGlobals = {
  ...sidecarGlobals,
  crypto: "readonly",
  D1Database: "readonly",
  ExecutionContext: "readonly",
  Headers: "readonly",
  Request: "readonly",
  Response: "readonly",
  WebSocketPair: "readonly",
};

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      "coverage",
      "sidecar/dist",
      "services/site-preview-worker/.wrangler",
      "src-tauri/target",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // ESLint 10 added these rules to its recommended preset. Keep the
    // Community Edition migration focused; they can be adopted incrementally
    // without weakening the existing TypeScript checks.
    rules: {
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      ...sharedRules,
    },
  },
  {
    files: [
      "src/components/chat/chat-message.tsx",
      "src/components/chat/conversation-list.tsx",
      "src/components/chat/tool-confirm-dialog.tsx",
      "src/components/chat/voice-recording-panel.tsx",
      "src/components/file-tree/file-tree-node.tsx",
      "src/components/git/git-file-list.tsx",
      "src/components/git/git-file-tree.tsx",
      "src/components/health-check/health-check-issue-list.tsx",
      "src/components/idea-hub/idea-chat-panel.tsx",
      "src/components/layout/workspace-open-dialog.tsx",
      "src/components/teams/AgentCard.tsx",
      "src/components/teams/TaskInputBar.tsx",
    ],
    rules: {
      "react-refresh/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
          allowExportNames: [
            "AnnouncementTypeBadge",
            "getTypeConfig",
            "ChatMessage",
            "TimeDivider",
            "normalizeMessageContent",
            "buildSegments",
            "ConversationList",
            "groupByDate",
            "ToolConfirmDialog",
            "findPendingConfirmation",
            "VoiceWaveform",
            "VoiceRecordingPanel",
            "formatVoiceDuration",
            "barColor",
            "FileTreeNode",
            "getFileIcon",
            "GitFileSection",
            "FileRow",
            "getStatusBadge",
            "getFileName",
            "GitFileTreeView",
            "buildGitFileTree",
            "HealthCheckIssueList",
            "toRelativePath",
            "IdeaChatPanel",
            "buildIdeaSystemPrompt",
            "buildInitialUserMessage",
            "WorkspaceOpenDialog",
            "showWorkspaceOpenDialog",
            "AgentCard",
            "CARD_THEME",
            "ROLE_ICON",
            "STATUS_CONFIG",
            "CARD_WIDTH",
            "CARD_HEIGHT",
            "CARD_HEIGHT_ORCHESTRATOR",
            "getActiveLabel",
            "getToolInfo",
            "extractFilePath",
            "extractSendMessageInfo",
            "cleanAgentText",
            "TaskInputBar",
            "guessRoleForColor",
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/components/chat/chat-message.tsx",
      "src/components/git/git-file-list.tsx",
      "src/components/git/git-file-tree.tsx",
      "src/components/health-check/health-check-issue-list.tsx",
      "src/components/idea-hub/idea-chat-panel.tsx",
      "src/components/teams/AgentCard.tsx",
      "src/components/teams/TaskInputBar.tsx",
    ],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  {
    files: ["sidecar/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: sidecarGlobals,
    },
    rules: sharedRules,
  },
  {
    files: ["services/site-preview-worker/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: workerGlobals,
    },
    rules: sharedRules,
  },
  {
    files: ["sidecar/src/skills-cli.ts", "sidecar/src/test-subagent-*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["sidecar/src/test-subagent-*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-empty": "off",
    },
  },
  prettier,
);
