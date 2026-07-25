import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Database,
  FolderOpen,
  Trash2,
  RefreshCw,
  AlertTriangle,
  CircleCheck,
  Loader2,
  HardDrive,
  Sparkles,
  Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StorageStats {
  readonly database_size_bytes: number;
  readonly database_message_count: number;
  readonly database_conversation_count: number;
  readonly jsonl_size_bytes: number;
  readonly jsonl_file_count: number;
  readonly codex_session_size_bytes: number;
  readonly codex_session_count: number;
  readonly temp_size_bytes: number;
}

interface DatabaseStorageStats {
  readonly size_bytes: number;
  readonly message_count: number;
  readonly conversation_count: number;
}

interface StorageCategoryStats {
  readonly size_bytes: number;
  readonly count: number;
}

const SCAN_CATEGORIES = ["database", "jsonl", "codex", "temp"] as const;
type ScanCategory = (typeof SCAN_CATEGORIES)[number];
type ScanStatus = "scanning" | "done" | "error";

const initialScanStatus = (): Record<ScanCategory, ScanStatus> => ({
  database: "scanning",
  jsonl: "scanning",
  codex: "scanning",
  temp: "scanning",
});

interface CleanupResult {
  readonly freed_bytes: number;
  readonly items_removed: number;
}

type CleanupAction = "old_conversations" | "all_conversations" | "vacuum" | "activity" | "temp";

