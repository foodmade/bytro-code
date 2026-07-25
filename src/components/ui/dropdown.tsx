import { useCallback, useRef, useState, type ReactNode } from "react";
import { cn, collapseStyle } from "@/lib/utils";
import { useClickOutside } from "@/hooks";

// ---------------------------------------------------------------------------
// Dropdown trigger + popover shell
// ---------------------------------------------------------------------------

interface DropdownProps {
  /** Trigger button content — receives open state for chevron rotation etc. */
  readonly trigger: (open: boolean) => ReactNode;
  /** Panel content rendered when open */
  readonly children: (close: () => void) => ReactNode;
  /** Width of the popover panel */
  readonly panelWidth?: number;
  /** Open direction */
  readonly align?: "left" | "right";
  /** Position relative to trigger */
  readonly position?: "above" | "below";
  /** Extra class names on the root wrapper */
  readonly className?: string;
  /** Accessible label for the dropdown panel */
  readonly "aria-label"?: string;
}

export function Dropdown({
  trigger,
  children,
  panelWidth = 260,
  align = "right",
  position = "above",
  className,
  "aria-label": ariaLabel,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, () => setOpen(false), open);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }, [open]);

  return (
    <div ref={ref} className={cn("relative", className)} onKeyDown={handleKeyDown}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded hover:bg-border-light transition-colors min-w-0"
      >
        {trigger(open)}
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className={cn(
            "absolute z-50 rounded-lg border border-border-light bg-card overflow-hidden",
            position === "above" ? "bottom-full mb-2 animate-popup-enter" : "top-full mt-2 animate-popup-enter-below",
            align === "right" ? "right-0" : "left-0",
          )}
          style={{ width: panelWidth, boxShadow: "var(--shadow-popup)" }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Standard trigger layout: icon + label + chevron
// ---------------------------------------------------------------------------

interface DropdownTriggerContentProps {
  readonly icon: ReactNode;
  readonly label: ReactNode;
  readonly open: boolean;
  readonly compact?: boolean;
}

export function DropdownTriggerContent({ icon, label, compact }: DropdownTriggerContentProps) {
  return (
    <>
      {icon}
      <span
        className="text-[11px] font-medium text-[#9a9a9a] font-sans truncate"
        style={compact ? collapseStyle(true) : undefined}
      >
        {label}
      </span>
    </>
  );
}

// ---------------------------------------------------------------------------
// Dropdown header (e.g. "CLAUDE", "Permission Mode")
// ---------------------------------------------------------------------------

interface DropdownHeaderProps {
  readonly children: ReactNode;
}

export function DropdownHeader({ children }: DropdownHeaderProps) {
  return (
    <div className="px-3 py-2 border-b border-border-subtle">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dropdown item
// ---------------------------------------------------------------------------

interface DropdownItemProps {
  readonly selected?: boolean;
  readonly selectedBg?: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly className?: string;
}

export function DropdownItem({
  selected = false,
  selectedBg,
  onClick,
  children,
  className,
}: DropdownItemProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "flex items-center w-full px-3 py-2.5 gap-3 transition-colors",
        !selected && "hover:bg-border-subtle active:bg-border-light",
        className,
      )}
      style={selected && selectedBg ? { backgroundColor: selectedBg } : undefined}
    >
      {children}
    </button>
  );
}
