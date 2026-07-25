import { useCallback, useEffect, useRef, useState } from "react";
import { X, Minus, Maximize2, Minimize2, Pencil } from "lucide-react";
import { useTerminalStore } from "@/stores";
import { useTerminal } from "@/hooks/use-terminal";
import { Terminal } from "./terminal";

export function TerminalPopup() {
  const { popupOpen, popupCwd, closePopup } = useTerminalStore();
  const { createSession, closeSession } = useTerminal();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [customTitle, setCustomTitle] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleCommittedRef = useRef(false);
  const [size, setSize] = useState({ width: 720, height: 420 });
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; posX: number; posY: number } | null>(
    null,
  );
  const popupRef = useRef<HTMLDivElement>(null);

  // Initialize position to center on first open
  useEffect(() => {
    if (popupOpen && !position) {
      setPosition({
        x: Math.max(0, (window.innerWidth - size.width) / 2),
        y: Math.max(0, (window.innerHeight - size.height) / 2),
      });
    }
  }, [popupOpen, position, size.width, size.height]);

  // Auto-focus title input when entering edit mode
  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [editingTitle]);

  // Clamp position & size when browser window resizes
  const sizeRef = useRef(size);
  sizeRef.current = size;
  useEffect(() => {
    const handleWindowResize = () => {
      if (maximized || minimized) return;
      const currentSize = sizeRef.current;
      setSize((prev) => ({
        width: Math.max(400, Math.min(prev.width, window.innerWidth)),
        height: Math.max(250, Math.min(prev.height, window.innerHeight)),
      }));
      setPosition((prev) => {
        if (!prev) return prev;
        return {
          x: Math.max(0, Math.min(prev.x, window.innerWidth - currentSize.width)),
          y: Math.max(0, Math.min(prev.y, window.innerHeight - currentSize.height)),
        };
      });
    };
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [maximized, minimized]);

  // Create PTY session when popup opens
  useEffect(() => {
    if (!popupOpen || !popupCwd) return;

    let cancelled = false;
    const currentSize = sizeRef.current;
    // Estimate initial cols/rows based on popup size to avoid line-wrapping mismatch.
    // xterm char width ~8.4px (fontSize 14, JetBrains Mono), line height ~18.2px (14 * 1.3)
    const estimatedCols = Math.max(40, Math.floor((currentSize.width - 16) / 8.4));
    const estimatedRows = Math.max(10, Math.floor((currentSize.height - 36 - 8) / 18.2));
    createSession({
      cwd: popupCwd,
      title: popupCwd.split(/[/\\]/).pop() ?? "Terminal",
      cols: estimatedCols,
      rows: estimatedRows,
    })
      .then((id) => {
        if (!cancelled) setSessionId(id);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [popupOpen, popupCwd, createSession]);

  const handleClose = useCallback(() => {
    if (sessionId) {
      closeSession(sessionId);
    }
    setSessionId(null);
    setMinimized(false);
    setMaximized(false);
    setCustomTitle(null);
    setEditingTitle(false);
    closePopup();
  }, [sessionId, closeSession, closePopup]);

  // Drag handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (maximized) return;
      if (!position) return;
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        posX: position.x,
        posY: position.y,
      };
      const handleMouseMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const dx = ev.clientX - dragRef.current.startX;
        const dy = ev.clientY - dragRef.current.startY;
        const newX = Math.max(
          0,
          Math.min(dragRef.current.posX + dx, window.innerWidth - size.width),
        );
        const newY = Math.max(
          0,
          Math.min(dragRef.current.posY + dy, window.innerHeight - size.height),
        );
        setPosition({ x: newX, y: newY });
      };
      const handleMouseUp = () => {
        dragRef.current = null;
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [maximized, position, size.width, size.height],
  );

  // Generic resize handler for all edges and corners
  type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
  const handleEdgeResize = useCallback(
    (e: React.MouseEvent, direction: ResizeDirection) => {
      if (maximized) return;
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = size.width;
      const startH = size.height;
      const startPosX = position?.x ?? 0;
      const startPosY = position?.y ?? 0;

      const resizesLeft = direction.includes("w");
      const resizesRight = direction.includes("e");
      const resizesTop = direction.includes("n");
      const resizesBottom = direction.includes("s");

      const handleMouseMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        let newW = startW;
        let newH = startH;
        let newX = startPosX;
        let newY = startPosY;

        if (resizesRight) {
          newW = Math.max(400, Math.min(startW + dx, window.innerWidth - startPosX));
        }
        if (resizesBottom) {
          newH = Math.max(250, Math.min(startH + dy, window.innerHeight - startPosY));
        }
        if (resizesLeft) {
          const maxDx = startW - 400;
          const clampedDx = Math.max(-startPosX, Math.min(dx, maxDx));
          newW = startW - clampedDx;
          newX = startPosX + clampedDx;
        }
        if (resizesTop) {
          const maxDy = startH - 250;
          const clampedDy = Math.max(-startPosY, Math.min(dy, maxDy));
          newH = startH - clampedDy;
          newY = startPosY + clampedDy;
        }

        setSize({ width: newW, height: newH });
        setPosition({ x: newX, y: newY });
      };
      const handleMouseUp = () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [maximized, size, position],
  );

  if (!popupOpen) return null;

  const popupStyle: React.CSSProperties = maximized
    ? { position: "fixed", inset: 0, zIndex: 9999 }
    : {
        position: "fixed",
        left: position?.x ?? 0,
        top: position?.y ?? 0,
        width: size.width,
        height: size.height,
        zIndex: 9999,
      };

  return (
    <>
      {/* Minimized restore button */}
      {minimized && (
        <div
          style={{
            position: "fixed",
            bottom: 16,
            right: 16,
            zIndex: 9999,
          }}
        >
          <button
            onClick={() => setMinimized(false)}
            className="flex items-center gap-2 transition-colors"
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              color: "var(--color-foreground)",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              boxShadow: "var(--shadow-float)",
            }}
          >
            <Maximize2 size={14} />
            {customTitle ?? popupCwd?.split(/[/\\]/).pop() ?? "Terminal"}
          </button>
        </div>
      )}

      {/* Main popup — hidden via CSS when minimized to preserve xterm.js buffer */}
      <div
        ref={popupRef}
        style={{
          ...popupStyle,
          display: minimized ? "none" : "flex",
          flexDirection: "column",
          borderRadius: maximized ? 0 : 10,
          overflow: "hidden",
          border: maximized ? "none" : "1px solid var(--color-border-strong)",
          boxShadow: maximized ? "none" : "var(--shadow-float)",
        }}
      >
        {/* Title bar */}
        <div
          onMouseDown={handleMouseDown}
          className="flex items-center justify-between select-none shrink-0"
          style={{
            height: 36,
            padding: "0 10px",
            background: "var(--color-surface-alt)",
            borderBottom: "1px solid var(--color-border)",
            cursor: maximized ? "default" : "move",
          }}
        >
          {editingTitle ? (
            <input
              ref={titleInputRef}
              defaultValue={customTitle ?? popupCwd?.split(/[/\\]/).pop() ?? "Terminal"}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (val) setCustomTitle(val);
                  titleCommittedRef.current = true;
                  setEditingTitle(false);
                } else if (e.key === "Escape") {
                  titleCommittedRef.current = true;
                  setEditingTitle(false);
                }
              }}
              onBlur={(e) => {
                if (titleCommittedRef.current) {
                  titleCommittedRef.current = false;
                  return;
                }
                const val = e.target.value.trim();
                if (val) setCustomTitle(val);
                setEditingTitle(false);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "var(--color-foreground)",
                fontFamily: "Inter, sans-serif",
                background: "var(--color-surface)",
                border: "1px solid var(--color-accent-purple)",
                borderRadius: 4,
                padding: "2px 6px",
                outline: "none",
                width: 160,
              }}
            />
          ) : (
            <div
              className="group/title flex items-center gap-1"
              onDoubleClick={() => setEditingTitle(true)}
              title="Double click to rename"
              style={{ cursor: "default" }}
            >
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--color-muted-foreground)",
                  fontFamily: "Inter, sans-serif",
                }}
              >
                {customTitle ?? popupCwd?.split(/[/\\]/).pop() ?? "Terminal"}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingTitle(true);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className="opacity-0 group-hover/title:opacity-100 transition-opacity flex items-center justify-center"
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 3,
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--color-muted)",
                }}
              >
                <Pencil size={11} />
              </button>
            </div>
          )}
          <div className="flex items-center" style={{ gap: 4 }}>
            <button
              onClick={() => setMinimized(true)}
              className="flex items-center justify-center transition-colors native-css-hover"
              style={
                {
                  width: 24,
                  height: 24,
                  borderRadius: 4,
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--color-muted)",
                  "--native-hover-bg-color": "var(--color-surface-alt)",
                } as React.CSSProperties
              }
            >
              <Minus size={14} />
            </button>
            <button
              onClick={() => setMaximized((prev) => !prev)}
              className="flex items-center justify-center transition-colors native-css-hover"
              style={
                {
                  width: 24,
                  height: 24,
                  borderRadius: 4,
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--color-muted)",
                  "--native-hover-bg-color": "var(--color-surface-alt)",
                } as React.CSSProperties
              }
            >
              {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button
              onClick={handleClose}
              className="flex items-center justify-center transition-colors native-css-hover"
              style={
                {
                  width: 24,
                  height: 24,
                  borderRadius: 4,
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--color-muted)",
                  "--native-hover-bg-color": "#ef444420",
                  "--native-hover-color": "#ef4444",
                } as React.CSSProperties
              }
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Terminal content */}
        <div className="flex-1 min-h-0">
          <Terminal sessionId={sessionId} />
        </div>

        {/* Resize handles — edges (4px thick) and corners (12×12) */}
        {!maximized && (
          <>
            {/* Top edge */}
            <div
              onMouseDown={(e) => handleEdgeResize(e, "n")}
              style={{
                position: "absolute",
                top: -2,
                left: 12,
                right: 12,
                height: 4,
                cursor: "ns-resize",
              }}
            />
            {/* Bottom edge */}
            <div
              onMouseDown={(e) => handleEdgeResize(e, "s")}
              style={{
                position: "absolute",
                bottom: -2,
                left: 12,
                right: 12,
                height: 4,
                cursor: "ns-resize",
              }}
            />
            {/* Left edge */}
            <div
              onMouseDown={(e) => handleEdgeResize(e, "w")}
              style={{
                position: "absolute",
                left: -2,
                top: 12,
                bottom: 12,
                width: 4,
                cursor: "ew-resize",
              }}
            />
            {/* Right edge */}
            <div
              onMouseDown={(e) => handleEdgeResize(e, "e")}
              style={{
                position: "absolute",
                right: -2,
                top: 12,
                bottom: 12,
                width: 4,
                cursor: "ew-resize",
              }}
            />
            {/* Top-left corner */}
            <div
              onMouseDown={(e) => handleEdgeResize(e, "nw")}
              style={{
                position: "absolute",
                top: -2,
                left: -2,
                width: 12,
                height: 12,
                cursor: "nwse-resize",
              }}
            />
            {/* Top-right corner */}
            <div
              onMouseDown={(e) => handleEdgeResize(e, "ne")}
              style={{
                position: "absolute",
                top: -2,
                right: -2,
                width: 12,
                height: 12,
                cursor: "nesw-resize",
              }}
            />
            {/* Bottom-left corner */}
            <div
              onMouseDown={(e) => handleEdgeResize(e, "sw")}
              style={{
                position: "absolute",
                bottom: -2,
                left: -2,
                width: 12,
                height: 12,
                cursor: "nesw-resize",
              }}
            />
            {/* Bottom-right corner */}
            <div
              onMouseDown={(e) => handleEdgeResize(e, "se")}
              style={{
                position: "absolute",
                bottom: -2,
                right: -2,
                width: 12,
                height: 12,
                cursor: "nwse-resize",
              }}
            />
          </>
        )}
      </div>
    </>
  );
}
