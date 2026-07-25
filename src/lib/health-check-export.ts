import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { APP_NAME } from "@/lib/app-constants";
import type { DimensionState, EnrichedIssue } from "@/stores/health-check-store";

interface ExportData {
  readonly overallScore: number | null;
  readonly summary: string | null;
  readonly dimensions: ReadonlyArray<DimensionState>;
  readonly issues: ReadonlyArray<EnrichedIssue>;
  readonly workspaceName: string;
}

export async function exportHealthCheckReport(data: ExportData): Promise<boolean> {
  const md = buildMarkdownReport(data);

  try {
    const path = await save({
      defaultPath: `health-check-report-${new Date().toISOString().slice(0, 10)}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });

    if (!path) return false;

    await invoke("write_file_content", { path, content: md });
    return true;
  } catch {
    return false;
  }
}

function buildMarkdownReport(data: ExportData): string {
  const lines: string[] = [];
  const date = new Date().toLocaleString();

  lines.push(`# 项目体检报告`);
  lines.push(``);
  lines.push(`- **项目**: ${data.workspaceName}`);
  lines.push(`- **生成时间**: ${date}`);
  lines.push(`- **综合评分**: ${data.overallScore ?? "—"} / 100`);
  lines.push(``);

  if (data.summary) {
    lines.push(`## 总结`);
    lines.push(``);
    lines.push(data.summary);
    lines.push(``);
  }

  lines.push(`## 维度评分`);
  lines.push(``);
  lines.push(`| 维度 | 评分 | 问题数 |`);
  lines.push(`|------|------|--------|`);
  for (const dim of data.dimensions) {
    const issueCount = dim.issues.length;
    lines.push(`| ${dim.label} | ${dim.score ?? "—"} | ${issueCount} |`);
  }
  lines.push(``);

  if (data.issues.length > 0) {
    lines.push(`## 问题清单`);
    lines.push(``);

    const critical = data.issues.filter((i) => i.severity === "critical");
    const warning = data.issues.filter((i) => i.severity === "warning");
    const info = data.issues.filter((i) => i.severity === "info");

    if (critical.length > 0) {
      lines.push(`### 🔴 严重问题 (${critical.length})`);
      lines.push(``);
      for (const issue of critical) {
        lines.push(`- **${issue.message}**`);
        if (issue.file) lines.push(`  - 文件: \`${issue.file}\``);
        if (issue.suggestion) lines.push(`  - 建议: ${issue.suggestion}`);
      }
      lines.push(``);
    }

    if (warning.length > 0) {
      lines.push(`### 🟡 警告 (${warning.length})`);
      lines.push(``);
      for (const issue of warning) {
        lines.push(`- **${issue.message}**`);
        if (issue.file) lines.push(`  - 文件: \`${issue.file}\``);
        if (issue.suggestion) lines.push(`  - 建议: ${issue.suggestion}`);
      }
      lines.push(``);
    }

    if (info.length > 0) {
      lines.push(`### 🔵 提示 (${info.length})`);
      lines.push(``);
      for (const issue of info) {
        lines.push(`- ${issue.message}`);
        if (issue.file) lines.push(`  - 文件: \`${issue.file}\``);
      }
      lines.push(``);
    }
  }

  lines.push(`---`);
  lines.push(`*由 ${APP_NAME} 项目体检自动生成*`);

  return lines.join("\n");
}
