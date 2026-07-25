import { memo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Settings } from "lucide-react";
import { useAppStore } from "@/stores";

interface CliMissingCardProps {
  readonly displayName: string;
}

export const CliMissingCard = memo(function CliMissingCard({
  displayName,
}: CliMissingCardProps) {
  const { t } = useTranslation();
  const openSettings = useAppStore((state) => state.openSettings);

  return (
    <div
      className="flex flex-col gap-3 animate-fade-in"
      style={{
        padding: "14px 16px",
        borderRadius: "var(--radius-lg)",
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface)",
        maxWidth: 480,
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <div
          className="flex items-center justify-center shrink-0"
          style={{
            width: 28,
            height: 28,
            borderRadius: "var(--radius-md)",
            backgroundColor: "rgba(234,179,8,0.10)",
          }}
        >
          <AlertTriangle size={15} style={{ color: "#EAB308" }} />
        </div>
        <div className="flex flex-col gap-0.5">
          <span
            className="text-foreground"
            style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.3 }}
          >
            {t("cliDep.missing", { tool: displayName })}
          </span>
          <span
            className="text-muted"
            style={{ fontSize: 11, lineHeight: 1.3 }}
          >
            {t("cliDep.manualInstallHint", {
              defaultValue: "Install the CLI with its official instructions, then configure or detect its local path.",
            })}
          </span>
        </div>
      </div>

      <button
        onClick={() => openSettings("cli-paths")}
        className="flex items-center justify-center gap-2 transition-colors cursor-pointer"
        style={{
          height: 32,
          borderRadius: "var(--radius-md)",
          backgroundColor: "var(--color-accent-purple)",
          color: "#FFFFFF",
          fontSize: 12,
          fontWeight: 500,
          border: "none",
        }}
      >
        <Settings size={13} />
        {t("cliDep.openCliSettings", { defaultValue: "Open CLI settings" })}
      </button>
    </div>
  );
});
