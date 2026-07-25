// ---------------------------------------------------------------------------
// Chat Completions handler — for OpenAI-compatible providers that support
// the /chat/completions endpoint (e.g. DeepSeek, Grok, Ollama).
// Uses the standard `openai` SDK instead of @openai/agents (Responses API).
//
// Supports agentic tool calling via OpenAI function-calling protocol:
//   request includes `tools` array → model returns `tool_calls` →
//   sidecar executes tools → sends results back → model continues.
// ---------------------------------------------------------------------------

import OpenAI from "openai";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import type { QueryCommand } from "./protocol.js";
import {
  createLogger,
  getContextWindowForModel,
  estimateTokens,
  truncateMessages,
  truncatePrompt,
  publicSidecarErrorMessage,
} from "./shared.js";
import type { EmitFn } from "./shared.js";
import { validateProviderBaseUrl } from "./endpoint-validation.js";

const log = createLogger("chatcmpl");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SESSION_HISTORY = 50;
const MAX_TOOL_ITERATIONS = 25;
const MAX_FILE_LINES = 2000;
const TOOL_OUTPUT_LIMIT = 8000; // chars
const COMMAND_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Session history — supports text + tool messages
// ---------------------------------------------------------------------------

type SessionMessage = OpenAI.Chat.ChatCompletionMessageParam;

const sessionHistory = new Map<string, SessionMessage[]>();

function getOrCreateSession(sessionId: string): SessionMessage[] {
  const existing = sessionHistory.get(sessionId);
  if (existing) {
    sessionHistory.delete(sessionId);
    sessionHistory.set(sessionId, existing);
    return existing;
  }
  while (sessionHistory.size >= MAX_SESSION_HISTORY) {
    const oldest = sessionHistory.keys().next().value;
    if (oldest !== undefined) sessionHistory.delete(oldest);
  }
  const fresh: SessionMessage[] = [];
  sessionHistory.set(sessionId, fresh);
  return fresh;
}

// ---------------------------------------------------------------------------
// Reasoning effort mapping
// ---------------------------------------------------------------------------

function mapChatCmplReasoningEffort(
  reasoningLevel: string | undefined,
  thinkingEnabled: boolean | undefined,
): "low" | "medium" | "high" | undefined {
  if (reasoningLevel != null) {
    if (reasoningLevel === "off") return undefined;
    if (reasoningLevel === "max") return "high";
    return reasoningLevel as "low" | "medium" | "high";
  }
  if (thinkingEnabled) return "high";
  return undefined;
}

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling format)
// ---------------------------------------------------------------------------

const CHATCMPL_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file from the filesystem. Returns the file content. For large files, only the first 2000 lines are returned.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute or relative path to the file to read",
          },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a file with the given content. Parent directories are created automatically.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute or relative path to the file to write",
          },
          content: {
            type: "string",
            description: "The full content to write to the file",
          },
        },
        required: ["file_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Edit a file by replacing an exact string match. The old_string must appear exactly once in the file.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Path to the file to edit",
          },
          old_string: {
            type: "string",
            description: "The exact string to find and replace",
          },
          new_string: {
            type: "string",
            description: "The replacement string",
          },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Execute a shell command and return its stdout and stderr. Timeout: 30 seconds.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          cwd: {
            type: "string",
            description:
              "Working directory for the command (optional, defaults to project root)",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files and directories at the given path. Returns names, types (file/dir), and sizes.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Directory path to list (optional, defaults to project root)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_content",
      description:
        "Search for a pattern (regex) in files. Returns matching lines with file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regex pattern to search for",
          },
          path: {
            type: "string",
            description: "Directory to search in (defaults to project root)",
          },
          include: {
            type: "string",
            description:
              'Glob pattern to filter files, e.g. "*.ts" or "*.py"',
          },
        },
        required: ["pattern"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

function truncateOutput(text: string): string {
  if (text.length <= TOOL_OUTPUT_LIMIT) return text;
  return (
    text.slice(0, TOOL_OUTPUT_LIMIT) +
    `\n\n... [truncated, ${text.length - TOOL_OUTPUT_LIMIT} more chars]`
  );
}

function resolvePath(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function runShellCommand(
  command: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout && !stderr) {
          reject(err);
        } else {
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
        }
      },
    );
  });
}

