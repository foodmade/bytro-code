import { X, AlertCircle, AlertTriangle, Info } from "lucide-react";
import { useToastStore } from "@/stores/toast-store";
import type { ToastLevel } from "@/stores/toast-store";

const TOAST_STYLES: Record<ToastLevel, { icon: typeof AlertCircle; colorVar: string }> = {
  error: { icon: AlertCircle, colorVar: "--color-accent-danger" },
  warning: { icon: AlertTriangle, colorVar: "--color-accent-amber" },
  info: { icon: Info, colorVar: "--color-accent-info" },
};

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed z-[300] flex flex-col gap-2 pointer-events-none"
      style={{ bottom: 16, right: 16, maxWidth: 360 }}
    >
      {toasts.map((toast) => {
        const style = TOAST_STYLES[toast.level];
        const Icon = style.icon;
        return (
          <div
            key={toast.id}
            className="pointer-events-auto flex items-start gap-2.5 px-3 py-2.5 rounded-lg shadow-lg animate-fade-in-left"
            style={{
              backgroundColor: `color-mix(in srgb, var(${style.colorVar}) 10%, transparent)`,
              border: `1px solid color-mix(in srgb, var(${style.colorVar}) 30%, transparent)`,
              backdropFilter: "blur(12px)",
            }}
          >
            <Icon size={16} className="shrink-0 mt-0.5" style={{ color: `var(${style.colorVar})` }} />
            <p className="flex-1 text-[12px] font-sans text-foreground leading-relaxed">
              {toast.message}
            </p>
            <button
              onClick={() => dismiss(toast.id)}
              className="shrink-0 text-muted hover:text-foreground transition-colors mt-0.5"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
