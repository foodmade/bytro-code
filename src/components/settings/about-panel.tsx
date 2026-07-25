import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { APP_NAME } from "@/lib/app-constants";
import logoPng from "@/assets/logo.png";

function detectPlatformInfo(): string {
  const uaPlatform =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  const p = uaPlatform.toLowerCase();
  if (p.startsWith("mac")) return "macOS";
  if (p.startsWith("win")) return "Windows";
  return "Linux";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AboutPanel() {
  const { t } = useTranslation();
  const [appVersion, setAppVersion] = useState("");
  const osInfo = detectPlatformInfo();

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* Logo & Version Card */}
      <div className="rounded-lg bg-card border border-border-subtle p-6 flex flex-col items-center gap-6">
        {/* Logo & Product Name */}
        <div className="flex flex-col items-center gap-4">
          <img src={logoPng} alt={APP_NAME} className="w-[72px] h-[72px] rounded-2xl" />
          <div className="flex flex-col items-center gap-1">
            <span className="text-[24px] font-bold text-foreground font-sans">{APP_NAME}</span>
            <span className="text-[13px] text-muted font-sans">
              {t("settings.about.description")}
            </span>
          </div>
        </div>

        <div className="h-px w-full bg-border-subtle" />

        {/* Installed version */}
        <div className="flex flex-col items-center gap-3.5">
          <div
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full"
            style={{
              backgroundColor: "var(--color-background)",
              border: "1px solid var(--color-border)",
            }}
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: "var(--color-accent-success)" }}
            />
            <span className="text-[13px] font-medium text-foreground">v{appVersion}</span>
            <span
              className="text-[12px] font-medium"
              style={{ color: "var(--color-accent-success)" }}
            >
              {t("settings.about.installed")}
            </span>
          </div>
        </div>
      </div>

      {/* Runtime Info Card */}
      <div className="rounded-lg bg-card border border-border-subtle p-4 flex flex-col gap-3">
        <InfoRow label={t("settings.about.framework")} value="Tauri v2" />
        <InfoRow label={t("settings.about.platform")} value={osInfo} />
        <InfoRow label={t("settings.about.license")} value="Apache-2.0" />
      </div>

      <div className="rounded-lg bg-card border border-border-subtle p-4 flex items-center justify-center">
        <span className="text-[11px] text-muted">{t("settings.about.copyright")}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function InfoRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px] font-medium" style={{ color: "var(--color-muted)" }}>
        {label}
      </span>
      <span
        className="text-[12px] font-medium"
        style={{ color: "var(--color-foreground-secondary, #C8C8C8)" }}
      >
        {value}
      </span>
    </div>
  );
}
