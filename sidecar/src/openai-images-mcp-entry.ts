/**
 * openai-images-mcp-entry.ts — Standalone stdio MCP server for OpenAI Images API.
 *
 * Bundled by esbuild into a single file (openai-images-mcp.mjs) and spawned
 * by the Codex App Server (or any MCP client) as a child process. Exposes:
 *   - generate_image: text-to-image via gpt-image-2
 *   - edit_image:     image-to-image edit / restyle / inpaint via gpt-image-2
 *
 * Design contract:
 *   - The `model` parameter is intentionally NOT exposed in the tool schemas.
 *     The server hard-codes `model: "gpt-image-2"`.
 *   - Returns absolute file paths on disk (PNG saved to a temp dir) instead of
 *     inlining base64, to keep the MCP tool result small.
 *   - When n > 1, fires N concurrent n=1 requests via Promise.allSettled to
 *     bypass server-side serial reasoning (gpt-image-2 plans-then-renders each
 *     image, so a single n=4 request can be substantially slower than 4
 *     parallel n=1 requests when the relay/quota allows concurrency).
 *
 * Environment variables:
 *   OPENAI_API_KEY    — required.
 *   OPENAI_BASE_URL   — optional. Custom endpoint (e.g. relay).
 *   OPENAI_IMAGES_OUT — optional. Output directory; default <tmp>/bytro-community-openai-images.
 *   OPENAI_IMAGES_INPUT_ROOTS — required JSON array of canonical directories
 *     approved by the parent process for edit_image inputs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import OpenAI, { toFile } from "openai";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  approvedImageOutputDirectory,
  parseApprovedImageRoots,
  readApprovedImageFile,
} from "./openai-images-path-policy.js";

function diagnosticSummary(raw: string, event: string): string {
  return `event=${event} len=${Buffer.byteLength(raw, "utf8")} sha256=${createHash("sha256").update(raw).digest("hex")}`;
}

// Surface uncaught crashes — they would otherwise vanish into a generic
// codex-side "process exited" with no actionable context.
process.on("uncaughtException", (err) => {
  process.stderr.write(
    `[openai-images-mcp] ${diagnosticSummary(String(err), "images.uncaught")}\n`,
  );
  process.exit(2);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `[openai-images-mcp] ${diagnosticSummary(String(reason), "images.unhandled_rejection")}\n`,
  );
  process.exit(3);
});

const TOOL_MODEL = "gpt-image-2";
// gpt-image-2 with quality=high can take several minutes per image; pin to
// 10 minutes explicitly so callers see a deterministic cap.
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  process.stderr.write("[openai-images-mcp] FATAL: OPENAI_API_KEY env var is required\n");
  process.exit(1);
}

const baseURL = process.env.OPENAI_BASE_URL?.trim() || undefined;
let outDir = process.env.OPENAI_IMAGES_OUT?.trim()
  || join(tmpdir(), "bytro-community-openai-images");

// User-configurable default quality, sourced from the harness via env var.
// Falls back to "low" (matches the ChatGPT web default — fastest path).
const VALID_QUALITIES = new Set(["low", "medium", "high", "auto"]);
const DEFAULT_QUALITY: "low" | "medium" | "high" | "auto" = (() => {
  const v = process.env.OPENAI_IMAGES_QUALITY?.trim().toLowerCase();
  if (v && VALID_QUALITIES.has(v)) return v as "low" | "medium" | "high" | "auto";
  return "low";
})();

// User-configurable default size, sourced via env var. Accepts the popular
// gpt-image-2 presets the harness exposes. Falls back to "auto" so the model
// picks for itself. The agent can still override per-call by passing an
// explicit `size` argument from the tool's input schema.
const VALID_DEFAULT_SIZES = new Set([
  "auto",
  "1024x1024", "1536x1024", "1024x1536",
  "2048x2048", "2048x1152",
  "3840x2160", "2160x3840",
]);
const DEFAULT_SIZE: string = (() => {
  const v = process.env.OPENAI_IMAGES_SIZE?.trim();
  if (v && VALID_DEFAULT_SIZES.has(v)) return v;
  return "auto";
})();

if (!existsSync(outDir)) {
  try {
    mkdirSync(outDir, { recursive: true });
  } catch (err) {
    process.stderr.write(
      `[openai-images-mcp] ${diagnosticSummary(String(err), "images.output_directory_error")}\n`,
    );
    process.exit(4);
  }
}

let approvedImageRoots: readonly string[];
try {
  approvedImageRoots = parseApprovedImageRoots(
    process.env.OPENAI_IMAGES_INPUT_ROOTS,
  );
  outDir = approvedImageOutputDirectory(outDir, approvedImageRoots);
} catch (error) {
  process.stderr.write(
    `[openai-images-mcp] ${diagnosticSummary(
      String(error),
      "images.input_roots_invalid",
    )}\n`,
  );
  process.exit(4);
}

const client = new OpenAI({ apiKey, baseURL, timeout: REQUEST_TIMEOUT_MS });

const mcp = new McpServer(
  { name: "openai-images", version: "0.2.0" },
  {
    instructions:
      `Generate or edit images via the OpenAI Images API. Always uses ${TOOL_MODEL}; ` +
      `there is no way to select an older model.\n` +
      `- generate_image: produce a brand-new image from a text prompt.\n` +
      `- edit_image:     transform an existing image (restyle, inpaint, extend, ` +
      `combine multiple references) by passing absolute file path(s). ` +
      `When the user supplies an image and asks to "modify / restyle / repaint / ` +
      `add something to it", call edit_image — never call generate_image and ` +
      `re-describe the picture.\n` +
      `Returned image paths are absolute local files; reference them in your reply ` +
      `so the user can see/open them.`,
  },
);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Official gpt-image-2 popular sizes (per the OpenAI docs). The model
// accepts any resolution that satisfies the constraints (max edge ≤ 3840,
// both edges multiples of 16, long:short ratio ≤ 3:1, total pixels in
// [655_360, 8_294_400]) — these are the documented presets. 4K outputs
// require server-side upscaling and are flagged beta with potentially
// inconsistent results.
const SizeEnum = z
  .enum([
    "1024x1024",   // 1K square
    "1536x1024",   // 1K landscape
    "1024x1536",   // 1K portrait
    "2048x2048",   // 2K square
    "2048x1152",   // 2K landscape
    "3840x2160",   // 4K landscape (beta)
    "2160x3840",   // 4K portrait (beta)
    "auto",
  ])
  .optional()
  .describe(
    "Image dimensions. Defaults to whatever the harness configured via " +
    "OPENAI_IMAGES_SIZE env, falling back to `auto`. 4K outputs are a " +
    "server-side upscale of the 2K render — beta, may produce inconsistent " +
    "results, and cost roughly 4× the tokens of 2K. Pick a portrait variant " +
    "(1024x1536 / 2160x3840) when the user's prompt is clearly vertical.",
  );

// gpt-image-2 supports low|medium|high|auto. Default `low` mirrors the speed
// users get from chat.openai.com — `high` can take 1–3 minutes per image.
const QualityEnum = z
  .enum(["low", "medium", "high", "auto"])
  .optional()
  .describe(
    "Render quality / cost trade-off. `low` (default, ~10–30s) matches the " +
    "ChatGPT web experience; `high` is much slower (1–3 min per image). " +
    "Use `auto` to let the server decide. Only escalate to `medium`/`high` " +
    "when the user explicitly asks for higher fidelity.",
  );

const NEnum = z
  .number()
  .int()
  .min(1)
  .max(4)
  .optional()
  .describe("Number of images to generate (1-4). Default: 1.");

interface SavedImage { path: string; size: string }

const ALLOWED_EDIT_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_EDIT_BYTES = 50 * 1024 * 1024;
const MAX_MASK_BYTES = 4 * 1024 * 1024;
const PUBLIC_IMAGE_POLICY_ERRORS = new Set([
  "Image path is invalid",
  "Image input must be a regular file",
  "Image path is outside approved directories",
  "Image input changed during validation",
  "Image input exceeds the allowed size",
  "Linked image paths are not allowed",
  "Reparse-point image paths are not allowed",
]);

function detectMime(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

async function loadAsUploadable(
  path: string,
  maxBytes: number = MAX_EDIT_BYTES,
  allowedExtensions: ReadonlySet<string> = ALLOWED_EDIT_EXTS,
) {
  const ext = extname(path).toLowerCase();
  if (!allowedExtensions.has(ext)) {
    throw new Error("Image input has an unsupported extension");
  }
  let loaded: ReturnType<typeof readApprovedImageFile>;
  try {
    loaded = readApprovedImageFile(path, approvedImageRoots, maxBytes);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[openai-images-mcp] ${diagnosticSummary(
        raw,
        "images.path_policy_error",
      )}\n`,
    );
    throw new Error(
      PUBLIC_IMAGE_POLICY_ERRORS.has(raw)
        ? raw
        : "Image input failed validation",
    );
  }
  return toFile(loaded.buffer, basename(loaded.canonicalPath), {
    type: detectMime(loaded.canonicalPath),
  });
}

// ---------------------------------------------------------------------------
// One-shot lane runner — gpt-image-2 non-streaming. Streaming was removed
// because third-party proxies don't reliably support SSE for the images API
// (PROTOCOL_ERROR / "not async iterable" / silent connection drops were
// frequent), and codex's MCP client doesn't subscribe to progress
// notifications anyway, so partial frames never reached the UI.
// ---------------------------------------------------------------------------

interface LaneResult {
  savedPath: string | null;
  error: string | null;
}

async function runOneShotLane(
  generate: () => Promise<{ data?: Array<{ b64_json?: string; url?: string }> }>,
  laneIndex: number,
): Promise<LaneResult> {
  try {
    const result = await generate();
    const item = result?.data?.[0];
    if (!item?.b64_json) {
      return { savedPath: null, error: "response missing b64_json" };
    }
    const buf = Buffer.from(item.b64_json, "base64");
    const finalFilename = `${Date.now()}-${randomUUID().slice(0, 8)}-lane${laneIndex}.png`;
    const finalPath = join(outDir, finalFilename);
    writeFileSync(finalPath, buf);
    // Normalize separators to forward slashes before handing the path back to
    // the MCP client. Windows accepts `/` in every fs API, but every backslash
    // we emit becomes a transit-time escape hazard:
    //   - JSON.stringify doubles `\` to `\\` once; inner-then-outer wrapping
    //     by codex/sidecar can compound it
    //   - the LLM frequently pastes the path back into chat markdown, where
    //     CommonMark eats `\` before ASCII punctuation (`\:`, `\.`, ...)
    //   - the same path rendered in different surfaces (chat, log, copy
    //     button) ends up with subtly different separator counts
    // Returning `/` everywhere makes the path round-trip identical no matter
    // how many encoders touch it.
    const portablePath = finalPath.split("\\").join("/");
    return { savedPath: portablePath, error: null };
  } catch (err) {
    return {
      savedPath: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface DiagnosticInfo {
  /** Args the agent originally sent — verbatim. */
  readonly agentArgs: Record<string, unknown>;
  /** Final params actually sent to OpenAI after harness overrides. */
  readonly resolved: { size: string; quality: string; n: number };
  /** Per-key list of fields the harness overrode (agent value → forced value). */
  readonly overrides: Array<{ field: string; from: unknown; to: unknown; reason: string }>;
}

