import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  X,
  Search,
  Loader2,
  Trash2,
  Radar,
  Download,
  PackageSearch,
  Package,
  Terminal,
  ArrowUpRight,
  Check,
  CheckCheck,
  BookOpen,
  RefreshCw,
  Info,
  ChevronRight,
  ArrowLeft,
  Pencil,
  Save,
  Sparkles,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useSkillsStore, useSettingsStore } from "@/stores";
import type { InstalledSkill, DiscoveredSkill, MarketplaceSkill } from "@/stores";
import { useIsLightTheme } from "@/hooks/use-is-light-theme";

// ---------------------------------------------------------------------------
// Parse npx skills add <url> [--skill xxx] syntax
// ---------------------------------------------------------------------------
function parseSkillsInput(raw: string): string {
  const trimmed = raw.trim();
  const npxMatch = trimmed.match(
    /npx\s+skills(?:@[\w./-]+)?\s+add\s+(https?:\/\/\S+|[\w.-]+\/[\w.-]+)/i,
  );
  if (npxMatch) {
    return npxMatch[1].replace(/\s.*$/, "").replace(/[,;]+$/, "");
  }
  return trimmed;
}

function normalizeSkillToken(value?: string): string {
  return (value || "").trim().toLowerCase();
}

function normalizeGitHubSource(value?: string): string {
  let source = (value || "").trim().toLowerCase();
  if (!source) return "";

  source = source
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

  const parts = source.split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : source;
}

function marketplaceSkillIdentityKey(sourceValue?: string, skillValue?: string): string {
  const source = normalizeGitHubSource(sourceValue);
  const skill = normalizeSkillToken(skillValue);
  return source && skill ? `${source}#${skill}` : "";
}

/** Color mapping for skill categories: [bg, textDark, textLight] */
const CATEGORY_COLORS: Record<string, readonly [string, string, string]> = {
  development: ["rgba(var(--theme-accent-rgb),0.12)", "#C4B5FD", "#7C3AED"],
  testing: ["rgba(34,197,94,0.12)", "#86EFAC", "#16A34A"],
  review: ["rgba(59,130,246,0.12)", "#93C5FD", "#2563EB"],
  devops: ["rgba(249,115,22,0.12)", "#FDBA74", "#C2410C"],
  docs: ["rgba(20,184,166,0.12)", "#5EEAD4", "#0D9488"],
  security: ["rgba(239,68,68,0.12)", "#FCA5A5", "#DC2626"],
  other: ["rgba(148,163,184,0.12)", "#CBD5E1", "#64748B"],
};

/** Color mapping for source badges: [label_key, bg, textDark, textLight] */
const SOURCE_BADGE_MAP: Record<string, readonly [string, string, string, string]> = {
  manifest: ["skills.source.manifest", "rgba(34,197,94,0.12)", "#86EFAC", "#16A34A"],
  "provider-skills": [
    "skills.source.providerSkills",
    "rgba(148,163,184,0.12)",
    "#CBD5E1",
    "#64748B",
  ],
  "provider-commands": [
    "skills.source.providerCommands",
    "rgba(59,130,246,0.12)",
    "#93C5FD",
    "#2563EB",
  ],
  "project-skills": ["skills.source.projectSkills", "rgba(20,184,166,0.12)", "#5EEAD4", "#0D9488"],
  "project-commands": [
    "skills.source.projectCommands",
    "rgba(20,184,166,0.12)",
    "#5EEAD4",
    "#0D9488",
  ],
};

type ProviderFilter = "claude" | "codex";
type AddMode = "marketplace" | "repo";

type InstalledMarketplaceLookup = {
  readonly repoSkillKeys: ReadonlySet<string>;
};

interface SkillsConfigDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

type Tab = "installed" | "add";

