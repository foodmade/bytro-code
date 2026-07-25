import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { useStreamStateStore } from "@/stores/stream-state-store";

interface StreamRetryBannerProps {
  readonly attempt?: number | null;
  readonly maxAttempts?: number | null;
}

export function StreamRetryBanner({
  attempt: attemptProp = null,
  maxAttempts: maxAttemptsProp = null,
}: StreamRetryBannerProps) {
  const { t } = useTranslation();
  const attemptState = useStreamStateStore((s) => s.retryAttempt);
  const maxAttemptsState = useStreamStateStore((s) => s.retryMaxAttempts);
  const attempt = attemptProp ?? attemptState;
  const maxAttempts = maxAttemptsProp ?? maxAttemptsState;

  if (attempt === null || maxAttempts === null) return null;

  return (
    <div
      className="flex items-center gap-1.5 animate-fade-in-up"
      style={{ padding: "4px 0" }}
    >
      <RefreshCw
        size={12}
        className="shrink-0 animate-spin"
        style={{ color: "var(--color-muted)", animationDuration: "1.5s" }}
      />
      <span
        className="font-sans"
        style={{ fontSize: 12, color: "var(--color-muted)" }}
      >
        {t("chat.streamRetry.compact", { current: attempt, total: maxAttempts })}
      </span>
    </div>
  );
}
