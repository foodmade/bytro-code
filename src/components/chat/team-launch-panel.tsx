import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Users, Plus, Trash2, Rocket, Loader2, AlertCircle } from "lucide-react";
import { useTeamsStore, useSettingsStore, ROLE_META, TEAM_TEMPLATES } from "@/stores";
import type { AgentRole, TeamsAgentConfig, TeamTemplate } from "@/stores";
import { useTeamsChat } from "@/hooks";
import { getCustomModelsForActiveProfile, getDisplayModelsForPlatform, resolveActiveCredentials } from "@/lib/platform-config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DraftMember {
  readonly id: string;
  readonly name: string;
  readonly role: AgentRole;
}

// ---------------------------------------------------------------------------
// TeamLaunchPanel
// ---------------------------------------------------------------------------

interface TeamLaunchPanelProps {
  readonly onClose: () => void;
  /** Override the container's positioning styles (e.g. for sidebar popover mode). */
  readonly containerStyle?: React.CSSProperties;
}

export function TeamLaunchPanel({ onClose, containerStyle }: TeamLaunchPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"templates" | "custom">("templates");
  const [launching, setLaunching] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");
  const [selectedTeamModelId, setSelectedTeamModelId] = useState("");
  const [modelValidationVisible, setModelValidationVisible] = useState(false);
  const [members, setMembers] = useState<DraftMember[]>([
    { id: "1", name: "dev", role: "coder" },
    { id: "2", name: "reviewer", role: "reviewer" },
  ]);
  const panelRef = useRef<HTMLDivElement>(null);
  const { launchTeam } = useTeamsChat();
  const claudeConfig = useSettingsStore((s) => s.platforms.claude);
  const getDefaultPrompt = useTeamsStore((s) => s.getDefaultPrompt);
  const sessionPhase = useTeamsStore((s) => s.session?.phase);
  const sessionError = useTeamsStore((s) => s.session?.error);
  const startupStatus = useTeamsStore((s) => s.session?.startupStatus);
  const clearSession = useTeamsStore((s) => s.clearSession);
  const claudeCredentials = useMemo(() => resolveActiveCredentials(claudeConfig), [claudeConfig]);
  const modelOptions = useMemo(() => (
    claudeCredentials
      ? getDisplayModelsForPlatform("claude", undefined, getCustomModelsForActiveProfile(claudeConfig))
      : []
  ), [claudeConfig, claudeCredentials]);
  const canLaunchWithModel = Boolean(claudeCredentials) && modelOptions.length > 0 && selectedTeamModelId.length > 0;
  const canLaunchCustom = members.length > 0 && canLaunchWithModel;
  const startupStatusText = startupStatus?.attempt && startupStatus.maxAttempts
    ? `${startupStatus.message ?? startupStatus.status} (${startupStatus.attempt}/${startupStatus.maxAttempts})`
    : startupStatus?.message ?? startupStatus?.status;

  // If launch fails (sidecar emits teams_error), exit launching state so the
  // user sees the error inline instead of an indefinite spinner. The launch
  // panel may be controlled by parent-local state (workspace-rail) that the
  // store's closeLaunchPanel cannot reach, so we surface the error here.
  useEffect(() => {
    if (launching && sessionPhase === "error") {
      setLaunching(false);
    }
  }, [launching, sessionPhase]);

  // Close on Escape (but not while launching)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !launching) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, launching]);

  // Close on click outside (but not while launching)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!launching && panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose, launching]);

  useEffect(() => {
    if (selectedTeamModelId && !modelOptions.some((model) => model.id === selectedTeamModelId)) {
      setSelectedTeamModelId("");
      setModelValidationVisible(false);
    }
  }, [modelOptions, selectedTeamModelId]);

  /** Common launch logic — build agents, call launchTeam, show loading */
  const doLaunch = useCallback(async (agents: ReadonlyArray<TeamsAgentConfig>) => {
    if (!canLaunchWithModel) {
      setModelValidationVisible(true);
      return;
    }

    setLaunching(true);
    try {
      await launchTeam(agents, customPrompt || undefined, selectedTeamModelId);
      // The panel stays visible with a spinner. The teams-stream-listeners
      // will switch to TeamsView when teams-ready fires, at which point
      // this panel unmounts.
    } catch (err) {
      console.error("Team launch failed:", err);
      setLaunching(false);
    }
  }, [launchTeam, customPrompt, selectedTeamModelId, canLaunchWithModel]);

  /** Launch from a template */
  const handleLaunchTemplate = useCallback((template: TeamTemplate) => {
    const agents: TeamsAgentConfig[] = template.roles.map((r) => ({
      name: r.name,
      role: r.role,
      description: ROLE_META[r.role].label,
      prompt: getDefaultPrompt(r.role),
    }));
    doLaunch(agents);
  }, [doLaunch, getDefaultPrompt]);

  /** Launch from custom member list */
  const handleLaunchCustom = useCallback(() => {
    if (members.length === 0) return;
    const agents: TeamsAgentConfig[] = members.map((m) => ({
      name: m.name,
      role: m.role,
      description: ROLE_META[m.role].label,
      prompt: getDefaultPrompt(m.role),
    }));
    doLaunch(agents);
  }, [members, doLaunch, getDefaultPrompt]);

  const addMember = useCallback(() => {
    const roles: AgentRole[] = ["coder", "reviewer", "researcher", "tester"];
    setMembers((prev) => {
      const usedRoles = new Set(prev.map((m) => m.role));
      const nextRole = roles.find((r) => !usedRoles.has(r)) ?? "coder";
      const id = crypto.randomUUID();
      return [...prev, { id, name: nextRole, role: nextRole }];
    });
  }, []);

  const removeMember = useCallback((id: string) => {
    setMembers((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const updateMember = useCallback((id: string, field: "name" | "role", value: string) => {
    setMembers((prev) =>
      prev.map((m) => (m.id === id ? { ...m, [field]: value } : m)),
    );
  }, []);

  return (
    <div
      ref={panelRef}
      style={{
        position: "absolute",
        bottom: "100%",
        left: 0,
        width: 380,
        marginBottom: 8,
        maxHeight: "calc(100vh - 120px)",
        display: "flex",
        flexDirection: "column",
        background: "var(--color-card)",
        border: "1px solid var(--color-border-light)",
        borderRadius: 12,
        boxShadow: "0 -8px 24px rgba(0,0,0,0.25)",
        zIndex: 50,
        overflow: "hidden",
        ...containerStyle,
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between"
        style={{ padding: "12px 16px", borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="flex items-center" style={{ gap: 8 }}>
          <Users size={16} style={{ color: "#A855F7" }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text)" }}>
            {t("teams.startTeamMode")}
          </span>
        </div>
        <button
          onClick={onClose}
          disabled={launching}
          className="flex items-center justify-center transition-colors hover:bg-hover-overlay/[0.06]"
          style={{ width: 24, height: 24, borderRadius: 4, opacity: launching ? 0.4 : 1 }}
        >
          <X size={14} style={{ color: "var(--color-text-muted)" }} />
        </button>
      </div>

      {/* Launching overlay */}
      {launching ? (
        <div
          className="flex flex-col items-center justify-center"
          style={{ padding: "32px 16px", gap: 12 }}
        >
          <Loader2 size={24} className="animate-spin" style={{ color: "#A855F7" }} />
          <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
            {t("teams.initializingAgents")}
          </span>
          {startupStatusText && (
            <span
              style={{
                fontSize: 11,
                color: "var(--color-text-muted)",
                textAlign: "center",
                lineHeight: 1.5,
                maxWidth: 320,
                wordBreak: "break-word",
              }}
            >
              {startupStatusText}
            </span>
          )}
        </div>
      ) : sessionPhase === "error" && sessionError ? (
        <div
          className="flex flex-col items-center justify-center"
          style={{ padding: "24px 16px", gap: 10 }}
        >
          <AlertCircle size={22} style={{ color: "var(--color-accent-red, #ef4444)" }} />
          <span
            style={{
              fontSize: 12,
              color: "var(--color-foreground)",
              textAlign: "center",
              lineHeight: 1.5,
              maxWidth: 320,
            }}
          >
            {sessionError}
          </span>
          <button
            onClick={() => {
              clearSession();
              onClose();
            }}
            style={{
              marginTop: 4,
              padding: "6px 14px",
              fontSize: 12,
              borderRadius: "var(--radius-sm)",
              backgroundColor: "var(--color-surface)",
              color: "var(--color-foreground)",
              border: "1px solid var(--color-border)",
              cursor: "pointer",
            }}
          >
            {t("common.close")}
          </button>
        </div>
      ) : (
        <>
          {/* Tabs */}
          <div
            className="flex"
            style={{ padding: "0 16px", gap: 16, borderBottom: "1px solid var(--color-border)" }}
          >
            {(["templates", "custom"] as const).map((tabKey) => (
              <button
                key={tabKey}
                onClick={() => setTab(tabKey)}
                style={{
                  padding: "8px 0",
                  fontSize: 12,
                  fontWeight: 500,
                  color: tab === tabKey ? "#A855F7" : "var(--color-text-muted)",
                  borderBottom: tab === tabKey ? "2px solid #A855F7" : "2px solid transparent",
                  background: "none",
                  transition: "color 0.15s, border-color 0.15s",
                }}
              >
                {tabKey === "templates" ? t("teams.tabs.templates") : t("teams.tabs.custom")}
              </button>
            ))}
          </div>

          {/* Custom Prompt */}
          <div style={{ padding: "8px 16px 0" }}>
            <label
              style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", display: "block", marginBottom: 4 }}
            >
              {t("teams.customInstructions")}
            </label>
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder={t("teams.customInstructionsPlaceholder")}
              rows={3}
              style={{
                width: "100%",
                padding: "6px 8px",
                fontSize: 11,
                lineHeight: 1.5,
                background: "var(--color-surface-alt)",
                border: "1px solid var(--color-border)",
                borderRadius: 6,
                color: "var(--color-text)",
                outline: "none",
                resize: "vertical",
                minHeight: 48,
                maxHeight: 120,
                fontFamily: "Inter, sans-serif",
              }}
            />
          </div>

          {/* Team Model */}
          <div style={{ padding: "8px 16px 0" }}>
            <label
              style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", display: "block", marginBottom: 4 }}
            >
              {t("teams.modelLabel")}
            </label>
            {claudeCredentials && modelOptions.length > 0 ? (
              <select
                value={selectedTeamModelId}
                onChange={(e) => {
                  setSelectedTeamModelId(e.target.value);
                  setModelValidationVisible(false);
                }}
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  fontSize: 11,
                  background: "var(--color-surface-alt)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 6,
                  color: selectedTeamModelId ? "var(--color-text)" : "var(--color-text-muted)",
                  outline: "none",
                }}
              >
                <option value="" disabled>
                  {t("teams.modelPlaceholder")}
                </option>
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            ) : (
              <div
                style={{
                  padding: "8px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--color-border)",
                  background: "var(--color-surface-alt)",
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text)" }}>
                  {t("teams.modelNoData")}
                </div>
                <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginTop: 2 }}>
                  {t("teams.modelNoDataHint")}
                </div>
              </div>
            )}
            {modelValidationVisible && (
              <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginTop: 4 }}>
                {t("teams.selectModelFirst")}
              </div>
            )}
          </div>

          {/* Content */}
          <div style={{ padding: "8px 16px 16px", flex: 1, minHeight: 0, overflowY: "auto" }}>
            {tab === "templates" ? (
              <div className="flex flex-col" style={{ gap: 6 }}>
                {TEAM_TEMPLATES.map((tmpl) => (
                  <div
                    key={tmpl.id}
                    className="flex items-center justify-between transition-colors hover:bg-hover-overlay/[0.04]"
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      border: "1px solid var(--color-border)",
                      cursor: canLaunchWithModel ? "pointer" : "not-allowed",
                      opacity: canLaunchWithModel ? 1 : 0.6,
                    }}
                    onClick={() => handleLaunchTemplate(tmpl)}
                  >
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text)" }}>
                        {t(`teams.templates.${tmpl.id}.name`, { defaultValue: tmpl.name })}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>
                        {t(`teams.templates.${tmpl.id}.description`, { defaultValue: tmpl.description })}
                      </div>
                      <div className="flex" style={{ gap: 4, marginTop: 4 }}>
                        {tmpl.roles.map((r) => (
                          <span
                            key={r.name}
                            style={{
                              fontSize: 10,
                              padding: "1px 6px",
                              borderRadius: 4,
                              background: ROLE_META[r.role].color + "20",
                              color: ROLE_META[r.role].color,
                              fontWeight: 500,
                            }}
                          >
                            {t(`teams.roles.${r.role}`, { defaultValue: r.role })}
                          </span>
                        ))}
                      </div>
                    </div>
                    <Rocket size={14} style={{ color: "#A855F7", flexShrink: 0 }} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col" style={{ gap: 8 }}>
                {/* Member list */}
                {members.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center"
                    style={{ gap: 6 }}
                  >
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        background: ROLE_META[m.role].color,
                        flexShrink: 0,
                      }}
                    />
                    <input
                      type="text"
                      value={m.name}
                      onChange={(e) => updateMember(m.id, "name", e.target.value)}
                      style={{
                        flex: 1,
                        padding: "4px 8px",
                        fontSize: 11,
                        background: "var(--color-surface-alt)",
                        border: "1px solid var(--color-border)",
                        borderRadius: 4,
                        color: "var(--color-text)",
                        outline: "none",
                        minWidth: 0,
                      }}
                    />
                    <select
                      value={m.role}
                      onChange={(e) => updateMember(m.id, "role", e.target.value)}
                      style={{
                        padding: "4px 8px",
                        fontSize: 11,
                        background: "var(--color-surface-alt)",
                        border: "1px solid var(--color-border)",
                        borderRadius: 4,
                        color: "var(--color-text)",
                        outline: "none",
                      }}
                    >
                      {(Object.keys(ROLE_META) as AgentRole[]).map((role) => (
                        <option key={role} value={role}>
                          {t(`teams.roles.${role}`, { defaultValue: ROLE_META[role].label })}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => removeMember(m.id)}
                      className="flex items-center justify-center transition-colors hover:bg-hover-overlay/[0.06]"
                      style={{ width: 24, height: 24, borderRadius: 4, flexShrink: 0 }}
                    >
                      <Trash2 size={12} style={{ color: "var(--color-text-muted)" }} />
                    </button>
                  </div>
                ))}

                {/* Add member */}
                <button
                  onClick={addMember}
                  className="flex items-center transition-colors hover:bg-hover-overlay/[0.06]"
                  style={{
                    gap: 6,
                    padding: "6px 8px",
                    borderRadius: 6,
                    border: "1px dashed var(--color-border)",
                    background: "none",
                    color: "var(--color-text-muted)",
                    fontSize: 11,
                  }}
                >
                  <Plus size={12} />
                  <span>{t("teams.addMember")}</span>
                </button>

                {/* Launch button */}
                <button
                  onClick={handleLaunchCustom}
                  disabled={!canLaunchCustom}
                  className="flex items-center justify-center transition-colors"
                  style={{
                    gap: 6,
                    padding: "8px 16px",
                    borderRadius: 6,
                    background: canLaunchCustom ? "var(--color-accent-purple)" : "var(--color-surface-alt)",
                    color: canLaunchCustom ? "var(--color-user-bubble-text)" : "var(--color-text-muted)",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: canLaunchCustom ? "pointer" : "not-allowed",
                    marginTop: 4,
                    opacity: canLaunchCustom ? 1 : 0.7,
                  }}
                >
                  <Rocket size={14} />
                  <span>{t("teams.launchTeam")}</span>
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
