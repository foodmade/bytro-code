import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, X, Minus, Check, Info } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useToolStateStore } from "@/stores/tool-state-store";
import { useConversationStore } from "@/stores";
import type { AskUserQuestionItem } from "@/stores/chat-store";

// ---------------------------------------------------------------------------
// Per-question answer state
// ---------------------------------------------------------------------------

interface QuestionAnswer {
  readonly selected: string[]; // option labels or "__other__"
  readonly customText: string;
}

const EMPTY_QUESTION_ANSWER: QuestionAnswer = { selected: [], customText: "" };

// ---------------------------------------------------------------------------
// Single question card — renders header, question text, and selectable options.
// ---------------------------------------------------------------------------

function QuestionCard({
  item,
  answer,
  onChange,
  disabled,
  focusedOptionIndex,
  onFocusChange,
}: {
  readonly item: AskUserQuestionItem;
  readonly answer: QuestionAnswer;
  readonly onChange: (answer: QuestionAnswer) => void;
  readonly disabled: boolean;
  readonly focusedOptionIndex: number;
  readonly onFocusChange: (localIndex: number) => void;
}) {
  const isOtherSelected = answer.selected.includes("__other__");
  const isOtherFocused = focusedOptionIndex === item.options.length;

  const handleOptionClick = (label: string, localIndex: number) => {
    if (disabled) return;
    onFocusChange(localIndex);
    if (item.multiSelect) {
      if (answer.selected.includes(label)) {
        onChange({ ...answer, selected: answer.selected.filter((a) => a !== label) });
      } else {
        onChange({ ...answer, selected: [...answer.selected, label] });
      }
    } else {
      onChange({ ...answer, selected: [label] });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Header chip + question */}
      <div className="flex items-start gap-2.5">
        <span
          className="shrink-0 text-[10px] font-semibold font-sans px-2 py-0.5 rounded"
          style={{ backgroundColor: "rgba(var(--theme-accent-rgb),0.125)", color: "var(--color-accent-purple)" }}
        >
          {item.header}
        </span>
        <span
          className="font-medium"
          style={{ color: "var(--color-foreground)", fontFamily: "Inter", fontSize: 13 }}
        >
          {item.question}
        </span>
      </div>

      {/* Options */}
      <div className="flex flex-col gap-1.5" style={{ paddingLeft: 4 }}>
        {item.options.map((opt, optIdx) => {
          const isSelected = answer.selected.includes(opt.label);
          const isFocused = optIdx === focusedOptionIndex;
          return (
            <button
              key={opt.label}
              type="button"
              onClick={() => handleOptionClick(opt.label, optIdx)}
              disabled={disabled}
              data-option-focused={isFocused || undefined}
              className="flex items-center gap-3 w-full text-left transition-colors"
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                backgroundColor: isSelected ? "rgba(var(--theme-accent-rgb),0.063)" : isFocused ? "rgba(var(--theme-accent-rgb),0.031)" : "var(--color-card)",
                border: `1px solid ${isSelected ? "rgba(var(--theme-accent-rgb),0.314)" : isFocused ? "rgba(var(--theme-accent-rgb),0.251)" : "var(--color-border-light)"}`,
                boxShadow: isFocused ? "0 0 0 2px rgba(var(--theme-accent-rgb),0.251)" : "none",
              }}
            >
              {/* Checkbox / Radio */}
              <div
                className="flex items-center justify-center shrink-0"
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: item.multiSelect ? 4 : 8,
                  backgroundColor: isSelected ? "var(--color-accent-purple)" : "transparent",
                  border: `2px solid ${isSelected ? "var(--color-accent-purple)" : "var(--color-border-strong)"}`,
                }}
              >
                {isSelected && (
                  item.multiSelect
                    ? <Check size={10} className="text-white" />
                    : (
                      <div
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 3,
                          backgroundColor: "#FFFFFF",
                        }}
                      />
                    )
                )}
              </div>
              <div className="flex flex-col gap-0.5 min-w-0">
                <span
                  className="font-medium"
                  style={{ color: "var(--color-foreground)", fontFamily: "Inter", fontSize: 13 }}
                >
                  {opt.label}
                </span>
                {opt.description && (
                  <span
                    className="text-[11px]"
                    style={{ color: "var(--color-text-placeholder)", fontFamily: "Inter" }}
                  >
                    {opt.description}
                  </span>
                )}
              </div>
            </button>
          );
        })}

        {/* "Other" free-text option */}
        <button
          type="button"
          onClick={() => handleOptionClick("__other__", item.options.length)}
          disabled={disabled}
          data-option-focused={isOtherFocused || undefined}
          className="flex items-center gap-3 w-full text-left transition-colors"
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            backgroundColor: isOtherSelected ? "rgba(var(--theme-accent-rgb),0.063)" : isOtherFocused ? "rgba(var(--theme-accent-rgb),0.031)" : "var(--color-card)",
            border: `1px solid ${isOtherSelected ? "rgba(var(--theme-accent-rgb),0.314)" : isOtherFocused ? "rgba(var(--theme-accent-rgb),0.251)" : "var(--color-border-light)"}`,
            boxShadow: isOtherFocused ? "0 0 0 2px rgba(var(--theme-accent-rgb),0.251)" : "none",
          }}
        >
          <div
            className="flex items-center justify-center shrink-0"
            style={{
              width: 16,
              height: 16,
              borderRadius: item.multiSelect ? 4 : 8,
              backgroundColor: isOtherSelected ? "var(--color-accent-purple)" : "transparent",
              border: `2px solid ${isOtherSelected ? "var(--color-accent-purple)" : "var(--color-border-strong)"}`,
            }}
          >
            {isOtherSelected && (
              item.multiSelect
                ? <Check size={10} className="text-white" />
                : (
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: "#FFFFFF",
                    }}
                  />
                )
            )}
          </div>
          <span
            className="font-medium"
            style={{ color: "var(--color-foreground)", fontFamily: "Inter", fontSize: 13 }}
          >
            Other
          </span>
        </button>

        {/* Free-text input when "Other" is selected — smooth expand */}
        <div
          style={{
            display: "grid",
            gridTemplateRows: isOtherSelected ? "1fr" : "0fr",
            transition: "grid-template-rows 200ms ease-out",
          }}
        >
          <div style={{ overflow: "hidden" }}>
            <input
              type="text"
              value={answer.customText}
              onChange={(e) => onChange({ ...answer, customText: e.target.value })}
              placeholder="Type your answer..."
              disabled={disabled || !isOtherSelected}
              autoFocus={isOtherSelected}
              tabIndex={isOtherSelected ? 0 : -1}
              className="w-full text-[13px] font-sans outline-none"
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                backgroundColor: "var(--color-card)",
                border: "1px solid rgba(var(--theme-accent-rgb),0.251)",
                color: "var(--color-foreground)",
                marginLeft: 4,
                marginTop: 4,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resolve a QuestionAnswer to a string for the SDK
