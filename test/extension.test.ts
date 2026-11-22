import { describe, expect, it, mock } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import {
  AgentSession,
  Settings,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import pvpExtension, { PVP_STATUS_KEY, PVP_WIDGET_KEY } from "../src/index.js";

// Real host settings, isolated from user files; commands require an initialized host.
await Settings.init({ inMemory: true });

type EventHandler = (event: any, ctx: ExtensionContext) => any;

function createMockExtensionApi(): {
  api: ExtensionAPI;
  handlers: Map<string, EventHandler[]>;
  commands: Map<string, any>;
  sentMessages: Array<{ content: any; options?: any }>;
  sentCustomMessages: Array<{ message: any; options?: any }>;
  currentModel: Model | undefined;
  setModelMock: ReturnType<typeof mock>;
} {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, any>();
  const sentMessages: Array<{ content: any; options?: any }> = [];
  const sentCustomMessages: Array<{ message: any; options?: any }> = [];
  let currentModel: Model | undefined = undefined;

  const setModelMock = mock(async (model: Model) => {
    currentModel = model;
    return true;
  });

  const api: Partial<ExtensionAPI> = {
    on(event: string, handler: EventHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    sendUserMessage(content: any, options?: any) {
      sentMessages.push({ content, options });
    },
    sendMessage(message: any, options?: any) {
      sentCustomMessages.push({ message, options });
    },
    setModel: setModelMock as any,
  };

  return {
    api: api as ExtensionAPI,
    handlers,
    commands,
    sentMessages,
    sentCustomMessages,
    get currentModel() {
      return currentModel;
    },
    setModelMock,
  };
}

function createMockContext(model?: Model): ExtensionCommandContext & {
  statuses: Record<string, string | undefined>;
  widgets: Record<string, { content: string[] | undefined; options?: any }>;
  notifications: Array<{ msg: string; type?: string }>;
} {
  const statuses: Record<string, string | undefined> = {};
  const widgets: Record<string, { content: string[] | undefined; options?: any }> = {};
  const notifications: Array<{ msg: string; type?: string }> = [];

  return {
    ui: {
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
      notify: mock((msg: string, type?: string) => {
        notifications.push({ msg, type });
      }),
      select: mock(async () => undefined),
      confirm: mock(async () => true),
      input: mock(async () => undefined),
    } as any,
    statuses,
    widgets,
    notifications,
    mode: "tui",
    hasUI: true,
    cwd: "/mock/cwd",
    sessionManager: {} as any,
    modelRegistry: {} as any,
    model,
    models: {
      current: () => model,
    } as any,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: mock(() => {}),
    hasPendingMessages: () => false,
    shutdown: mock(() => {}),
    getContextUsage: () => undefined,
    compact: mock(async () => {}),
    getSystemPrompt: () => [],
    getSystemPromptOptions: () => ({ cwd: "/mock/cwd" }),
    waitForIdle: async () => {},
    newSession: mock(async () => ({ cancelled: false })),
    branch: mock(async () => ({ cancelled: false })),
    navigateTree: mock(async () => ({ cancelled: false })),
  };
}

describe("PVP Extension End-to-End Lifecycle in OMP", () => {
  it("registers /pvp command and required lifecycle hooks", () => {
    const { api, commands, handlers } = createMockExtensionApi();
    pvpExtension(api);

    expect(commands.has("pvp")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("retry_fallback_applied")).toBe(true);
    expect(handlers.has("turn_end")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });

  it("keeps a persistent failure in the transcript and only counts on the real wire retry", async () => {
    const { api, handlers, commands, sentMessages } = createMockExtensionApi();
    pvpExtension(api);

    const mockModel: Model = {
      id: "gpt-4o",
      name: "GPT-4o",
      provider: "openai",
      api: "openai-responses",
      contextWindow: 128000,
      maxTokens: 4096,
      reasoning: false,
      inputPrice: 0,
      outputPrice: 0,
    };
    const ctx = createMockContext(mockModel);

    const pvpCmd = commands.get("pvp");
    await pvpCmd.handler("", ctx);
    expect(ctx.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
    expect(ctx.widgets[PVP_WIDGET_KEY]?.options).toEqual({ placement: "belowEditor" });
    expect(ctx.notifications[0]?.msg).toBe("PVP ON");

    const beforeAgentStart = handlers.get("before_agent_start")![0];
    beforeAgentStart({ type: "before_agent_start", prompt: "Build a feature", systemPrompt: [] }, ctx);

    // A provider failure reaches turn_end; PVP must plan a retry without
    // injecting a user message into the chat.
    const turnEnd = handlers.get("turn_end")![0];
    const failureMsg = {
      role: "assistant" as const,
      content: [],
      stopReason: "error" as const,
      errorMessage: "HTTP 500 Server Error",
    };
    turnEnd({ type: "turn_end", turnIndex: 1, message: failureMsg, toolResults: [] }, ctx);

    expect(sentMessages).toHaveLength(0);
    // The failed reply is never rewritten or dropped by the extension.
    expect(failureMsg.content).toEqual([]);
    expect(failureMsg.errorMessage).toBe("HTTP 500 Server Error");

    // Success closes the retry plan and restores the clean status text.
    const successMsg = { role: "assistant" as const, content: [{ type: "text", text: "Done!" }], stopReason: "stop" as const };
    turnEnd({ type: "turn_end", turnIndex: 2, message: successMsg, toolResults: [] }, ctx);
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
    expect(sentMessages).toHaveLength(0);

    // Abort cancels any pending retry and leaves the mode enabled.
    turnEnd(
      { type: "turn_end", turnIndex: 3, message: { role: "assistant", content: [], stopReason: "aborted" }, toolResults: [] },
      ctx
    );
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
  });

  it("counts one attempt per gated retry and auto-off after the configured successes", async () => {
    const { api, handlers, commands, sentMessages } = createMockExtensionApi();
    pvpExtension(api);
    const ctx = createMockContext();

    const pvpCmd = commands.get("pvp");
    await pvpCmd.handler("2", ctx);
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp 2"]);
    expect(ctx.notifications[0]?.msg).toBe("PVP 2");

    const beforeAgentStart = handlers.get("before_agent_start")![0];
    beforeAgentStart({ type: "before_agent_start", prompt: "One shot prompt", systemPrompt: [] }, ctx);

    // No watchdog listener is installed, so the gate lets the retry proceed and
    // the attempt is counted exactly once.
    const controllerAttempts: number[] = [];
    const turnEnd = handlers.get("turn_end")![0];
    turnEnd(
      {
        type: "turn_end",
        turnIndex: 1,
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Network error" },
        toolResults: [],
      },
      ctx
    );
    controllerAttempts.push(ctx.widgets[PVP_WIDGET_KEY]?.content?.length ?? 0);

    const successMsg = { role: "assistant" as const, content: [{ type: "text", text: "Success" }], stopReason: "stop" as const };
    turnEnd({ type: "turn_end", turnIndex: 2, message: successMsg, toolResults: [] }, ctx);
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp 2 (1/2)"]);

    turnEnd({ type: "turn_end", turnIndex: 3, message: successMsg, toolResults: [] }, ctx);
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toBeUndefined();
    expect(ctx.notifications.some((n) => n.msg.includes("PVP OFF"))).toBe(true);
    expect(sentMessages).toHaveLength(0);
    expect(controllerAttempts).toHaveLength(1);
  });
  it("intercepts OMP retry_fallback_applied and restores original model", async () => {
    const { api, handlers, commands, setModelMock } = createMockExtensionApi();
    pvpExtension(api);

    const originalModel: Model = {
      id: "claude-3-5-sonnet",
      name: "Claude 3.5 Sonnet",
      provider: "anthropic",
      api: "anthropic-messages",
      contextWindow: 200000,
      maxTokens: 8192,
      reasoning: false,
      inputPrice: 0,
      outputPrice: 0,
    };
    const ctx = createMockContext(originalModel);

    // Enable PVP
    const pvpCmd = commands.get("pvp");
    await pvpCmd.handler("on", ctx);

    // Start turn to record model
    const beforeAgentStart = handlers.get("before_agent_start")![0];
    beforeAgentStart({ type: "before_agent_start", prompt: "Hello", systemPrompt: [] }, ctx);

    // Suppose an external retry_fallback_applied event was emitted by OMP
    const retryFallbackApplied = handlers.get("retry_fallback_applied")![0];
    await retryFallbackApplied(
      {
        type: "retry_fallback_applied",
        from: "anthropic/claude-3-5-sonnet",
        to: "openai/gpt-4o",
        role: "default",
      },
      ctx
    );

    // Verify user notification and setModel restoration
    expect(ctx.notifications.some((n) => n.msg.includes("检测到模型 Fallback"))).toBe(true);
    expect(setModelMock).toHaveBeenCalledWith(originalModel);
  });

  it("cleans up on session shutdown", async () => {
    const { api, handlers, commands } = createMockExtensionApi();
    pvpExtension(api);
    const ctx = createMockContext();

    const pvpCmd = commands.get("pvp");
    await pvpCmd.handler("", ctx);
    expect(ctx.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);

    const sessionShutdown = handlers.get("session_shutdown")![0];
    sessionShutdown({ type: "session_shutdown", reason: "quit" }, ctx);

    expect(ctx.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toBeUndefined();
  });

  it("continues a turn OMP settled as terminal instead of surfacing 'Retry failed'", async () => {
    const { api, handlers, commands } = createMockExtensionApi();
    pvpExtension(api);
    const ctx = createMockContext();

    await commands.get("pvp").handler("on", ctx);

    const sessionStop = handlers.get("session_stop")![0];
    const settledError = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Error Code upstream_http2_stream_error: Upstream HTTP/2 stream failed",
      content: [],
    };

    const result = await sessionStop(
      {
        type: "session_stop",
        messages: [settledError],
        turn_id: 0,
        last_assistant_message: settledError,
        session_id: "test-session",
        stop_hook_active: false,
      },
      ctx
    );

    // `decision: "block"` bypasses OMP's continuation cap, so retries stay unlimited.
    expect(result?.decision).toBe("block");
    expect(result?.reason).toContain("upstream_http2_stream_error");
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on (第 1 次重试)"]);
    expect(ctx.notifications.some((n) => n.msg.includes("正在无延迟重试"))).toBe(true);
  });

  it("leaves clean stops, aborts, and context overflows to OMP", async () => {
    const { api, handlers, commands } = createMockExtensionApi();
    pvpExtension(api);
    const ctx = createMockContext();
    await commands.get("pvp").handler("on", ctx);

    const sessionStop = handlers.get("session_stop")![0];
    const stopEvent = (message: any) => ({
      type: "session_stop",
      messages: [message],
      turn_id: 0,
      last_assistant_message: message,
      session_id: "test-session",
      stop_hook_active: false,
    });

    expect(await sessionStop(stopEvent({ role: "assistant", stopReason: "stop", content: [] }), ctx)).toBeUndefined();
    expect(
      await sessionStop(stopEvent({ role: "assistant", stopReason: "aborted", content: [] }), ctx)
    ).toBeUndefined();
    expect(
      await sessionStop(
        stopEvent({
          role: "assistant",
          stopReason: "error",
          errorMessage: "prompt is too long: context window overflow",
          content: [],
        }),
        ctx
      )
    ).toBeUndefined();
  });

  it("does not continue settled turns while PVP is off", async () => {
    const { api, handlers } = createMockExtensionApi();
    pvpExtension(api);
    const ctx = createMockContext();

    const sessionStop = handlers.get("session_stop")![0];
    const settledError = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Error Code upstream_http2_stream_error: Upstream HTTP/2 stream failed",
      content: [],
    };

    expect(
      await sessionStop(
        { type: "session_stop", messages: [settledError], last_assistant_message: settledError, session_id: "s" },
        ctx
      )
    ).toBeUndefined();
  });

  it("restarts the turn from the auto_retry_end fallback when no continuation lands", async () => {
    const { api, handlers, commands, sentCustomMessages } = createMockExtensionApi();
    pvpExtension(api);
    const ctx = createMockContext();
    await commands.get("pvp").handler("on", ctx);

    // A failed turn arms PVP's pending retry (as the turn_end handler would).
    handlers.get("turn_end")![0](
      {
        type: "turn_end",
        turnIndex: 0,
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Error Code upstream_http2_stream_error: Upstream HTTP/2 stream failed",
          content: [],
        },
        toolResults: [],
      },
      ctx
    );

    const autoRetryEnd = handlers.get("auto_retry_end")![0];
    autoRetryEnd({ type: "auto_retry_end", success: false, attempt: 2, finalError: "stream failed" }, ctx);

    await Bun.sleep(1400);

    expect(sentCustomMessages).toHaveLength(1);
    expect(sentCustomMessages[0]?.options).toEqual({ deliverAs: "nextTurn", triggerTurn: true });
    expect(sentCustomMessages[0]?.message.display).toBe(false);
  });

  it("cancels the fallback restart when a fresh turn starts first", async () => {
    const { api, handlers, commands, sentCustomMessages } = createMockExtensionApi();
    pvpExtension(api);
    const ctx = createMockContext();
    await commands.get("pvp").handler("on", ctx);

    handlers.get("turn_end")![0](
      {
        type: "turn_end",
        turnIndex: 0,
        message: { role: "assistant", stopReason: "error", errorMessage: "boom", content: [] },
        toolResults: [],
      },
      ctx
    );

    handlers.get("auto_retry_end")![0]({ type: "auto_retry_end", success: false, attempt: 1 }, ctx);
    handlers.get("turn_start")![0]({ type: "turn_start", turnIndex: 1, timestamp: Date.now() }, ctx);

    await Bun.sleep(1400);
    expect(sentCustomMessages).toHaveLength(0);
  });

  it("resumes a turn that failed while PVP was off when /pvp on is issued", async () => {
    const { api, handlers, commands, sentCustomMessages } = createMockExtensionApi();
    pvpExtension(api);
    const ctx = createMockContext();

    handlers.get("turn_end")![0](
      {
        type: "turn_end",
        turnIndex: 0,
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Error Code upstream_http2_stream_error: Upstream HTTP/2 stream failed",
          content: [],
        },
        toolResults: [],
      },
      ctx
    );

    await commands.get("pvp").handler("on", ctx);

    expect(sentCustomMessages).toHaveLength(1);
    expect(sentCustomMessages[0]?.message.customType).toBe("pvp-auto-retry");
    expect(sentCustomMessages[0]?.options?.triggerTurn).toBe(true);
  });
});
