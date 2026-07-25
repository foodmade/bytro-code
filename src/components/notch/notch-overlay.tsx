import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Terminal,
  Square,
  Sparkles,
  Clock,
  Check,
  AlertCircle,
  Wrench,
  Loader2,
  ChevronUp,
  Shield,
  ShieldCheck,
  ShieldX,
  MessageCircleQuestion,
  ChevronLeft,
  ChevronRight,
  Send,
} from "lucide-react";
import { windowListen } from "@/lib/window-listen";
import {
  NOTCH_APPROVAL_RESOLVED_EVENT,
  NOTCH_COLLAPSE_EVENT,
  NOTCH_LAST_STATE_STORAGE_KEY,
  NOTCH_STATE_EVENT,
  notchAccent,
  type NotchState,
  type NotchProvider,
} from "@/lib/notch-bridge";
import { NotchTokenWave } from "@/components/notch/notch-token-wave";

// 灵动岛 · 真正的 spring morph 动效 + 真实状态绑定
//
// 数据流: 主窗口 useNotchBroadcaster → emitTo("notch-overlay", "notch:state", payload)
//         本窗口 windowListen("notch:state") → 渲染
//
// 三态尺寸:
//   idle    : 完全隐藏(仅物理刘海)
//   active  : (notchWidth + 152) × baseH 折叠态,显示平台图标 + 状态
//   hover   : (notchWidth + 168) × (baseH+4) 略微撑大,提示可点击
//   expanded: 560 × 180 完整面板

type NotchMetrics = {
  screenWidth: number;
  screenHeight: number;
  safeAreaTop: number;
  auxLeftWidth: number;
  auxRightWidth: number;
  notchWidth: number;
  hasNotch: boolean;
};

const FALLBACK: NotchMetrics = {
  screenWidth: 1440,
  screenHeight: 900,
  safeAreaTop: 38,
  auxLeftWidth: 600,
  auxRightWidth: 600,
  notchWidth: 220,
  hasNotch: false,
};

const SPRING = "cubic-bezier(.34, 1.56, .64, 1)";
const MORPH_MS = 420;
const OVERLAY_WINDOW_WIDTH = 600;
const DEFAULT_NOTCH_WIDTH = 220;
const MIN_NOTCH_WIDTH = 160;
const MAX_NOTCH_WIDTH = 320;
const ACTIVE_SIDE_WIDTH = 76;
const HOVER_SIDE_WIDTH = 84;

type UiMode = "hidden" | "active" | "hover" | "expanded";

const PROVIDER_LABEL: Record<string, string> = {
  claude: "Claude",
  openai: "OpenAI",
  codex: "Codex",
  gemini: "Gemini",
  grok: "Grok",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  bigmodel: "BigModel",
  mimo: "MiMO",
  minimax: "MiniMax",
  kimi: "Kimi",
  ollama: "Ollama",
};

function providerLabel(p: NotchProvider): string {
  return PROVIDER_LABEL[p as string] ?? String(p);
}

function stateProvider(state: NotchState): NotchProvider | null {
  if (
    state.kind === "streaming" ||
    state.kind === "tool" ||
    state.kind === "done" ||
    state.kind === "approval" ||
    state.kind === "approval-bash" ||
    state.kind === "ask-question"
  ) {
    return state.provider;
  }
  return null;
}

type ApprovalState = Extract<NotchState, { kind: "approval" | "approval-bash" | "ask-question" }>;

function isApprovalState(state: NotchState): state is ApprovalState {
  return (
    state.kind === "approval" ||
    state.kind === "approval-bash" ||
    state.kind === "ask-question"
  );
}

function ProviderLogo({
  provider,
  accent,
  size,
}: {
  provider: NotchProvider;
  accent: { primary: string; glow: string };
  size: number;
}) {
  const label = providerLabel(provider);
  return (
    <span
      aria-label={label}
      title={label}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: accent.primary,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
        fontSize: Math.max(9, Math.round(size * 0.48)),
        fontWeight: 700,
        lineHeight: 1,
        boxShadow: `0 0 8px ${accent.glow}`,
        flex: "0 0 auto",
      }}
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

function phaseLabel(phase: "connecting" | "waiting" | "thinking" | "generating"): string {
  switch (phase) {
    case "connecting":
      return "连接中";
    case "waiting":
      return "等待响应";
    case "thinking":
      return "思考中";
    case "generating":
      return "执行中";
  }
}

function normalizeNotchWidth(metrics: NotchMetrics): number {
  const raw = Number.isFinite(metrics.notchWidth) ? metrics.notchWidth : 0;

  // 某些 macOS WindowServer 路径下 auxiliaryTopLeft/Right 会短暂返回 0，
  // 这会让 notchWidth 变成整块屏幕宽度。覆盖层窗口固定 600px 宽，
  // 因此这里把宽度夹在真实摄像头刘海范围内，异常时回退到常见宽度。
  if (!metrics.hasNotch || raw < MIN_NOTCH_WIDTH || raw > MAX_NOTCH_WIDTH) {
    return DEFAULT_NOTCH_WIDTH;
  }

  return Math.min(Math.max(raw, MIN_NOTCH_WIDTH), MAX_NOTCH_WIDTH);
}