// ---------------------------------------------------------------------------

function resolveAnswer(answer: QuestionAnswer): string {
  const parts = answer.selected.map((s) =>
    s === "__other__" ? answer.customText : s,
  ).filter(Boolean);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// AskUserQuestionDialog — modal dialog for Claude's AskUserQuestion tool.
// ---------------------------------------------------------------------------

export function AskUserQuestionDialog() {
  const { t } = useTranslation();
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const pending = useToolStateStore((s) =>
    s.getPendingAskUserQuestion(activeConversationId ?? undefined),
  );
  // Per-question answer state
  const [answers, setAnswers] = useState<Record<number, QuestionAnswer>>({});
  const [submitting, setSubmitting] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [closing, setClosing] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Reset when a new question appears
  useEffect(() => {
    if (pending) {
      // Auto-select first option for single-select questions
      const initialAnswers: Record<number, QuestionAnswer> = {};
      for (let i = 0; i < pending.questions.length; i++) {
        const q = pending.questions[i];
        if (!q.multiSelect && q.options.length > 0) {
          initialAnswers[i] = { selected: [q.options[0].label], customText: "" };
        }
      }
      setAnswers(initialAnswers);
      setFocusedIndex(0);
      setSubmitting(false);
      setMinimized(false);
      setClosing(false);
      dialogRef.current?.focus();
    }
  }, [pending]);

  const handleChange = useCallback((index: number, answer: QuestionAnswer) => {
    setAnswers((prev) => ({ ...prev, [index]: answer }));
  }, []);

  // Keyboard navigation helpers
  const totalOptions = useMemo(() => {
    if (!pending) return 0;
    return pending.questions.reduce((acc, q) => acc + q.options.length + 1, 0);
  }, [pending]);

  const questionStartIndices = useMemo(() => {
    if (!pending) return [];
    const indices: number[] = [];
    let start = 0;
    for (const q of pending.questions) {
      indices.push(start);
      start += q.options.length + 1;
    }
    return indices;
  }, [pending]);

  const mapFlatIndex = useCallback((flatIndex: number): { questionIndex: number; localIndex: number } | null => {
    if (!pending) return null;
    let remaining = flatIndex;
    for (let qi = 0; qi < pending.questions.length; qi++) {
      const count = pending.questions[qi].options.length + 1;
      if (remaining < count) {
        return { questionIndex: qi, localIndex: remaining };
      }
      remaining -= count;
    }
    return null;
  }, [pending]);

  // Check if all questions have at least one valid answer
  const allAnswered = useMemo(() => {
    if (!pending) return false;
    return pending.questions.every((_, i) => {
      const a = answers[i] ?? EMPTY_QUESTION_ANSWER;
      if (a.selected.length === 0) return false;
      // If only "Other" is selected, require non-empty custom text
      if (a.selected.length === 1 && a.selected[0] === "__other__" && !a.customText.trim()) {
        return false;
      }
      return true;
    });
  }, [pending, answers]);

  const handleSubmit = useCallback(() => {
    if (!pending || submitting || !allAnswered) return;
    setSubmitting(true);

    // Build the answers map: question text -> selected label(s)
    const answersMap: Record<string, string> = {};
    for (let i = 0; i < pending.questions.length; i++) {
      const q = pending.questions[i];
      const a = answers[i] ?? EMPTY_QUESTION_ANSWER;
      answersMap[q.question] = resolveAnswer(a);
    }

    useToolStateStore.getState().removePendingAskUserQuestion(pending.conversationId);
    invoke("respond_ask_user_question", {
      confirmId: pending.confirmId,
      answers: answersMap,
    }).catch(() => {
      setSubmitting(false);
    });
  }, [pending, submitting, allAnswered, answers]);

  const handleDismiss = useCallback(() => {
    if (!pending || submitting) return;
    setSubmitting(true);
    useToolStateStore.getState().removePendingAskUserQuestion(pending.conversationId);
    // Send empty answers — the sidecar will treat this as a timeout/skip
    invoke("respond_ask_user_question", {
      confirmId: pending.confirmId,
      answers: {},
    }).catch(() => {
      setSubmitting(false);
    });
  }, [pending, submitting]);

  const handleAnimatedAction = useCallback((action: () => void) => {
    if (submitting || closing) return;
    setClosing(true);
    setTimeout(action, 280);
  }, [submitting, closing]);

  const handleMinimize = useCallback(() => {
    setMinimized(true);
  }, []);

  const handleRestore = useCallback(() => {
    setMinimized(false);
  }, []);

  // Keyboard navigation: Escape, Arrow keys, Enter, Space
  useEffect(() => {
    if (!pending || minimized) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't interfere with text input for "Other"
      if (e.target instanceof HTMLInputElement) {
        if (e.key === "Enter" && allAnswered) {
          e.preventDefault();
          handleSubmit();
        }
        return;
      }

      if (e.key === "Escape") {
        handleMinimize();
        return;
      }

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const newIndex = e.key === "ArrowDown"
          ? Math.min(focusedIndex + 1, totalOptions - 1)
          : Math.max(focusedIndex - 1, 0);
        setFocusedIndex(newIndex);
        // Auto-select for single-select questions
        const mapped = mapFlatIndex(newIndex);
        if (mapped) {
          const q = pending.questions[mapped.questionIndex];
          if (!q.multiSelect) {
            const label = mapped.localIndex < q.options.length
              ? q.options[mapped.localIndex].label
              : "__other__";
            handleChange(mapped.questionIndex, {
              ...(answers[mapped.questionIndex] ?? EMPTY_QUESTION_ANSWER),
              selected: [label],
            });
          }
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        if (allAnswered) {
          handleSubmit();
        }
        return;
      }

      if (e.key === " ") {
        e.preventDefault();
        const mapped = mapFlatIndex(focusedIndex);
        if (!mapped) return;
        const q = pending.questions[mapped.questionIndex];
        const label = mapped.localIndex < q.options.length
          ? q.options[mapped.localIndex].label
          : "__other__";
        const currentAnswer = answers[mapped.questionIndex] ?? EMPTY_QUESTION_ANSWER;
        if (q.multiSelect) {
          const isCurrentlySelected = currentAnswer.selected.includes(label);
          handleChange(mapped.questionIndex, {
            ...currentAnswer,
            selected: isCurrentlySelected
              ? currentAnswer.selected.filter((a) => a !== label)
              : [...currentAnswer.selected, label],
          });
        } else {
          handleChange(mapped.questionIndex, {
            ...currentAnswer,
            selected: [label],
          });
        }
        return;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [pending, minimized, focusedIndex, totalOptions, allAnswered, handleSubmit, handleMinimize, mapFlatIndex, answers, handleChange]);

  // Scroll focused option into view
  useEffect(() => {
    if (!pending || minimized) return;
    const el = dialogRef.current?.querySelector('[data-option-focused]');
    if (el) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [focusedIndex, pending, minimized]);

  // The pending question is already scoped to the active conversation
  // via the store lookup — no additional filtering needed.
  if (!pending) return null;

  // Derive first question text for the minimized pill
  const firstQuestion = pending.questions[0]?.question ?? "";

  // ── Collapsed inline bar (in-place, no position change) ──
  if (minimized) {
    return (
      <div
        className="w-full cursor-pointer transition-all hover:brightness-110"
        style={{ marginBottom: 8 }}
        onClick={handleRestore}
      >
        <div
          className="flex items-center gap-2.5"
          style={{
            padding: "10px 16px",
            borderRadius: 12,
            backgroundColor: "var(--color-card)",
            border: "1px solid var(--color-border)",
          }}
        >
          <MessageSquare size={16} style={{ color: "var(--color-accent-blue)" }} />
          <span
            className="font-semibold truncate"
            style={{ color: "var(--color-foreground)", fontFamily: "Inter", fontSize: 13 }}
          >
            {t("askUserQuestion.pendingQuestion")}
          </span>
          <span
            className="truncate"
            style={{
              color: "var(--color-text-placeholder)",
              fontFamily: "Inter",
              fontSize: 12,
              maxWidth: 200,
            }}
          >
            {firstQuestion}
          </span>
          <div className="flex-1" />
          <div
            className="shrink-0 animate-pulse"
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: "var(--color-accent-blue)",
            }}
          />
        </div>
      </div>
    );
  }

  // ── Full dialog — card rendered inside floating-input-wrapper ──
  return (
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("askUserQuestion.ariaLabel")}
        tabIndex={-1}
        className={`outline-none w-full ${closing ? "dialog-slide-exit" : "dialog-slide-enter"}`}
        style={{ marginBottom: 8 }}
      >
        <div
          className="flex flex-col overflow-hidden"
          style={{
            borderRadius: 12,
            backgroundColor: "var(--color-card)",
            border: "1px solid var(--color-border)",
            padding: "16px 20px",
            gap: 14,
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <MessageSquare size={18} style={{ color: "var(--color-accent-blue)" }} />
              <span
                className="font-semibold"
                style={{ color: "var(--color-foreground)", fontFamily: "Inter", fontSize: 14 }}
              >
                {t("askUserQuestion.needsConfirmation")}
              </span>
              <span
                className="font-medium"
                style={{
                  padding: "2px 8px",
                  borderRadius: 10,
                  backgroundColor: "#4285F418",
                  color: "var(--color-accent-blue)",
                  fontFamily: "Inter",
                  fontSize: 10,
                }}
              >
                {t("askUserQuestion.questionBadge")}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleMinimize}
                disabled={submitting}
                className="flex items-center justify-center transition-opacity hover:opacity-80"
                title={t("askUserQuestion.minimize")}
              >
                <Minus size={16} style={{ color: "#52525b" }} />
              </button>
              <button
                type="button"
                onClick={() => handleAnimatedAction(handleDismiss)}
                disabled={submitting}
                className="flex items-center justify-center transition-opacity hover:opacity-80"
              >
                <X size={16} style={{ color: "#52525b" }} />
              </button>
            </div>
          </div>

          {/* Questions body — scrollable */}
          <div
            className="flex flex-col gap-5 overflow-y-auto"
            style={{ maxHeight: "40vh" }}
          >
            {pending.questions.map((q, i) => (
              <QuestionCard
                key={`${q.header}-${i}`}
                item={q}
                answer={answers[i] ?? EMPTY_QUESTION_ANSWER}
                onChange={(a) => handleChange(i, a)}
                disabled={submitting}
                focusedOptionIndex={
                  focusedIndex >= (questionStartIndices[i] ?? 0) &&
                  focusedIndex < (questionStartIndices[i] ?? 0) + q.options.length + 1
                    ? focusedIndex - (questionStartIndices[i] ?? 0)
                    : -1
                }
                onFocusChange={(localIdx) => setFocusedIndex((questionStartIndices[i] ?? 0) + localIdx)}
              />
            ))}
          </div>

          {/* Separator */}
          <div style={{ height: 1, backgroundColor: "var(--color-border)" }} />

          {/* Footer */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Info size={12} style={{ color: "#52525b" }} />
              <span style={{ color: "#52525b", fontFamily: "Inter", fontSize: 11 }}>
                {t("askUserQuestion.selectHint")}
              </span>
            </div>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !allAnswered}
              className="flex items-center justify-center gap-1.5 transition-opacity hover:brightness-110"
              style={{
                padding: "8px 24px",
                borderRadius: 8,
                background: allAnswered
                  ? "linear-gradient(180deg, #4285F4 0%, #3B78E7 100%)"
                  : "var(--color-border-strong)",
                opacity: submitting ? 0.5 : 1,
              }}
            >
              <Check size={14} style={{ color: "#FFFFFF" }} />
              <span
                className="font-semibold"
                style={{ color: "#FFFFFF", fontFamily: "Inter", fontSize: 13 }}
              >
                {t("askUserQuestion.confirmSelection")}
              </span>
            </button>
          </div>
        </div>
      </div>
  );
}
