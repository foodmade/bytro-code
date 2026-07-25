import { useTranslation } from "react-i18next";
import { RefreshCw, Download, Loader, TrendingUp } from "lucide-react";
import { useHealthCheckStore } from "@/stores/health-check-store";
import type { HealthCheckPhase } from "@/stores/health-check-store";

interface HealthCheckToolbarProps {
  readonly phase: HealthCheckPhase;
  readonly onStartCheck: () => void;
  readonly onCancelCheck: () => void;
  readonly onExport?: () => void;
}

export function HealthCheckToolbar({
  phase,
  onStartCheck,
  onCancelCheck,
  onExport,
}: HealthCheckToolbarProps) {
  const { t } = useTranslation();
  const activeTab = useHealthCheckStore((s) => s.activeTab);
  const setActiveTab = useHealthCheckStore((s) => s.setActiveTab);
  const isScanning = phase === "scanning";

  return (
    <div
      className="flex items-center shrink-0"
      style={{
        height: 48,
        padding: "0 20px",
        backgroundColor: "var(--color-card)",
        borderRadius: 12,
        border: "1px solid var(--color-border)",
        boxShadow: "var(--shadow-card)",
        justifyContent: "space-between",
      }}
    >
      {/* Left: Title on issues tab, Tab row on history tab */}
      {activeTab === "issues" ? (
        <div className="flex items-center" style={{ gap: 16 }}>
          {/* Title — design psKGn: fontSize:16 fontWeight:600 color:#FFFFFF */}
          <span
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: "var(--color-foreground)",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {t("workspace.healthCheck.detail.title", "项目体检报告")}
          </span>
          {/* Subtle history link */}
          <button
            onClick={() => setActiveTab("history")}
            className="flex items-center native-css-hover"
            style={
              {
                gap: 4,
                padding: "4px 8px",
                borderRadius: 4,
                border: "none",
                backgroundColor: "transparent",
                color: "var(--color-text-placeholder)",
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "Inter, sans-serif",
                transition: "color 0.15s ease",
                "--native-hover-color": "var(--color-muted-foreground)",
              } as React.CSSProperties
            }
          >
            <TrendingUp size={12} />
            <span>{t("workspace.healthCheck.detail.tabHistory", "历史趋势")}</span>
          </button>
        </div>
      ) : (
        /* Tab row — design 5Ajr4: tabRow */
        <div className="flex items-center" style={{ height: "100%" }}>
          <TabButton
            active={false}
            label={t("workspace.healthCheck.detail.tabIssues", "问题列表")}
            onClick={() => setActiveTab("issues")}
          />

          <TabButton
            active={true}
            label={t("workspace.healthCheck.detail.tabHistory", "历史趋势")}
            onClick={() => setActiveTab("history")}
          />
        </div>
      )}

      {/* Right buttons — design: gap:12 */}
      <div className="flex items-center" style={{ gap: 12 }}>
        {/* Export — design: bg:#3A3A3C color:#EBEBF5CC cornerRadius:6 padding:6 14 gap:6 */}
        <button
          onClick={onExport}
          className="flex items-center"
          style={{
            gap: 6,
            padding: "6px 14px",
            borderRadius: 6,
            border: "none",
            backgroundColor: "var(--color-surface-raised)",
            color: "var(--color-muted-foreground)",
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
            fontFamily: "Inter, sans-serif",
          }}
          title={t("workspace.healthCheck.detail.export", "导出报告")}
        >
          <Download size={14} />
          <span>{t("workspace.healthCheck.detail.export", "导出报告")}</span>
        </button>

        {/* Scan button — design: bg:#0A84FF color:#FFFFFF */}
        {isScanning ? (
          <button
            onClick={onCancelCheck}
            className="flex items-center"
            style={{
              gap: 6,
              padding: "6px 14px",
              borderRadius: 6,
              border: "none",
              backgroundColor: "#FF453A20",
              color: "#FF453A",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "Inter, sans-serif",
            }}
          >
            <Loader size={14} className="animate-spin" />
            <span>{t("workspace.healthCheck.cancelCheck", "取消体检")}</span>
          </button>
        ) : (
          <button
            onClick={onStartCheck}
            className="flex items-center"
            style={{
              gap: 6,
              padding: "6px 14px",
              borderRadius: 6,
              border: "none",
              backgroundColor: "#0A84FF",
              color: "#FFFFFF",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "Inter, sans-serif",
            }}
          >
            <RefreshCw size={14} />
            <span>{t("workspace.healthCheck.reCheck", "重新体检")}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/* Tab button — design 5Ajr4: active=#0A84FF fontWeight:600 borderBottom:2px #0A84FF; inactive=#EBEBF566 borderBottom:2px #EBEBF54D */
function TabButton({
  active,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 16px",
        border: "none",
        borderBottom: active ? "2px solid #0A84FF" : "2px solid var(--color-border-light)",
        backgroundColor: "transparent",
        color: active ? "#0A84FF" : "var(--color-muted)",
        fontSize: 14,
        fontWeight: active ? 600 : 400,
        cursor: "pointer",
        transition: "all 0.15s ease",
        height: "100%",
        fontFamily: "Inter, sans-serif",
      }}
    >
      {label}
    </button>
  );
}