async function executeTool(
  name: string,
  rawArgs: string,
  cwd: string,
): Promise<{ success: boolean; result: string }> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    return { success: false, result: `Invalid JSON arguments: ${rawArgs}` };
  }

  try {
    switch (name) {
      case "read_file": {
        const filePath = resolvePath(String(args.file_path ?? ""), cwd);
        const raw = await fs.readFile(filePath, "utf-8");
        const lines = raw.split("\n");
        if (lines.length > MAX_FILE_LINES) {
          const truncated = lines.slice(0, MAX_FILE_LINES).join("\n");
          return {
            success: true,
            result:
              truncated +
              `\n\n... [showing first ${MAX_FILE_LINES} of ${lines.length} lines]`,
          };
        }
        return { success: true, result: raw };
      }

      case "write_file": {
        const filePath = resolvePath(String(args.file_path ?? ""), cwd);
        const content = String(args.content ?? "");
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf-8");
        return {
          success: true,
          result: `File written: ${filePath} (${content.length} chars)`,
        };
      }

      case "edit_file": {
        const filePath = resolvePath(String(args.file_path ?? ""), cwd);
        const oldString = String(args.old_string ?? "");
        const newString = String(args.new_string ?? "");
        const existing = await fs.readFile(filePath, "utf-8");
        const count = existing.split(oldString).length - 1;
        if (count === 0) {
          return {
            success: false,
            result: `old_string not found in ${filePath}`,
          };
        }
        if (count > 1) {
          return {
            success: false,
            result: `old_string found ${count} times in ${filePath} — must be unique`,
          };
        }
        const updated = existing.replace(oldString, newString);
        await fs.writeFile(filePath, updated, "utf-8");
        return {
          success: true,
          result: `File edited: ${filePath} (replaced 1 occurrence)`,
        };
      }

      case "run_command": {
        const command = String(args.command ?? "");
        const cmdCwd = args.cwd
          ? resolvePath(String(args.cwd), cwd)
          : cwd;
        const { stdout, stderr } = await runShellCommand(command, cmdCwd);
        const output = [
          stdout ? `STDOUT:\n${stdout}` : "",
          stderr ? `STDERR:\n${stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        return { success: true, result: truncateOutput(output || "(no output)") };
      }

      case "list_files": {
        const dirPath = args.path
          ? resolvePath(String(args.path), cwd)
          : cwd;
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const lines = await Promise.all(
          entries.slice(0, 200).map(async (e) => {
            const fullPath = path.join(dirPath, e.name);
            const type = e.isDirectory() ? "dir" : "file";
            try {
              const stat = await fs.stat(fullPath);
              const size = e.isDirectory()
                ? ""
                : ` (${stat.size} bytes)`;
              return `${type}\t${e.name}${size}`;
            } catch {
              return `${type}\t${e.name}`;
            }
          }),
        );
        const result =
          lines.join("\n") +
          (entries.length > 200
            ? `\n... [${entries.length - 200} more entries]`
            : "");
        return { success: true, result };
      }

      case "search_content": {
        const pattern = String(args.pattern ?? "");
        const searchPath = args.path
          ? resolvePath(String(args.path), cwd)
          : cwd;
        const include = args.include ? String(args.include) : "";
        const grepArgs = [
          "grep",
          "-rn",
          "--max-count=5",
          ...(include ? [`--include=${include}`] : []),
          pattern,
          searchPath,
        ];
        const { stdout } = await runShellCommand(
          grepArgs.join(" "),
          cwd,
        );
        return {
          success: true,
          result: truncateOutput(stdout || "(no matches)"),
        };
      }

      default:
        return { success: false, result: `Unknown tool: ${name}` };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, result: `Tool error: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Streaming tool_calls accumulator
// ---------------------------------------------------------------------------

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

function accumulateToolCalls(
  current: AccumulatedToolCall[],
  deltas:
    | OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[]
    | undefined,
): void {
  if (!deltas) return;
  for (const d of deltas) {
    const idx = d.index ?? 0;
    while (current.length <= idx) {
      current.push({ id: "", name: "", arguments: "" });
    }
    if (d.id) current[idx].id = d.id;
    if (d.function?.name) current[idx].name = d.function.name;
    if (d.function?.arguments) current[idx].arguments += d.function.arguments;
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleChatCmplQuery(
  cmd: QueryCommand,
  emit: EmitFn,
  activeAbortControllers: Map<string, AbortController>,
): Promise<void> {
  const { id, prompt, model, systemPrompt, sessionId, apiKey, baseUrl } = cmd;

  const abortController = new AbortController();
  activeAbortControllers.set(id, abortController);

  try {
    const resolvedApiKey = apiKey;
    if (!resolvedApiKey) {
      emit({
        evt: "error",
        id,
        error:
          "API key is not configured. Go to Settings > Models to set it.",
      });
      emit({ evt: "done", id });
      return;
    }

    const resolvedBaseUrl = baseUrl
      ? validateProviderBaseUrl(baseUrl)
      : undefined;
    const client = new OpenAI({
      apiKey: resolvedApiKey,
      ...(resolvedBaseUrl ? { baseURL: resolvedBaseUrl } : {}),
    });

    const resolvedSessionId = sessionId?.startsWith("ccmpl-")
      ? sessionId
      : `ccmpl-${id}`;
    const resolvedModel = model || "deepseek-chat";
    const reservedTokens =
      estimateTokens(prompt) + estimateTokens(systemPrompt || "");
    const reasoningEffort = mapChatCmplReasoningEffort(
      cmd.reasoningLevel,
      cmd.thinkingEnabled,
    );

    // Build initial messages
    const messages: SessionMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    if (cmd.messages && cmd.messages.length > 0) {
      const trimmed = truncateMessages(
        cmd.messages,
        resolvedModel,
        reservedTokens,
      );
      for (const m of trimmed) {
        const role = m.role === "user" ? "user" : "assistant";
        messages.push({ role, content: m.content });
      }
    } else if (sessionId) {
      const history = getOrCreateSession(sessionId);
      if (history.length > 0) {
        const histAsSimple = history
          .filter(
            (m): m is { role: "user" | "assistant" | "system"; content: string } =>
              typeof (m as { content?: unknown }).content === "string",
          );
        const trimmed = truncateMessages(
          histAsSimple,
          resolvedModel,
          reservedTokens,
        );
        for (const m of trimmed) {
          messages.push({ role: m.role, content: m.content });
        }
      }
    }

    const safePrompt = truncatePrompt(prompt, resolvedModel);

    // Build user message (with optional images)
    const hasImages = cmd.images && cmd.images.length > 0;
    if (hasImages) {
      const contentParts: OpenAI.Chat.ChatCompletionContentPart[] = [
        ...cmd.images!.map(
          (img) =>
            ({
              type: "image_url" as const,
              image_url: {
                url: `data:${img.media_type};base64,${img.data}`,
              },
            }) as OpenAI.Chat.ChatCompletionContentPartImage,
        ),
        ...(safePrompt
          ? [{ type: "text" as const, text: safePrompt }]
          : []),
      ];
      messages.push({ role: "user", content: contentParts });
    } else {
      messages.push({ role: "user", content: safePrompt || " " });
    }

    emit({ evt: "session", id, sessionId: resolvedSessionId });

    // Determine whether to include tools in this request
    const useTools = !cmd.disableTools;

    let fullText = "";

    // ------- Agentic loop -------
    for (
      let iteration = 0;
      iteration < MAX_TOOL_ITERATIONS;
      iteration++
    ) {
      if (abortController.signal.aborted) break;

      const createParams = {
        model: resolvedModel,
        messages,
        stream: true as const,
        stream_options: { include_usage: true },
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(useTools ? { tools: CHATCMPL_TOOLS } : {}),
        // Ollama-specific: pass num_ctx when provided
        ...(cmd.numCtx ? { num_ctx: cmd.numCtx } : {}),
      };

      const stream = await client.chat.completions.create(
        createParams as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        { signal: abortController.signal },
      );

      let chunkText = "";
      let chunkReasoning = "";
      const toolCalls: AccumulatedToolCall[] = [];

      for await (const chunk of stream) {
        if (abortController.signal.aborted) break;

        const delta = chunk.choices[0]?.delta;

        // Thinking / reasoning content (Ollama, DeepSeek, o1-style models)
        const reasoningDelta =
          (delta as Record<string, unknown>)?.reasoning_content as string | undefined;
        if (reasoningDelta) {
          chunkReasoning += reasoningDelta;
          emit({ evt: "thinking_delta", id, delta: reasoningDelta });
        }

        // Text content
        if (delta?.content) {
          chunkText += delta.content;
          fullText += delta.content;
          emit({ evt: "text_delta", id, delta: delta.content });
        }

        // Tool calls (incremental accumulation)
        accumulateToolCalls(toolCalls, delta?.tool_calls);

        // Usage (last chunk)
        if (chunk.usage) {
          try {
            emit({
              evt: "usage",
              id,
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              totalCostUsd: 0,
              contextWindow: getContextWindowForModel(resolvedModel),
              model: resolvedModel,
            });
          } catch {
            // Non-critical
          }
        }
      }

      // Filter out incomplete tool calls (no id or name)
      const validToolCalls = toolCalls.filter((tc) => tc.id && tc.name);

      if (validToolCalls.length === 0) {
        // No tool calls — pure text response, exit loop
        break;
      }

      // Append assistant message with tool_calls to history.
      //
      // DeepSeek / Qwen-Think and similar thinking-mode providers require that
      // any `reasoning_content` produced by the assistant in a turn be echoed
      // back on the SAME assistant message in subsequent requests, otherwise
      // the API rejects with 400 "The `reasoning_content` in the thinking mode
      // must be passed back to the API". The OpenAI SDK's typing does not
      // include this field, but DeepSeek/Qwen accept it; we attach it via a
      // cast so the next iteration's tool-result follow-up survives.
      const assistantMsg: SessionMessage = {
        role: "assistant",
        content: chunkText || null,
        tool_calls: validToolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
      if (chunkReasoning) {
        (assistantMsg as unknown as Record<string, unknown>).reasoning_content =
          chunkReasoning;
      }
      messages.push(assistantMsg);

      // Execute each tool call
      for (const tc of validToolCalls) {
        const toolCallId = tc.id;
        const toolInput = tc.arguments;

        // Emit tool_start (→ Rust → Tauri → frontend)
        emit({
          evt: "tool_start",
          id,
          toolCallId,
          toolName: tc.name,
          toolInput,
        });

        const result = await executeTool(tc.name, toolInput, cmd.cwd);

        // Emit tool_result (→ Rust → Tauri → frontend)
        emit({
          evt: "tool_result",
          id,
          toolCallId,
          toolName: tc.name,
          toolInput,
          success: result.success,
          result: result.result,
          display: {
            status: result.success ? "success" : "error",
            severity: result.success ? "info" : "error",
          },
        });

        // Append tool result to messages for next iteration
        messages.push({
          role: "tool" as const,
          tool_call_id: toolCallId,
          content: result.result,
        });
      }

      // Continue loop — model will see tool results and may call more tools
    }

    // Save to session history
    const sessionHist = getOrCreateSession(resolvedSessionId);
    sessionHist.push({ role: "user", content: prompt });
    if (fullText) {
      sessionHist.push({ role: "assistant", content: fullText });
    }

    emit({ evt: "complete", id, fullText });
    emit({ evt: "done", id });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Query error: ${errorMsg}`);
    if (!abortController.signal.aborted) {
      emit({ evt: "error", id, error: publicSidecarErrorMessage(err) });
    }
    emit({ evt: "done", id });
  } finally {
    activeAbortControllers.delete(id);
  }
}
