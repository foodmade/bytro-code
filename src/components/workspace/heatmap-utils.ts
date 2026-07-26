import type { HeatmapDayData } from "@/hooks/use-heatmap-data";

export const MONTH_ABBREVIATIONS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

export function calculateActivityLevel(
  day: HeatmapDayData | undefined,
  maxValues: {
    readonly fileChanges: number;
    readonly chatCount: number;
    readonly tokenUsage: number;
  },
): 0 | 1 | 2 | 3 | 4 {
  if (!day) return 0;

  const fileScore = maxValues.fileChanges
    ? day.file_changes / maxValues.fileChanges
    : 0;
  const chatScore = maxValues.chatCount
    ? day.chat_count / maxValues.chatCount
    : 0;
  const tokenScore = maxValues.tokenUsage
    ? day.token_usage / maxValues.tokenUsage
    : 0;

  const score = fileScore * 0.6 + chatScore * 0.25 + tokenScore * 0.15;

  if (score === 0) return 0;
  if (score <= 0.25) return 1;
  if (score <= 0.5) return 2;
  if (score <= 0.75) return 3;
  return 4;
}

export interface WeekColumn {
  readonly days: ReadonlyArray<string | null>;
}

export interface MonthLabel {
  readonly name: string;
  readonly colIndex: number;
}

export interface GridData {
  readonly weeks: readonly WeekColumn[];
  readonly monthLabels: readonly MonthLabel[];
}

function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function buildCalendarGrid(): GridData {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const jan1 = new Date(today.getFullYear(), 0, 1);
  const dec31 = new Date(today.getFullYear(), 11, 31);

  const startDate = new Date(jan1);
  const jan1Dow = startDate.getDay();
  if (jan1Dow !== 0) {
    startDate.setDate(startDate.getDate() - jan1Dow);
  }

  const weeks: WeekColumn[] = [];
  const monthLabels: MonthLabel[] = [];
  let lastMonthSeen = -1;
  const cursor = new Date(startDate);

  while (cursor <= dec31) {
    const week: (string | null)[] = [];

    for (let dow = 0; dow < 7; dow++) {
      if (cursor >= jan1 && cursor <= dec31) {
        const dateStr = formatDate(cursor);
        week.push(dateStr);

        const month = cursor.getMonth();
        if (month !== lastMonthSeen && cursor.getDate() <= 7) {
          monthLabels.push({
            name: MONTH_ABBREVIATIONS[month],
            colIndex: weeks.length,
          });
          lastMonthSeen = month;
        }
      } else {
        week.push(null);
      }

      cursor.setDate(cursor.getDate() + 1);
    }

    weeks.push({ days: week });
  }

  return { weeks, monthLabels };
}

// ─── Daily trend data ───

export interface DailyDataPoint {
  readonly date: string;
  readonly sessions: number;
  readonly tokens: number;
}

export function buildDailyTrend(
  data: Map<string, HeatmapDayData>,
  days: number = 30,
): readonly DailyDataPoint[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result: DailyDataPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = formatDate(d);
    const dayData = data.get(dateStr);
    result.push({
      date: dateStr,
      sessions: dayData?.chat_count ?? 0,
      tokens: dayData?.token_usage ?? 0,
    });
  }

  return result;
}

export interface DailySummary {
  readonly todaySessions: number;
  readonly avgDailySessions: number;
  readonly todayTokens: number;
  readonly tokensChangePercent: number | null;
}

export function computeDailySummary(
  dailyData: readonly DailyDataPoint[],
): DailySummary {
  if (dailyData.length === 0) {
    return {
      todaySessions: 0,
      avgDailySessions: 0,
      todayTokens: 0,
      tokensChangePercent: null,
    };
  }

  const today = dailyData[dailyData.length - 1];
  const yesterday =
    dailyData.length >= 2 ? dailyData[dailyData.length - 2] : null;

  const totalSessions = dailyData.reduce((sum, d) => sum + d.sessions, 0);
  const avgDailySessions = Math.round(totalSessions / dailyData.length);

  const tokensChangePercent =
    yesterday && yesterday.tokens > 0
      ? Math.round(
          ((today.tokens - yesterday.tokens) / yesterday.tokens) * 100,
        )
      : null;

  return {
    todaySessions: today.sessions,
    avgDailySessions,
    todayTokens: today.tokens,
    tokensChangePercent,
  };
}

// ─── SVG curve rendering ───

export function buildSmoothPath(
  points: readonly { x: number; y: number }[],
): string {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M ${points[0].x},${points[0].y} L ${points[1].x},${points[1].y}`;
  }

  const tension = 0.3;
  // Compute y bounds from data points to clamp control points
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  let d = `M ${points[0].x},${points[0].y}`;

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    const cp1x = p1.x + (p2.x - p0.x) * tension;
    const cp1y = Math.max(minY, Math.min(maxY, p1.y + (p2.y - p0.y) * tension));
    const cp2x = p2.x - (p3.x - p1.x) * tension;
    const cp2y = Math.max(minY, Math.min(maxY, p2.y - (p3.y - p1.y) * tension));

    d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
  }

  return d;
}

export function buildAreaPath(
  linePath: string,
  points: readonly { x: number; y: number }[],
  baseY: number,
): string {
  if (points.length < 2) return "";
  const first = points[0];
  const last = points[points.length - 1];
  return `${linePath} L ${last.x},${baseY} L ${first.x},${baseY} Z`;
}

export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}
