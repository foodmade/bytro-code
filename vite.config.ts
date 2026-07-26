import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "fs";
import crypto from "crypto";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const fileHashCache = new Map<string, string>();
const manualChunkGroups = {
  "vendor-react": ["react", "react-dom"],
  "vendor-markdown": [
    "react-markdown",
    "remark-gfm",
    "rehype-highlight",
    "highlight.js",
  ],
  "vendor-xterm": [
    "@xterm/xterm",
    "@xterm/addon-fit",
    "@xterm/addon-webgl",
  ],
  "vendor-xyflow": ["@xyflow/react"],
} as const;

function skipUnchangedPlugin() {
  return {
    name: "skip-unchanged-files",
    handleHotUpdate({ file, server }: { file: string; server: unknown }) {
      try {
        const content = fs.readFileSync(file);
        const newHash = crypto.createHash("md5").update(content).digest("hex");
        const oldHash = fileHashCache.get(file);
        if (oldHash === newHash) {
          return [];
        }
        fileHashCache.set(file, newHash);
      } catch {
        // 文件不可读时忽略，交给 Vite 默认处理
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [skipUnchangedPlugin(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  build: {
    // The CodeMirror editor chunk exceeds the 500KB default and some feature
    // chunks top 300KB. Raise the limit to silence noisy warnings while still
    // catching accidental 1MB+ chunks.
    chunkSizeWarningLimit: 1000,
    // Skip gzip size reporting during build — speeds up builds noticeably on large projects.
    reportCompressedSize: false,
    // No source maps in production Tauri builds (they're not uploaded anywhere).
    sourcemap: false,
    rolldownOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
      },
      output: {
        manualChunks(id) {
          const normalizedId = id.replaceAll("\\", "/");
          for (const [chunkName, packageNames] of Object.entries(manualChunkGroups)) {
            if (
              packageNames.some((packageName) =>
                normalizedId.includes(`/node_modules/${packageName}/`),
              )
            ) {
              return chunkName;
            }
          }
        },
        minify: {
          compress: {
            dropConsole: mode === "production",
            dropDebugger: mode === "production",
          },
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore non-frontend trees. The app can read and touch
      // docs during SDK/tool regression; those files are not part of Vite's
      // module graph and should not full-reload the desktop shell.
      ignored: ["**/src-tauri/**", "**/docs/**", "**/*.pen"],
    },
  },
}));
