import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  X,
  ChevronDown,
  Loader2,
  Zap,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsLightTheme } from "@/hooks/use-is-light-theme";
import type { McpServerConfig } from "@/stores";
import type { DraftServer, ServerType } from "./mcp-helpers";
import { EMPTY_DRAFT, configFromDraft } from "./mcp-helpers";

interface AddServerPanelProps {
  readonly onSave: (name: string, config: McpServerConfig) => void;
  readonly onCancel: () => void;
  readonly verifyServer: (name: string, config: McpServerConfig) => void;
  readonly verifyStatus: Record<string, { loading: boolean; result: { ok: boolean; message: string } | null }>;
}

export function AddServerPanel({
  onSave,
  onCancel,
  verifyServer,
  verifyStatus,
}: AddServerPanelProps) {
  const { t } = useTranslation();
  const isLight = useIsLightTheme();
  const [draft, setDraft] = useState<DraftServer>({ ...EMPTY_DRAFT });

  const handleSave = () => {
    if (!draft.name.trim()) return;
    const config = configFromDraft(draft);
    if (draft.type === "stdio" && !draft.command.trim()) return;
    if ((draft.type === "sse" || draft.type === "http") && !draft.url.trim()) return;
    onSave(draft.name.trim(), config);
  };

  const handleVerify = () => {
    if (!draft.name.trim()) return;
    const config = configFromDraft(draft);
    if (draft.type === "stdio" && !draft.command.trim()) return;
    if ((draft.type === "sse" || draft.type === "http") && !draft.url.trim()) return;
    verifyServer(draft.name.trim(), config);
  };

  const vs = verifyStatus[draft.name.trim()];

  return (
    <div className="flex flex-col gap-3 p-4 rounded-xl" style={{
      backgroundColor: "var(--color-card)",
      border: "1px solid var(--color-border-light)",
    }}>
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-foreground">{t("mcp.addServer.title")}</span>
        <button onClick={onCancel} className="text-muted hover:text-muted-foreground transition-colors">
          <X size={14} />
        </button>
      </div>

      {/* Name */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-text-placeholder">{t("mcp.addServer.serverName")}</span>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="my-mcp-server"
          className="h-8 rounded-md px-3 text-[12px] text-foreground font-mono outline-none placeholder:text-muted"
          style={{ backgroundColor: "var(--color-surface-alt)", border: "1px solid var(--color-border-strong)" }}
        />
      </div>

      {/* Type */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-text-placeholder">{t("mcp.addServer.type")}</span>
        <div className="relative">
          <select
            value={draft.type}
            onChange={(e) => setDraft({ ...draft, type: e.target.value as ServerType })}
            className="w-full h-8 rounded-md px-3 text-[12px] text-foreground font-mono outline-none appearance-none cursor-pointer"
            style={{ backgroundColor: "var(--color-surface-alt)", border: "1px solid var(--color-border-strong)" }}
          >
            <option value="stdio">{t("mcp.addServer.stdioType")}</option>
            <option value="sse">{t("mcp.addServer.sseType")}</option>
            <option value="http">{t("mcp.addServer.httpType")}</option>
          </select>
          <ChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 text-border-strong pointer-events-none" />
        </div>
      </div>

      {/* Stdio fields */}
      {draft.type === "stdio" && (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-text-placeholder">{t("mcp.addServer.command")}</span>
            <input
              type="text"
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              placeholder="npx"
              className="h-8 rounded-md px-3 text-[12px] text-foreground font-mono outline-none placeholder:text-muted"
              style={{ backgroundColor: "var(--color-surface-alt)", border: "1px solid var(--color-border-strong)" }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-text-placeholder">{t("mcp.addServer.arguments")} <span className="text-border-strong font-normal">{t("mcp.addServer.argsSeparated")}</span></span>
            <input
              type="text"
              value={draft.args}
              onChange={(e) => setDraft({ ...draft, args: e.target.value })}
              placeholder="-y @modelcontextprotocol/server-filesystem /path"
              className="h-8 rounded-md px-3 text-[12px] text-foreground font-mono outline-none placeholder:text-muted"
              style={{ backgroundColor: "var(--color-surface-alt)", border: "1px solid var(--color-border-strong)" }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-text-placeholder">{t("mcp.addServer.envVariables")} <span className="text-border-strong font-normal">{t("mcp.addServer.envFormat")}</span></span>
            <textarea
              value={draft.env}
              onChange={(e) => setDraft({ ...draft, env: e.target.value })}
              placeholder={"API_KEY=xxx\nDEBUG=true"}
              rows={2}
              className="rounded-md px-3 py-2 text-[12px] text-foreground font-mono outline-none placeholder:text-muted resize-none"
              style={{ backgroundColor: "var(--color-surface-alt)", border: "1px solid var(--color-border-strong)" }}
            />
          </div>
        </>
      )}

      {/* SSE / HTTP fields */}
      {(draft.type === "sse" || draft.type === "http") && (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-text-placeholder">{t("mcp.addServer.url")}</span>
            <input
              type="text"
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              placeholder="http://localhost:3000/mcp"
              className="h-8 rounded-md px-3 text-[12px] text-foreground font-mono outline-none placeholder:text-muted"
              style={{ backgroundColor: "var(--color-surface-alt)", border: "1px solid var(--color-border-strong)" }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-text-placeholder">{t("mcp.addServer.headers")} <span className="text-border-strong font-normal">{t("mcp.addServer.headersFormat")}</span></span>
            <textarea
              value={draft.headers}
              onChange={(e) => setDraft({ ...draft, headers: e.target.value })}
              placeholder={"Authorization: Bearer token123"}
              rows={2}
              className="rounded-md px-3 py-2 text-[12px] text-foreground font-mono outline-none placeholder:text-muted resize-none"
              style={{ backgroundColor: "var(--color-surface-alt)", border: "1px solid var(--color-border-strong)" }}
            />
          </div>
        </>
      )}

      {/* Test + result */}
      <button
        onClick={handleVerify}
        disabled={
          !draft.name.trim() ||
          (draft.type === "stdio" && !draft.command.trim()) ||
          ((draft.type === "sse" || draft.type === "http") && !draft.url.trim()) ||
          vs?.loading
        }
        className="flex items-center justify-center gap-1.5 w-full py-2 rounded-md text-[11px] font-medium text-foreground hover:bg-card transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ border: "1px solid var(--color-border-strong)" }}
      >
        {vs?.loading ? <Loader2 size={12} className="text-[#F59E0B] animate-spin" /> : <Zap size={12} className="text-[#22C55E]" />}
        {vs?.loading ? t("mcp.addServer.testing") : t("mcp.addServer.testConnection")}
      </button>

      {vs?.result && (
        <div
          className="flex items-start gap-2 px-3 py-2 rounded-md text-[11px]"
          style={{
            backgroundColor: vs.result.ok ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
            border: `1px solid ${vs.result.ok ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}`,
          }}
        >
          {vs.result.ok ? <CheckCircle2 size={12} className="text-[#22C55E] shrink-0 mt-0.5" /> : <XCircle size={12} className="text-[#EF4444] shrink-0 mt-0.5" />}
          <span style={{ color: vs.result.ok ? (isLight ? "#16A34A" : "#4ADE80") : (isLight ? "#DC2626" : "#F87171") }}>{vs.result.message}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-md text-[11px] font-medium text-muted-foreground hover:bg-border transition-colors" style={{ border: "1px solid var(--color-border-strong)" }}>
          {t("mcp.addServer.cancel")}
        </button>
        <button
          onClick={handleSave}
          disabled={
            !draft.name.trim() ||
            (draft.type === "stdio" && !draft.command.trim()) ||
            ((draft.type === "sse" || draft.type === "http") && !draft.url.trim())
          }
          className={cn(
            "px-4 py-1.5 rounded-md text-[11px] font-semibold text-white transition-colors",
            "bg-accent-purple hover:bg-[#9333EA] disabled:opacity-40 disabled:cursor-not-allowed",
          )}
        >
          {t("mcp.addServer.add")}
        </button>
      </div>
    </div>
  );
}
