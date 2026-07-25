import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface HeatmapDayData {
  readonly date: string;
  readonly chat_count: number;
  readonly token_usage: number;
  readonly file_changes: number;
}

export function useHeatmapData(workspaceId: string) {
  const [data, setData] = useState<Map<string, HeatmapDayData>>(new Map());
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const rows = await invoke<HeatmapDayData[]>("get_local_heatmap", {
          workspaceId,
          days: 365,
        });

        if (!cancelled) {
          setData(new Map(rows.map((r) => [r.date, r])));
        }
      } catch {
        // Silently fail - show empty heatmap
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  return { data, loading };
}
