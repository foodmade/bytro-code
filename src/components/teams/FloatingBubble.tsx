/**
 * FloatingBubble - Enhanced canvas message input.
 *
 * Features:
 *   - @mention dropdown with agent list
 *   - Agent quick-select chips
 *   - Image paste from clipboard
 *   - File attachment upload button
 *   - Smooth hover scale + focus glow animations
 */
import { useState, useRef, useCallback, useMemo } from "react";
import { ArrowUp, Paperclip, X } from "lucide-react";
import { resizeImageIfNeeded } from "@/lib/image-resize";
import { ROLE_META } from "@/stores";
import type { AgentRole } from "@/stores";

function guessRoleForColor(name: string): AgentRole {
  const lower = name.toLowerCase();
  if (lower === "main" || lower.includes("orchestrat")) return "orchestrator";
  if (lower.includes("lead")) return "leader";
  if (lower.includes("review")) return "reviewer";
  if (lower.includes("research") || lower.includes("explore")) return "researcher";
  if (lower.includes("test")) return "tester";
  return "coder";
}

interface Attachment {
  readonly id: string;
  readonly type: "image" | "file";
  readonly name: string;
  readonly dataUrl?: string;
}

/** Image payload sent to the backend (base64-encoded, no data URL prefix). */
export interface ImagePayload {
  readonly media_type: string;
  readonly data: string;
}

interface FloatingBubbleProps {
  readonly onSend?: (message: string, images?: ReadonlyArray<ImagePayload>) => void;
  readonly placeholder?: string;
  readonly agentNames?: ReadonlyArray<string>;
}

