import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  ScanSearch,
  ShieldCheck,
  Star,
  Gauge,
  Lock,
  FileText,
  TestTube,
  Package,
  Sparkles,
} from "lucide-react";
import type { PastedImage } from "./image-preview";

interface QuickAction {
  readonly id: string;
  readonly titleKey: string;
  readonly icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  readonly iconColor: string;
  readonly prompt: string;
}

const QUICK_ACTIONS_ROW1: readonly QuickAction[] = [
  {
    id: "analyze",
    titleKey: "workspace.quickActions.analyzeStructure",
    icon: ScanSearch,
    iconColor: "#A855F7",
    prompt:
      "Analyze the project structure of this codebase. Provide a high-level overview including: directory structure, main technologies used, architecture patterns, entry points, and key configuration files.",
  },
  {
    id: "review",
    titleKey: "workspace.quickActions.codeReview",
    icon: ShieldCheck,
    iconColor: "#22c55e",
    prompt:
      "Review the recent code changes in this project. Check for potential bugs, code style issues, security concerns, and suggest improvements. Focus on the most recently modified files.",
  },
  {
    id: "score",
    titleKey: "workspace.quickActions.projectScore",
    icon: Star,
    iconColor: "#F59E0B",
    prompt:
      "Evaluate this project's overall health and quality. Score it across these dimensions: code quality, test coverage, documentation, dependency management, security, and maintainability. Provide specific recommendations for improvement.",
  },
  {
    id: "performance",
    titleKey: "workspace.quickActions.performance",
    icon: Gauge,
    iconColor: "#3b82f6",
    prompt:
      "Analyze this project for performance bottlenecks and optimization opportunities. Look at build configuration, bundle size, runtime performance patterns, database queries, and suggest concrete improvements.",
  },
];

const QUICK_ACTIONS_ROW2: readonly QuickAction[] = [
  {
    id: "security",
    titleKey: "workspace.quickActions.securityScan",
    icon: Lock,
    iconColor: "#ef4444",
    prompt:
      "Perform a security audit of this project. Check for common vulnerabilities (OWASP Top 10), dependency vulnerabilities, secrets in code, insecure configurations, and authentication/authorization issues.",
  },
  {
    id: "docs",
    titleKey: "workspace.quickActions.generateDocs",
    icon: FileText,
    iconColor: "#06B6D4",
    prompt:
      "Analyze the codebase and generate comprehensive documentation including: API reference, architecture overview, setup instructions, and key module descriptions. Focus on undocumented or poorly documented areas.",
  },
  {
    id: "tests",
    titleKey: "workspace.quickActions.testCoverage",
    icon: TestTube,
    iconColor: "#8b5cf6",
    prompt:
      "Analyze the test coverage of this project. Identify untested code paths, suggest missing test cases, evaluate test quality, and recommend a testing strategy for improving overall coverage.",
  },
  {
    id: "deps",
    titleKey: "workspace.quickActions.dependencyAudit",
    icon: Package,
    iconColor: "#d97757",
    prompt:
      "Audit the project dependencies. Check for: outdated packages, security vulnerabilities, unused dependencies, duplicate functionality, and suggest updates or replacements where appropriate.",
  },
];

function ActionCard({
  action,
  onClick,
}: {
  readonly action: QuickAction;
  readonly onClick: () => void;
}) {
  const { t } = useTranslation();
  const Icon = action.icon;

  return (
    <button
      onClick={onClick}
      className="flex flex-col text-left native-css-hover"
      style={
        {
          gap: 8,
          height: 76,
          padding: "14px 16px",
          borderRadius: 14,
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.06)",
          boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
          flex: "1 1 0",
          minWidth: 0,
          cursor: "pointer",
          "--native-hover-bg": "rgba(255,255,255,0.06)",
          "--native-hover-border-color": `${action.iconColor}30`,
          "--native-hover-shadow": `0 4px 16px rgba(0,0,0,0.2), 0 0 0 1px ${action.iconColor}15`,
          "--native-hover-transform": "translateY(-2px) scale(1.02)",
        } as React.CSSProperties
      }
    >
      <Icon size={18} style={{ color: action.iconColor }} />
      <span
        className="font-sans truncate w-full"
        style={{ fontSize: 12, fontWeight: 500, color: "var(--color-foreground)" }}
      >
        {t(action.titleKey)}
      </span>
    </button>
  );
}

export function ChatEmptyState({
  onSend,
}: {
  readonly onSend: (
    message: string,
    images?: ReadonlyArray<PastedImage>,
    displayContent?: string,
  ) => void;
}) {
  const { t } = useTranslation();

  const handleAction = useCallback(
    (action: QuickAction) => {
      onSend(action.prompt);
    },
    [onSend],
  );

  return (
    <div
      className="flex flex-col items-center justify-center"
      style={{ padding: "20px 24px", gap: 32, width: "100%", maxWidth: 720 }}
    >
      {/* Header */}
      <div className="flex flex-col items-center" style={{ gap: 10 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <Sparkles size={20} style={{ color: "#A855F7" }} />
          <h2
            className="font-sans"
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: "var(--color-foreground)",
              margin: 0,
            }}
          >
            {t("chat.emptyState.title")}
          </h2>
        </div>
        <p
          className="font-sans"
          style={{
            fontSize: 13,
            color: "var(--color-muted)",
            margin: 0,
          }}
        >
          {t("chat.emptyState.subtitle")}
        </p>
      </div>

      <div className="flex flex-col w-full" style={{ gap: 10, maxWidth: 640 }}>
        <div className="flex w-full" style={{ gap: 10 }}>
          {QUICK_ACTIONS_ROW1.map((action) => (
            <ActionCard key={action.id} action={action} onClick={() => handleAction(action)} />
          ))}
        </div>
        <div className="flex w-full" style={{ gap: 10 }}>
          {QUICK_ACTIONS_ROW2.map((action) => (
            <ActionCard key={action.id} action={action} onClick={() => handleAction(action)} />
          ))}
        </div>
      </div>
    </div>
  );
}