function buildResultPayload(
  saved: SavedImage[],
  errors: string[],
  isError: boolean,
  diag?: DiagnosticInfo,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const body: Record<string, unknown> = {
    model: TOOL_MODEL,
    count: saved.length,
    images: saved,
  };
  if (errors.length > 0) body.errors = errors;
  if (isError && saved.length === 0 && errors[0]) body.error = errors[0];
  // Diagnostic info travels back through codex → sidecar tool_result event,
  // bypassing the MCP-stderr channel that codex tends to swallow. The UI's
  // tool-result-display picks `images` out and ignores the rest, so this
  // adds zero noise to the chat but is fully visible in the raw result.
  if (diag) body.diagnostics = diag;
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// generate_image — text-to-image
// ---------------------------------------------------------------------------

mcp.registerTool(
  "generate_image",
  {
    description:
      `Generate a brand-new image from a text prompt with OpenAI ${TOOL_MODEL}. ` +
      `Returns absolute file paths to PNG files saved on disk. ` +
      `Use whenever the user asks for an entirely new picture (illustration, ` +
      `mockup, icon, banner, etc.) without supplying a reference image. ` +
      `If the user attached an image and wants it modified, use \`edit_image\` instead.`,
    inputSchema: {
      prompt: z.string().min(1).describe("Detailed text prompt describing the desired image."),
      size: SizeEnum,
      quality: QualityEnum,
      n: NEnum,
    },
  },
  async (args) => {
    const prompt = args.prompt.trim();
    process.stderr.write(
      `[openai-images-mcp] ${diagnosticSummary(JSON.stringify(args), "images.generate_input")}\n`,
    );
    const overrides: DiagnosticInfo["overrides"] = [];
    const size = DEFAULT_SIZE !== "auto" ? DEFAULT_SIZE : (args.size ?? "auto");
    if (DEFAULT_SIZE !== "auto" && args.size !== DEFAULT_SIZE) {
      overrides.push({ field: "size", from: args.size ?? "<unset>", to: DEFAULT_SIZE, reason: "harness preference (OPENAI_IMAGES_SIZE)" });
      process.stderr.write(
        `[openai-images-mcp] generate_image: overriding size ${args.size ?? "<unset>"} → ${DEFAULT_SIZE}\n`,
      );
    }
    const quality = DEFAULT_QUALITY !== "auto" ? DEFAULT_QUALITY : (args.quality ?? "auto");
    if (DEFAULT_QUALITY !== "auto" && args.quality !== DEFAULT_QUALITY) {
      overrides.push({ field: "quality", from: args.quality ?? "<unset>", to: DEFAULT_QUALITY, reason: "harness preference (OPENAI_IMAGES_QUALITY)" });
      process.stderr.write(
        `[openai-images-mcp] generate_image: overriding quality ${args.quality ?? "<unset>"} → ${DEFAULT_QUALITY}\n`,
      );
    }
    const n = args.n ?? 1;

    process.stderr.write(
      `[openai-images-mcp] generate_image RESOLVED size=${size} quality=${quality} n=${n} ` +
      `${diagnosticSummary(prompt, "images.prompt")}\n`,
    );

    const buildBaseParams = () => ({
      model: TOOL_MODEL,
      prompt,
      size,
      quality,
      n: 1,
    });

    const tasks = Array.from({ length: n }, (_, i) =>
      runOneShotLane(
        () =>
          client.images.generate(
            buildBaseParams() as unknown as Parameters<typeof client.images.generate>[0],
          ) as unknown as Promise<{ data?: Array<{ b64_json?: string }> }>,
        i,
      ),
    );
    const results = await Promise.allSettled(tasks);

    const saved: SavedImage[] = [];
    const errors: string[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value.savedPath) saved.push({ path: r.value.savedPath, size });
        if (r.value.error) errors.push(r.value.error);
      } else {
        errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
      }
    }
    process.stderr.write(`[openai-images-mcp] generate_image: saved=${saved.length} errors=${errors.length}\n`);
    const diag: DiagnosticInfo = {
      agentArgs: args as Record<string, unknown>,
      resolved: { size, quality, n },
      overrides,
    };
    return buildResultPayload(saved, errors, saved.length === 0, diag);
  },
);

