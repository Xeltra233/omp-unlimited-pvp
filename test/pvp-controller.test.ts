import { describe, expect, it, mock } from "bun:test";
import {
  formatPvpStatus,
  getPvpArgumentCompletions,
  installPvpRetryHook,
  PvpController,
  PVP_STATUS_KEY,
  PVP_WIDGET_KEY,
  type PvpAgentMessage,
  type PvpUi,
} from "../src/pvp-controller.js";
import { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { SettingsLike } from "../src/settings-guard.js";

function createMockUi(): PvpUi & {
  statuses: Record<string, string | undefined>;
  widgets: Record<string, { content: string[] | undefined; options?: any }>;
  notifications: Array<{ msg: string; type?: string }>;
} {
  const statuses: Record<string, string | undefined> = {};
  const widgets: Record<string, { content: string[] | undefined; options?: any }> = {};
  const notifications: Array<{ msg: string; type?: string }> = [];

  return {
    statuses,
    widgets,
    notifications,
    setStatus: mock((key: string, value: string | undefined) => {
      statuses[key] = value;
    }),
    setWidget: mock((key: string, content: any, options?: any) => {
      let resolvedContent: string[] | undefined;
      if (typeof content === "function") {
        const comp = content({}, undefined);
        resolvedContent = comp?.render?.(80);
      } else {
        resolvedContent = content;
      }
      widgets[key] = { content: resolvedContent, options };
    }),
    notify: mock((msg: string, type?: "info" | "warning" | "error") => {
      notifications.push({ msg, type });
    }),
  };
}

function createMockSettings(): SettingsLike & { overrides: Record<string, unknown> } {
  const overrides: Record<string, unknown> = {};
  return {
    overrides,
    override: mock((path: string, val: unknown) => {
      overrides[path] = val;
    }),
    clearOverride: mock((path: string) => {
      delete overrides[path];
    }),
  };
}

describe("PvpController State & Commands", () => {
  it("starts in 'off' mode with no status bar marker", () => {
    const controller = new PvpController();
    expect(controller.currentMode).toBe("off");
    expect(controller.enabled).toBe(false);
    expect(controller.isPendingRetry).toBe(false);
    expect(controller.currentAttempt).toBe(0);
    expect(controller.hasTimer).toBe(false);
    expect(controller.isAntiFallbackApplied).toBe(false);
  });

  it("handles '/pvp' and '/pvp on' to enable persistent mode with anti-fallback", () => {
    const mockSettings = createMockSettings();
    const controller = new PvpController(mockSettings);
    const ui = createMockUi();

    controller.handleCommand("", { ui });
    expect(controller.currentMode).toBe("persistent");
    expect(controller.enabled).toBe(true);
    expect(controller.isAntiFallbackApplied).toBe(true);
    expect(mockSettings.overrides["retry.modelFallback"]).toBe(false);
    expect(mockSettings.overrides["retry.enabled"]).toBe(true);
    expect(mockSettings.overrides["retry.maxRetries"]).toBe(999999);
    expect(mockSettings.overrides["retry.baseDelayMs"]).toBe(0);
    expect(mockSettings.overrides["retry.fallbackChains"]).toEqual({});
    expect(ui.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
    expect(ui.widgets[PVP_WIDGET_KEY]?.options).toEqual({ placement: "belowEditor" });
    expect(ui.notifications[0]?.msg).toBe("PVP ON");

    controller.handleCommand("on", { ui });
    expect(controller.currentMode).toBe("persistent");
    expect(ui.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
    expect(ui.notifications[1]?.msg).toBe("PVP ON");
  });

  it("handles '/pvp one' to enable one-success mode with anti-fallback", () => {
    const mockSettings = createMockSettings();
    const controller = new PvpController(mockSettings);
    const ui = createMockUi();

    controller.handleCommand("one", { ui });
    expect(controller.currentMode).toBe("one");
    expect(controller.enabled).toBe(true);
    expect(controller.isAntiFallbackApplied).toBe(true);
    expect(mockSettings.overrides["retry.modelFallback"]).toBe(false);
    expect(mockSettings.overrides["retry.enabled"]).toBe(true);
    expect(mockSettings.overrides["retry.maxRetries"]).toBe(999999);
    expect(mockSettings.overrides["retry.baseDelayMs"]).toBe(0);
    expect(mockSettings.overrides["retry.fallbackChains"]).toEqual({});
    expect(ui.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp one"]);
    expect(ui.widgets[PVP_WIDGET_KEY]?.options).toEqual({ placement: "belowEditor" });
    expect(ui.notifications[0]?.msg).toBe("PVP ONE");
  });

  it("handles '/pvp off' to disable, clear UI, and restore OMP fallback settings", () => {
    const mockSettings = createMockSettings();
    const controller = new PvpController(mockSettings);
    const ui = createMockUi();

    controller.enable("persistent", ui);
    expect(controller.isAntiFallbackApplied).toBe(true);
    expect(ui.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);

    controller.handleCommand("off", { ui });
    expect(controller.currentMode).toBe("off");
    expect(controller.enabled).toBe(false);
    expect(controller.isAntiFallbackApplied).toBe(false);
    expect(mockSettings.overrides["retry.modelFallback"]).toBeUndefined();
    expect(mockSettings.overrides["retry.enabled"]).toBeUndefined();
    expect(ui.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toBeUndefined();
    expect(ui.notifications.some((n) => n.msg === "PVP OFF")).toBe(true);
  });

  it("warns on unknown command and preserves mode", () => {
    const controller = new PvpController();
    const ui = createMockUi();

    controller.enable("persistent", ui);
    controller.handleCommand("unknown-arg", { ui });

    expect(controller.currentMode).toBe("persistent");
    expect(ui.notifications.some((n) => n.type === "warning")).toBe(true);
  });

  it("falls back to ui.setStatus if ui.setWidget is not a function", () => {
    const controller = new PvpController();
    const minimalUi = {
      setStatus: (key: string, text?: string) => {
        minimalUi.statuses[key] = text;
      },
      notify: () => {},
      statuses: {} as Record<string, string | undefined>,
    };

    controller.enable("persistent", minimalUi as any);
    expect(minimalUi.statuses[PVP_STATUS_KEY]).toBe("pvp on");
  });

  it("provides argument completions correctly", () => {
    expect(getPvpArgumentCompletions("")).toEqual([
      { value: "on", label: "on" },
      { value: "one", label: "one" },
      { value: "off", label: "off" },
    ]);
    expect(getPvpArgumentCompletions("o")).toEqual([
      { value: "on", label: "on" },
      { value: "one", label: "one" },
      { value: "off", label: "off" },
    ]);
    expect(getPvpArgumentCompletions("on")).toEqual([
      { value: "on", label: "on" },
      { value: "one", label: "one" },
    ]);
    expect(getPvpArgumentCompletions("of")).toEqual([
      { value: "off", label: "off" },
    ]);
    expect(getPvpArgumentCompletions("invalid")).toBeNull();
  });
});

describe("PvpController Prompt Recording", () => {
  it("records prompt text and image attachments", () => {
    const controller = new PvpController();
    controller.recordPrompt("Test prompt", [{ type: "image", data: "base64", mimeType: "image/png" }]);

    expect(controller.recordedPrompt).toBe("Test prompt");
    expect(controller.recordedImages).toHaveLength(1);
    expect(controller.recordedImages?.[0]?.type).toBe("image");
  });
});

describe("PvpController Turn Outcomes & Retries", () => {
  it("flags pending retry upon error in persistent mode", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);

    const errorMessage: PvpAgentMessage = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "error",
      errorMessage: "Rate limit reached (429)",
      timestamp: Date.now(),
    } as any;

    const result = controller.handleTurnEnd(errorMessage, ui);
    expect(result.shouldRetry).toBe(true);
    expect(result.success).toBe(false);
    expect(controller.isPendingRetry).toBe(true);
    expect(controller.lastErrorMessage).toBe("Rate limit reached (429)");
  });

  it("schedules immediate retry on settled event without cooldown", async () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);
    controller.recordPrompt("Retry prompt");

    const errorMessage: PvpAgentMessage = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "error",
      errorMessage: "Service unavailable (503)",
      timestamp: Date.now(),
    } as any;

    controller.handleTurnEnd(errorMessage, ui);

    let sentPrompt: string | undefined;
    const sendFn = mock((prompt: string) => {
      sentPrompt = prompt;
    });

    const scheduled = controller.scheduleRetry(sendFn, ui);
    expect(scheduled).toBe(true);
    expect(controller.currentAttempt).toBe(1);
    expect(ui.notifications.some((n) => n.msg.includes("正在无延迟重试"))).toBe(true);

    // Await the setTimeout(..., 0)
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sentPrompt).toBe("Retry prompt");
  });

  it("clears pending retry and turns off in 'one' mode upon success", () => {
    const mockSettings = createMockSettings();
    const controller = new PvpController(mockSettings);
    const ui = createMockUi();
    controller.enable("one", ui);
    expect(controller.isAntiFallbackApplied).toBe(true);

    const successMessage: PvpAgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Answer" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    } as any;

    const result = controller.handleTurnEnd(successMessage, ui);
    expect(result.shouldRetry).toBe(false);
    expect(result.success).toBe(true);
    expect(controller.currentMode).toBe("off");
    expect(controller.enabled).toBe(false);
    expect(controller.isAntiFallbackApplied).toBe(false);
    expect(mockSettings.overrides["retry.modelFallback"]).toBeUndefined();
    expect(ui.notifications.some((n) => n.msg === "PVP OFF")).toBe(true);
  });

  it("cancels retry on user abort", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);

    const abortMessage: PvpAgentMessage = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "aborted",
      timestamp: Date.now(),
    } as any;

    const result = controller.handleTurnEnd(abortMessage, ui);
    expect(result.shouldRetry).toBe(false);
    expect(result.success).toBe(false);
    expect(controller.isPendingRetry).toBe(false);
    expect(controller.currentAttempt).toBe(0);
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
  });

  it("preserves retry count across consecutive retry cycles and before_agent_start", async () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);
    controller.recordPrompt("Infinite test");

    const errorMessage: PvpAgentMessage = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "HTTP 500",
    } as any;

    const sendFn = mock(() => {});

    for (let i = 1; i <= 5; i++) {
      controller.handleTurnEnd(errorMessage, ui);
      controller.scheduleRetry(sendFn, ui);
      expect(controller.currentAttempt).toBe(i);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sendFn).toHaveBeenCalledTimes(i);
      // Simulate OMP firing before_agent_start on the retried run:
      controller.recordPrompt("Infinite test");
      // Counter must be preserved and NOT reset to zero!
      expect(controller.currentAttempt).toBe(i);
    }
  });

  it("resets retry count on success, and restarts count from 1 on subsequent failure", async () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);
    controller.recordPrompt("Task 1");

    const errorMessage: PvpAgentMessage = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "error",
      errorMessage: "500 Error",
      timestamp: Date.now(),
    } as any;

    const sendFn = mock(() => {});

    // Round 1: fail -> retry (attempt 1)
    controller.handleTurnEnd(errorMessage, ui);
    controller.scheduleRetry(sendFn, ui);
    expect(controller.currentAttempt).toBe(1);
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on (第 1 次重试)"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.recordPrompt("Task 1");
    expect(controller.currentAttempt).toBe(1);

    // Round 2: fail -> retry (attempt 2)
    controller.handleTurnEnd(errorMessage, ui);
    controller.scheduleRetry(sendFn, ui);
    expect(controller.currentAttempt).toBe(2);
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on (第 2 次重试)"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.recordPrompt("Task 1");
    expect(controller.currentAttempt).toBe(2);

    // Round 3: succeeds!
    const successMessage: PvpAgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    } as any;
    const successResult = controller.handleTurnEnd(successMessage, ui);
    expect(successResult.success).toBe(true);
    // Count must be reset to 0!
    expect(controller.currentAttempt).toBe(0);
    // Widget must be restored to clean "pvp on" without attempt counter
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);

    // Subsequent prompt or failure must restart count from 1!
    controller.recordPrompt("Task 2", undefined, ui);
    expect(controller.currentAttempt).toBe(0);

    controller.handleTurnEnd(errorMessage, ui);
    controller.scheduleRetry(sendFn, ui);
    expect(controller.currentAttempt).toBe(1);
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on (第 1 次重试)"]);
  });

  it("resets retry count and cleans UI when a brand new user prompt is submitted", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);
    controller.recordPrompt("Task A");

    const errorMessage: PvpAgentMessage = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Fail",
    } as any;

    const sendFn = mock(() => {});
    controller.handleTurnEnd(errorMessage, ui);
    controller.scheduleRetry(sendFn, ui);
    expect(controller.currentAttempt).toBe(1);
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on (第 1 次重试)"]);

    // User submits a new prompt manually before/during retry:
    controller.recordPrompt("Brand new task B", undefined, ui);
    expect(controller.currentAttempt).toBe(0);
    expect(controller.recordedPrompt).toBe("Brand new task B");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
  });

  it("tracks isRetryInFlight status during scheduling and execution", async () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);
    controller.recordPrompt("Test prompt");

    expect(controller.isRetryInFlight).toBe(false);

    const errorMessage: PvpAgentMessage = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Fail",
    } as any;

    controller.handleTurnEnd(errorMessage, ui);

    let inFlightDuringSend = false;
    const sendFn = mock(() => {
      inFlightDuringSend = controller.isRetryInFlight;
    });

    controller.scheduleRetry(sendFn, ui);
    expect(controller.isRetryInFlight).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(inFlightDuringSend).toBe(true);
    expect(controller.isRetryInFlight).toBe(true);

    // Consumed by recordPrompt on next agent start
    controller.recordPrompt("Test prompt");
    expect(controller.isRetryInFlight).toBe(false);
  });
});

