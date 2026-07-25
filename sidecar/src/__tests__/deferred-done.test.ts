// ---------------------------------------------------------------------------
// 后台子代理 deferred-done 生命周期测试
//
// 场景:主代理启动后台子代理后结束自己的 turn(result 到达时子代理仍活跃),
// done 被推迟(donePending)。SubagentStop 触发后 SDK 会注入 task-notification
// 唤醒主代理继续新 turn —— deferred done 绝不能与该唤醒 turn 竞态发出,
// 否则前端提前清理流上下文,唤醒 turn 的所有事件被静默丢弃
// (工具卡在 loading、任务看似被中断)。
//
// classifyDeferredDoneWake 是该竞态的仲裁器:
//   - "cancel" — 主会话新活动:唤醒 turn 已开始,撤销 pending done
//   - "extend" — task_notification 系统消息:唤醒在即,延长宽限窗口
//   - null     — 子代理内部消息/无关消息:不影响 pending done
//
// 运行: cd sidecar && npx vitest run src/__tests__/deferred-done.test.ts
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { classifyDeferredDoneWake } from "../claude-handler.js";

describe("classifyDeferredDoneWake", () => {
  it("extends the grace window on a task_notification system message", () => {
    expect(
      classifyDeferredDoneWake({
        type: "system",
        subtype: "task_notification",
        task_id: "t1",
        status: "completed",
      }),
    ).toBe("extend");
  });

  it("ignores other system subtypes (task_progress must not disturb pending done)", () => {
    expect(
      classifyDeferredDoneWake({ type: "system", subtype: "task_progress" }),
    ).toBe(null);
    expect(
      classifyDeferredDoneWake({ type: "system", subtype: "task_started" }),
    ).toBe(null);
    expect(
      classifyDeferredDoneWake({ type: "system", subtype: "compact_boundary" }),
    ).toBe(null);
  });

  it("cancels on main-conversation assistant/user/stream_event messages", () => {
    expect(
      classifyDeferredDoneWake({ type: "assistant", parent_tool_use_id: null }),
    ).toBe("cancel");
    // parent_tool_use_id 字段完全缺失时同样视为主会话消息
    expect(classifyDeferredDoneWake({ type: "assistant" })).toBe("cancel");
    expect(
      classifyDeferredDoneWake({ type: "user", parent_tool_use_id: null }),
    ).toBe("cancel");
    expect(
      classifyDeferredDoneWake({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "message_start" },
      }),
    ).toBe("cancel");
  });

  it("ignores subagent-internal messages (parent_tool_use_id set)", () => {
    expect(
      classifyDeferredDoneWake({ type: "assistant", parent_tool_use_id: "toolu_01" }),
    ).toBe(null);
    expect(
      classifyDeferredDoneWake({ type: "user", parent_tool_use_id: "toolu_01" }),
    ).toBe(null);
    expect(
      classifyDeferredDoneWake({
        type: "stream_event",
        parent_tool_use_id: "toolu_01",
        event: { type: "content_block_delta" },
      }),
    ).toBe(null);
  });

  it("ignores result messages (the result path emits done itself)", () => {
    expect(
      classifyDeferredDoneWake({ type: "result", subtype: "success" }),
    ).toBe(null);
  });
});
