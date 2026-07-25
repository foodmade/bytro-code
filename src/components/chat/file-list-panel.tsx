import { FileCode } from "lucide-react";
import {
  useFileChangesStore,
  useConversationStore,
  type FileChange,
} from "@/stores";

// ---------------------------------------------------------------------------
// Color helpers — match pencil design node KwdP3
// ---------------------------------------------------------------------------

/** Icon colors rotate for 'modify' action to add visual variety. */
const MODIFY_ICON_COLORS = ["var(--color-accent-purple)", "var(--color-accent-blue)"] as const;

function getActionConfig(action: FileChange["action"], index: number): {
  iconColor: string;
  tagLabel: string;
  tagColor: string;
  tagBg: string;
} {
  switch (action) {
    case "create":
      return {
        iconColor: "#4ADE80",
        tagLabel: "A",
        tagColor: "#4ADE80",
        tagBg: "var(--color-filelist-tag-create)",
      };
    case "delete":
      return {
        iconColor: "#F87171",
        tagLabel: "D",
        tagColor: "#F87171",
        tagBg: "var(--color-filelist-tag-delete)",
      };
    default:
      return {
        iconColor: MODIFY_ICON_COLORS[index % MODIFY_ICON_COLORS.length],
        tagLabel: "M",
        tagColor: "#4ADE80",
        tagBg: "var(--color-filelist-tag-modify)",
      };
  }
}

/** Split a file path into directory and filename portions. */
function splitPath(filePath: string): { dir: string; name: string } {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return { dir: "", name: normalized };
  return {
    dir: normalized.slice(0, lastSlash + 1),
    name: normalized.slice(lastSlash + 1),
  };
}

// ---------------------------------------------------------------------------
// FileRow
// ---------------------------------------------------------------------------

function FileRow({
  change,
  index,
  isLast,
}: {
  readonly change: FileChange;
  readonly index: number;
  readonly isLast: boolean;
}) {
  const { dir, name } = splitPath(change.filePath);
  const config = getActionConfig(change.action, index);

  return (
    <div
      className="flex items-center justify-between w-full"
      style={{
        padding: "7px 12px",
        borderBottom: isLast ? "none" : "1px solid var(--color-filelist-border)",
      }}
    >
      {/* Left: icon + path + tag */}
      <div className="flex items-center min-w-0" style={{ gap: 8 }}>
        <FileCode
          size={13}
          style={{ color: config.iconColor, flexShrink: 0 }}
        />
        <div className="flex items-center min-w-0" style={{ gap: 2 }}>
          <span
            className="truncate"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontWeight: 400,
              color: "var(--color-filelist-dir)",
            }}
          >
            {dir}
          </span>
          <span
            className="truncate"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontWeight: 500,
              color: "var(--color-filelist-name)",
            }}
          >
            {name}
          </span>
        </div>
        <div
          className="flex items-center justify-center flex-shrink-0"
          style={{
            padding: "1px 5px",
            borderRadius: 3,
            background: config.tagBg,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              color: config.tagColor,
              fontSize: 9,
              fontWeight: 700,
            }}
          >
            {config.tagLabel}
          </span>
        </div>
      </div>

      {/* Right: stats */}
      <div className="flex items-center flex-shrink-0" style={{ gap: 6 }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontWeight: 500,
            color: "#4ADE80",
          }}
        >
          +{change.additions}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontWeight: 500,
            color: change.deletions > 0 ? "#F87171" : "var(--color-filelist-zero)",
          }}
        >
          -{change.deletions}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileListPanel
// ---------------------------------------------------------------------------

/**
 * Expandable panel listing all changed files with per-file stats.
 * Matches pencil design node KwdP3 (ExpandedFileList).
 */
export function FileListPanel() {
  const conversationId = useConversationStore(
    (s) => s.activeConversationId,
  );
  const convState = useFileChangesStore((s) =>
    s.getConversationState(conversationId),
  );
  const isExpanded = useFileChangesStore((s) => s.isExpanded);

  const { changes } = convState;

  if (!isExpanded || changes.length === 0) return null;

  return (
    <div
      className="w-full overflow-hidden flex flex-col max-h-[200px]"
      style={{
        background: "var(--color-filelist-bg)",
        borderRadius: 8,
        border: "1px solid var(--color-filelist-border)",
      }}
    >
      <div className="flex flex-col w-full overflow-y-auto">
        {changes.map((change, i) => (
          <FileRow
            key={change.filePath}
            change={change}
            index={i}
            isLast={i === changes.length - 1}
          />
        ))}
      </div>
    </div>
  );
}
