import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderOpen,
  Briefcase,
  ShoppingBag,
  BarChart3,
  BookOpen,
  Rocket,
  UtensilsCrossed,
  CloudSun,
  ListChecks,
  Users,
  Music,
  Paperclip,
  ArrowUp,
  Folder,
  RotateCcw,
  ArrowLeft,
  CircleAlert,
  Image,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore, useWorkspaceStore, useConversationStore, useSettingsStore, useChatStore, useStreamStateStore, useAgentStatusStore, useToastStore, usePreviewStore, useSplitViewStore } from "@/stores";
import { encodeConversationModel, resolveActiveCredentials } from "@/lib/platform-config";
import { track } from "@/lib/tracking";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ModelSelector } from "@/components/chat/model-selector";

const ALL_SUGGESTIONS: ReadonlyArray<{
  readonly icon: LucideIcon;
  readonly labelKey: string;
  readonly promptKey: string;
  readonly color: string;
}> = [
  { icon: Briefcase, labelKey: "welcome.suggestions.portfolio", promptKey: "welcome.prompts.portfolio", color: "var(--color-accent-purple)" },
  { icon: ShoppingBag, labelKey: "welcome.suggestions.ecommerce", promptKey: "welcome.prompts.ecommerce", color: "#F472B6" },
  { icon: BarChart3, labelKey: "welcome.suggestions.dashboard", promptKey: "welcome.prompts.dashboard", color: "#22D3EE" },
  { icon: BookOpen, labelKey: "welcome.suggestions.blog", promptKey: "welcome.prompts.blog", color: "var(--color-accent-green)" },
  { icon: Rocket, labelKey: "welcome.suggestions.landing", promptKey: "welcome.prompts.landing", color: "var(--color-accent-amber)" },
  { icon: UtensilsCrossed, labelKey: "welcome.suggestions.restaurant", promptKey: "welcome.prompts.restaurant", color: "#FB923C" },
  { icon: CloudSun, labelKey: "welcome.suggestions.weather", promptKey: "welcome.prompts.weather", color: "#38BDF8" },
  { icon: ListChecks, labelKey: "welcome.suggestions.todoApp", promptKey: "welcome.prompts.todoApp", color: "#34D399" },
  { icon: Users, labelKey: "welcome.suggestions.socialFeed", promptKey: "welcome.prompts.socialFeed", color: "#818CF8" },
  { icon: Music, labelKey: "welcome.suggestions.musicPlayer", promptKey: "welcome.prompts.musicPlayer", color: "#E879F9" },
];

const SUGGESTION_COUNT = 5;

/** Fisher-Yates shuffle and take first n items. */
function pickRandom<T>(arr: ReadonlyArray<T>, n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

const INPUT_ACTIONS: ReadonlyArray<{
  readonly icon: LucideIcon;
  readonly i18nKey: string;
}> = [
  { icon: Paperclip, i18nKey: "welcome.actions.attachFile" },
];

const TYPEWRITER_CHAR_DELAY = 30;

function TopBar({
  onBack,
  onOpenFolder,
}: {
  readonly onBack: (() => void) | null;
  readonly onOpenFolder: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center justify-between shrink-0"
      style={{ height: 56, padding: "0 32px" }}
    >
      <div>
        {onBack && (
          <button
            onClick={onBack}
            className="flex items-center transition-colors hover:brightness-125"
            style={{
              gap: 6,
              padding: "8px 14px",
              borderRadius: 8,
              backgroundColor: "var(--color-surface-alt)",
              border: "1px solid var(--color-border-light)",
            }}
          >
            <ArrowLeft size={15} style={{ color: "var(--color-muted)" }} />
            <span
              className="font-sans"
              style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-tertiary)" }}
            >
              {t("welcome.back")}
            </span>
          </button>
        )}
      </div>
      <button
        onClick={onOpenFolder}
        className="flex items-center transition-colors hover:brightness-110"
        style={{
          gap: 8,
          padding: "8px 14px",
          borderRadius: 8,
          backgroundColor: "var(--color-surface-alt)",
          border: "1px solid var(--color-border-light)",
        }}
      >
        <FolderOpen size={15} className="text-accent-purple" />
        <span
          className="font-sans text-foreground"
          style={{ fontSize: 13, fontWeight: 500 }}
        >
          {t("welcome.openWorkspace")}
        </span>
      </button>
    </div>
  );
}

