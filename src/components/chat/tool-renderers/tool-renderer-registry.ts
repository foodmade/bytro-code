import {
  Terminal,
  FileText,
  FilePen,
  FolderOpen,
  Search,
  Globe,
  Layers,
  PencilLine,
  Blocks,
  ListTodo,
  MessageCircleQuestion,
  Zap,
  GitBranch,
  Trash2,
  Shield,
  SendHorizonal,
  BookOpen,
  Brain,
  ListChecks,
  Activity,
  CheckSquare,
  Files,
  Bell,
  Clock,
  Code2,
  Radio,
} from "lucide-react";
import type { ToolCall } from "@/stores/chat-store";
import i18n from "@/i18n/config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolMeta {
  /** i18n key for the tool label — resolve via `t(meta.label)` at render time. */
  readonly label: string;
  readonly icon: typeof Terminal;
  readonly accentColor: string;
}

export interface DiffStat {
  readonly added: number;
  readonly removed: number;
}

export interface FormattedInput {
  readonly display: string;
  readonly tooltip: string;
  readonly diffStat?: DiffStat;
}

export type RenderItem =
  | { kind: "single"; call: ToolCall }
  | { kind: "group"; toolName: string; calls: ToolCall[] };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_RESULT_LINES = 12;

// ---------------------------------------------------------------------------
// Tool metadata: icon & color mappings per tool name
// `label` stores an i18n key; the consumer resolves it via `t(meta.label)`.
// ---------------------------------------------------------------------------

