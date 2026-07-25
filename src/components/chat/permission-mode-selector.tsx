import { Bot, Check, Shield, ClipboardList, Lightbulb, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Dropdown, DropdownTriggerContent, DropdownHeader, DropdownItem } from "@/components/ui";
import { usePermissionStore, PERMISSION_MODES } from "@/stores";
import { useIsLightTheme } from "@/hooks";
import type { PermissionMode } from "@/stores";

const PERMISSION_ICONS: Record<PermissionMode, typeof Shield> = {
  default: Shield,
  acceptEdits: Bot,
  plan: ClipboardList,
  deep: Lightbulb,
  bypassPermissions: Zap,
};

const PERMISSION_COLORS: Record<PermissionMode, string> = {
  default: "#3B82F6",
  acceptEdits: "#10B981",
  plan: "#F59E0B",
  deep: "#8B5CF6",
  bypassPermissions: "#EF4444",
};

/**
 * Permission mode selector dropdown — matches ModelSelector design pattern.
 */
export function PermissionModeSelector({ compact }: { readonly compact?: boolean } = {}) {
  const { t } = useTranslation();
  const mode = usePermissionStore((s) => s.mode);
  const setMode = usePermissionStore((s) => s.setMode);
  const isLight = useIsLightTheme();

  const Icon = PERMISSION_ICONS[mode];
  const accentColor = PERMISSION_COLORS[mode];

  return (
    <Dropdown
      panelWidth={280}
      className="min-w-0"
      aria-label={t("chat.permissionMode.header")}
      trigger={(open) => (
        <DropdownTriggerContent
          icon={<Icon size={12} style={{ color: accentColor }} />}
          label={t(`chat.permissionMode.${mode}.label`)}
          open={open}
          compact={compact}
        />
      )}
    >
      {(close) => (
        <>
          <DropdownHeader>
            <span className="text-[10px] font-semibold font-mono text-text-placeholder uppercase tracking-wider">
              {t("chat.permissionMode.header")}
            </span>
          </DropdownHeader>
          {PERMISSION_MODES.map((m) => {
            const isSelected = m.id === mode;
            const ModeIcon = PERMISSION_ICONS[m.id];
            const modeColor = PERMISSION_COLORS[m.id];
            const selectedBg = isLight ? `${modeColor}18` : "#1A1A2E";
            return (
              <DropdownItem
                key={m.id}
                selected={isSelected}
                selectedBg={selectedBg}
                onClick={() => {
                  setMode(m.id);
                  close();
                }}
              >
                <ModeIcon
                  size={14}
                  style={{ color: isSelected ? modeColor : undefined }}
                  className={cn("shrink-0", !isSelected && "text-text-placeholder")}
                />
                <div className="flex flex-col items-start flex-1 min-w-0">
                  <span
                    className="text-[12px] font-semibold"
                    style={{ color: isSelected ? modeColor : undefined }}
                  >
                    {t(`chat.permissionMode.${m.id}.label`)}
                  </span>
                  <span className="text-[10px] font-sans text-text-placeholder truncate w-full text-left">
                    {t(`chat.permissionMode.${m.id}.description`)}
                  </span>
                </div>
                {isSelected && <Check size={14} style={{ color: modeColor }} className="shrink-0" />}
              </DropdownItem>
            );
          })}
        </>
      )}
    </Dropdown>
  );
}