// ---------------------------------------------------------------------------
// 审批响应辅助
// ---------------------------------------------------------------------------

function emitApprovalResolved(notch: ApprovalState, approved?: boolean) {
  const payload = {
    confirmId: notch.confirmId,
    toolCallId: notch.toolCallId,
    kind: notch.kind,
    conversationId: notch.conversationId,
    approved,
  };
  void emit(NOTCH_APPROVAL_RESOLVED_EVENT, payload)
    .catch(() => {
      console.warn("[notch][overlay] approval result delivery failed");
    });
}

function resolveApproval(
  notch: ApprovalState,
  respond: () => Promise<unknown>,
  collapse: () => void,
  approved?: boolean,
) {
  void respond()
    .then(() => {
      collapse();
      emitApprovalResolved(notch, approved);
    })
    .catch(() => {
      console.warn("[notch][overlay] approval response failed");
    });
}

function useApprovalCountdown(arrivedAt: number, timeoutMs: number): number {
  const [remaining, setRemaining] = useState(
    Math.max(0, timeoutMs - (Date.now() - arrivedAt)),
  );
  useEffect(() => {
    const tick = window.setInterval(() => {
      setRemaining(Math.max(0, timeoutMs - (Date.now() - arrivedAt)));
    }, 1000);
    return () => window.clearInterval(tick);
  }, [arrivedAt, timeoutMs]);
  return remaining;
}

