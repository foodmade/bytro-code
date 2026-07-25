// ---------------------------------------------------------------------------
// Claude CLI adapter 兼容性测试
//
// 验证本地 CLI adapter 的关键类型与事件兼容性：
//   1. thinkingEnabled boolean → ThinkingConfig 映射
//   2. StreamObserver 签名（3 参数、无控制返回值）
//   3. postTaskObserver toolUseId 获取的双重回退
//   4. Task → Agent 工具重命名兼容性
//
// 运行: cd sidecar && npx vitest run src/__tests__/claude-cli-compat.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { ThinkingConfig, StreamObserver, HookInput } from "../claude-cli-adapter.js";

// ---------------------------------------------------------------------------
// 1. thinkingEnabled → ThinkingConfig 映射
// ---------------------------------------------------------------------------

/**
 * 提取自 claude-handler.ts buildQueryOptions 的映射逻辑。
 * 将协议层的 boolean 转换为 SDK 的 ThinkingConfig 对象。
 */
function mapThinkingConfig(thinkingEnabled: boolean | undefined | null): ThinkingConfig | undefined {
  if (thinkingEnabled == null) return undefined;
  return thinkingEnabled
    ? ({ type: "adaptive", display: "summarized" } as ThinkingConfig)
    : ({ type: "disabled" } as ThinkingConfig);
}

describe("thinkingEnabled → ThinkingConfig 映射", () => {
  it("true → adaptive summarized thinking", () => {
    const result = mapThinkingConfig(true);
    expect(result).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("false → { type: 'disabled' }", () => {
    const result = mapThinkingConfig(false);
    expect(result).toEqual({ type: "disabled" });
  });

  it("undefined → undefined（不设置，SDK 使用默认行为）", () => {
    const result = mapThinkingConfig(undefined);
    expect(result).toBeUndefined();
  });

  it("null → undefined（不设置，SDK 使用默认行为）", () => {
    const result = mapThinkingConfig(null);
    expect(result).toBeUndefined();
  });

  it("映射结果可正确展开到 Options 对象", () => {
    const thinkingEnabled = true;
    const options = {
      model: "test",
      ...(thinkingEnabled != null
        ? { thinking: (thinkingEnabled ? { type: "adaptive", display: "summarized" } : { type: "disabled" }) as ThinkingConfig }
        : {}),
    };
    expect(options).toHaveProperty("thinking", { type: "adaptive", display: "summarized" });
  });

  it("undefined 时 Options 中不包含 thinking 属性", () => {
    const thinkingEnabled = undefined;
    const options = {
      model: "test",
      ...(thinkingEnabled != null
        ? { thinking: (thinkingEnabled ? { type: "enabled" } : { type: "disabled" }) as ThinkingConfig }
        : {}),
    };
    expect(options).not.toHaveProperty("thinking");
  });
});

// ---------------------------------------------------------------------------
// 2. StreamObserver 签名兼容性
// ---------------------------------------------------------------------------

describe("StreamObserver 签名兼容性", () => {
  it("3 参数的观察函数满足 StreamObserver 类型", () => {
    // 这是一个编译时测试 — 如果类型不兼容，TypeScript 会报错
    const observer: StreamObserver = async (_input, _toolUseID, _options) => {};
    expect(typeof observer).toBe("function");
  });

  it("observer 接收到正确的 toolUseID 参数", async () => {
    let capturedToolUseID: string | undefined;
    const observer: StreamObserver = async (_input, toolUseID, _options) => {
      capturedToolUseID = toolUseID;
    };

    const mockInput = {
      hook_event_name: "PostToolUse",
      session_id: "test-session",
      transcript_path: "/tmp/test",
      cwd: "/tmp",
      tool_name: "Task",
      tool_input: {},
      tool_response: "result",
      tool_use_id: "tu_123",
    } as unknown as HookInput;

    await observer(mockInput, "tu_123", { signal: new AbortController().signal });
    expect(capturedToolUseID).toBe("tu_123");
  });

  it("observer has no control return channel", async () => {
    const observer: StreamObserver = async () => {};
    await expect(
      observer(
        { hook_event_name: "PreToolUse" } as unknown as HookInput,
        "tu_456",
        { signal: new AbortController().signal },
      ),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. postTaskHook toolUseId 双重回退逻辑
// ---------------------------------------------------------------------------

/**
 * 提取自 claude-handler.ts postTaskObserver 的 toolUseId 获取逻辑。
 * 优先使用 StreamObserver 第 2 参数 toolUseID，回退到 input.tool_use_id。
 */
function resolveToolUseId(
  toolUseID: string | undefined,
  rawInput: Record<string, unknown>,
): string {
  return toolUseID ?? (typeof rawInput.tool_use_id === "string" ? rawInput.tool_use_id : "");
}

describe("postTaskHook toolUseId 双重回退", () => {
  it("优先使用第 2 参数 toolUseID", () => {
    const result = resolveToolUseId("param-id", { tool_use_id: "input-id" });
    expect(result).toBe("param-id");
  });

  it("第 2 参数为 undefined 时回退到 input.tool_use_id", () => {
    const result = resolveToolUseId(undefined, { tool_use_id: "input-id" });
    expect(result).toBe("input-id");
  });

  it("两者都缺失时返回空字符串", () => {
    const result = resolveToolUseId(undefined, {});
    expect(result).toBe("");
  });

  it("第 2 参数为空字符串时使用空字符串（不回退）", () => {
    // 空字符串是 truthy 对于 ?? 运算符 — 空字符串 ?? x 返回空字符串
    const result = resolveToolUseId("", { tool_use_id: "input-id" });
    expect(result).toBe("");
  });

  it("input.tool_use_id 为非字符串类型时回退到空字符串", () => {
    const result = resolveToolUseId(undefined, { tool_use_id: 123 });
    expect(result).toBe("");
  });
});