export function FloatingBubble({
  onSend,
  placeholder = "Message your team...",
  agentNames = [],
}: FloatingBubbleProps) {
  const [message, setMessage] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasContent = message.trim().length > 0 || attachments.length > 0;

  const filteredAgents = useMemo(() => {
    if (!mentionFilter) return [...agentNames];
    return agentNames.filter((n) => n.toLowerCase().startsWith(mentionFilter.toLowerCase()));
  }, [agentNames, mentionFilter]);

  const currentTarget = useMemo(() => {
    const match = message.match(/^@(\S+)\s/);
    return match ? match[1] : undefined;
  }, [message]);

  const handleSubmit = useCallback(() => {
    const trimmed = message.trim();
    if (!trimmed && attachments.length === 0) return;

    // Extract base64 image data from attachments
    const imagePayloads: ImagePayload[] = [];
    for (const att of attachments) {
      if (att.type === "image" && att.dataUrl) {
        const match = att.dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (match) {
          imagePayloads.push({ media_type: match[1], data: match[2] });
        }
      }
    }

    // If only images and no text, provide a brief description
    const finalText =
      trimmed ||
      (imagePayloads.length > 0
        ? `(${imagePayloads.length} image${imagePayloads.length > 1 ? "s" : ""})`
        : "");

    onSend?.(finalText, imagePayloads.length > 0 ? imagePayloads : undefined);
    setMessage("");
    setAttachments([]);
  }, [message, attachments, onSend]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setMessage(val);

    const atIdx = val.lastIndexOf("@");
    if (atIdx >= 0) {
      const afterAt = val.slice(atIdx + 1);
      const charBefore = atIdx > 0 ? val[atIdx - 1] : " ";
      if ((charBefore === " " || atIdx === 0) && !afterAt.includes(" ")) {
        setShowMentions(true);
        setMentionFilter(afterAt);
        setSelectedIdx(0);
        return;
      }
    }
    setShowMentions(false);
    setMentionFilter("");
  }, []);

  const insertMention = useCallback(
    (agentName: string) => {
      const atIdx = message.lastIndexOf("@");
      if (atIdx >= 0) {
        setMessage(message.slice(0, atIdx) + `@${agentName} `);
      } else {
        setMessage(message + `@${agentName} `);
      }
      setShowMentions(false);
      setMentionFilter("");
      inputRef.current?.focus();
    },
    [message],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showMentions && filteredAgents.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIdx((i) => Math.min(i + 1, filteredAgents.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIdx((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          insertMention(filteredAgents[selectedIdx]);
          return;
        }
        if (e.key === "Escape") {
          setShowMentions(false);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit, showMentions, filteredAgents, selectedIdx, insertMention],
  );

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          resizeImageIfNeeded(file)
            .then(({ preview }) => {
              setAttachments((prev) => [
                ...prev,
                {
                  id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                  type: "image",
                  name: file.name || "pasted-image.png",
                  dataUrl: preview,
                },
              ]);
            })
            .catch(() => {
              // Fallback: use original file without resize
              const reader = new FileReader();
              reader.onload = (ev) => {
                setAttachments((prev) => [
                  ...prev,
                  {
                    id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                    type: "image",
                    name: file.name || "pasted-image.png",
                    dataUrl: ev.target?.result as string,
                  },
                ]);
              };
              reader.readAsDataURL(file);
            });
        }
        return;
      }
    }
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith("image/")) {
        resizeImageIfNeeded(file)
          .then(({ preview }) => {
            setAttachments((prev) => [
              ...prev,
              {
                id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                type: "image",
                name: file.name,
                dataUrl: preview,
              },
            ]);
          })
          .catch(() => {
            // Fallback: use original file without resize
            const reader = new FileReader();
            reader.onload = (ev) => {
              setAttachments((prev) => [
                ...prev,
                {
                  id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                  type: "image",
                  name: file.name,
                  dataUrl: ev.target?.result as string,
                },
              ]);
            };
            reader.readAsDataURL(file);
          });
      } else {
        setAttachments((prev) => [
          ...prev,
          {
            id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            type: "file",
            name: file.name,
          },
        ]);
      }
    }
    e.target.value = "";
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const scale = isFocused ? 1.02 : isHovered ? 1.01 : 1;
  const glowOpacity = isFocused ? 0.18 : isHovered ? 0.08 : 0.03;
  const borderOpacity = isFocused ? 0.22 : isHovered ? 0.12 : 0.06;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 24,
        left: "50%",
        transform: `translateX(-50%) scale(${scale})`,
        width: 480,
        zIndex: 6,
        transition: "transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div
          className="flex items-center"
          style={{ gap: 6, flexWrap: "wrap", justifyContent: "center" }}
        >
          {attachments.map((att) => (
            <div
              key={att.id}
              style={{
                position: "relative",
                borderRadius: 8,
                border: "1px solid #2A2A3A",
                overflow: "hidden",
                background: "#1A1A24",
              }}
            >
              {att.type === "image" && att.dataUrl ? (
                <img
                  src={att.dataUrl}
                  alt={att.name}
                  style={{
                    width: 60,
                    height: 60,
                    objectFit: "cover",
                    display: "block",
                  }}
                />
              ) : (
                <div className="flex items-center" style={{ padding: "6px 10px", gap: 4 }}>
                  <Paperclip size={10} style={{ color: "#888" }} />
                  <span
                    style={{
                      fontSize: 9,
                      color: "#AAA",
                      maxWidth: 80,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {att.name}
                  </span>
                </div>
              )}
              <button
                onClick={() => removeAttachment(att.id)}
                style={{
                  position: "absolute",
                  top: 2,
                  right: 2,
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  background: "rgba(0,0,0,0.6)",
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <X size={8} style={{ color: "#FFF" }} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input area with mention dropdown */}
      <div style={{ position: "relative", width: "100%" }}>
        {/* @mention dropdown */}
        {showMentions && filteredAgents.length > 0 && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              left: 0,
              right: 0,
              marginBottom: 4,
              borderRadius: 8,
              background: "#1A1A24",
              border: "1px solid #2A2A3A",
              boxShadow: "0 -4px 16px rgba(0,0,0,0.3)",
              overflow: "hidden",
              zIndex: 10,
            }}
          >
            {filteredAgents.map((name, idx) => {
              const role = guessRoleForColor(name);
              const color = ROLE_META[role]?.color ?? "#777";
              return (
                <button
                  key={name}
                  onClick={() => insertMention(name)}
                  className="flex items-center"
                  style={{
                    width: "100%",
                    gap: 8,
                    padding: "6px 12px",
                    background: idx === selectedIdx ? "#2A2A3A" : "transparent",
                    border: "none",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      background: color,
                      flexShrink: 0,
                    }}
                  />

                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: "#E0E0E0",
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    @{name}
                  </span>
                  <span style={{ fontSize: 10, color: "#555555" }}>{role}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Outer glow layer */}
        <div
          style={{
            position: "absolute",
            inset: -4,
            borderRadius: 26,
            background: `radial-gradient(ellipse at center, rgba(var(--theme-accent-rgb),${glowOpacity}) 0%, transparent 70%)`,
            transition: "background 0.4s ease",
            pointerEvents: "none",
          }}
        />

        {/* Main container */}
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            gap: 6,
            minHeight: 44,
            padding: "8px 8px 8px 6px",
            borderRadius: 22,
            background: isFocused ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.025)",
            border: `1px solid rgba(var(--theme-accent-rgb),${borderOpacity})`,
            boxShadow: isFocused
              ? "0 0 0 1px rgba(var(--theme-accent-rgb),0.15), 0 4px 24px rgba(0,0,0,0.25), 0 0 40px rgba(var(--theme-accent-rgb),0.08)"
              : "0 2px 12px rgba(0,0,0,0.2)",
            transition: "background 0.3s ease, border-color 0.3s ease, box-shadow 0.4s ease",
            cursor: "text",
          }}
          onClick={() => inputRef.current?.focus()}
        >
          {/* Attachment button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current?.click();
            }}
            style={
              {
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 28,
                height: 28,
                borderRadius: 14,
                background: "transparent",
                border: "none",
                cursor: "pointer",
                flexShrink: 0,
                transition: "opacity 0.15s",
                opacity: 0.5,
                "--native-hover-opacity": "1",
              } as React.CSSProperties
            }
            className="native-css-hover"
          >
            <Paperclip size={14} style={{ color: "#888888" }} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.pdf,.txt,.md,.json,.csv"
            onChange={handleFileSelect}
            style={{ display: "none" }}
          />

          {/* Textarea */}
          <textarea
            ref={inputRef}
            value={message}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            onPaste={handlePaste}
            placeholder={
              agentNames.length > 0 ? "Message your team... (@ to mention)" : placeholder
            }
            rows={1}
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "#E8E8EE",
              fontSize: 13,
              fontFamily: "'Inter', -apple-system, sans-serif",
              lineHeight: "20px",
              resize: "none",
              maxHeight: 120,
              overflowY: "auto",
            }}
            className="placeholder-gray-500"
          />

          {/* Route indicator */}
          {currentTarget && (
            <span
              style={{
                fontSize: 9,
                color: "#A855F7",
                fontFamily: "'JetBrains Mono', monospace",
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              {"\u2192"} @{currentTarget}
            </span>
          )}

          {/* Send button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleSubmit();
            }}
            disabled={!hasContent}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 30,
              height: 30,
              borderRadius: 15,
              background: hasContent
                ? "linear-gradient(135deg, #A855F7, #9333EA)"
                : "rgba(255,255,255,0.06)",
              border: "none",
              cursor: hasContent ? "pointer" : "default",
              flexShrink: 0,
              transition: "background 0.2s ease, transform 0.2s ease, opacity 0.2s ease",
              transform: hasContent ? "scale(1)" : "scale(0.9)",
              opacity: hasContent ? 1 : 0.4,
            }}
          >
            <ArrowUp
              size={15}
              style={{
                color: hasContent ? "#FFFFFF" : "#666666",
                transition: "color 0.2s ease",
              }}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
