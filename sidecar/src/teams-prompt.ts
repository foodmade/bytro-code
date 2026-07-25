// ---------------------------------------------------------------------------
// Teams orchestrator prompt building and message formatting
// ---------------------------------------------------------------------------

import type { TeamsAgentConfig } from "./protocol.js";
import type { EmitFn } from "./shared.js";

// ---------------------------------------------------------------------------
// Response language instructions (shared between orchestrator and teammates)
// ---------------------------------------------------------------------------

const LANG_INSTRUCTIONS: Readonly<Record<string, string>> = {
  zh: "You MUST respond entirely in Chinese (简体中文). All explanations, comments, descriptions, and conversational text must be written in Chinese. When using extended thinking (thinking/reasoning mode), you MUST also think and reason in Chinese (简体中文). Your internal thought process, analysis, and reasoning must all be conducted in Chinese, not English.",
  ja: "You MUST respond entirely in Japanese (日本語). All explanations, comments, descriptions, and conversational text must be written in Japanese. When using extended thinking (thinking/reasoning mode), you MUST also think and reason in Japanese (日本語). Your internal thought process, analysis, and reasoning must all be conducted in Japanese, not English.",
  ko: "You MUST respond entirely in Korean (한국어). All explanations, comments, descriptions, and conversational text must be written in Korean. When using extended thinking (thinking/reasoning mode), you MUST also think and reason in Korean (한국어). Your internal thought process, analysis, and reasoning must all be conducted in Korean, not English.",
  fr: "You MUST respond entirely in French (Français). All explanations, comments, descriptions, and conversational text must be written in French. When using extended thinking (thinking/reasoning mode), you MUST also think and reason in French (Français). Your internal thought process, analysis, and reasoning must all be conducted in French, not English.",
  de: "You MUST respond entirely in German (Deutsch). All explanations, comments, descriptions, and conversational text must be written in German. When using extended thinking (thinking/reasoning mode), you MUST also think and reason in German (Deutsch). Your internal thought process, analysis, and reasoning must all be conducted in German, not English.",
  es: "You MUST respond entirely in Spanish (Español). All explanations, comments, descriptions, and conversational text must be written in Spanish. When using extended thinking (thinking/reasoning mode), you MUST also think and reason in Spanish (Español). Your internal thought process, analysis, and reasoning must all be conducted in Spanish, not English.",
};

function buildLanguageDirective(lang?: string): string {
  if (!lang) return "";
  const body = LANG_INSTRUCTIONS[lang];
  if (!body) return "";
  return [
    "",
    "## CRITICAL: Response Language",
    body,
    "Code identifiers, technical terms in code blocks, and file paths may remain in English,",
    "but ALL surrounding text, explanations, status updates, and conversational messages must",
    "be in the specified language. This applies to YOU and ALL your teammates — when spawning",
    "teammates, their prompts already include this language requirement.",
    "",
  ].join("\n");
}

/**
 * Map a full model ID (e.g. "claude-opus-4-6") to the SDK short name
 * accepted by the Task tool's `model` parameter ("sonnet" | "opus" | "haiku").
 */
function toSdkModelShortName(fullModelId?: string): string {
  if (!fullModelId) return "opus";
  const lower = fullModelId.toLowerCase();
  if (lower.includes("haiku")) return "haiku";
  if (lower.includes("sonnet")) return "sonnet";
  return "opus"; // default for opus / unknown
}

// ---------------------------------------------------------------------------
// Build agents option for the SDK
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Directed message formatting — [DIRECTED:agent] prefix → orchestrator prompt
// ---------------------------------------------------------------------------