const TOOL_META: Record<string, ToolMeta> = {
  // ── Gemini CLI tool names (27 tools) ──────────────────────────────────────
  // File I/O
  read_file:        { label: "chat.tools.labels.readFile",      icon: FileText,    accentColor: "#3B82F6" },
  read_many_files:  { label: "chat.tools.labels.readFiles",     icon: Files,       accentColor: "#3B82F6" },
  write_file:       { label: "chat.tools.labels.writeFile",     icon: FilePen,     accentColor: "#F59E0B" },
  replace:          { label: "chat.tools.labels.editFile",      icon: PencilLine,  accentColor: "#F59E0B" },
  delete_file:      { label: "chat.tools.labels.deleteFile",    icon: Trash2,      accentColor: "#EF4444" },
  remove_file:      { label: "chat.tools.labels.deleteFile",    icon: Trash2,      accentColor: "#EF4444" },
  list_directory:   { label: "chat.tools.labels.listDirectory", icon: FolderOpen,  accentColor: "#10B981" },
  glob:             { label: "chat.tools.labels.findFiles",     icon: FolderOpen,  accentColor: "#10B981" },
  // Search & shell
  grep_search:          { label: "chat.tools.labels.search",   icon: Search,   accentColor: "#06B6D4" },
  grep_search_ripgrep:  { label: "chat.tools.labels.search",   icon: Search,   accentColor: "#06B6D4" },
  run_shell_command:    { label: "chat.tools.labels.command",  icon: Terminal, accentColor: "var(--color-accent-purple)" },
  // Web
  google_web_search: { label: "chat.tools.labels.webSearch",  icon: Globe, accentColor: "#8B5CF6" },
  web_fetch:         { label: "chat.tools.labels.webFetch",   icon: Globe, accentColor: "#8B5CF6" },
  // Todo / tasks
  write_todos:       { label: "chat.tools.labels.todo",       icon: ListTodo,    accentColor: "#F59E0B" },
  complete_task:     { label: "chat.tools.labels.complete",   icon: CheckSquare, accentColor: "#10B981" },
  // Task tracker
  tracker_create_task:    { label: "chat.tools.labels.createTask", icon: ListChecks, accentColor: "#EC4899" },
  tracker_update_task:    { label: "chat.tools.labels.updateTask", icon: ListChecks, accentColor: "#EC4899" },
  tracker_get_task:       { label: "chat.tools.labels.getTask",    icon: ListChecks, accentColor: "#EC4899" },
  tracker_list_tasks:     { label: "chat.tools.labels.listTasks",  icon: ListChecks, accentColor: "#EC4899" },
  tracker_add_dependency: { label: "chat.tools.labels.addDep",     icon: ListChecks, accentColor: "#EC4899" },
  tracker_visualize:      { label: "chat.tools.labels.visualize",  icon: ListChecks, accentColor: "#EC4899" },
  // Interactive / mode
  ask_user:          { label: "chat.tools.labels.askUser",    icon: MessageCircleQuestion, accentColor: "#8B5CF6" },
  enter_plan_mode:   { label: "chat.tools.labels.planMode",   icon: GitBranch,             accentColor: "#06B6D4" },
  exit_plan_mode:    { label: "chat.tools.labels.exitPlan",   icon: GitBranch,             accentColor: "#06B6D4" },
  // Memory & docs
  save_memory:       { label: "chat.tools.labels.memory",     icon: Brain,     accentColor: "#EC4899" },
  get_internal_docs: { label: "chat.tools.labels.docs",       icon: BookOpen,  accentColor: "#3B82F6" },
  activate_skill:    { label: "chat.tools.labels.skill",      icon: Zap,       accentColor: "#EC4899" },
  update_topic:      { label: "chat.tools.labels.topic",      icon: MessageCircleQuestion, accentColor: "#8B5CF6" },
  // Background processes
  list_background_processes: { label: "chat.tools.labels.processes", icon: Activity, accentColor: "#06B6D4" },
  read_background_output:    { label: "chat.tools.labels.output",    icon: Activity, accentColor: "#06B6D4" },
  // Sub-agent tools (Gemini's codebase_investigator etc.)
  codebase_investigator: { label: "chat.tools.labels.investigate", icon: Search, accentColor: "#EC4899" },
  // Legacy
  execute_command: { label: "chat.tools.labels.command", icon: Terminal, accentColor: "var(--color-accent-purple)" },
  // SDK tool names
  Bash: {
    label: "chat.tools.labels.command",
    icon: Terminal,
    accentColor: "var(--color-accent-purple)",
  },
  Read: {
    label: "chat.tools.labels.readFile",
    icon: FileText,
    accentColor: "#3B82F6",
  },
  Write: {
    label: "chat.tools.labels.writeFile",
    icon: FilePen,
    accentColor: "#F59E0B",
  },
  Edit: {
    label: "chat.tools.labels.editFile",
    icon: PencilLine,
    accentColor: "#F59E0B",
  },
  Delete: {
    label: "chat.tools.labels.deleteFile",
    icon: Trash2,
    accentColor: "#EF4444",
  },
  Glob: {
    label: "chat.tools.labels.findFiles",
    icon: FolderOpen,
    accentColor: "#10B981",
  },
  Grep: {
    label: "chat.tools.labels.search",
    icon: Search,
    accentColor: "#06B6D4",
  },
  WebFetch: {
    label: "chat.tools.labels.webFetch",
    icon: Globe,
    accentColor: "#8B5CF6",
  },
  WebSearch: {
    label: "chat.tools.labels.webSearch",
    icon: Globe,
    accentColor: "#8B5CF6",
  },
  Agent: {
    label: "chat.tools.labels.subAgent",
    icon: Layers,
    accentColor: "#EC4899",
  },
  Task: {
    label: "chat.tools.labels.subAgent",
    icon: Layers,
    accentColor: "#EC4899",
  },
  NotebookEdit: {
    label: "chat.tools.labels.notebook",
    icon: FileText,
    accentColor: "#F59E0B",
  },
  // MCP tools (prefixed with mcp__)
  TodoWrite: {
    label: "chat.tools.labels.todo",
    icon: ListTodo,
    accentColor: "#F59E0B",
  },
  TaskCreate: {
    label: "chat.tools.labels.createTask",
    icon: ListChecks,
    accentColor: "#EC4899",
  },
  TaskUpdate: {
    label: "chat.tools.labels.updateTask",
    icon: ListChecks,
    accentColor: "#EC4899",
  },
  TaskGet: {
    label: "chat.tools.labels.getTask",
    icon: ListChecks,
    accentColor: "#EC4899",
  },
  TaskList: {
    label: "chat.tools.labels.listTasks",
    icon: ListChecks,
    accentColor: "#EC4899",
  },
  AskUserQuestion: {
    label: "chat.tools.labels.askUser",
    icon: MessageCircleQuestion,
    accentColor: "#8B5CF6",
  },
  Skill: {
    label: "chat.tools.labels.skill",
    icon: Zap,
    accentColor: "#EC4899",
  },
  EnterPlanMode: {
    label: "chat.tools.labels.planMode",
    icon: GitBranch,
    accentColor: "#06B6D4",
  },
  ExitPlanMode: {
    label: "chat.tools.labels.exitPlan",
    icon: GitBranch,
    accentColor: "#06B6D4",
  },
  Workflow: {
    label: "chat.tools.labels.workflow",
    icon: GitBranch,
    accentColor: "#A855F7",
  },
  CronCreate: {
    label: "chat.tools.labels.cronCreate",
    icon: Clock,
    accentColor: "#F59E0B",
  },
  CronDelete: {
    label: "chat.tools.labels.cronDelete",
    icon: Clock,
    accentColor: "#EF4444",
  },
  CronList: {
    label: "chat.tools.labels.cronList",
    icon: Clock,
    accentColor: "#06B6D4",
  },
  ScheduleWakeup: {
    label: "chat.tools.labels.scheduleWakeup",
    icon: Clock,
    accentColor: "#F59E0B",
  },
  Monitor: {
    label: "chat.tools.labels.monitor",
    icon: Radio,
    accentColor: "#06B6D4",
  },
  PushNotification: {
    label: "chat.tools.labels.notification",
    icon: Bell,
    accentColor: "#F59E0B",
  },
  REPL: {
    label: "chat.tools.labels.repl",
    icon: Code2,
    accentColor: "#A855F7",
  },
  RemoteTrigger: {
    label: "chat.tools.labels.remoteTrigger",
    icon: Radio,
    accentColor: "#06B6D4",
  },
  TeamCreate: {
    label: "chat.tools.labels.team",
    icon: Layers,
    accentColor: "#EC4899",
  },
  TeamDelete: {
    label: "chat.tools.labels.teamDelete",
    icon: Trash2,
    accentColor: "#EF4444",
  },
  SendMessage: {
    label: "chat.tools.labels.message",
    icon: SendHorizonal,
    accentColor: "#3B82F6",
  },
  TaskOutput: {
    label: "chat.tools.labels.taskOutput",
    icon: Layers,
    accentColor: "#EC4899",
  },
  TaskStop: {
    label: "chat.tools.labels.stopTask",
    icon: Trash2,
    accentColor: "#EF4444",
  },
  SecurityReview: {
    label: "chat.tools.labels.security",
    icon: Shield,
    accentColor: "#EF4444",
  },
};

