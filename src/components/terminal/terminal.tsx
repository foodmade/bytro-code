import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useIsLightTheme } from "@/hooks/use-is-light-theme";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  readonly sessionId: string | null;
}

const XTERM_DARK_THEME = {
  background: "#0A0A0A",
  foreground: "#E0E0E0",
  cursor: "#10B981",
  cursorAccent: "#0A0A0A",
  selectionBackground: "#A855F733",
  selectionForeground: "#E0E0E0",
  black: "#1E1E1E",
  red: "#F87171",
  green: "#4ADE80",
  yellow: "#FACC15",
  blue: "#60A5FA",
  magenta: "#C084FC",
  cyan: "#22D3EE",
  white: "#E0E0E0",
  brightBlack: "#525252",
  brightRed: "#FCA5A5",
  brightGreen: "#86EFAC",
  brightYellow: "#FDE68A",
  brightBlue: "#93C5FD",
  brightMagenta: "#D8B4FE",
  brightCyan: "#67E8F9",
  brightWhite: "#F5F5F5",
};

const XTERM_LIGHT_THEME = {
  background: "#FFFFFF",
  foreground: "#1A1A1E",
  cursor: "#10B981",
  cursorAccent: "#FFFFFF",
  selectionBackground: "#A855F730",
  selectionForeground: "#1A1A1E",
  black: "#1A1A1E",
  red: "#DC2626",
  green: "#16A34A",
  yellow: "#CA8A04",
  blue: "#2563EB",
  magenta: "#9333EA",
  cyan: "#0891B2",
  white: "#E5E7EB",
  brightBlack: "#6B7280",
  brightRed: "#EF4444",
  brightGreen: "#22C55E",
  brightYellow: "#EAB308",
  brightBlue: "#3B82F6",
  brightMagenta: "#A855F7",
  brightCyan: "#06B6D4",
  brightWhite: "#F9FAFB",
};

export function Terminal({ sessionId }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const isLight = useIsLightTheme();

  // Keep sessionId ref in sync so ResizeObserver always has the latest value
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Update xterm theme when system theme changes
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme = isLight ? XTERM_LIGHT_THEME : XTERM_DARK_THEME;
  }, [isLight]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      theme: isLight ? XTERM_LIGHT_THEME : XTERM_DARK_THEME,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 14,
      lineHeight: 1.3,
      cursorBlink: false,
      cursorStyle: "block",
      allowProposedApi: true,
      scrollback: 10000,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 4.5,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const unicode11Addon = new Unicode11Addon();
    term.loadAddon(unicode11Addon);
    term.unicode.activeVersion = "11";

    term.open(containerRef.current);

    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      term.loadAddon(webglAddon);
    } catch {
      // WebGL not available, fall back to canvas
    }

    try {
      fitAddon.fit();
    } catch {
      // Container may not be visible
    }

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          fitAddon.fit();
          const sid = sessionIdRef.current;
          if (sid) {
            invoke("resize_pty", {
              sessionId: sid,
              rows: term.rows,
              cols: term.cols,
            }).catch((err) => {
              console.error("resize_pty failed:", err);
            });
          }
        } catch {
          // Ignore
        }
      });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [isLight]);

  // When sessionId becomes available, do an initial fit + resize to sync PTY dimensions
  useEffect(() => {
    if (!sessionId || !termRef.current || !fitAddonRef.current) return;

    const term = termRef.current;
    const fitAddon = fitAddonRef.current;

    // Small delay to ensure container is fully laid out
    const timer = setTimeout(() => {
      try {
        fitAddon.fit();
        term.focus();
        invoke("resize_pty", {
          sessionId,
          rows: term.rows,
          cols: term.cols,
        }).catch((err) => {
          console.error("Initial resize_pty failed:", err);
        });
      } catch {
        // Ignore
      }
    }, 50);

    return () => clearTimeout(timer);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !termRef.current) return;

    const term = termRef.current;
    const unlisteners: UnlistenFn[] = [];

    const dataDisposable = term.onData((data) => {
      invoke("write_pty", { sessionId, data }).catch((err) => {
        console.error("write_pty failed:", err);
      });
    });

    const setup = async () => {
      const unlistenOutput = await listen<{ session_id: string; data: string }>(
        "pty-output",
        (event) => {
          if (event.payload.session_id === sessionId) {
            term.write(event.payload.data);
          }
        },
      );
      unlisteners.push(unlistenOutput);

      const unlistenExit = await listen<{ session_id: string }>(
        "pty-exit",
        (event) => {
          if (event.payload.session_id === sessionId) {
            term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
          }
        },
      );
      unlisteners.push(unlistenExit);
    };

    setup();

    return () => {
      dataDisposable.dispose();
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, [sessionId]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full p-1"
      style={{ backgroundColor: isLight ? XTERM_LIGHT_THEME.background : XTERM_DARK_THEME.background }}
    />
  );
}