export function formatDirectedMessage(raw: string, emit: EmitFn, requestId: string): string {
  const match = raw.match(/^\[DIRECTED:(\S+)\]\s*([\s\S]*)$/);
  if (match) {
    const [, targetAgent, content] = match;
    emit({
      evt: "teams_message_routed",
      id: requestId,
      targetAgent,
      content,
      timestamp: Date.now(),
    });
    return [
      `## DIRECTIVE: Route to @${targetAgent}`,
      `The user wants to send the following message specifically to the agent named "${targetAgent}".`,
      `Use SendMessage to forward this to "${targetAgent}":`,
      ``,
      content,
      ``,
      `IMPORTANT: Do NOT interpret this yourself. Send it to "${targetAgent}" using SendMessage immediately.`,
    ].join("\n");
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Build the orchestrator system prompt
// ---------------------------------------------------------------------------

export function buildOrchestratorPrompt(
  agents: ReadonlyArray<TeamsAgentConfig>,
  task: string,
  teamName: string,
  responseLanguage?: string,
  modelId?: string,
): string {
  const agentDescriptions = agents
    .map((a) => `- **${a.name}** (role: ${a.role}): ${a.description}`)
    .join("\n");

  const modelShort = toSdkModelShortName(modelId);

  const langBody = responseLanguage ? LANG_INSTRUCTIONS[responseLanguage] : undefined;
  const langSuffix = langBody
    ? ` CRITICAL LANGUAGE REQUIREMENT: ${langBody}`
    : "";

  const spawnLines = agents
    .map((a) => {
      const teammatePrompt = [
        `You are ${a.name}, a ${a.role}.`,
        a.description,
        a.prompt,
        langSuffix.trim(),
      ]
        .filter(Boolean)
        .join(" ");
      return `   Task(team_name=${JSON.stringify(teamName)}, name=${JSON.stringify(a.name)}, subagent_type="general-purpose", model="${modelShort}", prompt=${JSON.stringify(teammatePrompt)})`;
    })
    .join("\n");

  return [
    "You are a team orchestrator managing a TRUE collaborative team using Claude Code's Teams mode.",
    "Teams mode enables independent agents that can communicate directly with each other,",
    "share a task list, and work in parallel — this is fundamentally different from simple subagents.",
    "",
    "## Step 1: Create the Team",
    `Use the TeamCreate tool to create a team: TeamCreate(team_name="${teamName}")`,
    "",
    "## Step 2: Spawn ALL Teammates IN PARALLEL",
    "Use the Task tool with team_name parameter to spawn each teammate.",
    "CRITICAL: Put ALL Task calls in a SINGLE response so they run simultaneously!",
    "",
    agentDescriptions,
    "",
    "Spawn each member like this (ALL in ONE response):",
    spawnLines,
    "",
    "## Step 3: Signal Readiness",
    "After ALL teammates have been successfully spawned, output the exact text: [TEAMS_READY]",
    "Then list the available members and tell the user they can use @name to address specific members.",
    "Wait for the user to provide a task before starting any work.",
    "",
    "## Team Communication Tools (use these AFTER spawning)",
    "- **SendMessage(type=\"message\", recipient=\"name\", content=\"...\", summary=\"...\")** — direct message to a specific teammate",
    "- **SendMessage(type=\"broadcast\", content=\"...\", summary=\"...\")** — message ALL teammates (use sparingly)",
    "- **SendMessage(type=\"shutdown_request\", recipient=\"name\", content=\"...\")** — request a teammate to shut down gracefully",
    "- **TeamDelete** — delete the team and clean up resources when all work is done",
    "",
    "## How You Receive Teammate Messages",
    "When teammates send you messages via SendMessage, the message content will be",
    "delivered directly into this conversation as a user message prefixed with",
    "\"--- Message from teammate ...\". You do NOT need to check any inbox or call",
    "any special tool — messages arrive automatically. Simply read and respond to them.",
    "",
    "## CRITICAL: PARALLEL Execution — NOT Sequential",
    "The entire point of Teams mode is parallel work. Rules:",
    "- Spawn ALL teammates in a SINGLE response (multiple Task calls in ONE message)",
    "- When assigning work, send messages to MULTIPLE agents simultaneously",
    "- NEVER wait for one agent to finish before starting another on independent work",
    "- Use SendMessage to assign parallel subtasks to different agents simultaneously",
    "- Only use sequential calls when one task GENUINELY depends on another's output",
    "",
    "## @Mention Routing (CRITICAL)",
    "When the user's message starts with \"## DIRECTIVE: Route to @agent_name\",",
    "immediately forward the content to that agent using SendMessage.",
    "Do NOT add your own interpretation. Simply send the task to the named agent.",
    "Strip the directive header before sending — only send the actual task content.",
    "",
    "When no directive is present and the message contains @agent_name inline,",
    "delegate to that agent. If no @mention at all, analyze and route to the best agent(s).",
    "",
    "## Dynamically Adding New Teammates",
    "If the user asks you to create a NEW team member that wasn't in the initial roster,",
    "you MUST use the EXACT SAME Task format as the initial spawn — including team_name!",
    "Without team_name the new agent will NOT have SendMessage and cannot communicate.",
    "",
    "Template for creating a new teammate:",
    `   Task(team_name="${teamName}", name="<agent_name>", subagent_type="general-purpose", model="${modelShort}", prompt="You are <agent_name>, a <role>. <description>${langSuffix}")`,
    "",
    "CRITICAL rules for new teammates:",
    `- ALWAYS include team_name="${teamName}" — this is what gives the agent SendMessage capability`,
    "- ALWAYS include name=\"<agent_name>\" — this registers the agent in the team",
    "- The new agent will automatically be able to use SendMessage to communicate with you and other teammates",
    "- After spawning, use SendMessage to assign work to the new teammate — do NOT put the task in the prompt",
    "",
    "## Guidelines",
    "- Break complex tasks into parallel subtasks for different agents",
    "- Use SendMessage for real-time coordination between agents",
    "- Synthesize results from all agents into a coherent response for the user",
    `- ALWAYS use model="${modelShort}" when spawning teammates`,
    "- For follow-up tasks to EXISTING teammates, use SendMessage instead of spawning new agents",
    "- Resume existing teammates (via Task with resume) rather than creating new ones",
    "- When adding NEW members the user requests, always use the template above with team_name",
    buildLanguageDirective(responseLanguage),
    "## Task",
    task,
  ].join("\n");
}
