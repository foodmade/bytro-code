import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Blocks, Plus, RefreshCw, Store, X } from "lucide-react";
import { useMcpStore, useToastStore } from "@/stores";
import type { McpServerConfig } from "@/stores";
import { formatError } from "@/lib/format-error";
import { useIsLightTheme } from "@/hooks/use-is-light-theme";
import { AddServerPanel } from "./mcp/add-server-panel";
import { MarketplaceTab } from "./mcp/marketplace-tab";

interface McpConfigDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function McpConfigDialog({ open, onClose }: McpConfigDialogProps) {
  const { t } = useTranslation();
  const isLight = useIsLightTheme();
  const {
    servers,
    load,
    loaded,
    loadError,
    setServer,
    removeServer,
    verifyServer,
    verifyStatus,
    toolsStatus,
    listServerTools,
    marketplaceServers,
    marketplaceSearching,
    marketplaceNextCursor,
    marketplaceError,
    searchMarketplace,
    lookupMarketplace,
  } = useMcpStore();

  const [searchQuery, setSearchQuery] = useState("");
  const [showAddPanel, setShowAddPanel] = useState(false);

  useEffect(() => {
    if (open && !loaded) {
      load();
    }
  }, [open, loaded, load]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (showAddPanel) {
          setShowAddPanel(false);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose, showAddPanel]);

  useEffect(() => {
    if (!open) {
      setSearchQuery("");
      setShowAddPanel(false);
    }
  }, [open]);

  const handleAddSave = useCallback(
    async (name: string, config: McpServerConfig) => {
      try {
        await setServer(name, config);
        setShowAddPanel(false);
      } catch (error) {
        useToastStore
          .getState()
          .addToast("error", `Failed to save MCP configuration: ${formatError(error)}`);
      }
    },
    [setServer],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className={`absolute inset-0 ${isLight ? "bg-black/30" : "bg-black/65"}`}
        onClick={onClose}
      />

      <div
        className="relative flex h-[792px] max-h-[88vh] w-[1060px] max-w-[94vw] flex-col overflow-hidden rounded-2xl"
        style={{
          background: isLight
            ? "linear-gradient(180deg, #FEFEFE 0%, #F6F5FA 100%)"
            : "var(--color-surface)",
          border: `1px solid ${isLight ? "rgba(var(--theme-accent-rgb),0.18)" : "var(--color-border)"}`,
          boxShadow: isLight
            ? "0 18px 60px rgba(0,0,0,0.16), 0 4px 16px rgba(var(--theme-accent-rgb),0.08)"
            : "0 18px 60px rgba(0,0,0,0.55), 0 4px 16px rgba(0,0,0,0.3)",
        }}
      >
        <div
          className="flex h-[66px] shrink-0 items-center justify-between px-6"
          style={{ borderBottom: "1px solid var(--color-border-light)" }}
        >
          <div className="flex items-center gap-3">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-[10px]"
              style={{ backgroundColor: isLight ? "#F0E6FF" : "var(--color-card)" }}
            >
              <Blocks size={18} className="text-accent-purple" />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[16px] font-bold text-foreground">{t("mcp.manager")}</span>
              <span className="text-[11px] text-muted">{t("mcp.subtitle")}</span>
            </div>
            <div
              className="ml-4 flex items-center gap-2 rounded-[10px] px-3 py-2 text-[13px] font-semibold text-foreground"
              style={{ backgroundColor: "var(--color-card)" }}
            >
              <Store size={15} className="text-accent-purple" />
              {t("mcp.tabs.marketplace")}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowAddPanel(true)}
              className="flex h-8 items-center gap-1.5 rounded-[10px] px-3 text-[12px] font-semibold text-foreground transition-colors hover:bg-border-light"
              style={{
                backgroundColor: "var(--color-card)",
                border: "1px solid var(--color-border-light)",
              }}
            >
              <Plus size={14} />
              {t("mcp.installed.addServer")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-[10px] transition-colors hover:bg-border-light"
              style={{ backgroundColor: "rgba(var(--hover-overlay-rgb),0.03)" }}
              aria-label={t("common.close", "Close")}
            >
              <X size={16} className="text-muted" />
            </button>
          </div>
        </div>

        {loadError && (
          <div
            role="alert"
            className="mx-6 mt-4 flex items-center gap-3 rounded-lg px-3 py-2 text-[12px]"
            style={{
              color: "var(--color-accent-danger)",
              backgroundColor: "color-mix(in srgb, var(--color-accent-danger) 8%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-accent-danger) 30%, transparent)",
            }}
          >
            <AlertTriangle size={15} className="shrink-0" />
            <span className="flex-1">{loadError}</span>
            <button
              type="button"
              onClick={() => void load()}
              className="flex items-center gap-1 rounded-md px-2 py-1 font-semibold hover:bg-border-light"
            >
              <RefreshCw size={12} />
              Retry
            </button>
          </div>
        )}

        <MarketplaceTab
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          servers={servers}
          marketplaceServers={marketplaceServers}
          marketplaceSearching={marketplaceSearching}
          marketplaceNextCursor={marketplaceNextCursor}
          marketplaceError={marketplaceError}
          searchMarketplace={searchMarketplace}
          lookupMarketplace={lookupMarketplace}
          setServer={setServer}
          removeServer={removeServer}
          verifyServer={verifyServer}
          verifyStatus={verifyStatus}
          toolsStatus={toolsStatus}
          listServerTools={listServerTools}
        />

        {showAddPanel && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 px-6">
            <div className="w-[440px] max-w-full">
              <AddServerPanel
                onSave={handleAddSave}
                onCancel={() => setShowAddPanel(false)}
                verifyServer={verifyServer}
                verifyStatus={verifyStatus}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