export function SkillsConfigDialog({ open, onClose }: SkillsConfigDialogProps) {
  const { t } = useTranslation();
  const isLight = useIsLightTheme();
  const [tab, setTab] = useState<Tab>("installed");
  const [searchQuery, setSearchQuery] = useState("");

  const activePlatformId = useSettingsStore((s) => s.activePlatformId);
  const skills = useSkillsStore((s) => s.skills);
  const loading = useSkillsStore((s) => s.loading);
  const installing = useSkillsStore((s) => s.installing);
  const scanning = useSkillsStore((s) => s.scanning);
  const marketplaceSearching = useSkillsStore((s) => s.marketplaceSearching);
  const discoveredSkills = useSkillsStore((s) => s.discoveredSkills);
  const marketplaceResults = useSkillsStore((s) => s.marketplaceResults);
  const error = useSkillsStore((s) => s.error);
  const load = useSkillsStore((s) => s.load);
  const scanRepo = useSkillsStore((s) => s.scanRepo);
  const searchMarketplace = useSkillsStore((s) => s.searchMarketplace);
  const installFromRepo = useSkillsStore((s) => s.installFromRepo);
  const removeSkill = useSkillsStore((s) => s.removeSkill);
  const updateSkill = useSkillsStore((s) => s.updateSkill);
  const updatingSkill = useSkillsStore((s) => s.updatingSkill);
  const togglingSkill = useSkillsStore((s) => s.togglingSkill);
  const setSkillDisabled = useSkillsStore((s) => s.setSkillDisabled);
  const clearDiscovered = useSkillsStore((s) => s.clearDiscovered);
  const clearMarketplaceResults = useSkillsStore((s) => s.clearMarketplaceResults);
  const clearError = useSkillsStore((s) => s.clearError);
  const getDetail = useSkillsStore((s) => s.getDetail);
  const saveContent = useSkillsStore((s) => s.saveContent);

  // Platform switcher
  const initialProvider: ProviderFilter = activePlatformId === "codex" ? "codex" : "claude";
  const [selectedProvider, setSelectedProvider] = useState<ProviderFilter>(initialProvider);

  // Detail view state
  const [selectedSkill, setSelectedSkill] = useState<InstalledSkill | null>(null);
  const [skillContent, setSkillContent] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState("");
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);

  const [addMode, setAddMode] = useState<AddMode>("marketplace");
  const [addInputs, setAddInputs] = useState<Record<AddMode, string>>({
    marketplace: "",
    repo: "",
  });
  const [marketplaceSearched, setMarketplaceSearched] = useState(false);
  const [installingMarketplaceId, setInstallingMarketplaceId] = useState<string | null>(null);
  const [selectedSkills, setSelectedSkills] = useState<ReadonlySet<string>>(new Set());
  const addInput = addInputs[addMode];

  // Every open → rescan
  useEffect(() => {
    if (open) {
      load(selectedProvider);
      setSelectedSkill(null);
      setIsEditing(false);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Switch provider → rescan
  const handleProviderSwitch = useCallback(
    (prov: ProviderFilter) => {
      setSelectedProvider(prov);
      setSelectedSkill(null);
      setIsEditing(false);
      load(prov);
    },
    [load],
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selectedSkill) {
          setSelectedSkill(null);
          setIsEditing(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, selectedSkill]);

  const filteredSkills = useMemo(() => {
    if (!searchQuery) return skills;
    const q = searchQuery.toLowerCase();
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [skills, searchQuery]);

  const installedMarketplaceLookup = useMemo<InstalledMarketplaceLookup>(() => {
    const repoSkillKeys = new Set<string>();

    for (const skill of skills) {
      const key = marketplaceSkillIdentityKey(skill.source_repo, skill.name);
      if (key) {
        repoSkillKeys.add(key);
      }
    }

    return { repoSkillKeys };
  }, [skills]);

  const setAddInputForMode = useCallback((mode: AddMode, value: string) => {
    setAddInputs((prev) => (prev[mode] === value ? prev : { ...prev, [mode]: value }));
  }, []);

  const handleAddModeChange = useCallback(
    (mode: AddMode) => {
      setAddMode(mode);
      clearError();
    },
    [clearError],
  );

  const handleAddInputChange = useCallback(
    (value: string) => {
      setAddInputForMode(addMode, value);
      if (addMode === "marketplace") {
        setMarketplaceSearched(false);
        clearMarketplaceResults();
      } else {
        clearDiscovered();
        setSelectedSkills(new Set());
      }
    },
    [addMode, setAddInputForMode, clearDiscovered, clearMarketplaceResults],
  );

  const handleScan = useCallback(async () => {
    if (!addInput.trim()) return;
    clearError();
    const parsed = parseSkillsInput(addInput);
    if (parsed !== addInput) setAddInputForMode("repo", parsed);
    await scanRepo(parsed);
  }, [addInput, scanRepo, clearError, setAddInputForMode]);

  const handleMarketplaceSearch = useCallback(async () => {
    if (!addInput.trim()) return;
    clearError();
    setMarketplaceSearched(true);
    await searchMarketplace(addInput);
  }, [addInput, searchMarketplace, clearError]);

  const handleAddSubmit = useCallback(async () => {
    if (addMode === "marketplace") {
      await handleMarketplaceSearch();
      return;
    }
    await handleScan();
  }, [addMode, handleMarketplaceSearch, handleScan]);

  const handleMarketplaceInstall = useCallback(
    async (skill: MarketplaceSkill) => {
      clearError();
      setInstallingMarketplaceId(skill.id);
      try {
        await installFromRepo(skill.repo_url, [skill.skill_id || skill.name], selectedProvider);
        if (!useSkillsStore.getState().error) {
          setAddInputForMode("marketplace", "");
          setMarketplaceSearched(false);
          clearMarketplaceResults();
          setTab("installed");
        }
      } finally {
        setInstallingMarketplaceId(null);
      }
    },
    [installFromRepo, clearError, selectedProvider, clearMarketplaceResults, setAddInputForMode],
  );

  const handleInstall = useCallback(async () => {
    if (!addInput.trim() || selectedSkills.size === 0) return;
    clearError();
    await installFromRepo(parseSkillsInput(addInput), [...selectedSkills], selectedProvider);
    if (!useSkillsStore.getState().error) {
      setAddInputForMode("repo", "");
      setSelectedSkills(new Set());
      setTab("installed");
    }
  }, [addInput, selectedSkills, installFromRepo, clearError, selectedProvider, setAddInputForMode]);

  const toggleSkillSelection = useCallback((name: string) => {
    setSelectedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedSkills((prev) => {
      const allSelected = discoveredSkills.length > 0 && prev.size === discoveredSkills.length;
      if (allSelected) {
        return new Set<string>();
      }
      return new Set(discoveredSkills.map((s) => s.name));
    });
  }, [discoveredSkills]);

  const allSelected =
    discoveredSkills.length > 0 && selectedSkills.size === discoveredSkills.length;

  const handleRemove = useCallback(
    async (name: string) => {
      await removeSkill(name, selectedProvider);
      if (selectedSkill?.name === name) {
        setSelectedSkill(null);
        setIsEditing(false);
      }
    },
    [removeSkill, selectedProvider, selectedSkill],
  );

  const handleUpdate = useCallback(
    async (name: string) => {
      await updateSkill(name, selectedProvider);
    },
    [updateSkill, selectedProvider],
  );

  const handleSkillClick = useCallback(
    async (skill: InstalledSkill) => {
      setSelectedSkill(skill);
      setIsEditing(false);
      setLoadingDetail(true);
      try {
        const detail = await getDetail(skill.name, skill.source, selectedProvider);
        setSkillContent(detail.content);
        setEditedContent(detail.content);
      } catch {
        setSkillContent("(Failed to load content)");
        setEditedContent("");
      } finally {
        setLoadingDetail(false);
      }
    },
    [getDetail, selectedProvider],
  );

  const handleSaveContent = useCallback(async () => {
    if (!selectedSkill) return;
    setSaving(true);
    try {
      await saveContent(selectedSkill.name, editedContent, selectedSkill.source, selectedProvider);
      setSkillContent(editedContent);
      setIsEditing(false);
    } catch {
      // error is surfaced by store
    } finally {
      setSaving(false);
    }
  }, [selectedSkill, editedContent, saveContent, selectedProvider]);

  const handleToggleSkillDisabled = useCallback(
    async (skill: InstalledSkill, disabled: boolean) => {
      const updated = await setSkillDisabled(skill.name, disabled, selectedProvider);
      if (updated) {
        setSelectedSkill(updated);
        setIsEditing(false);
      }
    },
    [setSkillDisabled, selectedProvider],
  );

  const handleBack = useCallback(() => {
    setSelectedSkill(null);
    setIsEditing(false);
  }, []);

  const providerPrefix = selectedProvider === "codex" ? "~/.codex" : "~/.claude";
  const managedSkillsPath = `~/.bytro-community/skills/${selectedProvider}`;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div
        className={`absolute inset-0 ${isLight ? "bg-black/25" : "bg-black/50"}`}
        onClick={onClose}
      />

      {/* Dialog */}
      <div
        className={`relative flex flex-col w-[680px] max-w-[90vw] max-h-[85vh] overflow-hidden rounded-xl border border-border bg-surface ${isLight ? "shadow-[0_12px_32px_rgba(0,0,0,0.12)]" : "shadow-[0_12px_32px_rgba(0,0,0,0.4)]"}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between shrink-0 px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            {selectedSkill ? (
              <button
                onClick={handleBack}
                className="flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-[rgba(var(--hover-overlay-rgb),0.05)]"
              >
                <ArrowLeft size={16} className="text-muted" />
              </button>
            ) : (
              <BookOpen size={20} className="text-accent-purple" />
            )}
            <span className="text-base font-bold text-foreground font-sans">
              {selectedSkill ? selectedSkill.name : t("skills.title")}
            </span>
            {selectedSkill && (
              <div className="flex items-center gap-1.5">
                <CategoryBadge category={selectedSkill.category} isLight={isLight} />
                <SourceBadge source={selectedSkill.source} isLight={isLight} />
                {selectedSkill.is_disabled && <DisabledBadge />}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-[rgba(var(--hover-overlay-rgb),0.05)]"
          >
            <X size={14} className="text-muted" />
          </button>
        </div>

        {/* Detail view */}
        {selectedSkill ? (
          <SkillDetailView
            skill={selectedSkill}
            content={skillContent}
            loadingDetail={loadingDetail}
            isEditing={isEditing}
            editedContent={editedContent}
            saving={saving}
            updatingSkill={updatingSkill}
            togglingSkill={togglingSkill}
            isLight={isLight}
            skillPath={
              selectedSkill.source === "manifest"
                ? managedSkillsPath
                : `${providerPrefix}/skills (read-only)`
            }
            onStartEdit={() => {
              setIsEditing(true);
              setEditedContent(skillContent);
            }}
            onCancelEdit={() => setIsEditing(false)}
            onEditChange={setEditedContent}
            onSave={handleSaveContent}
            onToggleDisabled={(disabled) => handleToggleSkillDisabled(selectedSkill, disabled)}
            onUpdate={() => handleUpdate(selectedSkill.name)}
            onRemove={() => handleRemove(selectedSkill.name)}
          />
        ) : (
          <>
            {/* Tabs */}
            <div className="flex shrink-0 px-5 border-b border-border-subtle">
              <TabButton
                label={t("skills.tabs.installed")}
                active={tab === "installed"}
                onClick={() => setTab("installed")}
              />
              <TabButton
                label={t("skills.tabs.add")}
                active={tab === "add"}
                onClick={() => {
                  setTab("add");
                  clearDiscovered();
                }}
              />
            </div>

            {/* Platform switcher — visible in both tabs */}
            <PlatformSwitcher
              selected={selectedProvider}
              onSelect={handleProviderSwitch}
              skillCount={tab === "installed" ? skills.length : undefined}
              isLight={isLight}
            />

            {/* Error banner */}
            {error && (
              <div
                className="flex items-center gap-2 mx-5 mt-3 shrink-0 px-3 py-2 rounded-md"
                style={{
                  backgroundColor: "rgba(239,68,68,0.08)",
                  borderLeft: "3px solid #EF4444",
                }}
              >
                <span className="flex-1 text-xs font-sans" style={{ color: "#EF4444" }}>
                  {error}
                </span>
                <button onClick={clearError} className="shrink-0">
                  <X size={12} style={{ color: "#EF4444" }} />
                </button>
              </div>
            )}

            {/* Content */}
            <div className="overflow-y-auto px-5 py-3" style={{ height: 340 }}>
              {tab === "installed" && (
                <InstalledContent
                  skills={filteredSkills}
                  loading={loading}
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                  onRemove={handleRemove}
                  onUpdate={handleUpdate}
                  onSkillClick={handleSkillClick}
                  updatingSkill={updatingSkill}
                  isLight={isLight}
                />
              )}
              {tab === "add" && (
                <AddContent
                  mode={addMode}
                  inputValue={addInput}
                  onModeChange={handleAddModeChange}
                  onInputChange={handleAddInputChange}
                  marketplaceSearched={marketplaceSearched}
                  marketplaceSearching={marketplaceSearching}
                  marketplaceResults={marketplaceResults}
                  installedMarketplaceLookup={installedMarketplaceLookup}
                  installingMarketplaceId={installingMarketplaceId}
                  scanning={scanning}
                  discoveredSkills={discoveredSkills}
                  selectedSkills={selectedSkills}
                  onMarketplaceInstall={handleMarketplaceInstall}
                  onSubmit={handleAddSubmit}
                  onToggle={toggleSkillSelection}
                  onOpenWebsite={() => openUrl("https://skills.sh/").catch(() => {})}
                  isLight={isLight}
                />
              )}
            </div>

            {/* Install action bar */}
            {tab === "add" && addMode === "repo" && discoveredSkills.length > 0 && (
              <div className="flex items-center justify-between shrink-0 px-5 py-3 border-t border-border bg-surface">
                <div className="flex items-center gap-3">
                  <button
                    onClick={toggleSelectAll}
                    className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-sans font-medium transition-colors hover:bg-surface-raised"
                    style={{
                      color: allSelected ? "var(--color-accent-purple)" : "var(--color-muted)",
                    }}
                  >
                    <CheckCheck size={14} />
                    <span>
                      {allSelected ? t("skills.add.deselectAll") : t("skills.add.selectAll")}
                    </span>
                  </button>
                  <span className="text-xs font-sans text-text-placeholder">
                    {selectedSkills.size > 0
                      ? t("skills.add.selected", {
                          count: selectedSkills.size,
                        })
                      : t("skills.add.noSelection")}
                  </span>
                </div>
                <button
                  onClick={handleInstall}
                  disabled={installing || selectedSkills.size === 0}
                  className="flex items-center h-8 px-4 gap-1.5 rounded-lg bg-accent-purple text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110"
                >
                  {installing ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Download size={14} />
                  )}
                  <span className="text-[13px] font-semibold font-sans">
                    {installing ? t("skills.add.installing") : t("skills.add.install")}
                  </span>
                </button>
              </div>
            )}

            {/* Footer */}
            {!(tab === "add" && addMode === "repo" && discoveredSkills.length > 0) && (
              <div className="flex items-center justify-between shrink-0 px-5 py-2.5 border-t border-border">
                {tab === "add" && discoveredSkills.length === 0 ? (
                  <div className="flex items-center gap-1.5">
                    <Info size={12} className="text-muted shrink-0" />
                    <span className="text-[11px] font-sans text-muted">
                      {t("skills.add.footerHint")}
                    </span>
                  </div>
                ) : (
                  <span className="text-[11px] font-mono text-muted">{managedSkillsPath}/</span>
                )}
                <span className="text-xs font-sans text-muted-foreground">
                  {t("skills.count", { count: skills.length })}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Platform switcher                                                  */
/* ------------------------------------------------------------------ */

function PlatformSwitcher({
  selected,
  onSelect,
  skillCount,
  isLight,
}: {
  readonly selected: ProviderFilter;
  readonly onSelect: (p: ProviderFilter) => void;
  readonly skillCount?: number;
  readonly isLight: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between shrink-0 px-5 py-2.5 border-b border-border-subtle">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-sans font-medium text-muted uppercase tracking-wider">
          {t("skills.platform", "Platform")}
        </span>
        <div
          className="flex items-center h-7 rounded-md overflow-hidden"
          style={{
            backgroundColor: isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.04)",
          }}
        >
          <PlatformButton
            label="Claude"
            active={selected === "claude"}
            onClick={() => onSelect("claude")}
            isLight={isLight}
          />
          <PlatformButton
            label="Codex"
            active={selected === "codex"}
            onClick={() => onSelect("codex")}
            isLight={isLight}
          />
        </div>
      </div>
      {skillCount != null && (
        <span className="text-[11px] font-sans text-muted">
          {t("skills.count", { count: skillCount })}
        </span>
      )}
    </div>
  );
}

function PlatformButton({
  label,
  active,
  onClick,
  isLight,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly isLight: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 h-full px-3 text-[12px] font-sans font-medium transition-all"
      style={{
        backgroundColor: active
          ? isLight
            ? "rgba(var(--theme-accent-rgb),0.12)"
            : "rgba(var(--theme-accent-rgb),0.15)"
          : "transparent",
        color: active ? (isLight ? "#7C3AED" : "#E9D5FF") : "var(--color-muted)",
        borderRadius: 6,
      }}
    >
      {active && <Sparkles size={12} />}
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab button                                                         */
/* ------------------------------------------------------------------ */

function TabButton({
  label,
  active,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button onClick={onClick} className="relative flex flex-col items-center px-4 pt-2.5 pb-2">
      <span
        className="text-[13px] font-sans transition-colors"
        style={{
          fontWeight: active ? 600 : 500,
          color: active ? "var(--color-accent-purple)" : "var(--color-muted)",
        }}
      >
        {label}
      </span>
      {active && (
        <div
          className="mt-2 w-full h-0.5 rounded-sm"
          style={{ backgroundColor: "var(--color-accent-purple)" }}
        />
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Installed tab                                                      */
/* ------------------------------------------------------------------ */

function InstalledContent({
  skills,
  loading,
  searchQuery,
  setSearchQuery,
  onRemove,
  onUpdate,
  onSkillClick,
  updatingSkill,
  isLight,
}: {
  readonly skills: ReadonlyArray<InstalledSkill>;
  readonly loading: boolean;
  readonly searchQuery: string;
  readonly setSearchQuery: (q: string) => void;
  readonly onRemove: (name: string) => void;
  readonly onUpdate: (name: string) => void;
  readonly onSkillClick: (skill: InstalledSkill) => void;
  readonly updatingSkill: string | null;
  readonly isLight: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3">
      {/* Search bar */}
      <div className="flex items-center h-9 px-3 gap-2 rounded-lg bg-surface-dark border border-border-light">
        <Search size={14} className="text-muted shrink-0" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("skills.search")}
          className="flex-1 bg-transparent outline-none text-xs font-sans text-foreground placeholder:text-text-placeholder"
        />
        {searchQuery && (
          <button onClick={() => setSearchQuery("")} className="shrink-0">
            <X size={12} className="text-muted" />
          </button>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-accent-purple" />
        </div>
      )}

      {/* Empty state */}
      {!loading && skills.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 gap-2">
          <BookOpen size={48} className="text-border-light" />
          <span className="text-sm font-sans text-muted">{t("skills.empty.title")}</span>
          <span className="text-xs font-sans text-text-placeholder">{t("skills.empty.hint")}</span>
        </div>
      )}

      {/* Skill list */}
      {!loading && skills.length > 0 && (
        <div className="flex flex-col">
          {skills.map((skill, idx) => (
            <div key={skill.name}>
              <SkillRow
                skill={skill}
                onRemove={onRemove}
                onUpdate={onUpdate}
                onClick={() => onSkillClick(skill)}
                updating={updatingSkill === skill.name}
                isLight={isLight}
              />
              {idx < skills.length - 1 && <div className="h-px bg-border-subtle" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Single skill row                                                   */
/* ------------------------------------------------------------------ */

function SkillRow({
  skill,
  onRemove,
  onUpdate,
  onClick,
  updating,
  isLight,
}: {
  readonly skill: InstalledSkill;
  readonly onRemove: (name: string) => void;
  readonly onUpdate: (name: string) => void;
  readonly onClick: () => void;
  readonly updating: boolean;
  readonly isLight: boolean;
}) {
  const { t } = useTranslation();
  const hasRepo = !!skill.source_repo;
  const isManifest = skill.source === "manifest";

  return (
    <div
      className="flex items-center justify-between py-3 px-1 rounded-md transition-colors hover:bg-surface-raised cursor-pointer"
      onClick={onClick}
    >
      <div className="flex flex-col min-w-0 gap-0.5 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold font-sans text-foreground">
            {skill.name}
          </span>
          <CategoryBadge category={skill.category} isLight={isLight} />
          <SourceBadge source={skill.source} isLight={isLight} />
          {skill.is_disabled && <DisabledBadge />}
        </div>
        {skill.description && (
          <span className="truncate text-[11px] font-sans text-text-placeholder">
            {skill.description}
          </span>
        )}
        {hasRepo && (
          <span className="truncate text-[10px] font-mono text-muted">
            {skill.source_repo.replace("https://github.com/", "").replace(/\.git$/, "")} &middot;{" "}
            {skill.commit_hash.slice(0, 7)}
          </span>
        )}
      </div>
      <div className="flex items-center shrink-0 gap-0.5" onClick={(e) => e.stopPropagation()}>
        {/* Update button — only for manifest skills with source_repo */}
        {isManifest && hasRepo && (
          <button
            onClick={() => onUpdate(skill.name)}
            disabled={updating}
            className="flex items-center justify-center w-7 h-7 rounded-md transition-colors disabled:opacity-40 hover:bg-[rgba(59,130,246,0.1)] group"
            title={t("skills.update")}
          >
            <RefreshCw
              size={14}
              className={`transition-colors ${updating ? "animate-spin text-accent-info" : "text-muted group-hover:text-accent-info"}`}
            />
          </button>
        )}
        {/* Provider-owned and project skills are intentionally read-only. */}
        {isManifest && (
          <button
            onClick={() => onRemove(skill.name)}
            className="flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-[rgba(239,68,68,0.1)] group"
            title={t("skills.delete")}
          >
            <Trash2 size={14} className="transition-colors text-muted group-hover:text-[#EF4444]" />
          </button>
        )}
        {/* Chevron */}
        <ChevronRight size={14} className="text-muted ml-1" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Skill detail view                                                  */
/* ------------------------------------------------------------------ */

function SkillDetailView({
  skill,
  content,
  loadingDetail,
  isEditing,
  editedContent,
  saving,
  updatingSkill,
  togglingSkill,
  isLight,
  skillPath,
  onStartEdit,
  onCancelEdit,
  onEditChange,
  onSave,
  onToggleDisabled,
  onUpdate,
  onRemove,
}: {
  readonly skill: InstalledSkill;
  readonly content: string;
  readonly loadingDetail: boolean;
  readonly isEditing: boolean;
  readonly editedContent: string;
  readonly saving: boolean;
  readonly updatingSkill: string | null;
  readonly togglingSkill: string | null;
  readonly isLight: boolean;
  readonly skillPath: string;
  readonly onStartEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onEditChange: (v: string) => void;
  readonly onSave: () => void;
  readonly onToggleDisabled: (disabled: boolean) => void;
  readonly onUpdate: () => void;
  readonly onRemove: () => void;
}) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const updating = updatingSkill === skill.name;
  const toggling = togglingSkill === skill.name;
  const hasRepo = !!skill.source_repo;
  const isManifest = skill.source === "manifest";
  const canToggleDisabled = isManifest;
  const repoShort = skill.source_repo.replace("https://github.com/", "").replace(/\.git$/, "");

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isEditing]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Scrollable content */}
      <div className="overflow-y-auto px-5 py-4 flex-1" style={{ maxHeight: "calc(85vh - 160px)" }}>
        {/* Description */}
        {skill.description && (
          <p className="text-[13px] font-sans text-foreground/80 mb-4">{skill.description}</p>
        )}

        {canToggleDisabled && (
          <div
            className="flex items-center justify-between gap-4 mb-4 p-3 rounded-lg border border-border-subtle"
            style={{
              backgroundColor: isLight ? "rgba(0,0,0,0.018)" : "rgba(255,255,255,0.018)",
            }}
          >
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-xs font-sans font-semibold text-foreground">
                {t("skills.detail.status", "Skill Status")}
              </span>
              <span className="text-[11px] font-sans text-muted">
                {skill.is_disabled
                  ? t("skills.detail.disabled", "Disabled")
                  : t("skills.detail.enabled", "Enabled")}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={!skill.is_disabled}
              disabled={toggling || isEditing}
              onClick={() => onToggleDisabled(!skill.is_disabled)}
              className="relative flex items-center w-10 h-6 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                backgroundColor: skill.is_disabled
                  ? "var(--toggle-off-bg)"
                  : "var(--color-accent-purple)",
              }}
              title={
                skill.is_disabled
                  ? t("skills.detail.enable", "Enable Skill")
                  : t("skills.detail.disable", "Disable Skill")
              }
            >
              <span
                className="absolute left-1 flex items-center justify-center w-4 h-4 rounded-full transition-transform"
                style={{
                  backgroundColor: skill.is_disabled ? "var(--toggle-off-knob)" : "#FFFFFF",
                  transform: skill.is_disabled ? "translateX(0)" : "translateX(16px)",
                }}
              >
                {toggling && <Loader2 size={10} className="animate-spin text-muted" />}
              </span>
            </button>
          </div>
        )}

        {/* Meta info grid */}
        {(hasRepo || skill.installed_at) && (
          <div
            className="grid grid-cols-2 gap-x-6 gap-y-2 mb-4 p-3 rounded-lg"
            style={{
              backgroundColor: isLight ? "rgba(0,0,0,0.02)" : "rgba(255,255,255,0.02)",
            }}
          >
            {hasRepo && (
              <>
                <MetaItem
                  label={t("skills.detail.repo", "Repository")}
                  value={repoShort}
                  isLink
                  onClick={() =>
                    openUrl(
                      skill.source_repo.startsWith("http")
                        ? skill.source_repo.replace(/\.git$/, "")
                        : `https://github.com/${repoShort}`,
                    ).catch(() => {})
                  }
                />
                <MetaItem
                  label={t("skills.detail.commit", "Commit")}
                  value={skill.commit_hash.slice(0, 7)}
                />
              </>
            )}
            {skill.installed_at && (
              <MetaItem
                label={t("skills.detail.installed", "Installed")}
                value={new Date(skill.installed_at).toLocaleDateString()}
              />
            )}
            <MetaItem label={t("skills.detail.path", "Path")} value={skill.relative_path || "-"} />
          </div>
        )}

        {/* SKILL.md content */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-sans font-semibold text-foreground">
            {t("skills.detail.content", "SKILL.md")}
          </span>
          {!isEditing && isManifest && (
            <button
              onClick={onStartEdit}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-sans text-muted transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              <Pencil size={12} />
              {t("skills.detail.edit", "Edit")}
            </button>
          )}
          {isEditing && (
            <button
              onClick={onCancelEdit}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-sans text-muted transition-colors hover:bg-surface-raised"
            >
              <X size={12} />
              {t("skills.detail.cancel", "Cancel")}
            </button>
          )}
        </div>

        {loadingDetail ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="animate-spin text-accent-purple" />
          </div>
        ) : isEditing ? (
          <textarea
            ref={textareaRef}
            value={editedContent}
            onChange={(e) => onEditChange(e.target.value)}
            className="w-full min-h-[200px] p-3 rounded-lg font-mono text-[12px] text-foreground resize-y outline-none border border-accent-purple/50 focus:border-accent-purple"
            style={{
              backgroundColor: isLight ? "rgba(0,0,0,0.03)" : "rgba(0,0,0,0.3)",
              lineHeight: 1.6,
            }}
          />
        ) : (
          <pre
            className="w-full p-3 rounded-lg font-mono text-[12px] text-foreground/80 whitespace-pre-wrap break-words overflow-x-auto"
            style={{
              backgroundColor: isLight ? "rgba(0,0,0,0.03)" : "rgba(0,0,0,0.3)",
              lineHeight: 1.6,
              minHeight: 120,
              maxHeight: 300,
              overflowY: "auto",
            }}
          >
            {content}
          </pre>
        )}
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-between shrink-0 px-5 py-3 border-t border-border">
        <span className="text-[11px] font-mono text-muted truncate max-w-[200px]">
          {skillPath}
        </span>
        <div className="flex items-center gap-2">
          {isEditing && (
            <button
              onClick={onSave}
              disabled={saving}
              className="flex items-center gap-1.5 h-8 px-4 rounded-lg bg-accent-purple text-white text-[13px] font-semibold font-sans transition-all hover:brightness-110 disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {t("skills.detail.save", "Save")}
            </button>
          )}
          {!isEditing && isManifest && hasRepo && (
            <button
              onClick={onUpdate}
              disabled={updating}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium font-sans transition-colors hover:bg-surface-raised disabled:opacity-40"
              style={{ color: "var(--color-accent-info)" }}
            >
              <RefreshCw size={14} className={updating ? "animate-spin" : ""} />
              {t("skills.update")}
            </button>
          )}
          {!isEditing && isManifest && (
            <button
              onClick={onRemove}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium font-sans transition-colors border hover:bg-[rgba(239,68,68,0.08)]"
              style={{
                color: "#EF4444",
                borderColor: "rgba(239,68,68,0.3)",
              }}
            >
              <Trash2 size={14} />
              {t("skills.delete")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MetaItem({
  label,
  value,
  isLink,
  onClick,
}: {
  readonly label: string;
  readonly value: string;
  readonly isLink?: boolean;
  readonly onClick?: () => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-sans font-medium text-muted uppercase tracking-wider">
        {label}
      </span>
      {isLink ? (
        <button
          onClick={onClick}
          className="text-[12px] font-mono text-accent-purple hover:underline text-left truncate"
        >
          {value}
        </button>
      ) : (
        <span className="text-[12px] font-mono text-foreground/80 truncate">{value}</span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Add from repo tab                                                  */
/* ------------------------------------------------------------------ */

function AddContent({
  mode,
  inputValue,
  onModeChange,
  onInputChange,
  marketplaceSearched,
  marketplaceSearching,
  marketplaceResults,
  installedMarketplaceLookup,
  installingMarketplaceId,
  scanning,
  discoveredSkills,
  selectedSkills,
  onMarketplaceInstall,
  onSubmit,
  onToggle,
  onOpenWebsite,
  isLight,
}: {
  readonly mode: AddMode;
  readonly inputValue: string;
  readonly onModeChange: (mode: AddMode) => void;
  readonly onInputChange: (query: string) => void;
  readonly marketplaceSearched: boolean;
  readonly marketplaceSearching: boolean;
  readonly marketplaceResults: ReadonlyArray<MarketplaceSkill>;
  readonly installedMarketplaceLookup: InstalledMarketplaceLookup;
  readonly installingMarketplaceId: string | null;
  readonly scanning: boolean;
  readonly discoveredSkills: ReadonlyArray<DiscoveredSkill>;
  readonly selectedSkills: ReadonlySet<string>;
  readonly onMarketplaceInstall: (skill: MarketplaceSkill) => void;
  readonly onSubmit: () => void;
  readonly onToggle: (name: string) => void;
  readonly onOpenWebsite: () => void;
  readonly isLight: boolean;
}) {
  const { t } = useTranslation();
  const busy = mode === "marketplace" ? marketplaceSearching : scanning;
  const canSubmit = !busy && !!inputValue.trim();
  const hasMarketplaceResults = marketplaceResults.length > 0;
  const hasRepoResults = discoveredSkills.length > 0;
  const inputIcon =
    mode === "marketplace" ? (
      <Search size={14} className="text-muted shrink-0" />
    ) : (
      <Terminal size={14} className="text-muted shrink-0" />
    );
  const buttonIcon = busy ? (
    <Loader2 size={14} className="animate-spin" />
  ) : mode === "marketplace" ? (
    <Search size={14} />
  ) : (
    <Radar size={14} />
  );

  return (
    <div className="flex flex-col gap-3">
      <div
        className="rounded-xl border border-border-light p-3"
        style={{
          backgroundColor: isLight ? "rgba(0,0,0,0.015)" : "rgba(255,255,255,0.015)",
        }}
      >
        <div className="flex items-center mb-3">
          <ModeSegmentedControl mode={mode} onChange={onModeChange} isLight={isLight} />
        </div>

        <div className="flex items-center gap-2">
          <div
            className="flex items-center flex-1 h-11 px-3 gap-2 rounded-lg border transition-colors focus-within:border-accent-purple/70"
            style={{
              backgroundColor: isLight ? "var(--color-surface)" : "#0D0D12",
              borderColor: isLight ? "var(--color-border-light)" : "#333333",
            }}
          >
            {inputIcon}
            <input
              type="text"
              value={inputValue}
              onChange={(e) => onInputChange(e.target.value)}
              placeholder={
                mode === "marketplace"
                  ? t("skills.add.inputPlaceholderKeyword")
                  : t("skills.add.inputPlaceholderRepo")
              }
              className={`flex-1 bg-transparent outline-none text-sm text-foreground placeholder:text-text-placeholder ${
                mode === "repo" ? "font-mono" : "font-sans"
              }`}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSubmit();
              }}
            />
          </div>
          <button
            onClick={onSubmit}
            disabled={!canSubmit}
            className="flex items-center shrink-0 h-11 px-4 gap-1.5 rounded-lg bg-accent-purple text-white transition-all hover:brightness-110 disabled:cursor-not-allowed"
            style={{ opacity: canSubmit ? 1 : 0.35 }}
          >
            {buttonIcon}
            <span className="text-xs font-semibold font-sans">
              {busy
                ? mode === "marketplace"
                  ? t("skills.marketplace.searching")
                  : t("skills.add.scanning")
                : mode === "marketplace"
                  ? t("skills.marketplace.search")
                  : t("skills.add.scan")}
            </span>
          </button>
        </div>
      </div>

      {mode === "marketplace" && marketplaceSearching && !hasMarketplaceResults && (
        <div className="flex items-center justify-center py-6 gap-2">
          <Loader2 size={16} className="animate-spin text-accent-purple" />
          <span className="text-xs font-sans text-text-placeholder">
            {t("skills.marketplace.loading")}
          </span>
        </div>
      )}

      {mode === "marketplace" && hasMarketplaceResults && (
        <div className="flex flex-col rounded-lg border border-border-subtle overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 bg-surface-dark border-b border-border-subtle">
            <div className="flex items-center gap-2">
              <PackageSearch size={14} className="text-text-placeholder" />
              <span className="text-xs font-medium font-sans text-text-placeholder">
                {t("skills.marketplace.found", {
                  count: marketplaceResults.length,
                })}
              </span>
            </div>
          </div>
          <div className="flex flex-col">
            {marketplaceResults.map((skill, idx) => (
              <div key={skill.id}>
                <MarketplaceSkillRow
                  skill={skill}
                  installed={isMarketplaceSkillInstalled(skill, installedMarketplaceLookup)}
                  installing={installingMarketplaceId === skill.id}
                  installDisabled={installingMarketplaceId !== null}
                  onInstall={onMarketplaceInstall}
                  isLight={isLight}
                />
                {idx < marketplaceResults.length - 1 && <div className="h-px bg-border-subtle" />}
              </div>
            ))}
          </div>
        </div>
      )}

      {mode === "marketplace" &&
        !marketplaceSearching &&
        inputValue.trim() &&
        marketplaceSearched &&
        !hasMarketplaceResults && (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs font-sans text-text-placeholder">
              {t("skills.marketplace.noResults")}
            </span>
          </div>
        )}

      {mode === "repo" && scanning && !hasRepoResults && (
        <div className="flex items-center justify-center py-8 gap-2">
          <Loader2 size={16} className="animate-spin text-accent-purple" />
          <span className="text-xs font-sans text-text-placeholder">{t("skills.add.cloning")}</span>
        </div>
      )}

      {mode === "repo" && hasRepoResults && (
        <div className="flex flex-col rounded-lg border border-border-subtle overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 bg-surface-dark border-b border-border-subtle">
            <PackageSearch size={14} className="text-text-placeholder" />
            <span className="text-xs font-medium font-sans text-text-placeholder">
              {t("skills.add.found", { count: discoveredSkills.length })}
            </span>
          </div>
          {discoveredSkills.map((skill, idx) => (
            <div key={skill.name}>
              <DiscoveredRow
                skill={skill}
                selected={selectedSkills.has(skill.name)}
                onToggle={onToggle}
                isLight={isLight}
              />
              {idx < discoveredSkills.length - 1 && <div className="h-px bg-border-subtle" />}
            </div>
          ))}
        </div>
      )}

      {!busy && !hasMarketplaceResults && !hasRepoResults && !inputValue.trim() && (
        <AddEmptyState mode={mode} onOpenWebsite={onOpenWebsite} isLight={isLight} />
      )}
    </div>
  );
}

function ModeSegmentedControl({
  mode,
  onChange,
  isLight,
}: {
  readonly mode: AddMode;
  readonly onChange: (mode: AddMode) => void;
  readonly isLight: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="inline-flex items-center h-8 rounded-lg p-0.5"
      style={{
        backgroundColor: isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.04)",
      }}
    >
      <AddModeButton
        active={mode === "marketplace"}
        icon={<Search size={13} />}
        label={t("skills.add.modeKeyword")}
        onClick={() => onChange("marketplace")}
        isLight={isLight}
      />
      <AddModeButton
        active={mode === "repo"}
        icon={<Terminal size={13} />}
        label={t("skills.add.modeRepo")}
        onClick={() => onChange("repo")}
        isLight={isLight}
      />
    </div>
  );
}

function AddModeButton({
  active,
  icon,
  label,
  onClick,
  isLight,
}: {
  readonly active: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
  readonly isLight: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 h-7 px-3 rounded-md text-[12px] font-sans font-semibold transition-all"
      style={{
        backgroundColor: active ? (isLight ? "#FFFFFF" : "rgba(var(--theme-accent-rgb),0.18)") : "transparent",
        color: active ? (isLight ? "var(--color-accent-purple)" : "#E9D5FF") : "var(--color-muted)",
        boxShadow: active && isLight ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
      }}
    >
      {icon}
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Marketplace skill row                                              */
/* ------------------------------------------------------------------ */

function MarketplaceSkillRow({
  skill,
  installed,
  installing,
  installDisabled,
  onInstall,
  isLight,
}: {
  readonly skill: MarketplaceSkill;
  readonly installed: boolean;
  readonly installing: boolean;
  readonly installDisabled: boolean;
  readonly onInstall: (skill: MarketplaceSkill) => void;
  readonly isLight: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center w-full py-2.5 px-1 gap-3 rounded-md transition-colors hover:bg-surface-raised">
      <div className="flex flex-col min-w-0 gap-0.5 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold font-sans text-foreground">
            {skill.name}
          </span>
          <CategoryBadge category={skill.category} isLight={isLight} />
          {installed && (
            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-sans font-medium bg-green-500/10 text-green-500">
              <Check size={10} />
              {t("skills.marketplace.installed")}
            </span>
          )}
        </div>
        {skill.description && (
          <span className="truncate text-[11px] font-sans text-text-placeholder">
            {skill.description}
          </span>
        )}
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate text-[10px] font-mono text-muted">{skill.source}</span>
          <span className="text-[10px] font-mono text-text-placeholder">
            {formatInstallCount(skill.installs, t)}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={() => openUrl(skill.detail_url).catch(() => {})}
          className="flex items-center justify-center w-7 h-7 rounded-md text-muted transition-colors hover:bg-surface-raised hover:text-accent-purple"
          title={t("skills.marketplace.openDetail")}
        >
          <ArrowUpRight size={13} />
        </button>
        <button
          onClick={() => onInstall(skill)}
          disabled={installDisabled || installed}
          className="flex items-center h-7 px-2.5 gap-1 rounded-md bg-accent-purple text-white transition-all hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
          title={installed ? t("skills.marketplace.installed") : t("skills.marketplace.install")}
        >
          {installed ? (
            <Check size={12} />
          ) : installing ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Download size={12} />
          )}
          <span className="text-[11px] font-semibold font-sans">
            {installed
              ? t("skills.marketplace.installed")
              : installing
                ? t("skills.add.installing")
                : t("skills.marketplace.install")}
          </span>
        </button>
      </div>
    </div>
  );
}

function isMarketplaceSkillInstalled(
  skill: MarketplaceSkill,
  lookup: InstalledMarketplaceLookup,
): boolean {
  const source = skill.source || skill.repo_url;
  const candidateKeys = [
    marketplaceSkillIdentityKey(source, skill.skill_id),
    marketplaceSkillIdentityKey(source, skill.name),
  ].filter(Boolean);

  return candidateKeys.some((key) => lookup.repoSkillKeys.has(key));
}

function formatInstallCount(count: number, t: ReturnType<typeof useTranslation>["t"]): string {
  if (count >= 1_000_000) {
    return t("skills.marketplace.installsShort", {
      value: `${(count / 1_000_000).toFixed(1)}M`,
    });
  }
  if (count >= 1_000) {
    return t("skills.marketplace.installsShort", {
      value: `${Math.round(count / 1_000)}K`,
    });
  }
  return t("skills.marketplace.installsShort", { value: count });
}

/* ------------------------------------------------------------------ */
/*  Discovered skill row with checkbox                                 */
/* ------------------------------------------------------------------ */

function DiscoveredRow({
  skill,
  selected,
  onToggle,
  isLight,
}: {
  readonly skill: DiscoveredSkill;
  readonly selected: boolean;
  readonly onToggle: (name: string) => void;
  readonly isLight: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(skill.name)}
      className="flex items-center w-full text-left py-2.5 px-1 gap-2.5 rounded-md transition-colors hover:bg-surface-raised"
    >
      <div
        className="flex items-center justify-center shrink-0 w-4 h-4 rounded transition-all"
        style={{
          backgroundColor: selected ? "var(--color-accent-purple)" : "transparent",
          border: selected ? "none" : "1px solid var(--color-border-strong)",
        }}
      >
        {selected && <Check size={10} style={{ color: "#FFFFFF" }} />}
      </div>
      <div className="flex flex-col min-w-0 gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold font-sans text-foreground">
            {skill.name}
          </span>
          <CategoryBadge category={skill.category} isLight={isLight} />
        </div>
        {skill.description && (
          <span className="truncate text-[11px] font-sans text-text-placeholder">
            {skill.description}
          </span>
        )}
        <span className="truncate text-[10px] font-mono text-muted">{skill.relative_path}</span>
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Add tab — empty / onboarding state                                 */
/* ------------------------------------------------------------------ */

function AddEmptyState({
  mode,
  onOpenWebsite,
  isLight,
}: {
  readonly mode: AddMode;
  readonly onOpenWebsite: () => void;
  readonly isLight: boolean;
}) {
  const { t } = useTranslation();
  const hint =
    mode === "marketplace" ? t("skills.add.emptyKeywordHint") : t("skills.add.emptyRepoHint");

  return (
    <div className="flex flex-col items-center justify-center gap-4 w-full" style={{ height: 220 }}>
      <Package size={28} style={{ color: isLight ? "var(--color-border-light)" : "#2A2A2A" }} />
      <span
        className="text-[13px] font-sans"
        style={{ color: isLight ? "var(--color-muted)" : "#444444" }}
      >
        {hint}
      </span>
      {mode === "marketplace" && (
        <div className="flex items-center gap-1.5">
          <span
            className="text-[11px] font-sans"
            style={{ color: isLight ? "var(--color-muted)" : "#555555" }}
          >
            {t("skills.add.emptyGoTo")}
          </span>
          <button
            onClick={onOpenWebsite}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors hover:brightness-125"
            style={{
              backgroundColor: isLight ? "rgba(var(--theme-accent-rgb),0.1)" : "#1E1233",
              color: "#A855F7",
            }}
          >
            <span
              className="text-[11px] font-medium"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              skills.sh
            </span>
            <ArrowUpRight size={10} style={{ color: "#A855F7" }} />
          </button>
          <span
            className="text-[11px] font-sans"
            style={{ color: isLight ? "var(--color-muted)" : "#555555" }}
          >
            {t("skills.add.emptyBrowse")}
          </span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Badge components                                                   */
/* ------------------------------------------------------------------ */

function CategoryBadge({
  category,
  isLight,
}: {
  readonly category: string;
  readonly isLight: boolean;
}) {
  const { t } = useTranslation();

  const key = category || "other";
  const [bg, fgDark, fgLight] = CATEGORY_COLORS[key] ?? CATEGORY_COLORS.other;
  const label = t(`skills.category.${key}`, { defaultValue: key });

  return (
    <span
      className="inline-flex items-center shrink-0 px-1.5 py-px rounded text-[9px] font-semibold font-sans uppercase tracking-wide"
      style={{ backgroundColor: bg, color: isLight ? fgLight : fgDark }}
    >
      {label}
    </span>
  );
}

function DisabledBadge() {
  const { t } = useTranslation();

  return (
    <span className="inline-flex items-center h-5 px-1.5 rounded text-[10px] font-sans font-medium bg-yellow-500/10 text-yellow-500">
      {t("skills.detail.disabled", "Disabled")}
    </span>
  );
}

function SourceBadge({ source, isLight }: { readonly source?: string; readonly isLight: boolean }) {
  const { t } = useTranslation();

  const key = source || "other";
  const entry = SOURCE_BADGE_MAP[key];
  if (!entry) return null;

  const [labelKey, bg, fgDark, fgLight] = entry;
  const label = t(labelKey, { defaultValue: key });

  return (
    <span
      className="inline-flex items-center shrink-0 px-1.5 py-px rounded text-[9px] font-semibold font-sans uppercase tracking-wide"
      style={{ backgroundColor: bg, color: isLight ? fgLight : fgDark }}
    >
      {label}
    </span>
  );
}