function SuggestionPill({
  icon: Icon,
  text,
  color,
  onClick,
}: {
  readonly icon: LucideIcon;
  readonly text: string;
  readonly color: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center hover:brightness-125"
      style={{
        gap: 6,
        padding: "8px 14px",
        borderRadius: 20,
        backgroundColor: "var(--color-surface-inset)",
        border: "1px solid var(--color-border)",
        transition: "background-color 150ms",
      }}
    >
      <Icon size={13} style={{ color }} />
      <span className="font-sans" style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
        {text}
      </span>
    </button>
  );
}

/** Characters forbidden in project directory names. */
const INVALID_NAME_CHARS = /[/\\:*?"<>|]/;

/** Normal state: compact inline path display inside the input box. */
function DirAddon({
  projectPath,
  projectName,
  nameError,
  onSelectFolder,
  onProjectNameChange,
}: {
  readonly projectPath: string;
  readonly projectName: string;
  readonly nameError: string | null;
  readonly onSelectFolder: () => void;
  readonly onProjectNameChange: (name: string) => void;
}) {
  const { t } = useTranslation();

  const displayPath = projectPath
    .replace(/\\/g, "/")
    .replace(/^([A-Z]):/, (_, d: string) => d.toLowerCase() + ":");

  return (
    <div className="flex flex-col" style={{ gap: 4 }}>
      <div className="flex items-center" style={{ gap: 6, padding: "0 4px" }}>
        <Folder size={13} style={{ color: "#555555" }} />
        <span
          style={{ fontSize: 12, color: "#555555", fontFamily: "'JetBrains Mono', monospace" }}
        >
          {displayPath}/{projectName || t("welcome.dirSelector.namePlaceholder")}
        </span>
        <span style={{ fontSize: 12, color: "#333333" }}>·</span>
        <button
          onClick={onSelectFolder}
          className="transition-colors hover:brightness-150"
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "#777777",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: 0,
          }}
        >
          {t("welcome.dirSelector.changeFolder")}
        </button>
      </div>
      {/* Inline name editor — appears only when path is selected */}
      <div className="flex items-center" style={{ gap: 6, padding: "0 4px" }}>
        <input
          type="text"
          value={projectName}
          onChange={(e) => {
            const val = e.target.value;
            if (!INVALID_NAME_CHARS.test(val)) {
              onProjectNameChange(val);
            }
          }}
          placeholder={t("welcome.dirSelector.namePlaceholder")}
          className="bg-transparent outline-none"
          style={{
            fontSize: 12,
            fontFamily: "'JetBrains Mono', monospace",
            color: nameError ? "#EF4444" : "#777777",
            width: 200,
            borderBottom: `1px dashed ${nameError ? "#EF4444" : "#333333"}`,
            padding: "1px 0",
          }}
        />
        {nameError && (
          <span style={{ fontSize: 11, color: "#EF4444" }}>{nameError}</span>
        )}
      </div>
    </div>
  );
}

/** Warning state: orange banner when no path is selected. */
function DirWarningAddon({
  onSelectFolder,
}: {
  readonly onSelectFolder: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="flex items-center justify-center w-full"
      style={{
        gap: 8,
        padding: "8px 14px",
        borderRadius: 10,
        backgroundColor: "#F59E0B12",
        border: "1px solid #F59E0B30",
      }}
    >
      <CircleAlert size={14} style={{ color: "#F59E0B" }} />
      <span
        className="font-sans"
        style={{ fontSize: 13, fontWeight: 500, color: "#F59E0B" }}
      >
        {t("welcome.validation.noPath")}
      </span>
      <button
        onClick={onSelectFolder}
        className="flex items-center transition-colors hover:brightness-125"
        style={{
          gap: 4,
          padding: "4px 10px",
          borderRadius: 6,
          backgroundColor: "#F59E0B20",
          border: "1px solid #F59E0B50",
          cursor: "pointer",
        }}
      >
        <FolderOpen size={12} style={{ color: "#F59E0B" }} />
        <span
          className="font-sans"
          style={{ fontSize: 12, fontWeight: 500, color: "#F59E0B" }}
        >
          {t("welcome.dirSelector.selectDir")}
        </span>
      </button>
    </div>
  );
}

