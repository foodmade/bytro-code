import { ChevronLeft, ChevronRight } from "lucide-react";

interface SlideshowToolbarProps {
  readonly activeIndex: number;
  readonly total: number;
  readonly onPrev: () => void;
  readonly onNext: () => void;
}

export function SlideshowToolbar({ activeIndex, total, onPrev, onNext }: SlideshowToolbarProps) {

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: 44,
        padding: "0 16px",
        borderTop: "1px solid var(--color-border)",
        flexShrink: 0,
      }}
    >
      {/* Navigation */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <NavButton onClick={onPrev} disabled={activeIndex <= 0}>
          <ChevronLeft size={14} />
        </NavButton>
        <span
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--color-muted-foreground)",
            fontFamily: "Inter, sans-serif",
            minWidth: 40,
            textAlign: "center",
          }}
        >
          {activeIndex + 1} / {total}
        </span>
        <NavButton onClick={onNext} disabled={activeIndex >= total - 1}>
          <ChevronRight size={14} />
        </NavButton>
      </div>

      {/* Right side — placeholder for future export button */}
      <div />
    </div>
  );
}

function NavButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        backgroundColor: disabled ? "transparent" : "var(--color-card)",
        border: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? "default" : "pointer",
        color: disabled ? "var(--color-muted)" : "var(--color-muted-foreground)",
        opacity: disabled ? 0.4 : 1,
        transition: "opacity 0.15s",
      }}
    >
      {children}
    </button>
  );
}
