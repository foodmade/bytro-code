#!/usr/bin/env node

/**
 * Run sidecar build and frontend build in parallel, then prepare resources.
 * Used as Tauri's beforeBuildCommand to speed up the build pipeline.
 */

const { execSync, spawn } = require("child_process");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");

function runAsync(label, command) {
  return new Promise((resolve, reject) => {
    console.log(`[parallel-build] Starting: ${label}`);
    const start = Date.now();
    const child = spawn(command, {
      cwd: rootDir,
      stdio: "inherit",
      shell: true,
    });
    child.on("close", (code) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`[parallel-build] Done: ${label} (${elapsed}s)`);
        resolve();
      } else {
        reject(new Error(`${label} failed with exit code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

async function main() {
  const totalStart = Date.now();

  // Run the public sidecar and frontend builds in parallel.
  await Promise.all([
    runAsync("sidecar", "npm run build:sidecar"),
    runAsync("frontend", "npm run build"),
  ]);

  // Prepare resources (depends on sidecar output, must run after)
  console.log("[parallel-build] Preparing resources...");
  execSync("node scripts/prepare-resources.js", {
    cwd: rootDir,
    stdio: "inherit",
  });

  const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`[parallel-build] All done (${totalElapsed}s)`);
}

main().catch((err) => {
  console.error("[parallel-build] Failed:", err.message);
  process.exit(1);
});
