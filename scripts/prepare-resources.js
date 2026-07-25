/**
 * Stage public runtime resources for Tauri bundling.
 *
 * The community edition bundles the compiled Sidecar only. Codex, Claude, and
 * other CLI executables must already exist on the local machine; Canvas and
 * OpenPencil resources are intentionally not part of this repository.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, "..");
const sidecarDist = join(projectRoot, "sidecar", "dist");
const resourceDir = join(projectRoot, "resources", "sidecar");

const sidecarBundle = join(sidecarDist, "bundle.mjs");
if (!existsSync(sidecarBundle)) {
  throw new Error(
    "sidecar/dist/bundle.mjs not found. Run 'npm run build:sidecar' first.",
  );
}

mkdirSync(resourceDir, { recursive: true });
rmSync(join(resourceDir, "bundle.mjs"), { force: true });
rmSync(join(resourceDir, "openai-images-mcp.mjs"), { force: true });
copyFileSync(sidecarBundle, join(resourceDir, "bundle.mjs"));
console.log("[prepare] Copied Sidecar bundle");

const imageMcpBundle = join(sidecarDist, "openai-images-mcp.mjs");
if (existsSync(imageMcpBundle)) {
  copyFileSync(imageMcpBundle, join(resourceDir, "openai-images-mcp.mjs"));
  console.log("[prepare] Copied optional OpenAI Images MCP bundle");
}

console.log("[prepare] Public runtime resources are ready");