describe("formatPvpStatus", () => {
  it("formats status string with and without attempts", () => {
    expect(formatPvpStatus("persistent", 0)).toBe("pvp on");
    expect(formatPvpStatus("one", 0)).toBe("pvp one");
    expect(formatPvpStatus("persistent", 3)).toContain("pvp on");
    expect(formatPvpStatus("persistent", 3)).toContain("(第 3 次重试)");
  });

  it("respects theme colors if provided", () => {
    const mockTheme = {
      fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    } as any;

    const res = formatPvpStatus("persistent", 2, mockTheme);
    expect(res).toContain("[muted]pvp on[/muted]");
    expect(res).toContain("[dim](第 2 次重试)[/dim]");
  });
});

describe("PvpController Native In-Place Retry & Hook Mechanisms", () => {
  it("recordRetryAttempt increments attempt count and emits notification", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);

    const count1 = controller.recordRetryAttempt(ui, "Connection failed");
    expect(count1).toBe(1);
    expect(controller.currentAttempt).toBe(1);
    expect(controller.lastErrorMessage).toBe("Connection failed");
    expect(ui.notifications.some((n) => n.msg.includes("第 1 次"))).toBe(true);
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on (第 1 次重试)"]);

    const count2 = controller.recordRetryAttempt(ui, "Timeout");
    expect(count2).toBe(2);
    expect(controller.currentAttempt).toBe(2);
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on (第 2 次重试)"]);
  });

  it("handleSuccess resets retry count and handles 'one' mode auto-closing", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);
    controller.recordRetryAttempt(ui, "Err");
    expect(controller.currentAttempt).toBe(1);

    controller.handleSuccess(ui);
    expect(controller.currentAttempt).toBe(0);
    expect(controller.enabled).toBe(true);
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);

    // One mode
    controller.enable("one", ui);
    controller.recordRetryAttempt(ui, "Err");
    controller.handleSuccess(ui);
    expect(controller.enabled).toBe(false);
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toBeUndefined();
    expect(ui.notifications.some((n) => n.msg === "PVP OFF")).toBe(true);
  });

  it("handleAbort resets retry state and restores clean UI", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);
    controller.recordRetryAttempt(ui, "Err");
    expect(controller.currentAttempt).toBe(1);

    controller.handleAbort(ui);
    expect(controller.currentAttempt).toBe(0);
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
  });

  it("handleNewPrompt resets count when user submits fresh prompt", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);
    controller.recordRetryAttempt(ui, "Err");
    expect(controller.currentAttempt).toBe(1);

    controller.handleNewPrompt(ui);
    expect(controller.currentAttempt).toBe(0);
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
  });

  it("handleMessageEnd modifies assistant error messages when enabled", () => {
    const controller = new PvpController();
    const errorMsg: PvpAgentMessage = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Rate limit exceeded",
    } as any;

    expect(controller.handleMessageEnd(errorMsg)).toBeUndefined();

    controller.enable("persistent");
    const replaced = controller.handleMessageEnd(errorMsg);
    expect(replaced).toBeDefined();
    expect(replaced?.errorMessage).toBe("Rate limit exceeded <!-- quota exceeded -->");
  });

  it("installPvpRetryHook hooks AgentSession prototype and cleans up cleanly", async () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);

    const uninstall = installPvpRetryHook(controller);
    const sessionProto = (AgentSession as any).prototype;

    // Test _isRetryableError
    expect(sessionProto._isRetryableError({ stopReason: "error", errorMessage: "500" })).toBe(true);
    expect(sessionProto._isRetryableError({ stopReason: "aborted" })).toBe(false);
    expect(sessionProto._isRetryableError({ stopReason: "error", errorMessage: "context overflow exceed" })).toBe(false);

    // Test _prepareRetry
    const fakeSession = {
      _extensionUIContext: ui,
      agent: {
        state: {
          messages: [
            { role: "user", content: [{ type: "text", text: "Task" }] },
            { role: "assistant", stopReason: "error", errorMessage: "500" },
          ],
        },
      },
    };

    const willRetry = await sessionProto._prepareRetry.call(fakeSession, {
      role: "assistant",
      stopReason: "error",
      errorMessage: "500",
    });
    expect(willRetry).toBe(true);
    expect(fakeSession.agent.state.messages).toHaveLength(1);
    expect(controller.currentAttempt).toBe(1);

    // Cleanup restores prototype
    uninstall();
    controller.disable(ui);
  });
});
