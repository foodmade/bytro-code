import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { X, ScanSearch, FolderOpen, FilePenLine, Flag, Sparkles, Lightbulb } from "lucide-react";
import { useLiveReviewStore } from "@/stores/live-review-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { LiveReviewCard } from "./live-review-card";
import { LiveReviewModelPicker } from "./live-review-model-picker";

// Stable empty references — returning a fresh object literal from a Zustand
// selector causes infinite re-renders because the default equality check is
// `Object.is`, and a new `{}` is never `===` the previous `{}`.
const EMPTY_REVIEWS: Readonly<Record<string, never>> = Object.freeze({});
const EMPTY_ORDER: ReadonlyArray<string> = Object.freeze([]);

// ---------------------------------------------------------------------------
// LiveReviewPanel — right-side split panel that streams per-file code review
// output from an independent reviewer running in parallel with the main chat.
// Phase 1 implements Lite mode.  See plan §"Live Code Reviewer".
// ---------------------------------------------------------------------------

export function LiveReviewPanel() {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const conversationId = useConversationStore((s) => s.activeConversationId);
  const workspace = useWorkspaceStore((s) => s.activeWorkspace);

  const panelWidth = useLiveReviewStore((s) => s.panelWidth);
  const setPanelWidth = useLiveReviewStore((s) => s.setPanelWidth);
  const setEnabledFor = useLiveReviewStore((s) => s.setEnabledFor);

  // Subscribe to reviews and order separately so React only re-renders when
  // the actual sub-slice changes.  Returning a freshly-built fallback object
  // from a single selector would create a new reference on every render and
  // cause an infinite update loop (Object.is check fails forever).
  const reviewsMap = useLiveReviewStore(
    (s) => s.reviewsByConversation[conversationId ?? ""]?.reviews ?? EMPTY_REVIEWS,
  );
  const orderList = useLiveReviewStore(
    (s) => s.reviewsByConversation[conversationId ?? ""]?.order ?? EMPTY_ORDER,
  );

  // ── Drag-resize handle (mirrors slideshow-panel pattern) ────────────────
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    startXRef.current = e.clientX;
    startWidthRef.current = panel.getBoundingClientRect().width;
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMouseMove = (e: MouseEvent) => {
      const delta = startXRef.current - e.clientX;
      const newWidth = startWidthRef.current + delta;
      setPanelWidth(newWidth);
    };
    const onMouseUp = () => setDragging(false);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragging, setPanelWidth]);

  const handleClose = useCallback(() => {
    setEnabledFor(conversationId, false);
  }, [setEnabledFor, conversationId]);

  const cardEntries = useMemo(
    () =>
      orderList
        .map((rid) => reviewsMap[rid as keyof typeof reviewsMap])
        .filter((x): x is NonNullable<typeof x> => Boolean(x)),
    [reviewsMap, orderList],
  );

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      style={{
        width: panelWidth,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        outline: "none",
        flexShrink: 0,
        position: "relative",
        // Match the main chat surface exactly — the pencil redesign added a
        // subtle violet wash here, but injecting it would break theme parity
        // with the chat pane next door.  Stick to the same background var.
        backgroundColor: "var(--color-background)",
      }}
    >
      {/* ── Resize handle ─────────────────────────────────── */}
      <div
        onMouseDown={onMouseDown}
        className="native-css-hover"
        style={
          {
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 4,
            cursor: "col-resize",
            zIndex: 10,
            backgroundColor: dragging ? "var(--color-accent-purple)" : "var(--color-border)",
            "--native-hover-bg-color": !dragging ? "var(--color-border-strong)" : undefined,
          } as React.CSSProperties
        }
      />

      {/* ── Header (two rows, matches pencil redesign) ─────────────── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 14,
          padding: "18px 20px 16px 20px",
          borderBottom: "1px solid var(--color-border)",
          flexShrink: 0,
        }}
      >
        {/* Row 1: logo · title · LIVE pill ←———→ close */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            {/* Logo box — violet gradient square (30×30) */}
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: 9,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                backgroundImage:
                  "linear-gradient(135deg, color-mix(in srgb, var(--color-accent-purple) 27%, transparent) 0%, color-mix(in srgb, var(--color-accent-purple) 10%, transparent) 100%)",
                border: "1px solid color-mix(in srgb, var(--color-accent-purple) 33%, transparent)",
              }}
            >
              <ScanSearch size={14} style={{ color: "var(--color-accent-purple)" }} />
            </div>
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "var(--color-foreground)",
                fontFamily: "var(--font-sans)",
                whiteSpace: "nowrap",
              }}
            >
              {t("chat.codeReview.liveReview.title")}
            </span>
            {/* LIVE pill — pulsating green dot */}
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "2px 7px",
                borderRadius: 10,
                backgroundColor: "color-mix(in srgb, var(--color-accent-success) 12%, transparent)",
                border:
                  "1px solid color-mix(in srgb, var(--color-accent-success) 33%, transparent)",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  backgroundColor: "var(--color-accent-success)",
                }}
              />
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  color: "var(--color-accent-success)",
                  fontFamily: "var(--font-sans)",
                }}
              >
                LIVE
              </span>
            </span>
          </div>
          <button
            type="button"
            onClick={handleClose}
            title={t("chat.codeReview.liveReview.close")}
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              border: "1px solid var(--color-border)",
              backgroundColor: "var(--color-surface)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: "var(--color-muted-foreground)",
              flexShrink: 0,
            }}
          >
            <X size={14} />
          </button>
        </div>
        {/* Row 2: subtitle ←———→ mode toggle · model picker */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 400,
              color: "var(--color-muted-foreground)",
              fontFamily: "var(--font-sans)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
            }}
          >
            {t("chat.codeReview.liveReview.subtitle")}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {/* Lite is the only supported mode for now — Deep is gated until
                the agentic-SDK reviewer ships, so the segmented toggle is
                hidden to keep the header focused on the model picker. */}
            <LiveReviewModelPicker />
          </div>
        </div>
      </div>

      {/* ── Body ─────────────────────────────────────────── */}
      {!workspace ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            color: "var(--color-muted)",
            padding: "0 24px",
            textAlign: "center",
          }}
        >
          <FolderOpen size={28} style={{ opacity: 0.35 }} />
          <span style={{ fontSize: 12 }}>{t("chat.codeReview.liveReview.noWorkspace")}</span>
        </div>
      ) : cardEntries.length === 0 ? (
        <IdleState />
      ) : (
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {cardEntries.map((item) => (
            <LiveReviewCard key={item.reviewId} conversationId={conversationId ?? ""} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// IdleState — onboarding view shown when there are no reviews yet for the
// current conversation.  Replaces the old "icon + two muted lines" empty
// state with a hero (pulsing ring + glowing logo), a 3-step "how it works"
// list, and a single safety tip.  Designed in pencil.pen — see the "Live
// Review Panel — Idle Stage" frame for the source of truth.
// ---------------------------------------------------------------------------

function IdleState() {
  const { t } = useTranslation();
  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "28px 24px 24px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 22,
        color: "var(--color-muted)",
        textAlign: "center",
      }}
    >
      {/* Hero — 64×64 stack: outer pulse ring (animate-ping) + 48×48 logo
          with violet glow box-shadow.  The ring carries the "system is
          listening" semantic; the static glow conveys "ready". */}
      <div style={{ position: "relative", width: 64, height: 64, flexShrink: 0 }}>
        <span
          aria-hidden="true"
          className="animate-ping"
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            border: "1px solid color-mix(in srgb, var(--color-accent-purple) 45%, transparent)",
            opacity: 0.5,
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 8,
            borderRadius: 13,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundImage:
              "linear-gradient(135deg, color-mix(in srgb, var(--color-accent-purple) 27%, transparent) 0%, color-mix(in srgb, var(--color-accent-purple) 10%, transparent) 100%)",
            border: "1px solid color-mix(in srgb, var(--color-accent-purple) 33%, transparent)",
            boxShadow: "0 0 18px color-mix(in srgb, var(--color-accent-purple) 48%, transparent)",
          }}
        >
          <ScanSearch size={18} style={{ color: "var(--color-accent-purple)" }} />
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
        <span
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: "var(--color-foreground)",
            fontFamily: "var(--font-sans)",
          }}
        >
          {t("chat.codeReview.liveReview.idle.title")}
        </span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 400,
            color: "var(--color-muted-foreground)",
            fontFamily: "var(--font-sans)",
          }}
        >
          {t("chat.codeReview.liveReview.idle.subtitle")}
        </span>
      </div>

      {/* How-it-works — 3 lightweight rows, no card chrome */}
      <div
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          marginTop: 6,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.04em",
            color: "var(--color-muted)",
            alignSelf: "flex-start",
            paddingLeft: 4,
            marginBottom: 2,
          }}
        >
          {t("chat.codeReview.liveReview.idle.howTitle")}
        </span>
        <IdleStep
          icon={<FilePenLine size={12} style={{ color: "var(--color-accent-info)" }} />}
          tint="var(--color-accent-info)"
          title={t("chat.codeReview.liveReview.idle.step1Title")}
          desc={t("chat.codeReview.liveReview.idle.step1Desc")}
        />
        <IdleStep
          icon={<Flag size={12} style={{ color: "var(--color-accent-purple)" }} />}
          tint="var(--color-accent-purple)"
          title={t("chat.codeReview.liveReview.idle.step2Title")}
          desc={t("chat.codeReview.liveReview.idle.step2Desc")}
        />
        <IdleStep
          icon={<Sparkles size={12} style={{ color: "var(--color-accent-success)" }} />}
          tint="var(--color-accent-success)"
          title={t("chat.codeReview.liveReview.idle.step3Title")}
          desc={t("chat.codeReview.liveReview.idle.step3Desc")}
        />
      </div>

      {/* Bottom tip — privacy reassurance */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          alignSelf: "flex-start",
          padding: "0 4px",
          marginTop: 4,
        }}
      >
        {/* TODO: replace with var(--color-accent-warning) once a yellow/amber
            theme token is introduced; for now the codebase uses #FACC15 in
            three places (terminal, welcome bonus, here) without a token. */}
        <Lightbulb size={11} style={{ color: "#FACC15", flexShrink: 0 }} />
        <span
          style={{
            fontSize: 11,
            color: "var(--color-muted)",
            fontFamily: "var(--font-sans)",
            textAlign: "left",
          }}
        >
          {t("chat.codeReview.liveReview.idle.tip")}
        </span>
      </div>
    </div>
  );
}

interface IdleStepProps {
  readonly icon: ReactNode;
  readonly tint: string;
  readonly title: string;
  readonly desc: string;
}

function IdleStep({ icon, tint, title, desc }: IdleStepProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "8px 4px",
      }}
    >
      <div
        style={{
          width: 26,
          height: 26,
          flexShrink: 0,
          borderRadius: 7,
          backgroundColor: `color-mix(in srgb, ${tint} 14%, transparent)`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {icon}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          minWidth: 0,
          textAlign: "left",
          flex: 1,
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--color-foreground)",
            fontFamily: "var(--font-sans)",
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 400,
            lineHeight: 1.5,
            color: "var(--color-muted-foreground)",
            fontFamily: "var(--font-sans)",
          }}
        >
          {desc}
        </span>
      </div>
    </div>
  );
}