// ---------------------------------------------------------------------------
// edit_image — image-to-image (restyle / inpaint / extend / combine)
// ---------------------------------------------------------------------------

mcp.registerTool(
  "edit_image",
  {
    description:
      `Edit / transform an existing image (restyle, inpaint, extend, or combine ` +
      `multiple reference images) using OpenAI ${TOOL_MODEL}. Returns absolute ` +
      `file paths to PNG files saved on disk.\n\n` +
      `Call this tool whenever the user has provided one or more reference ` +
      `images and asks to "modify / restyle / repaint / add ... to / merge / ` +
      `turn into ... style" them. Never call \`generate_image\` and re-describe ` +
      `an attached picture — \`edit_image\` preserves identity and composition ` +
      `from the source.\n\n` +
      `\`image_path\` accepts the absolute path(s) the harness exposes when the ` +
      `user attaches an image (the user message will contain a hint like ` +
      `"[Attached image saved at ...]"), OR a path returned previously by ` +
      `\`generate_image\`/\`edit_image\`.`,
    inputSchema: {
      image_path: z
        .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(16)])
        .describe(
          "Absolute path(s) to source image file(s). Accepts a single path or " +
          "an array of up to 16 paths. Supported formats: .png, .jpg, .jpeg, .webp. " +
          "Each file must be < 50MB.",
        ),
      prompt: z
        .string()
        .min(1)
        .describe("Instruction describing the desired edit / transformation."),
      mask_path: z
        .string()
        .optional()
        .describe(
          "Optional PNG mask. Fully transparent regions (alpha=0) are the area " +
          "that will be edited; opaque regions are preserved. Must match the " +
          "first image's dimensions and be < 4MB. Only PNG is accepted for masks.",
        ),
      size: SizeEnum,
      quality: QualityEnum,
      n: NEnum,
    },
  },
  async (args) => {
    const prompt = args.prompt.trim();
    process.stderr.write(
      `[openai-images-mcp] ${diagnosticSummary(JSON.stringify(args), "images.edit_input")}\n`,
    );
    const overrides: DiagnosticInfo["overrides"] = [];
    const size = DEFAULT_SIZE !== "auto" ? DEFAULT_SIZE : (args.size ?? "auto");
    if (DEFAULT_SIZE !== "auto" && args.size !== DEFAULT_SIZE) {
      overrides.push({ field: "size", from: args.size ?? "<unset>", to: DEFAULT_SIZE, reason: "harness preference (OPENAI_IMAGES_SIZE)" });
      process.stderr.write(
        `[openai-images-mcp] edit_image: overriding size ${args.size ?? "<unset>"} → ${DEFAULT_SIZE}\n`,
      );
    }
    const quality = DEFAULT_QUALITY !== "auto" ? DEFAULT_QUALITY : (args.quality ?? "auto");
    if (DEFAULT_QUALITY !== "auto" && args.quality !== DEFAULT_QUALITY) {
      overrides.push({ field: "quality", from: args.quality ?? "<unset>", to: DEFAULT_QUALITY, reason: "harness preference (OPENAI_IMAGES_QUALITY)" });
      process.stderr.write(
        `[openai-images-mcp] edit_image: overriding quality ${args.quality ?? "<unset>"} → ${DEFAULT_QUALITY}\n`,
      );
    }
    const n = args.n ?? 1;
    const paths = Array.isArray(args.image_path) ? args.image_path : [args.image_path];

    process.stderr.write(
      `[openai-images-mcp] edit_image RESOLVED paths=${paths.length} size=${size} quality=${quality} n=${n}\n`,
    );

    // Validate + load all sources up-front so a bad path fails fast.
    let images: Awaited<ReturnType<typeof loadAsUploadable>>[] | undefined;
    let mask: Awaited<ReturnType<typeof loadAsUploadable>> | undefined;
    try {
      images = await Promise.all(
        paths.map((path) => loadAsUploadable(path)),
      );
      if (args.mask_path) {
        mask = await loadAsUploadable(
          args.mask_path,
          MAX_MASK_BYTES,
          new Set([".png"]),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[openai-images-mcp] ${diagnosticSummary(msg, "images.input_error")}\n`,
      );
      return buildResultPayload([], [msg], true);
    }

    const buildBaseEditParams = () => ({
      model: TOOL_MODEL,
      image: images!.length === 1 ? images![0] : images!,
      prompt,
      size,
      quality,
      n: 1,
      ...(mask ? { mask } : {}),
    });

    const tasks = Array.from({ length: n }, (_, i) =>
      runOneShotLane(
        () =>
          client.images.edit(
            buildBaseEditParams() as unknown as Parameters<typeof client.images.edit>[0],
          ) as unknown as Promise<{ data?: Array<{ b64_json?: string }> }>,
        i,
      ),
    );
    const results = await Promise.allSettled(tasks);

    const saved: SavedImage[] = [];
    const finalErrors: string[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value.savedPath) saved.push({ path: r.value.savedPath, size });
        if (r.value.error) finalErrors.push(r.value.error);
      } else {
        finalErrors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
      }
    }
    process.stderr.write(`[openai-images-mcp] edit_image: saved=${saved.length} errors=${finalErrors.length}\n`);
    const diag: DiagnosticInfo = {
      agentArgs: args as Record<string, unknown>,
      resolved: { size, quality, n },
      overrides,
    };
    return buildResultPayload(saved, finalErrors, saved.length === 0, diag);
  },
);

const transport = new StdioServerTransport();
try {
  await mcp.connect(transport);
} catch (err) {
  process.stderr.write(
    `[openai-images-mcp] ${diagnosticSummary(String(err), "images.connect_error")}\n`,
  );
  process.exit(5);
}