interface CleanupState {
  readonly status: "idle" | "running" | "done" | "error";
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  const value = bytes / Math.pow(k, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

const CATEGORY_COLORS: Record<string, string> = {
  database: "#A855F7",
  jsonl: "#3B82F6",
  codex: "#14B8A6",
  temp: "#F59E0B",
};

function sizeBytesForCategory(
  stats: Partial<StorageStats>,
  category: ScanCategory,
): number | undefined {
  switch (category) {
    case "database":
      return stats.database_size_bytes;
    case "jsonl":
      return stats.jsonl_size_bytes;
    case "codex":
      return stats.codex_session_size_bytes;
    case "temp":
      return stats.temp_size_bytes;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StoragePanel() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<Partial<StorageStats>>({});
  const [scanStatus, setScanStatus] = useState<Record<ScanCategory, ScanStatus>>(initialScanStatus);
  const scanIdRef = useRef(0);
  const [cleanupStates, setCleanupStates] = useState<Record<CleanupAction, CleanupState>>({
    old_conversations: { status: "idle", message: "" },
    all_conversations: { status: "idle", message: "" },
    vacuum: { status: "idle", message: "" },
    activity: { status: "idle", message: "" },
    temp: { status: "idle", message: "" },
  });
  const [confirmAction, setConfirmAction] = useState<CleanupAction | null>(null);
  const [retentionDays, setRetentionDays] = useState(7);

  const fetchStats = useCallback(async () => {
    const scanId = ++scanIdRef.current;
    setStats({});
    setScanStatus(initialScanStatus());

    const markDone = (category: ScanCategory, partial: Partial<StorageStats>) => {
      if (scanIdRef.current !== scanId) return;
      setStats((prev) => ({ ...prev, ...partial }));
      setScanStatus((prev) => ({ ...prev, [category]: "done" }));
    };
    const markError = (category: ScanCategory) => {
      if (scanIdRef.current !== scanId) return;
      setScanStatus((prev) => ({ ...prev, [category]: "error" }));
    };

    const tasks: Record<ScanCategory, () => Promise<Partial<StorageStats>>> = {
      database: async () => {
        const r = await invoke<DatabaseStorageStats>("get_storage_stats_database");
        return {
          database_size_bytes: r.size_bytes,
          database_message_count: r.message_count,
          database_conversation_count: r.conversation_count,
        };
      },
      jsonl: async () => {
        const r = await invoke<StorageCategoryStats>("get_storage_stats_jsonl");
        return { jsonl_size_bytes: r.size_bytes, jsonl_file_count: r.count };
      },
      codex: async () => {
        const r = await invoke<StorageCategoryStats>("get_storage_stats_codex");
        return { codex_session_size_bytes: r.size_bytes, codex_session_count: r.count };
      },
      temp: async () => {
        const r = await invoke<StorageCategoryStats>("get_storage_stats_temp");
        return { temp_size_bytes: r.size_bytes };
      },
    };

    const outcomes = await Promise.all(
      SCAN_CATEGORIES.map(async (category) => {
        try {
          markDone(category, await tasks[category]());
          return true;
        } catch {
          markError(category);
          return false;
        }
      }),
    );

    // All per-category commands failed — try the legacy aggregate command.
    if (outcomes.every((ok) => !ok) && scanIdRef.current === scanId) {
      try {
        const legacy = await invoke<StorageStats>("get_storage_stats");
        if (scanIdRef.current !== scanId) return;
        setStats(legacy);
        setScanStatus({
          database: "done",
          jsonl: "done",
          codex: "done",
          temp: "done",
        });
      } catch {
        // keep per-category error states
      }
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const setActionState = useCallback((action: CleanupAction, state: CleanupState) => {
    setCleanupStates((prev) => ({ ...prev, [action]: state }));
  }, []);

  const handleCleanup = useCallback(
    async (action: CleanupAction) => {
      setConfirmAction(null);
      setActionState(action, { status: "running", message: "" });

      try {
        let result: CleanupResult;

        switch (action) {
          case "old_conversations":
            result = await invoke<CleanupResult>("clear_old_conversations", {
              days: retentionDays,
            });
            break;
          case "all_conversations":
            result = await invoke<CleanupResult>("clear_all_conversations");
            break;
          case "vacuum":
            result = await invoke<CleanupResult>("vacuum_database");
            break;
          case "activity":
            result = await invoke<CleanupResult>("clear_activity_data");
            break;
          case "temp":
            result = await invoke<CleanupResult>("clear_temp_files");
            break;
        }

        const freed = result.freed_bytes > 0 ? formatBytes(result.freed_bytes) : "";
        const parts = [
          result.items_removed > 0
            ? t("settings.storage.itemsRemoved", { count: result.items_removed })
            : "",
          freed ? t("settings.storage.freedSpace", { size: freed }) : "",
        ].filter(Boolean);

        setActionState(action, {
          status: "done",
          message: parts.length > 0 ? parts.join(", ") : t("settings.storage.done"),
        });

        // Refresh stats
        fetchStats();
      } catch (err) {
        setActionState(action, {
          status: "error",
          message: String(err),
        });
      }
    },
    [retentionDays, setActionState, fetchStats, t],
  );

  const needsConfirm = (action: CleanupAction): boolean =>
    action === "old_conversations" || action === "all_conversations";

  const requestCleanup = useCallback(
    (action: CleanupAction) => {
      if (needsConfirm(action)) {
        setConfirmAction(action);
      } else {
        handleCleanup(action);
      }
    },
    [handleCleanup],
  );

  // ---------------------------------------------------------------------------
  // Derived scan state
  // ---------------------------------------------------------------------------

  const scanning = SCAN_CATEGORIES.some((c) => scanStatus[c] === "scanning");
  const scannedCount = SCAN_CATEGORIES.filter((c) => scanStatus[c] !== "scanning").length;
  const allFailed = SCAN_CATEGORIES.every((c) => scanStatus[c] === "error");
  const totalSizeBytes =
    (stats.database_size_bytes ?? 0) +
    (stats.jsonl_size_bytes ?? 0) +
    (stats.codex_session_size_bytes ?? 0) +
    (stats.temp_size_bytes ?? 0);

  const formatCount = (value: number | undefined) =>
    value === undefined ? "—" : value.toLocaleString();

  // ---------------------------------------------------------------------------
  // Storage breakdown bar
  // ---------------------------------------------------------------------------

  const renderBreakdownBar = () => {
    const segments = [
      { key: "database", size: stats.database_size_bytes, color: CATEGORY_COLORS.database },
      { key: "jsonl", size: stats.jsonl_size_bytes, color: CATEGORY_COLORS.jsonl },
      { key: "codex", size: stats.codex_session_size_bytes, color: CATEGORY_COLORS.codex },
      { key: "temp", size: stats.temp_size_bytes, color: CATEGORY_COLORS.temp },
    ];
    const doneSegments = segments.filter(
      (s) => scanStatus[s.key as ScanCategory] === "done" && (s.size ?? 0) > 0,
    );
    const scanningSegments = segments.filter(
      (s) => scanStatus[s.key as ScanCategory] === "scanning",
    );
    if (doneSegments.length === 0 && scanningSegments.length === 0) return null;
    const total = totalSizeBytes;

    return (
      <div className="flex flex-col gap-3">
        {/* Stacked bar */}
        <div className="flex h-3 rounded-full overflow-hidden bg-border">
          {total > 0 &&
            doneSegments.map((seg) => (
              <div
                key={seg.key}
                style={{
                  width: `${Math.max(((seg.size ?? 0) / total) * 100, 2)}%`,
                  backgroundColor: seg.color,
                  transition: "width 0.3s ease",
                }}
              />
            ))}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {doneSegments.map((seg) => (
            <div key={seg.key} className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: seg.color }} />
              <span className="text-[11px] text-muted">
                {t(`settings.storage.category.${seg.key}`)}
              </span>
              <span className="text-[11px] text-text-tertiary font-mono">
                {formatBytes(seg.size ?? 0)}
              </span>
            </div>
          ))}
          {scanningSegments.map((seg) => (
            <div key={seg.key} className="flex items-center gap-1.5">
              <Loader2 size={10} className="animate-spin text-muted" />
              <span className="text-[11px] text-muted">
                {t(`settings.storage.category.${seg.key}`)}
              </span>
              <span className="text-[11px] text-text-tertiary font-mono">
                {t("settings.storage.scanning")}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Cleanup card
  // ---------------------------------------------------------------------------

  const renderCleanupCard = (
    action: CleanupAction,
    icon: typeof Database,
    iconColor: string,
    titleKey: string,
    descKey: string,
    sizeCategory?: ScanCategory,
    extra?: React.ReactNode,
  ) => {
    const Icon = icon;
    const state = cleanupStates[action];
    const isRunning = state.status === "running";
    const sizeBytes =
      sizeCategory && scanStatus[sizeCategory] === "done"
        ? sizeBytesForCategory(stats, sizeCategory)
        : undefined;
    const sizeScanning = sizeCategory !== undefined && scanStatus[sizeCategory] === "scanning";

    return (
      <div className="flex items-center gap-3 py-2.5">
        <div
          className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
          style={{ backgroundColor: `color-mix(in srgb, ${iconColor} 15%, var(--color-card))` }}
        >
          <Icon size={15} style={{ color: iconColor }} />
        </div>

        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-foreground">{t(titleKey)}</span>
            {sizeBytes !== undefined && sizeBytes > 0 && (
              <span className="text-[11px] font-mono text-text-tertiary">
                {formatBytes(sizeBytes)}
              </span>
            )}
            {sizeScanning && <Loader2 size={10} className="animate-spin text-muted" />}
          </div>
          <span className="text-[11px] text-text-tertiary truncate">{t(descKey)}</span>
          {extra}
          {state.status === "done" && (
            <div className="flex items-center gap-1 mt-0.5">
              <CircleCheck size={11} className="text-[#10B981]" />
              <span className="text-[10px] font-mono text-[#10B981]">{state.message}</span>
            </div>
          )}
          {state.status === "error" && (
            <span className="text-[10px] font-mono text-red-400 mt-0.5 truncate">
              {state.message}
            </span>
          )}
        </div>

        <button
          onClick={() => requestCleanup(action)}
          disabled={isRunning}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border-strong text-[11px] font-medium text-foreground hover:bg-border-subtle disabled:opacity-40 transition-colors shrink-0"
        >
          {isRunning ? (
            <Loader2 size={12} className="animate-spin text-muted" />
          ) : (
            <Trash2 size={12} className="text-muted" />
          )}
          {t("settings.storage.clean")}
        </button>
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-4">
      {/* Overview Card */}
      <div className="rounded-lg bg-card border border-border-subtle p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="flex items-center justify-center w-9 h-9 rounded-lg"
              style={{
                backgroundColor:
                  "color-mix(in srgb, var(--color-accent-purple) 15%, var(--color-card))",
              }}
            >
              <HardDrive size={16} className="text-accent-purple" />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[14px] font-semibold text-foreground">
                {t("settings.storage.overview")}
              </span>
              <span className="text-[12px] text-text-tertiary">
                {scanning
                  ? t("settings.storage.scanningProgress", {
                      done: scannedCount,
                      total: SCAN_CATEGORIES.length,
                    })
                  : allFailed
                    ? t("settings.storage.unavailable")
                    : t("settings.storage.totalUsed", { size: formatBytes(totalSizeBytes) })}
              </span>
            </div>
          </div>
          <button
            onClick={fetchStats}
            disabled={scanning}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border-strong text-[11px] font-medium text-foreground hover:bg-border-subtle disabled:opacity-40 transition-colors"
          >
            <RefreshCw size={12} className={cn("text-muted", scanning && "animate-spin")} />
            {t("settings.storage.refresh")}
          </button>
        </div>

        {!allFailed && (
          <>
            <div className="h-px bg-border-subtle" />

            {renderBreakdownBar()}

            {/* Quick stats */}
            <div className="flex gap-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-[20px] font-semibold text-foreground font-mono">
                  {formatCount(stats.database_conversation_count)}
                </span>
                <span className="text-[11px] text-text-tertiary">
                  {t("settings.storage.conversations")}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[20px] font-semibold text-foreground font-mono">
                  {formatCount(stats.database_message_count)}
                </span>
                <span className="text-[11px] text-text-tertiary">
                  {t("settings.storage.messages")}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[20px] font-semibold text-foreground font-mono">
                  {formatCount(stats.jsonl_file_count)}
                </span>
                <span className="text-[11px] text-text-tertiary">
                  {t("settings.storage.sessionFiles")}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[20px] font-semibold text-foreground font-mono">
                  {formatCount(stats.codex_session_count)}
                </span>
                <span className="text-[11px] text-text-tertiary">
                  {t("settings.storage.persistentSessions")}
                </span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Retention days selector */}
      <div className="rounded-lg bg-card border border-border-subtle p-4 flex items-center gap-3">
        <div
          className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
          style={{ backgroundColor: "color-mix(in srgb, #3B82F6 15%, var(--color-card))" }}
        >
          <Activity size={15} className="text-[#3B82F6]" />
        </div>
        <div className="flex flex-col gap-0.5 flex-1">
          <span className="text-[13px] font-medium text-foreground">
            {t("settings.storage.retentionDays")}
          </span>
          <span className="text-[11px] text-text-tertiary">
            {t("settings.storage.retentionDaysDesc")}
          </span>
        </div>
        <select
          value={retentionDays}
          onChange={(e) => setRetentionDays(Number(e.target.value))}
          className="bg-surface border border-border-subtle rounded-md px-3 py-1.5 text-[13px] text-foreground outline-none focus:border-accent-purple transition-colors cursor-pointer"
        >
          <option value={3}>3 {t("settings.storage.days")}</option>
          <option value={7}>7 {t("settings.storage.days")}</option>
          <option value={14}>14 {t("settings.storage.days")}</option>
          <option value={30}>30 {t("settings.storage.days")}</option>
          <option value={60}>60 {t("settings.storage.days")}</option>
          <option value={90}>90 {t("settings.storage.days")}</option>
        </select>
      </div>

      {/* Cleanup Actions */}
      <div className="rounded-lg bg-card border border-border-subtle p-4 flex flex-col gap-1">
        <div className="flex items-center gap-3 mb-2">
          <div
            className="flex items-center justify-center w-9 h-9 rounded-lg"
            style={{ backgroundColor: "color-mix(in srgb, #F59E0B 15%, var(--color-card))" }}
          >
            <Sparkles size={16} className="text-[#F59E0B]" />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[14px] font-semibold text-foreground">
              {t("settings.storage.cleanupActions")}
            </span>
            <span className="text-[12px] text-text-tertiary">
              {t("settings.storage.cleanupActionsDesc")}
            </span>
          </div>
        </div>

        <div className="h-px bg-border-subtle" />

        {renderCleanupCard(
          "old_conversations",
          Database,
          CATEGORY_COLORS.database,
          "settings.storage.clearOldChats",
          "settings.storage.clearOldChatsDesc",
          "database",
        )}

        <div className="h-px bg-border-subtle ml-11" />

        {renderCleanupCard(
          "vacuum",
          RefreshCw,
          "#6366F1",
          "settings.storage.optimizeDb",
          "settings.storage.optimizeDbDesc",
        )}

        <div className="h-px bg-border-subtle ml-11" />

        {renderCleanupCard(
          "temp",
          FolderOpen,
          CATEGORY_COLORS.temp,
          "settings.storage.clearTemp",
          "settings.storage.clearTempDesc",
          "temp",
        )}

        <div className="h-px bg-border-subtle ml-11" />

        {renderCleanupCard(
          "activity",
          Activity,
          "#06B6D4",
          "settings.storage.clearActivity",
          "settings.storage.clearActivityDesc",
        )}
      </div>

      {/* Danger zone */}
      <div
        className="rounded-lg border border-red-500/30 p-4 flex flex-col gap-1"
        style={{ backgroundColor: "color-mix(in srgb, #EF4444 5%, var(--color-card))" }}
      >
        <div className="flex items-center gap-3 mb-2">
          <div
            className="flex items-center justify-center w-9 h-9 rounded-lg"
            style={{ backgroundColor: "color-mix(in srgb, #EF4444 15%, var(--color-card))" }}
          >
            <AlertTriangle size={16} className="text-red-400" />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[14px] font-semibold text-foreground">
              {t("settings.storage.dangerZone")}
            </span>
            <span className="text-[12px] text-text-tertiary">
              {t("settings.storage.dangerZoneDesc")}
            </span>
          </div>
        </div>
        <div className="h-px bg-red-500/20" />
        {renderCleanupCard(
          "all_conversations",
          Trash2,
          "#EF4444",
          "settings.storage.clearAllChats",
          "settings.storage.clearAllChatsDesc",
        )}
      </div>

      {/* Confirmation Dialog */}
      {confirmAction && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setConfirmAction(null)}
            aria-hidden="true"
          />
          <div
            className="relative w-[400px] rounded-xl p-6 flex flex-col gap-4"
            style={{
              backgroundColor: "var(--color-surface-raised)",
              border: "1px solid var(--color-border-light)",
              boxShadow: "0 16px 48px rgba(0,0,0,0.4)",
            }}
          >
            <div className="flex items-center gap-3">
              <div
                className="flex items-center justify-center w-10 h-10 rounded-full"
                style={{ backgroundColor: "color-mix(in srgb, #F59E0B 15%, var(--color-card))" }}
              >
                <AlertTriangle size={20} className="text-[#F59E0B]" />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[15px] font-semibold text-foreground">
                  {t("settings.storage.confirmTitle")}
                </span>
                <span className="text-[12px] text-text-tertiary">
                  {t(`settings.storage.confirm.${confirmAction}`)}
                </span>
              </div>
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmAction(null)}
                className="px-4 py-2 rounded-md text-[13px] font-medium text-muted-foreground hover:bg-border transition-colors"
                style={{ border: "1px solid var(--color-border-strong)" }}
              >
                {t("settings.storage.cancel")}
              </button>
              <button
                onClick={() => handleCleanup(confirmAction)}
                className="px-4 py-2 rounded-md text-[13px] font-semibold text-white bg-red-500 hover:bg-red-600 transition-colors"
              >
                {t("settings.storage.confirmDelete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