export function getMeta(toolName: string): ToolMeta {
  // Direct match
  if (TOOL_META[toolName]) return TOOL_META[toolName];

  // MCP tools: mcp__<server>__<tool> → show as server icon with tool label
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    const serverName = parts[1] ?? "mcp";
    const mcpToolName = parts[2] ?? toolName;
    return { label: `${serverName}:${mcpToolName}`, icon: Blocks, accentColor: "#06B6D4" };
  }

  return { label: toolName, icon: Terminal, accentColor: "#888888" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract just the filename from an absolute or relative path. */
function basename(filePath: string): string {
  const sep = filePath.lastIndexOf("/");
  const backslash = filePath.lastIndexOf("\\");
  const idx = Math.max(sep, backslash);
  return idx >= 0 ? filePath.slice(idx + 1) : filePath;
}

/** Count the number of lines in a string (empty string = 0 lines). */
function countLines(s: string): number {
  if (!s) return 0;
  // number of newline characters + 1
  let n = 1;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return n;
}

function extractFilePath(input: Record<string, unknown>): string {
  const direct = (input.file_path as string) || (input.path as string) || "";
  if (direct) return direct;
  const changes = input.changes as ReadonlyArray<{ path?: string }> | undefined;
  const firstPath = changes?.[0]?.path;
  return typeof firstPath === "string" ? firstPath : "";
}

/** Format a Read tool input as "filename:startLine-endLine". */
function formatReadInput(input: Record<string, unknown>, filePath: string): FormattedInput {
  const name = basename(filePath);
  const offset = typeof input.offset === "number" ? input.offset : undefined;
  const limit = typeof input.limit === "number" ? input.limit : undefined;

  let lineRange = "";
  if (offset !== undefined && limit !== undefined) {
    const endLine = limit > 0 ? offset + limit - 1 : offset;
    lineRange = `:${offset}-${endLine}`;
  } else if (offset !== undefined) {
    lineRange = `:${offset}`;
  } else if (limit !== undefined) {
    lineRange = `:1-${limit}`;
  }

  return { display: `${name}${lineRange}`, tooltip: filePath };
}

export function formatInput(toolName: string, toolInput: string): FormattedInput {
  const fallback: FormattedInput = { display: toolInput, tooltip: toolInput };
  try {
    const input = JSON.parse(toolInput) as Record<string, unknown>;
    switch (toolName) {
      // ── Gemini CLI tool names ──────────────────────────────────────────
      case "run_shell_command":
      case "execute_command":
        return { display: (input.command as string) ?? toolInput, tooltip: toolInput };
      case "read_file": {
        const rfp = (input.file_path as string) ?? (input.path as string) ?? "";
        return rfp ? formatReadInput(input, rfp) : fallback;
      }
      case "read_many_files": {
        const paths = input.paths as string[] | undefined;
        if (!paths || paths.length === 0) return fallback;
        return { display: i18n.t("chat.tools.summary.filesCount", { count: paths.length }), tooltip: paths.join(", ") };
      }
      case "write_file": {
        const wfPath = (input.file_path as string) ?? (input.path as string) ?? "";
        if (!wfPath) return fallback;
        const wfContent = input.content as string | undefined;
        const wfAdded = wfContent ? countLines(wfContent) : 0;
        return { display: basename(wfPath), tooltip: wfPath, diffStat: wfAdded > 0 ? { added: wfAdded, removed: 0 } : undefined };
      }
      case "replace": {
        const rpPath = (input.file_path as string) ?? (input.path as string) ?? "";
        if (!rpPath) return fallback;
        const rpOld = (input.old_string as string) ?? "";
        const rpNew = (input.new_string as string) ?? "";
        const rpAdded = rpNew ? countLines(rpNew) : 0;
        const rpRemoved = rpOld ? countLines(rpOld) : 0;
        return { display: basename(rpPath), tooltip: rpPath, diffStat: rpAdded > 0 || rpRemoved > 0 ? { added: rpAdded, removed: rpRemoved } : undefined };
      }
      case "delete_file":
      case "remove_file": {
        const dfPath = (input.file_path as string) ?? (input.path as string) ?? "";
        return dfPath ? { display: basename(dfPath), tooltip: dfPath } : fallback;
      }
      case "list_directory": {
        const ldPath = (input.path as string) ?? ".";
        return { display: ldPath === "." ? "." : basename(ldPath), tooltip: ldPath };
      }
      case "glob": {
        const glPat = (input.pattern as string) ?? "";
        const glPath = (input.path as string) ?? "";
        const glDisp = glPath && glPath !== "." ? `${glPat} in ${basename(glPath)}` : glPat;
        return { display: glDisp || toolInput, tooltip: toolInput };
      }
      case "grep_search":
      case "grep_search_ripgrep": {
        const gsPattern = (input.pattern as string) ?? (input.query as string) ?? "";
        const gsPath = (input.path as string) ?? "";
        return gsPattern
          ? { display: `${gsPattern}${gsPath ? ` in ${basename(gsPath)}` : ""}`, tooltip: toolInput }
          : fallback;
      }
      case "google_web_search":
        return { display: (input.query as string) ?? toolInput, tooltip: toolInput };
      case "web_fetch":
        return { display: (input.url as string) ?? toolInput, tooltip: toolInput };
      case "write_todos": {
        const wt = input.todos as Array<{ description?: string; content?: string }> | undefined;
        if (!Array.isArray(wt) || wt.length === 0) return fallback;
        return { display: i18n.t("chat.tools.summary.itemsCount", { count: wt.length }), tooltip: wt.map((t) => t.description ?? t.content ?? "").join(", ") };
      }
      case "complete_task":
        return { display: (input.task_id as string) ?? (input.description as string)?.slice(0, 60) ?? "", tooltip: toolInput };
      case "tracker_create_task":
      case "tracker_update_task":
      case "tracker_get_task": {
        const tid = (input.task_id as string) ?? (input.title as string) ?? "";
        return tid ? { display: tid.slice(0, 60), tooltip: toolInput } : fallback;
      }
      case "tracker_list_tasks":
      case "tracker_add_dependency":
      case "tracker_visualize":
        return { display: "", tooltip: toolInput };
      case "ask_user": {
        const auQ = (input.question as string) ?? "";
        return auQ ? { display: auQ.slice(0, 80), tooltip: auQ } : fallback;
      }
      case "enter_plan_mode":
      case "exit_plan_mode":
        return { display: "", tooltip: toolInput };
      case "save_memory":
        return { display: (input.key as string) ?? (input.description as string)?.slice(0, 60) ?? "", tooltip: toolInput };
      case "get_internal_docs":
        return { display: (input.topic as string) ?? (input.query as string)?.slice(0, 60) ?? "", tooltip: toolInput };
      case "activate_skill":
        return { display: (input.skill as string) ?? (input.name as string) ?? "", tooltip: toolInput };
      case "update_topic":
        return { display: (input.topic as string)?.slice(0, 60) ?? "", tooltip: toolInput };
      case "list_background_processes":
      case "read_background_output":
        return { display: (input.process_id as string)?.slice(0, 20) ?? "", tooltip: toolInput };
      case "codebase_investigator":
        return { display: (input.objective as string)?.slice(0, 80) ?? "", tooltip: toolInput };

      // ── Claude SDK tool names ──────────────────────────────────────────
      case "Bash":
        return { display: (input.command as string) ?? toolInput, tooltip: toolInput };
      case "Read": {
        const fp = extractFilePath(input);
        return fp ? formatReadInput(input, fp) : fallback;
      }
      case "Write": {
        const fp = extractFilePath(input);
        if (!fp) return fallback;
        const content = input.content as string | undefined;
        const added = content ? countLines(content) : 0;
        return { display: basename(fp), tooltip: fp, diffStat: added > 0 ? { added, removed: 0 } : undefined };
      }
      case "Edit": {
        const fp = extractFilePath(input);
        if (!fp) return fallback;
        const oldStr = (input.old_string as string) ?? "";
        const newStr = (input.new_string as string) ?? "";
        const removed = oldStr ? countLines(oldStr) : 0;
        const added = newStr ? countLines(newStr) : 0;
        if (added === 0 && removed === 0) {
          // Fallback to explicit additions/deletions fields (e.g. from Codex fileChange)
          const explicitAdded = typeof input.additions === "number" ? input.additions : 0;
          const explicitRemoved = typeof input.deletions === "number" ? input.deletions : 0;
          if (explicitAdded > 0 || explicitRemoved > 0) {
            return { display: basename(fp), tooltip: fp, diffStat: { added: explicitAdded, removed: explicitRemoved } };
          }
        }
        return { display: basename(fp), tooltip: fp, diffStat: added > 0 || removed > 0 ? { added, removed } : undefined };
      }
      case "Delete": {
        const fp = extractFilePath(input);
        return fp ? { display: basename(fp), tooltip: fp } : fallback;
      }
      case "Glob": {
        const gPattern = (input.pattern as string) ?? "";
        const gPath = (input.path as string) ?? "";
        const gDisplay = gPath && gPath !== "." ? `${gPattern} in ${basename(gPath)}` : gPattern;
        return { display: gDisplay || toolInput, tooltip: toolInput };
      }
      case "Grep": {
        const pattern = input.pattern as string | undefined;
        return pattern
          ? { display: `${pattern}${input.path ? ` in ${basename(input.path as string)}` : ""}`, tooltip: toolInput }
          : fallback;
      }
      case "WebFetch":
        return { display: (input.url as string) ?? toolInput, tooltip: toolInput };
      case "WebSearch":
        return { display: (input.query as string) ?? toolInput, tooltip: toolInput };
      case "Agent":
      case "Task":
        return { display: (input.description as string) ?? (input.prompt as string)?.slice(0, 60) ?? toolInput, tooltip: toolInput };
      case "NotebookEdit": {
        const np = (input.notebook_path as string) ?? "";
        return np ? { display: basename(np), tooltip: np } : fallback;
      }
      case "TodoWrite": {
        const raw = input.todos;
        if (!Array.isArray(raw) || raw.length === 0) return fallback;
        const todos = raw as Array<{ content?: string }>;
        return { display: i18n.t("chat.tools.summary.itemsCount", { count: todos.length }), tooltip: todos.map((t) => t.content ?? "").join(", ") };
      }
      case "TaskCreate":
        return { display: (input.subject as string) ?? (input.description as string)?.slice(0, 80) ?? toolInput, tooltip: toolInput };
      case "TaskUpdate": {
        const taskId = (input.taskId as string) ?? "";
        const status = (input.status as string) ?? "";
        const subject = (input.subject as string) ?? "";
        const display = subject || (status && taskId ? `${taskId.slice(0, 12)} → ${status}` : taskId);
        return display ? { display, tooltip: toolInput } : fallback;
      }
      case "TaskGet":
        return { display: ((input.taskId as string) ?? "").slice(0, 60), tooltip: toolInput };
      case "TaskList":
        return { display: "", tooltip: toolInput };
      case "AskUserQuestion": {
        const questions = input.questions as Array<{ question?: string }> | undefined;
        const q = questions?.[0]?.question ?? "";
        return q ? { display: q.slice(0, 80), tooltip: q } : fallback;
      }
      case "Skill":
        return { display: (input.skill as string) ?? toolInput, tooltip: toolInput };
      case "EnterPlanMode":
      case "ExitPlanMode":
        return { display: "", tooltip: toolInput };
      case "Workflow": {
        const display = (input.name as string) ?? (input.scriptPath as string) ?? (input.description as string) ?? "";
        return { display: display.slice(0, 80), tooltip: toolInput };
      }
      case "CronCreate":
        return { display: (input.cron as string) ?? (input.prompt as string)?.slice(0, 80) ?? toolInput, tooltip: toolInput };
      case "CronDelete":
        return { display: (input.id as string) ?? toolInput, tooltip: toolInput };
      case "CronList":
        return { display: "", tooltip: toolInput };
      case "ScheduleWakeup": {
        const delay = typeof input.delaySeconds === "number" ? `${input.delaySeconds}s` : "";
        const reason = (input.reason as string) ?? "";
        return { display: [delay, reason].filter(Boolean).join(" · "), tooltip: toolInput };
      }
      case "Monitor":
        return { display: (input.description as string) ?? (input.command as string)?.slice(0, 80) ?? toolInput, tooltip: toolInput };
      case "PushNotification":
        return { display: (input.message as string) ?? toolInput, tooltip: toolInput };
      case "REPL":
        return { display: (input.description as string) ?? (input.code as string)?.slice(0, 80) ?? toolInput, tooltip: toolInput };
      case "RemoteTrigger":
        return { display: (input.action as string) ?? (input.trigger_id as string) ?? toolInput, tooltip: toolInput };
      case "TeamCreate": {
        const name = (input.team_name as string) ?? "";
        return name ? { display: name, tooltip: toolInput } : fallback;
      }
      case "SendMessage": {
        const recipient = (input.recipient as string) ?? "";
        const summary = (input.summary as string) ?? "";
        return { display: recipient ? `→ ${recipient}` : summary.slice(0, 60), tooltip: toolInput };
      }
      case "TaskOutput":
      case "TaskStop": {
        const tid = (input.task_id as string) ?? "";
        return tid ? { display: tid.slice(0, 12), tooltip: toolInput } : fallback;
      }
      default: {
        // MCP tools: try to extract a meaningful display from input
        if (toolName.startsWith("mcp__")) {
          const keys = Object.keys(input);
          if (keys.length === 0) return { display: "", tooltip: toolInput };
          const firstVal = input[keys[0]];
          const display = typeof firstVal === "string" ? firstVal.slice(0, 80) : JSON.stringify(firstVal).slice(0, 80);
          return { display, tooltip: toolInput };
        }
        return fallback;
      }
    }
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Grouping logic: merge consecutive same-type calls into groups (2+)
// ---------------------------------------------------------------------------

// Tools that should NEVER be grouped — each call must render as its own block
// (e.g. image-gen renders an inline image preview that bypasses the standard
// tool-call wrapper, so grouping would hide the placeholder/image entirely).
const UNGROUPABLE_TOOLS = new Set<string>([
  "mcp__openai_images__generate_image",
  "mcp__openai_images__edit_image",
]);

export function groupToolCalls(calls: ReadonlyArray<ToolCall>): RenderItem[] {
  const items: RenderItem[] = [];
  let i = 0;

  while (i < calls.length) {
    const current = calls[i];
    let j = i + 1;

    if (!UNGROUPABLE_TOOLS.has(current.toolName)) {
      // look ahead for consecutive same-type calls
      while (j < calls.length && calls[j].toolName === current.toolName) {
        j++;
      }
    }

    const count = j - i;
    if (count >= 2) {
      items.push({ kind: "group", toolName: current.toolName, calls: calls.slice(i, j) as ToolCall[] });
    } else {
      items.push({ kind: "single", call: current as ToolCall });
    }

    i = j;
  }

  return items;
}
