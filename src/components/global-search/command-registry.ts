import type { TFunction } from "i18next";
import type { ShortcutBinding } from "@/lib/keyboard-shortcuts";
import { useAppStore } from "@/stores/app-store";
import { useSettingsStore } from "@/stores/settings-store";

export interface CommandDefinition {
  readonly id: string;
  readonly labelKey: string;
  readonly descriptionKey: string;
  readonly icon: string;
  readonly shortcut?: ShortcutBinding;
  readonly keywords?: ReadonlyArray<string>;
  readonly action: () => void;
}

export function getCommandDefinitions(): ReadonlyArray<CommandDefinition> {
  return [
    {
      id: "new-session",
      labelKey: "globalSearch.cmdNewSession",
      descriptionKey: "globalSearch.cmdNewSessionDesc",
      icon: "circle-plus",
      shortcut: { key: "n", ctrl: true },
      keywords: ["new", "session", "conversation", "chat", "create"],
      action: () => {
        // Trigger the same logic as Ctrl+N in App.tsx — dispatching a synthetic
        // keyboard event is fragile, so we replicate the essential steps here.
        const appStore = useAppStore.getState();
        const currentView = appStore.activeView;
        if (currentView === "workspace") {
          appStore.setActiveView("chat");
        }
      },
    },
    {
      id: "toggle-terminal",
      labelKey: "globalSearch.cmdToggleTerminal",
      descriptionKey: "globalSearch.cmdToggleTerminalDesc",
      icon: "terminal",
      shortcut: { key: "`", ctrl: true },
      keywords: ["terminal", "console", "shell", "cmd"],
      action: () => {
        useAppStore.getState().toggleTerminal();
      },
    },
    {
      id: "toggle-sidebar",
      labelKey: "globalSearch.cmdToggleSidebar",
      descriptionKey: "globalSearch.cmdToggleSidebarDesc",
      icon: "panel-left",
      keywords: ["sidebar", "panel", "hide", "show"],
      action: () => {
        useAppStore.getState().toggleSidebar();
      },
    },
    {
      id: "toggle-theme",
      labelKey: "globalSearch.cmdToggleTheme",
      descriptionKey: "globalSearch.cmdToggleThemeDesc",
      icon: "sun-moon",
      keywords: ["theme", "dark", "light", "system", "appearance"],
      action: () => {
        const current = useSettingsStore.getState().theme;
        const next = current === "light" ? "dark" : current === "dark" ? "system" : "light";
        useSettingsStore.getState().setTheme(next);
      },
    },
    {
      id: "open-mcp",
      labelKey: "globalSearch.cmdOpenMcp",
      descriptionKey: "globalSearch.cmdOpenMcpDesc",
      icon: "settings",
      keywords: ["mcp", "server", "config"],
      action: () => {
        useAppStore.getState().setMcpConfigOpen(true);
      },
    },
    {
      id: "go-workspace",
      labelKey: "globalSearch.cmdGoWorkspace",
      descriptionKey: "globalSearch.cmdGoWorkspaceDesc",
      icon: "layout-dashboard",
      keywords: ["workspace", "home", "project"],
      action: () => {
        useAppStore.getState().setActiveView("workspace");
      },
    },
    {
      id: "go-chat",
      labelKey: "globalSearch.cmdGoChat",
      descriptionKey: "globalSearch.cmdGoChatDesc",
      icon: "message-square",
      keywords: ["chat", "conversation", "message"],
      action: () => {
        useAppStore.getState().setActiveView("chat");
      },
    },
    {
      id: "go-idea-hub",
      labelKey: "globalSearch.cmdGoIdeaHub",
      descriptionKey: "globalSearch.cmdGoIdeaHubDesc",
      icon: "lightbulb",
      keywords: ["idea", "hub", "inspiration", "note"],
      action: () => {
        useAppStore.getState().setActiveView("ideas");
      },
    },
    {
      id: "go-teams",
      labelKey: "globalSearch.cmdGoTeams",
      descriptionKey: "globalSearch.cmdGoTeamsDesc",
      icon: "users",
      keywords: ["teams", "agent", "multi"],
      action: () => {
        useAppStore.getState().setActiveView("teams");
      },
    },
    {
      id: "go-health-check",
      labelKey: "globalSearch.cmdGoHealthCheck",
      descriptionKey: "globalSearch.cmdGoHealthCheckDesc",
      icon: "heart-pulse",
      keywords: ["health", "check", "quality", "audit"],
      action: () => {
        useAppStore.getState().setActiveView("health-check");
      },
    },
    {
      id: "quick-capture",
      labelKey: "globalSearch.cmdQuickCapture",
      descriptionKey: "globalSearch.cmdQuickCaptureDesc",
      icon: "zap",
      shortcut: { key: "I", ctrl: true, shift: true },
      keywords: ["capture", "quick", "idea", "note"],
      action: () => {
        useAppStore.getState().setQuickCaptureOpen(true);
      },
    },
  ];
}

export interface SearchResultItem {
  readonly id: string;
  readonly category: "file" | "function" | "command";
  readonly title: string;
  readonly subtitle: string;
  readonly icon: string;
  readonly shortcut?: ShortcutBinding;
  readonly action: () => void;
}

export function searchCommands(
  query: string,
  t: TFunction,
): ReadonlyArray<SearchResultItem> {
  const commands = getCommandDefinitions();
  const lower = query.toLowerCase();

  if (!lower) {
    return commands.map((cmd) => ({
      id: cmd.id,
      category: "command" as const,
      title: t(cmd.labelKey),
      subtitle: t(cmd.descriptionKey),
      icon: cmd.icon,
      shortcut: cmd.shortcut,
      action: cmd.action,
    }));
  }

  const scored: Array<{ readonly item: SearchResultItem; readonly score: number }> = [];

  for (const cmd of commands) {
    const label = t(cmd.labelKey).toLowerCase();
    const desc = t(cmd.descriptionKey).toLowerCase();
    const kws = cmd.keywords ?? [];

    let score = 0;
    if (label.startsWith(lower)) {
      score = 100;
    } else if (label.includes(lower)) {
      score = 80;
    } else if (desc.includes(lower)) {
      score = 60;
    } else if (kws.some((k) => k.includes(lower))) {
      score = 40;
    }

    if (score > 0) {
      scored.push({
        item: {
          id: cmd.id,
          category: "command",
          title: t(cmd.labelKey),
          subtitle: t(cmd.descriptionKey),
          icon: cmd.icon,
          shortcut: cmd.shortcut,
          action: cmd.action,
        },
        score,
      });
    }
  }

  return scored.sort((a, b) => b.score - a.score).map((s) => s.item);
}