export function WelcomePage() {
  const { t } = useTranslation();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setSidebarTab = useAppStore((s) => s.setSidebarTab);
  const setPendingQuickAction = useAppStore((s) => s.setPendingQuickAction);
  const createConversation = useConversationStore((s) => s.createConversation);
  const addToast = useToastStore((s) => s.addToast);
  const {
    initLogs,
    setProjectPath: storeSetProjectPath,
    setProjectName: storeSetProjectName,
    setIsInitializing,
    addInitLog,
    clearInitLogs,
    setPreviewVisible,
    setPreviewChatWidth,
  } = usePreviewStore();
  const [inputValue, setInputValue] = useState("");
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [showDirWarning, setShowDirWarning] = useState(false);
  const [initPhase, setInitPhase] = useState<"idle" | "initializing" | "error">("idle");
  const [initError, setInitError] = useState("");
  const typewriterRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const compositionEndTimeRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Pick 5 random suggestions once per mount
  const suggestions = useMemo(() => pickRandom(ALL_SUGGESTIONS, SUGGESTION_COUNT), []);

  // Auto-resize textarea to fit content
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [inputValue]);

  // Real-time debounced check: does projectPath/projectName already exist?
  useEffect(() => {
    const trimmed = projectName.trim();
    if (!projectPath || !trimmed) {
      setNameError(null);
      return;
    }

    const sep = projectPath.includes("/") ? "/" : "\\";
    const fullPath = `${projectPath}${sep}${trimmed}`;

    const timer = window.setTimeout(() => {
      invoke<boolean>("path_exists", { path: fullPath })
        .then((exists) => {
          setNameError(exists ? t("welcome.validation.dirExists", { name: trimmed }) : null);
        })
        .catch(() => {
          // Ignore check errors (e.g. parent path gone)
          setNameError(null);
        });
    }, 300);

    return () => window.clearTimeout(timer);
  }, [projectPath, projectName, t]);

  // Auto-scroll init logs to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [initLogs]);

  const handleOpenFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        await addWorkspace(selected as string);
        setActiveView("workspace");
      }
    } catch {
      console.error("[welcome] workspace picker failed");
    }
  }, [addWorkspace, setActiveView]);

  const handleSelectProjectFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        setProjectPath(selected as string);
        setShowDirWarning(false);
      }
    } catch {
      console.error("[welcome] project folder picker failed");
    }
  }, []);

  const handleSend = useCallback(async () => {
    const description = inputValue.trim();
    if (!description) return;

    // Validate project path — show inline warning instead of toast
    if (!projectPath) {
      setShowDirWarning(true);
      return;
    }

    // Validate project name
    const trimmedName = projectName.trim();
    if (!trimmedName) {
      addToast("warning", t("welcome.validation.noName"));
      return;
    }

    // Block if real-time check already detected the name exists
    if (nameError) {
      addToast("warning", nameError);
      return;
    }

    if (isSending) return;
    track("build", "build.project_started");
    setIsSending(true);
    setInitPhase("initializing");
    setInitError("");
    setIsInitializing(true);
    clearInitLogs();

    const unlisten = await listen<string>("preview-init-log", ({ payload }) => {
      addInitLog(payload);
    });

    try {
      // Call backend to copy template + npm install
      const resultPath = await invoke<string>("init_preview_project", {
        targetDir: projectPath,
        projectName: trimmedName,
      });

      // Preserve current conversation state before switching
      const chatState = useChatStore.getState();
      const currentConvId = useConversationStore.getState().activeConversationId;
      if (currentConvId) {
        useAgentStatusStore.getState().cacheAgentStatus(currentConvId);
        if (useStreamStateStore.getState().isStreaming || chatState.messages.length > 0) {
          chatState.saveSnapshot(currentConvId);
        }
      }

      setPendingQuickAction(null);
      useConversationStore.getState().setActiveConversationId(null);
      chatState.clearMessages();
      useSplitViewStore.getState().resetToSingle(null);
      useAppStore.getState().switchToFileTab(null);

      // Stop any running dev server from a previous build project and reset
      // preview state so the new project starts with a clean slate.
      // Always call stop unconditionally — the Rust backend handles the
      // no-child case gracefully, and relying on frontend devServerStatus
      // is unreliable due to race conditions during view/workspace switches.
      await invoke("stop_dev_server").catch(() => {});
      const ps = usePreviewStore.getState();
      ps.stopCustomRun();
      ps.resetPreviewSession();

      // Set preview store project info
      storeSetProjectPath(resultPath);
      storeSetProjectName(trimmedName);

      // Create workspace from the initialized project
      const workspace = await addWorkspace(resultPath);
      invoke("update_window_workspace", {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
      }).catch(() => {
        console.warn("[workspace-open][welcome] window binding update failed");
      });

      // Create a conversation linked to this workspace
      const settingsState = useSettingsStore.getState();
      const platformId = settingsState.activePlatformId;
      const platformConfig = settingsState.platforms[platformId];
      const creds = resolveActiveCredentials(platformConfig);
      const model = encodeConversationModel(platformId, creds?.model ?? platformConfig.activeModelId);
      const conversation = await createConversation(model, workspace.id, "build");
      useConversationStore.getState().setActiveConversationId(conversation.id);
      await useChatStore.getState().loadMessages(conversation.id);
      useSplitViewStore.getState().resetToSingle(conversation.id);

      // Build prompt and queue auto-send
      const prompt = [
        `请在以下目录创建新项目：${resultPath}`,
        "",
        `项目描述：${description}`,
        "",
        "## ⚠️ 第一铁律：写一个组件，立刻更新 App.tsx（违反此规则 = 任务失败）",
        "",
        "用户正在预览窗口中**实时观看**你写代码的效果（Vite HMR 热更新）。",
        "你的核心交付不仅是最终代码，更是**让用户看到页面一步步成型的过程**。",
        "",
        "### 强制执行循环（每个组件都必须走完这个循环）",
        "",
        "```",
        "Write(ComponentX.tsx) → Write(App.tsx，加入 <ComponentX />) → 下一个组件",
        "```",
        "",
        "每创建一个可视组件后，**必须紧接着更新 App.tsx** 引入并渲染它，然后才能开始写下一个组件。",
        "不允许连续写 2 个以上组件文件而不更新 App.tsx。",
        "",
        "### 正确示范 ✅",
        "```",
        "Write Header.tsx     → Write App.tsx (import + render Header)",
        "Write HeroSection.tsx → Write App.tsx (加入 HeroSection)",
        "Write Features.tsx   → Write App.tsx (加入 Features)",
        "```",
        "",
        "### 错误示范 ❌（严格禁止）",
        "```",
        "Write Header.tsx",
        "Write HeroSection.tsx",
        "Write Features.tsx",
        "Write Footer.tsx",
        "Write App.tsx ← 最后才更新，用户前面什么都看不到！",
        "```",
        "",
        "### 自检：每次 Write 文件后问自己",
        "「我刚才写了一个可视组件，我更新 App.tsx 了吗？」——如果没有，**立刻更新 App.tsx 再继续**。",
        "",
        "---",
        "",
        "## 执行规则",
        "",
        "### 第一步：必须使用 /frontend-design 技能（强制）",
        "在编写任何组件代码之前，**必须先调用 /frontend-design 技能**生成高质量的 UI 设计方案。",
        "- 将用户的项目描述传给 /frontend-design，获取完整的设计系统（配色、字体、间距、组件风格）",
        "- 基于 /frontend-design 输出的设计方案来编写每一个组件",
        "- **禁止跳过此步骤直接写代码**——没有设计方案的代码质量无法保证",
        "",
        "### 第二步：渐进式构建（严格按此顺序）",
        "",
        "1. 调用 /frontend-design 获取设计方案",
        "2. 创建 tailwind.config.js / index.css → **立刻更新 App.tsx** 渲染带背景色的容器 → 用户看到主题生效",
        "3. 创建 Header 组件 → **立刻更新 App.tsx** 加上 `<Header />` → 用户看到导航栏",
        "4. 创建 HeroSection → **立刻更新 App.tsx** 加上 `<HeroSection />` → 用户看到主视觉区",
        "5. 逐步添加更多区块（**每添加一个组件，就立刻更新 App.tsx**）",
        "6. 所有组件完成后 → 重构 App.tsx 为 React.lazy 路由结构",
        "",
        "前期 App.tsx 中可以直接 import 组件（不需要 lazy），最后再重构为 lazy 路由。",
        "禁止创建引用了尚未存在文件的组件（会导致 Vite 红屏报错）。",
        "",
        "### 多 Agent 协作策略",
        "允许使用 /dispatching-parallel-agents 进行以下**并行**工作：",
        "- **可以并行**：多个 agent 同时编写没有互相依赖的**叶子组件**（如 Button、Card、Input 等独立 UI 组件）",
        "- **可以并行**：一个 agent 写组件代码，另一个 agent 准备测试数据/mock 数据",
        "- **禁止并行**：有依赖关系的文件不能同时写（如 Layout 依赖 Header，必须先写 Header）",
        "- **禁止并行**：多个 agent 同时修改 App.tsx（会冲突）",
        "- **并行完成后，主 agent 必须立刻更新 App.tsx 引入所有新完成的组件**——不允许继续写下一批组件而不先更新 App.tsx",
        "",
        "### 依赖管理规则（违反会导致 Vite 红屏崩溃）",
        "",
        "项目已预装以下 npm 包，可以直接 import 使用，**无需 npm install**：",
        "",
        "**核心框架**: react, react-dom, react-router-dom",
        "**状态管理**: zustand, immer, @tanstack/react-query",
        "**表单**: react-hook-form, @hookform/resolvers, zod",
        "**样式工具**: clsx, tailwind-merge, class-variance-authority, tailwindcss-animate",
        "**图标**: lucide-react, react-icons, @heroicons/react",
        "**UI 原子组件 (Radix UI)**: @radix-ui/react-dialog, @radix-ui/react-dropdown-menu, @radix-ui/react-tooltip, @radix-ui/react-tabs, @radix-ui/react-accordion, @radix-ui/react-switch, @radix-ui/react-select, @radix-ui/react-popover, @radix-ui/react-checkbox, @radix-ui/react-slider, @radix-ui/react-avatar, @radix-ui/react-slot, @radix-ui/react-label, @radix-ui/react-separator, @radix-ui/react-scroll-area, @radix-ui/react-toast, @radix-ui/react-progress",
        "**通知**: sonner",
        "**图表**: recharts, react-countup",
        "**轮播**: swiper, embla-carousel-react, embla-carousel-autoplay",
        "**动画**: framer-motion, react-type-animation, react-intersection-observer",
        "**表格**: @tanstack/react-table",
        "**网络**: axios",
        "**日期**: date-fns, dayjs",
        "**Markdown**: react-markdown, remark-gfm, react-syntax-highlighter",
        "**地图**: leaflet, react-leaflet",
        "**拖拽**: @dnd-kit/core, @dnd-kit/sortable, @dnd-kit/utilities",
        "**其他 UI**: cmdk, input-otp, vaul, next-themes",
        "",
        "**强制规则：**",
        "1. **优先使用预装包**——上面列出的包覆盖了 95% 的常见场景",
        "2. **绝对禁止盲 import**——import 之前必须确认在预装列表中",
        "3. **先装后用**——预装列表之外的包，**必须先 `npm install` 成功**，才能 import",
        "4. **安装失败 = 换方案**——立即改用预装包中的替代方案",
        "",
        "### 文件编写规范",
        "- 每次使用 Write 工具写入一个完整文件，禁止 diff/patch 格式",
        "- 禁止使用 ... 省略号代替实现（会导致语法错误）",
        "- 每个组件必须包含完整的 Tailwind CSS 样式，禁止无样式裸 HTML",
        "- 使用路径别名：@/ 代替 src/，@ui/ 代替 components/ui/",
        "",
        "### 移动端适配规则（强制）",
        "",
        "所有页面和组件**必须**实现响应式布局（Mobile-First）：",
        "- 使用 Tailwind 响应式前缀 `sm:` / `md:` / `lg:` / `xl:`",
        "- 容器：`w-full max-w-screen-xl mx-auto px-4 md:px-8`",
        "- 导航栏：手机端折叠为汉堡菜单",
        "- 网格：`grid-cols-1` → `md:grid-cols-2` → `lg:grid-cols-3`",
        "- Flex：手机端 `flex-col`，桌面端 `md:flex-row`",
        "- 禁止固定像素宽度导致手机端溢出",
        "",
        "### Tailwind CSS @apply 关键规则",
        "**禁止在 `@layer` 块中 `@apply` 自定义颜色类**（如 `bg-surface-900`、`from-apple-blue`）。",
        "在 `@layer` 内必须写原生 CSS：`background-color: #0c0a08;`。",
        "在 JSX className 中可以正常使用这些自定义类。",
        "",
        "### 禁止停顿",
        "- 禁止以纯文本方式提问后停止，必须全程保持执行状态",
        "- 不明确的需求细节使用 AskUserQuestion 工具提问，收到回答后立即继续",
        "- 不要询问用户选择执行方式、确认计划，直接执行",
        "",
        "### Skill 使用策略",
        "- **强制**：编写组件前必须先调用 /frontend-design 生成设计方案",
        "- **推荐**：独立叶子组件可通过 /dispatching-parallel-agents 并行创建",
        "- **按需**：使用 /find-skills 动态查找并安装其他技能",
        "- **禁止**：/writing-plans、/brainstorming（会停顿等待确认）",
        "",
        "---",
        "",
        "## 再次强调：写一个组件 → 立刻更新 App.tsx → 再写下一个。不允许攒着最后统一更新。",
      ].join("\n");

      setPendingQuickAction({
        display: `项目描述：${description}`,
        prompt,
        conversationId: conversation.id,
      });
      setPreviewVisible(true);
      setPreviewChatWidth(480);
      setSidebarTab("explorer");
      setActiveView("chat");
    } catch {
      setInitError("Project initialization failed. Please check the project settings and try again.");
      setInitPhase("error");
    } finally {
      setIsInitializing(false);
      setIsSending(false);
      unlisten();
    }
  }, [inputValue, projectPath, projectName, nameError, isSending, addWorkspace, createConversation, setActiveView, setSidebarTab, setPendingQuickAction, addToast, t, setIsInitializing, clearInitLogs, addInitLog, storeSetProjectPath, storeSetProjectName, setPreviewVisible, setPreviewChatWidth]);

  const handleBack = useCallback(() => {
    setActiveView("workspace");
  }, [setActiveView]);

  const handleBackToIdle = useCallback(() => {
    setInitPhase("idle");
    setInitError("");
  }, []);

  // Typewriter effect — type text into input with 30ms char delay
  const handleSuggestionClick = useCallback((text: string) => {
    if (typewriterRef.current) {
      clearInterval(typewriterRef.current);
    }
    setInputValue("");
    let charIndex = 0;
    typewriterRef.current = window.setInterval(() => {
      charIndex++;
      setInputValue(text.slice(0, charIndex));
      if (charIndex >= text.length) {
        if (typewriterRef.current) clearInterval(typewriterRef.current);
        typewriterRef.current = null;
      }
    }, TYPEWRITER_CHAR_DELAY);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (typewriterRef.current) clearInterval(typewriterRef.current);
    };
  }, []);

  return (
    <div
      className="flex-1 flex flex-col relative overflow-hidden"
      style={{ backgroundColor: "var(--color-background)" }}
    >
      {/* Top Bar */}
      <TopBar onBack={workspaces.length > 0 ? handleBack : null} onOpenFolder={handleOpenFolder} />

      {/* Main Content */}
      <div className="flex-1 flex flex-col items-center justify-center relative" style={{ gap: 28 }}>
        {/* Spec 1: Staggered entrance — Hero Section */}
        <div className="flex flex-col items-center welcome-stagger welcome-stagger-1" style={{ gap: 12 }}>
          <h1
            className="font-sans text-center"
            style={{
              fontSize: 38,
              fontWeight: 700,
              letterSpacing: -0.5,
              background: "linear-gradient(180deg, var(--color-foreground) 0%, var(--color-muted) 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            {t("welcome.heroTitle")}
          </h1>
          <p
            className="font-sans text-center welcome-stagger welcome-stagger-2"
            style={{
              fontSize: 14,
              color: "var(--color-muted)",
              lineHeight: 1.5,
              maxWidth: 500,
            }}
          >
            {t("welcome.heroSubtitle")}
          </p>
        </div>

        {/* Suggestion Pills */}
        <div
          className="flex flex-col items-center welcome-stagger welcome-stagger-3"
          style={{ gap: 12 }}
        >
          <div className="flex items-center justify-center flex-wrap" style={{ gap: 8 }}>
            {suggestions.map((s) => (
              <SuggestionPill
                key={s.labelKey}
                icon={s.icon}
                text={t(s.labelKey)}
                color={s.color}
                onClick={() => handleSuggestionClick(t(s.promptKey))}
              />
            ))}
          </div>
        </div>

        {/* Bottom Section: switches based on initPhase */}
        <div
          className="flex flex-col w-full welcome-stagger welcome-stagger-4"
          style={{ gap: 8, maxWidth: 720, padding: "0 24px" }}
        >
          {initPhase === "idle" && (
            <div className="flex flex-col" style={{ gap: 8 }}>
              {/* Warning banner — only when no path selected and user tried to send */}
              {!projectPath && showDirWarning && (
                <DirWarningAddon onSelectFolder={handleSelectProjectFolder} />
              )}

              <div
                className="relative welcome-input-wrap"
                style={{ borderRadius: 16 }}
              >
                {!showDirWarning && <div className="welcome-input-border-glow" />}
                {!showDirWarning && <div className="welcome-input-border-mask" />}

                <div
                  className="flex flex-col relative"
                  style={{
                    padding: "20px 24px",
                    borderRadius: 16,
                    backgroundColor: "var(--color-surface-dark)",
                    border: showDirWarning && !projectPath ? "1.5px solid #F59E0B40" : undefined,
                    gap: 16,
                    zIndex: 1,
                  }}
                >
                  {/* Dir addon — inside input box */}
                  {projectPath ? (
                    <DirAddon
                      projectPath={projectPath}
                      projectName={projectName}
                      nameError={nameError}
                      onSelectFolder={handleSelectProjectFolder}
                      onProjectNameChange={setProjectName}
                    />
                  ) : (
                    !showDirWarning && (
                      <button
                        onClick={handleSelectProjectFolder}
                        className="flex items-center transition-colors hover:brightness-125"
                        style={{
                          gap: 6,
                          padding: "0 4px",
                          background: "transparent",
                          border: "none",
                          cursor: "pointer",
                        }}
                      >
                        <Folder size={13} style={{ color: "#555555" }} />
                        <span
                          style={{
                            fontSize: 12,
                            color: "#555555",
                            fontFamily: "'JetBrains Mono', monospace",
                          }}
                        >
                          {t("welcome.dirSelector.placeholder")}
                        </span>
                      </button>
                    )
                  )}

                  <textarea
                    ref={textareaRef}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onCompositionStart={() => { composingRef.current = true; }}
                    onCompositionEnd={() => {
                      compositionEndTimeRef.current = Date.now();
                      requestAnimationFrame(() => { composingRef.current = false; });
                    }}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing || composingRef.current) return;
                      if (e.key === "Enter" && Date.now() - compositionEndTimeRef.current < 100) return;
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                    placeholder={t("welcome.inputPlaceholder")}
                    aria-label={t("welcome.inputPlaceholder")}
                    rows={1}
                    className="font-sans bg-transparent outline-none w-full text-foreground"
                    style={{
                      fontSize: 15,
                      caretColor: "var(--color-accent-purple)",
                      resize: "none",
                      lineHeight: 1.5,
                      overflow: "auto",
                    }}
                  />

                  <div className="flex items-center justify-between">
                    <div className="flex items-center" style={{ gap: 4 }}>
                      {INPUT_ACTIONS.map(({ icon: Icon, i18nKey }) => (
                        <button
                          key={i18nKey}
                          aria-label={t(i18nKey)}
                          className="flex items-center justify-center transition-colors hover:brightness-150"
                          style={{ width: 32, height: 32, borderRadius: 8 }}
                        >
                          <Icon size={16} style={{ color: "var(--color-muted)" }} />
                        </button>
                      ))}
                      <button
                        aria-label={t("welcome.actions.attachImage")}
                        className="flex items-center justify-center transition-colors hover:brightness-150"
                        style={{ width: 32, height: 32, borderRadius: 8 }}
                      >
                        <Image size={16} style={{ color: "var(--color-muted)" }} />
                      </button>
                    </div>

                    <div className="flex items-center" style={{ gap: 8 }}>
                      <ModelSelector />
                      <button
                        onClick={handleSend}
                        disabled={isSending}
                        aria-label={t("welcome.sendMessage")}
                        className="flex items-center justify-center welcome-send-btn"
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 10,
                          background: !projectPath
                            ? "#333333"
                            : "linear-gradient(135deg, var(--color-accent-purple) 0%, #6366F1 100%)",
                          opacity: !projectPath ? 0.5 : isSending ? 0.6 : 1,
                          cursor: isSending ? "wait" : "pointer",
                        }}
                      >
                        <ArrowUp size={18} className="text-white welcome-send-icon" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {initPhase === "initializing" && (
            <div
              className="flex flex-col"
              style={{
                padding: "20px 24px",
                borderRadius: 16,
                backgroundColor: "var(--color-surface-dark)",
                border: "1px solid var(--color-border)",
                gap: 12,
              }}
            >
              <div className="flex items-center" style={{ gap: 8 }}>
                <div
                  className="animate-spin shrink-0"
                  style={{
                    width: 16,
                    height: 16,
                    border: "2px solid var(--color-accent-blue)",
                    borderTopColor: "transparent",
                    borderRadius: "50%",
                  }}
                />
                <span className="font-sans" style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>
                  {t("welcome.init.initializing")}
                </span>
              </div>
              <div
                className="rounded-lg overflow-y-auto"
                style={{
                  padding: 12,
                  maxHeight: 200,
                  backgroundColor: "var(--color-surface-alt)",
                }}
              >
                {initLogs.map((log, i) => (
                  <div
                    key={i}
                    className="font-mono"
                    style={{
                      fontSize: 11,
                      lineHeight: 1.6,
                      color: "var(--color-text-placeholder)",
                    }}
                  >
                    {log}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          )}

          {initPhase === "error" && (
            <div
              className="flex flex-col"
              style={{
                padding: "20px 24px",
                borderRadius: 16,
                backgroundColor: "var(--color-surface-dark)",
                border: "1px solid rgba(239, 68, 68, 0.3)",
                gap: 12,
              }}
            >
              <div
                className="font-sans rounded-lg"
                style={{
                  fontSize: 13,
                  padding: "10px 14px",
                  backgroundColor: "rgba(239, 68, 68, 0.1)",
                  color: "#EF4444",
                }}
              >
                {initError}
              </div>
              {initLogs.length > 0 && (
                <div
                  className="rounded-lg overflow-y-auto"
                  style={{
                    padding: 12,
                    maxHeight: 160,
                    backgroundColor: "var(--color-surface-alt)",
                  }}
                >
                  {initLogs.map((log, i) => (
                    <div
                      key={i}
                      className="font-mono"
                      style={{
                        fontSize: 11,
                        lineHeight: 1.6,
                        color: log.startsWith("Error:") ? "#EF4444" : "var(--color-text-placeholder)",
                      }}
                    >
                      {log}
                    </div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              )}
              <div className="flex items-center" style={{ gap: 8 }}>
                <button
                  onClick={handleBackToIdle}
                  className="flex items-center transition-colors hover:brightness-125"
                  style={{
                    gap: 6,
                    padding: "8px 14px",
                    borderRadius: 8,
                    backgroundColor: "transparent",
                    border: "1px solid var(--color-border)",
                    cursor: "pointer",
                  }}
                >
                  <ArrowLeft size={14} style={{ color: "var(--color-text-tertiary)" }} />
                  <span className="font-sans" style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>
                    {t("welcome.init.back")}
                  </span>
                </button>
                <button
                  onClick={handleSend}
                  className="flex items-center transition-colors hover:brightness-125"
                  style={{
                    gap: 6,
                    padding: "8px 14px",
                    borderRadius: 8,
                    backgroundColor: "#2563eb",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  <RotateCcw size={14} style={{ color: "#fff" }} />
                  <span className="font-sans" style={{ fontSize: 13, color: "#fff" }}>
                    {t("welcome.init.retry")}
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