function CountdownBar({
  remaining,
  total,
  color,
}: {
  remaining: number;
  total: number;
  color: string;
}) {
  const pct = Math.max(0, Math.min(1, remaining / total));
  return (
    <div
      style={{
        height: 2,
        background: "rgba(255,255,255,0.06)",
        borderRadius: 1,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${pct * 100}%`,
          background: color,
          borderRadius: 1,
          transition: "width 1s linear",
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// NotchApprovalPanel — 工具审批
// ---------------------------------------------------------------------------

type ApprovalNotch = Extract<NotchState, { kind: "approval" }>;

function NotchApprovalPanel({
  notch,
  accent,
  onResolve,
}: {
  notch: ApprovalNotch;
  accent: { primary: string; glow: string };
  onResolve: () => void;
}) {
  const remaining = useApprovalCountdown(notch.arrivedAt, APPROVAL_TIMEOUT_MS);

  const handleApprove = useCallback(() => {
    resolveApproval(
      notch,
      () => invoke("respond_tool_confirmation", {
        confirmId: notch.confirmId,
        approved: true,
      }),
      onResolve,
      true,
    );
  }, [notch, onResolve]);

  const handleDeny = useCallback(() => {
    resolveApproval(
      notch,
      () => invoke("respond_tool_confirmation", {
        confirmId: notch.confirmId,
        approved: false,
      }),
      onResolve,
      false,
    );
  }, [notch, onResolve]);

  const inputPreview = useMemo(() => {
    try {
      const parsed = JSON.parse(notch.toolInput);
      return JSON.stringify(parsed, null, 2).slice(0, 200);
    } catch {
      return notch.toolInput.slice(0, 200);
    }
  }, [notch.toolInput]);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ProviderLogo provider={notch.provider} accent={accent} size={20} />
        <Shield size={16} color={accent.primary} strokeWidth={2.4} />
        <span style={{ fontSize: 14, fontWeight: 700 }}>{notch.toolName}</span>
        {notch.queueDepth > 1 && (
          <span
            style={{
              fontSize: 10,
              color: "#a1a1aa",
              background: "rgba(255,255,255,0.08)",
              borderRadius: 10,
              padding: "2px 7px",
              fontWeight: 600,
            }}
          >
            +{notch.queueDepth - 1}
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 10, color: "#a1a1aa" }}>
          {Math.ceil(remaining / 1000)}s
        </span>
      </div>
      <CountdownBar remaining={remaining} total={APPROVAL_TIMEOUT_MS} color={accent.primary} />
      <div
        style={{
          flex: 1,
          padding: "8px 10px",
          background: "rgba(255,255,255,0.04)",
          borderRadius: 8,
          fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
          fontSize: 11,
          color: "rgba(255,255,255,0.7)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "pre-wrap",
          lineHeight: 1.4,
        }}
      >
        {inputPreview}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={handleDeny} style={btnStyle("#ef4444", "rgba(239,68,68,0.14)")}>
          <ShieldX size={13} /> 拒绝
        </button>
        <button onClick={handleApprove} style={btnStyle(accent.primary, `${accent.primary}22`)}>
          <ShieldCheck size={13} /> 批准
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// NotchBashApprovalPanel — Bash 命令审批
// ---------------------------------------------------------------------------

type BashNotch = Extract<NotchState, { kind: "approval-bash" }>;

function NotchBashApprovalPanel({
  notch,
  accent,
  onResolve,
}: {
  notch: BashNotch;
  accent: { primary: string; glow: string };
  onResolve: () => void;
}) {
  const remaining = useApprovalCountdown(notch.arrivedAt, APPROVAL_TIMEOUT_MS);

  const handleAllow = useCallback(() => {
    resolveApproval(
      notch,
      () => invoke("respond_tool_confirmation", {
        confirmId: notch.confirmId,
        approved: true,
      }),
      onResolve,
      true,
    );
  }, [notch, onResolve]);

  const handleDeny = useCallback(() => {
    resolveApproval(
      notch,
      () => invoke("respond_tool_confirmation", {
        confirmId: notch.confirmId,
        approved: false,
      }),
      onResolve,
      false,
    );
  }, [notch, onResolve]);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ProviderLogo provider={notch.provider} accent={accent} size={20} />
        <Terminal size={16} color={accent.primary} strokeWidth={2.4} />
        <span style={{ fontSize: 14, fontWeight: 700 }}>命令授权</span>
        {notch.queueDepth > 1 && (
          <span
            style={{
              fontSize: 10,
              color: "#a1a1aa",
              background: "rgba(255,255,255,0.08)",
              borderRadius: 10,
              padding: "2px 7px",
              fontWeight: 600,
            }}
          >
            +{notch.queueDepth - 1}
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 10, color: "#a1a1aa" }}>
          {Math.ceil(remaining / 1000)}s
        </span>
      </div>
      <CountdownBar remaining={remaining} total={APPROVAL_TIMEOUT_MS} color={accent.primary} />
      <div
        style={{
          flex: 1,
          padding: "8px 10px",
          background: "rgba(255,255,255,0.04)",
          borderRadius: 8,
          fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
          fontSize: 12,
          color: "rgba(255,255,255,0.9)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "pre-wrap",
          lineHeight: 1.5,
        }}
      >
        $ {notch.command.length > 200 ? `${notch.command.slice(0, 200)}…` : notch.command}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={handleDeny} style={btnStyle("#ef4444", "rgba(239,68,68,0.14)")}>
          <ShieldX size={13} /> 拒绝
        </button>
        <button onClick={handleAllow} style={btnStyle(accent.primary, `${accent.primary}22`)}>
          <ShieldCheck size={13} /> 允许
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// NotchAskQuestionPanel — 问题询问
// ---------------------------------------------------------------------------

type AskNotch = Extract<NotchState, { kind: "ask-question" }>;

function NotchAskQuestionPanel({
  notch,
  accent,
  onResolve,
}: {
  notch: AskNotch;
  accent: { primary: string; glow: string };
  onResolve: () => void;
}) {
  const remaining = useApprovalCountdown(notch.arrivedAt, ASK_QUESTION_TIMEOUT_MS);
  const questions = notch.questions;
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});

  const current = questions[currentIdx];
  const total = questions.length;
  const isLast = currentIdx === total - 1;

  const handleSelect = useCallback(
    (label: string) => {
      if (!current) return;
      setAnswers((prev) => {
        const selected = prev[current.question] ?? [];
        if (!current.multiSelect) {
          return { ...prev, [current.question]: [label] };
        }
        const idx = selected.indexOf(label);
        if (idx >= 0) {
          return { ...prev, [current.question]: selected.filter((item) => item !== label) };
        }
        return { ...prev, [current.question]: [...selected, label] };
      });
    },
    [current],
  );

  const handleSubmit = useCallback(() => {
    const resolvedAnswers = Object.fromEntries(
      Object.entries(answers).map(([question, selected]) => [question, selected.join(", ")]),
    );
    resolveApproval(
      notch,
      () => invoke("respond_ask_user_question", {
        confirmId: notch.confirmId,
        answers: resolvedAnswers,
      }),
      onResolve,
    );
  }, [notch, answers, onResolve]);

  const handleDismiss = useCallback(() => {
    resolveApproval(
      notch,
      () => invoke("respond_ask_user_question", {
        confirmId: notch.confirmId,
        answers: {},
      }),
      onResolve,
    );
  }, [notch, onResolve]);

  if (!current) return null;

  const selectedValues = answers[current.question] ?? [];

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ProviderLogo provider={notch.provider} accent={accent} size={20} />
        <MessageCircleQuestion size={16} color={accent.primary} strokeWidth={2.4} />
        <span style={{ fontSize: 14, fontWeight: 700 }}>{current.header}</span>
        <span style={{ fontSize: 10, color: "#a1a1aa" }}>
          {currentIdx + 1}/{total}
        </span>
        {notch.queueDepth > 1 && (
          <span
            style={{
              fontSize: 10,
              color: "#a1a1aa",
              background: "rgba(255,255,255,0.08)",
              borderRadius: 10,
              padding: "2px 7px",
              fontWeight: 600,
            }}
          >
            +{notch.queueDepth - 1}
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 10, color: "#a1a1aa" }}>
          {Math.ceil(remaining / 1000)}s
        </span>
      </div>
      <CountdownBar remaining={remaining} total={ASK_QUESTION_TIMEOUT_MS} color={accent.primary} />

      <div style={{ display: "flex", gap: 10, flex: 1, minHeight: 0 }}>
        {/* 左侧问题列表 */}
        {total > 1 && (
          <div
            style={{
              width: 120,
              minWidth: 120,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              overflow: "auto",
            }}
          >
            {questions.map((q, i) => (
              <div
                key={i}
                onClick={() => setCurrentIdx(i)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 6px",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 10,
                  color: i === currentIdx ? "#fff" : "#a1a1aa",
                  background: i === currentIdx ? "rgba(255,255,255,0.08)" : "transparent",
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: answers[q.question]
                      ? accent.primary
                      : "rgba(255,255,255,0.2)",
                    flex: "0 0 auto",
                  }}
                />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {q.header}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* 右侧选项 */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            overflow: "auto",
          }}
        >
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.8)", marginBottom: 2 }}>
            {current.question.length > 100 ? `${current.question.slice(0, 100)}…` : current.question}
          </div>
          {current.options.map((opt) => {
            const isSelected = selectedValues.includes(opt.label);
            return (
              <div
                key={opt.label}
                onClick={() => handleSelect(opt.label)}
                style={{
                  padding: "5px 8px",
                  borderRadius: 6,
                  fontSize: 11,
                  cursor: "pointer",
                  background: isSelected ? `${accent.primary}22` : "rgba(255,255,255,0.04)",
                  border: isSelected
                    ? `1px solid ${accent.primary}88`
                    : "1px solid rgba(255,255,255,0.06)",
                  color: isSelected ? "#fff" : "rgba(255,255,255,0.7)",
                  transition: "all 120ms ease",
                }}
              >
                <span style={{ fontWeight: 600 }}>{opt.label}</span>
                {opt.description && (
                  <span style={{ marginLeft: 6, fontSize: 10, color: "#a1a1aa" }}>
                    {opt.description.length > 60 ? `${opt.description.slice(0, 60)}…` : opt.description}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {currentIdx > 0 && (
            <button
              onClick={() => setCurrentIdx((i) => i - 1)}
              style={btnStyleSmall("#a1a1aa", "rgba(255,255,255,0.06)")}
            >
              <ChevronLeft size={12} /> 上一题
            </button>
          )}
          {!isLast && (
            <button
              onClick={() => setCurrentIdx((i) => i + 1)}
              style={btnStyleSmall("#a1a1aa", "rgba(255,255,255,0.06)")}
            >
              下一题 <ChevronRight size={12} />
            </button>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleDismiss} style={btnStyle("#a1a1aa", "rgba(255,255,255,0.06)")}>
            跳过
          </button>
          <button onClick={handleSubmit} style={btnStyle(accent.primary, `${accent.primary}22`)}>
            <Send size={12} /> 提交
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 按钮样式辅助
// ---------------------------------------------------------------------------

const APPROVAL_TIMEOUT_MS = 120_000;
const ASK_QUESTION_TIMEOUT_MS = 300_000;

function btnStyle(color: string, bg: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 11,
    fontWeight: 600,
    color,
    background: bg,
    border: `1px solid ${color}66`,
    borderRadius: 8,
    padding: "5px 12px",
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

function btnStyleSmall(color: string, bg: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    fontSize: 10,
    fontWeight: 500,
    color,
    background: bg,
    border: `1px solid ${color}44`,
    borderRadius: 6,
    padding: "3px 8px",
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

// ---------------------------------------------------------------------------
// NotchOverlay 主组件
// ---------------------------------------------------------------------------

export function NotchOverlay() {
  const [metrics, setMetrics] = useState<NotchMetrics | null>(null);
  const [notch, setNotch] = useState<NotchState>({ kind: "idle" });
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastBoundsRef = useRef<string>("");
  const lastStoredStateRawRef = useRef<string | null>(null);
  const lastActiveProviderRef = useRef<NotchProvider | null>(null);
  const approvalConfirmIdRef = useRef<string | null>(null);

  const collapse = useCallback((_reason: string) => {
    setExpanded(false);
    setHovered(false);
  }, []);

  useEffect(() => {
    const restoreFromStorage = () => {
      try {
        const raw = window.localStorage.getItem(NOTCH_LAST_STATE_STORAGE_KEY);
        if (!raw) return;
        if (raw === lastStoredStateRawRef.current) return;
        lastStoredStateRawRef.current = raw;
        const parsed = JSON.parse(raw) as NotchState;
        const provider = stateProvider(parsed);
        if (provider) lastActiveProviderRef.current = provider;
        setNotch(parsed);
      } catch {
        console.warn("[notch][overlay] saved state could not be restored");
      }
    };

    restoreFromStorage();
    const storagePoll = window.setInterval(restoreFromStorage, 1000);

    invoke<NotchMetrics>("get_notch_metrics")
      .then((nextMetrics) => {
        setMetrics(nextMetrics);
      })
      .catch(() => {
        console.warn("[notch][overlay] notch metrics unavailable; using fallback");
        setMetrics(FALLBACK);
      });
    return () => window.clearInterval(storagePoll);
  }, []);

  // 订阅主窗口推送的状态
  useEffect(() => {
    let cancelled = false;
    let un: (() => void) | undefined;
    let unCollapse: (() => void) | undefined;
    let unFocus: (() => void) | undefined;
    windowListen<NotchState>(NOTCH_STATE_EVENT, (e) => {
      const provider = stateProvider(e.payload);
      if (provider) lastActiveProviderRef.current = provider;
      setNotch(e.payload);
    }).then((u) => {
      if (cancelled) {
        u();
        return;
      }
      un = u;
    });
    windowListen<void>(NOTCH_COLLAPSE_EVENT, () => collapse("external-pointer")).then((u) => {
      if (cancelled) {
        u();
        return;
      }
      unCollapse = u;
    });
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) collapse("focus-lost");
      })
      .then((u) => {
        if (cancelled) {
          u();
          return;
        }
        unFocus = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      un?.();
      unCollapse?.();
      unFocus?.();
    };
  }, [collapse]);

  // 展开态点击灵动岛外区域 → 收起
  useEffect(() => {
    if (!expanded) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        collapse("document-outside");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [expanded, collapse]);

  // 状态变为 idle 时,强制收起展开态
  useEffect(() => {
    if (notch.kind === "idle") {
      setExpanded(false);
      setHovered(false);
    }
  }, [notch.kind]);

  // 审批状态自动展开
  useEffect(() => {
    if (isApprovalState(notch)) {
      if (approvalConfirmIdRef.current !== notch.confirmId) {
        approvalConfirmIdRef.current = notch.confirmId;
        setExpanded(true);
      }
      return;
    }
    if (approvalConfirmIdRef.current !== null) {
      approvalConfirmIdRef.current = null;
      setExpanded(false);
      setHovered(false);
    }
  }, [notch]);

  const mode: UiMode = useMemo(() => {
    if (notch.kind === "idle") return "hidden";
    if (expanded) return "expanded";
    if (hovered) return "hover";
    return "active";
  }, [notch.kind, hovered, expanded]);

  const accent = useMemo(() => {
    if (
      notch.kind === "streaming" ||
      notch.kind === "tool" ||
      notch.kind === "done" ||
      notch.kind === "approval" ||
      notch.kind === "approval-bash" ||
      notch.kind === "ask-question"
    ) {
      return notchAccent(notch.provider);
    }
    if (notch.kind === "error") {
      return { primary: "#ef4444", glow: "rgba(239,68,68,0.55)" };
    }
    return notchAccent("claude");
  }, [notch]);

  const effectiveMetrics = metrics ?? FALLBACK;
  const notchWidth = normalizeNotchWidth(effectiveMetrics);
  const baseH = Math.max(effectiveMetrics.safeAreaTop, 38);

  // 三态尺寸
  const activeW = Math.min(OVERLAY_WINDOW_WIDTH, notchWidth + ACTIVE_SIDE_WIDTH * 2);
  const hoverW = Math.min(OVERLAY_WINDOW_WIDTH, notchWidth + HOVER_SIDE_WIDTH * 2);
  const expandedW = 560;
  const hiddenW = notchWidth;

  // streaming/tool/done 展开态带 token 波形图,需要更高的面板
  const expandedH =
    notch.kind === "ask-question"
      ? 220
      : notch.kind === "streaming" || notch.kind === "tool" || notch.kind === "done"
        ? 244
        : 180;

  let W: number;
  let H: number;
  let radius: number;
  if (mode === "hidden") {
    W = hiddenW;
    H = baseH;
    radius = 18;
  } else if (mode === "expanded") {
    W = expandedW;
    H = expandedH;
    radius = 26;
  } else if (mode === "hover") {
    W = hoverW;
    H = baseH + 4;
    radius = 20;
  } else {
    W = activeW;
    H = baseH;
    radius = 18;
  }

  const topStripH = mode === "hover" ? baseH + 4 : baseH;
  const isActiveLike = mode === "active" || mode === "hover";
  const showDone = notch.kind === "done";
  const showError = notch.kind === "error";
  const collapsedSideW = mode === "hover" ? HOVER_SIDE_WIDTH : ACTIVE_SIDE_WIDTH;
  const activeProvider = stateProvider(notch) ?? (showError ? lastActiveProviderRef.current : null);

  // 如果 hidden,整块黑不可见也不可交互
  const bodyColor = mode === "hidden" ? "transparent" : "#000";

  // 鼠标事件穿透:只在 hidden 态穿透。
  // - hidden:窗口缩到物理刘海宽度,无可见内容,穿透避免吃掉刘海周边点击
  // - active/hover/expanded:必须接收鼠标事件 — hover 放大靠 onMouseEnter,
  //   展开靠 onClick,若穿透则永远点不开(展开的唯一入口就是点击)。窗口
  //   尺寸始终贴合可见胶囊(见下方 bounds useEffect),所以不会挡住胶囊
  //   以外的 menu bar 区域;胶囊本身可见即可点,符合直觉。
  //   注:窗口是 focusable(false),点击不会抢走主窗口键盘焦点。
  useEffect(() => {
    const ignore = mode === "hidden";
    void invoke("set_notch_overlay_ignore_mouse", { ignore }).catch(() => {});
  }, [mode]);

  // "点外收起"替代路径:窗口 focusable(false) 永不获焦,收不到失焦事件。
  // 展开期间让 Rust 装一个全局鼠标按下 monitor(只收本 App 之外的点击),
  // 点其他 App / 桌面 / 菜单栏 → Rust emit NOTCH_COLLAPSE_EVENT → 收起。
  // 本 App 主窗口内的点击由 use-notch-broadcaster 的 pointerdown 广播覆盖。
  useEffect(() => {
    void invoke("set_notch_collapse_watch", { enabled: mode === "expanded" }).catch(() => {});
  }, [mode]);

  // 跟踪上一次实际下发的 bounds — 用来判断本次到底是放大还是收缩。
  // 放大(展开/hover)需要立即把窗口撑开,否则内部 div 的 CSS spring morph
  // 会被旧窗口边界裁掉一截。收缩(折叠/idle)反过来:必须等 CSS morph 跑完
  // 再缩窗口,否则同样的裁切发生在另一个方向 — 内部 div 还是 560 宽,但
  // 窗口已经先一步缩到 372,中间几百 ms 会看到内容被框住、贴左/贴右。
  const lastBoundsWidthRef = useRef<number>(0);
  const lastBoundsHeightRef = useRef<number>(0);

  useEffect(() => {
    const width = Math.ceil(mode === "hidden" ? hiddenW : W);
    const height = Math.ceil(mode === "hidden" ? baseH : H);

    const prevW = lastBoundsWidthRef.current;
    const prevH = lastBoundsHeightRef.current;
    const isShrinking = prevW > 0 && (width < prevW || height < prevH);

    lastBoundsWidthRef.current = width;
    lastBoundsHeightRef.current = height;

    const sendBounds = () => {
      void invoke("set_notch_overlay_bounds", { width, height }).catch(() => {});
      lastBoundsRef.current = `${width}x${height}`;
    };

    let shrinkTimer: number | null = null;
    if (isShrinking && mode !== "hidden") {
      // 让 CSS 上的 width/height transition 把内部 div 收缩到位再缩窗口。
      // +30ms 余量覆盖 spring 缓动尾段(cubic-bezier(.34, 1.56, .64, 1) 末尾
      // 会有一个轻微回弹,30ms 足够它落到目标值)。
      shrinkTimer = window.setTimeout(sendBounds, MORPH_MS + 30);
    } else {
      sendBounds();
    }

    if (mode === "hidden") {
      return () => {
        if (shrinkTimer !== null) window.clearTimeout(shrinkTimer);
      };
    }

    // macOS 窗口最大化/恢复过渡可能导致 overlay 位置漂移，
    // 定时重发确保 5s 内自动修正。
    const drift = window.setInterval(sendBounds, 5000);
    return () => {
      if (shrinkTimer !== null) window.clearTimeout(shrinkTimer);
      window.clearInterval(drift);
    };
  }, [H, W, baseH, hiddenW, mode]);

  return (
    <>
      <style>{`
        @keyframes notch-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.4; transform: scale(0.7); }
        }
        @keyframes notch-spin { to { transform: rotate(360deg); } }
      `}</style>

      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "transparent",
          pointerEvents: mode === "expanded" ? "auto" : "none",
          color: "#fff",
          fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
        }}
        onPointerDown={(e) => {
          if (mode === "expanded" && e.target === e.currentTarget) {
            collapse("overlay-outside");
          }
        }}
      >
        <div
          ref={containerRef}
          style={{
            position: "absolute",
            top: 0,
            left: "50%",
            transform: "translateX(-50%)",
            width: W,
            height: H,
            backgroundColor: bodyColor,
            borderRadius: `0 0 ${radius}px ${radius}px`,
            transition: `width ${MORPH_MS}ms ${SPRING}, height ${MORPH_MS}ms ${SPRING}, border-radius ${MORPH_MS}ms ${SPRING}, background-color 200ms ease`,
            overflow: "hidden",
            pointerEvents: mode === "hidden" ? "none" : "auto",
            cursor: mode === "expanded" ? "default" : "pointer",
            border: "none",
            outline: "none",
            boxShadow:
              mode === "expanded"
                ? "0 12px 40px rgba(0,0,0,0.6)"
                : "none",
            WebkitBackfaceVisibility: "hidden",
          }}
          onMouseEnter={() => mode !== "expanded" && setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onClick={() => {
            if (mode === "hidden") return;
            if (expanded) return;
            setExpanded(true);
          }}
        >
          {/* —— 折叠/Hover 态内容 —— */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: topStripH,
              display: "flex",
              alignItems: "center",
              padding: 0,
              opacity: mode === "expanded" || mode === "hidden" ? 0 : 1,
              transition: `opacity 160ms ease ${mode === "expanded" ? "0ms" : "120ms"}`,
              pointerEvents: "none",
            }}
          >
            {/* 左: 平台图标 + 状态图标 */}
            <div
              style={{
                width: collapsedSideW,
                minWidth: collapsedSideW,
                height: "100%",
                paddingLeft: 10,
                paddingRight: 4,
                display: "flex",
                alignItems: "center",
                gap: 5,
                overflow: "hidden",
              }}
            >
              {activeProvider && (
                <ProviderLogo
                  provider={activeProvider}
                  accent={accent}
                  size={mode === "hover" ? 18 : 16}
                />
              )}
              {showDone ? (
                <Check
                  size={isActiveLike && mode === "hover" ? 16 : 14}
                  color={accent.primary}
                  strokeWidth={2.8}
                />
              ) : showError ? (
                <AlertCircle
                  size={isActiveLike && mode === "hover" ? 16 : 14}
                  color={accent.primary}
                  strokeWidth={2.4}
                />
              ) : notch.kind === "tool" ? (
                <Wrench
                  size={isActiveLike && mode === "hover" ? 16 : 14}
                  color={accent.primary}
                  strokeWidth={2.4}
                />
              ) : !activeProvider ? (
                <span
                  style={{
                    width: mode === "hover" ? 10 : 8,
                    height: mode === "hover" ? 10 : 8,
                    borderRadius: "50%",
                    background: accent.primary,
                    boxShadow: `0 0 8px ${accent.glow}`,
                    transition: `all ${MORPH_MS}ms ${SPRING}`,
                  }}
                />
              ) : null}
            </div>

            <div
              aria-hidden
              style={{
                width: notchWidth,
                minWidth: notchWidth,
                height: "100%",
                flex: "0 0 auto",
              }}
            />

            {/* 右: 心跳或 token 计数 */}
            <div
              style={{
                width: collapsedSideW,
                minWidth: collapsedSideW,
                height: "100%",
                paddingLeft: 6,
                paddingRight: 12,
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                gap: 6,
                overflow: "hidden",
              }}
            >
              {notch.kind === "streaming" && (
                <span
                  style={{
                    fontSize: 10,
                    color: "#a1a1aa",
                    fontFamily: "'JetBrains Mono Variable', monospace",
                  }}
                >
                  {formatElapsed(notch.elapsedMs)}
                </span>
              )}
              {notch.kind === "tool" && (
                <span
                  style={{
                    fontSize: 10,
                    color: "#a1a1aa",
                    fontFamily: "'JetBrains Mono Variable', monospace",
                  }}
                >
                  {formatElapsed(notch.elapsedMs)}
                </span>
              )}
              {notch.kind === "done" && (
                <span
                  style={{
                    fontSize: 10,
                    color: accent.primary,
                    fontFamily: "'JetBrains Mono Variable', monospace",
                  }}
                >
                  {formatTokens(notch.tokens)}
                </span>
              )}
              {(notch.kind === "streaming" || notch.kind === "tool") && (
                <span
                  style={{
                    width: mode === "hover" ? 9 : 7,
                    height: mode === "hover" ? 9 : 7,
                    borderRadius: "50%",
                    background: accent.primary,
                    boxShadow: `0 0 6px ${accent.primary}, 0 0 14px ${accent.glow}`,
                    animation: "notch-pulse 1.3s ease-in-out infinite",
                    transition: `all ${MORPH_MS}ms ${SPRING}`,
                  }}
                />
              )}
            </div>
          </div>

          {/* —— 展开态完整面板 —— */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              padding: "14px 18px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              opacity: mode === "expanded" ? 1 : 0,
              transform: `translateY(${mode === "expanded" ? 0 : -6}px)`,
              transition: `opacity 240ms ease ${mode === "expanded" ? "180ms" : "0ms"}, transform 320ms ${SPRING} ${mode === "expanded" ? "180ms" : "0ms"}`,
              pointerEvents: mode === "expanded" ? "auto" : "none",
            }}
          >
            {isApprovalState(notch) ? (
              notch.kind === "approval" ? (
                <NotchApprovalPanel notch={notch} accent={accent} onResolve={() => collapse("approval-resolved")} />
              ) : notch.kind === "approval-bash" ? (
                <NotchBashApprovalPanel notch={notch} accent={accent} onResolve={() => collapse("approval-resolved")} />
              ) : notch.kind === "ask-question" ? (
                <NotchAskQuestionPanel notch={notch} accent={accent} onResolve={() => collapse("approval-resolved")} />
              ) : null
            ) : (
              <>
                {/* 头部 */}
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {activeProvider && (
                      <ProviderLogo provider={activeProvider} accent={accent} size={20} />
                    )}
                    {notch.kind === "tool" ? (
                      <Terminal size={16} color={accent.primary} strokeWidth={2.4} />
                    ) : notch.kind === "streaming" ? (
                      <Loader2
                        size={16}
                        color={accent.primary}
                        strokeWidth={2.4}
                        style={{ animation: "notch-spin 1s linear infinite" }}
                      />
                    ) : notch.kind === "done" ? (
                      <Check size={16} color={accent.primary} strokeWidth={3} />
                    ) : notch.kind === "error" ? (
                      <AlertCircle size={16} color={accent.primary} strokeWidth={2.4} />
                    ) : null}
                    <span style={{ fontSize: 14, fontWeight: 700 }}>
                      {notch.kind === "tool"
                        ? notch.toolName
                        : notch.kind === "streaming"
                          ? phaseLabel(notch.phase)
                          : notch.kind === "done"
                            ? "已完成"
                            : notch.kind === "error"
                              ? "错误"
                              : ""}
                    </span>
                    {notch.kind === "tool" && (
                      <span style={{ fontSize: 11, color: "#8a8a8a" }}>· 工具执行中</span>
                    )}
                  </div>

                  <div
                    style={{
                      marginLeft: "auto",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "flex-end",
                      gap: 8,
                      flex: "0 0 auto",
                    }}
                  >
                    {(notch.kind === "streaming" || notch.kind === "tool") && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void invoke("abort_active_stream").catch(() => {});
                        }}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          fontSize: 11,
                          fontWeight: 600,
                          color: "#ef4444",
                          background: "rgba(239,68,68,0.14)",
                          border: "1px solid rgba(239,68,68,0.6)",
                          borderRadius: 8,
                          padding: "5px 10px",
                          cursor: "pointer",
                          fontFamily: "inherit",
                        }}
                      >
                        <Square size={9} fill="#ef4444" color="#ef4444" />
                        停止
                      </button>
                    )}
                    <button
                      aria-label="收起灵动岛"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpanded(false);
                        setHovered(false);
                      }}
                      style={{
                        width: 26,
                        height: 26,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#a1a1aa",
                        background: "rgba(255,255,255,0.06)",
                        border: "1px solid rgba(255,255,255,0.1)",
                        borderRadius: 8,
                        cursor: "pointer",
                        fontFamily: "inherit",
                        fontSize: 14,
                        lineHeight: 1,
                      }}
                    >
                      <ChevronUp size={15} strokeWidth={2.4} />
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    height: 1,
                    background:
                      "linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)",
                  }}
                />

                {notch.kind === "error" && (
                  <div
                    style={{
                      padding: "10px 12px",
                      background: "rgba(239,68,68,0.08)",
                      border: "1px solid rgba(239,68,68,0.3)",
                      borderRadius: 10,
                      fontSize: 12,
                      color: "rgba(255,255,255,0.9)",
                      lineHeight: 1.5,
                    }}
                  >
                    {notch.message}
                  </div>
                )}

                {(notch.kind === "streaming" || notch.kind === "tool" || notch.kind === "done") && (
                  <NotchTokenWave
                    rate={notch.rate}
                    live={notch.kind !== "done"}
                    active={mode === "expanded"}
                    accent={accent}
                  />
                )}

                <div
                  style={{
                    marginTop: "auto",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: 10.5,
                    color: "#a1a1aa",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0 }}>
                    {(notch.kind === "streaming" || notch.kind === "tool" || notch.kind === "done") && (
                      <>
                        <span style={{ display: "flex", alignItems: "center", gap: 4, fontWeight: 600 }}>
                          <Sparkles size={11} color={accent.primary} />
                          {formatTokens(notch.tokens)}
                        </span>
                        {notch.usage && (
                          <span
                            style={{
                              display: "flex",
                              gap: 10,
                              alignItems: "center",
                              color: "#71717a",
                              whiteSpace: "nowrap",
                            }}
                          >
                            <span>
                              输入 <span style={{ color: "#a1a1aa" }}>{formatTokens(notch.usage.input)}</span>
                            </span>
                            <span>
                              输出 <span style={{ color: "#a1a1aa" }}>{formatTokens(notch.usage.output)}</span>
                            </span>
                            <span>
                              缓存{" "}
                              <span style={{ color: "#a1a1aa" }}>
                                {formatTokens(notch.usage.cacheRead + notch.usage.cacheWrite)}
                              </span>
                            </span>
                          </span>
                        )}
                        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <Clock size={11} color="#a1a1aa" />
                          {formatElapsed(notch.kind === "done" ? notch.durationMs : notch.elapsedMs)}
                        </span>
                      </>
                    )}
                  </div>
                  <span
                    style={{
                      color: accent.primary,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      void invoke("focus_main_window").catch(() => {});
                    }}
                  >
                    ↗ 打开窗口
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
