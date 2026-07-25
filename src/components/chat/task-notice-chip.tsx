import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, ListChecks } from "lucide-react";
import type { TaskNotice } from "./chat-message-segments";

// ---------------------------------------------------------------------------
// TaskNoticeChip — compact rendering for harness-injected
// <task-notification> blocks (subagent completion notices). These are machine
// messages replayed into the assistant stream; showing the raw tags as prose
// buries the actual answer, so they collapse to a one-line chip with the
// original text available on demand.
// ---------------------------------------------------------------------------

export function TaskNoticeChip({ notices }: { readonly notices: ReadonlyArray<TaskNotice> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const names = notices
    .map((notice) => notice.agentName)
    .filter((name): name is string => !!name);
  const visibleNames = names.slice(0, 3);
  const hiddenCount = names.length - visibleNames.length;

  return (
    <div className="task-notice-chip" data-task-notice-chip={open ? "open" : "collapsed"}>
      <button
        type="button"
        className="task-notice-header"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ListChecks size={13} className="task-notice-icon" />
        <span className="task-notice-label">
          {t("chat.tools.taskNotice.completed", { count: notices.length })}
        </span>
        {visibleNames.length > 0 && (
          <span className="task-notice-names" title={names.join(", ")}>
            {visibleNames.join(", ")}
            {hiddenCount > 0 ? ` +${hiddenCount}` : ""}
          </span>
        )}
        {open
          ? <ChevronDown size={11} className="task-notice-chevron" />
          : <ChevronRight size={11} className="task-notice-chevron" />}
      </button>

      {open && (
        <div className="task-notice-body">
          {notices.map((notice, index) => (
            <div key={`${notice.start}-${index}`} className="task-notice-item">
              {notice.agentName && (
                <span className="task-notice-item-name">{notice.agentName}</span>
              )}
              <span className="task-notice-item-text">{notice.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
