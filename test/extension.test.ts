import { describe, expect, it, mock } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import pvpExtension, { PVP_STATUS_KEY, PVP_WIDGET_KEY } from "../src/index.js";

type EventHandler = (event: any, ctx: ExtensionContext) => any;

function createMockExtensionApi(): {
  api: ExtensionAPI;
  handlers: Map<string, EventHandler[]>;
  commands: Map<string, any>;
  sentMessages: Array<{ content: any; options?: any }>;
  currentModel: Model | undefined;
  setModelMock: ReturnType<typeof mock>;
} {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, any>();
  const sentMessages: Array<{ content: any; options?: any }> = [];
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
    setModel: setModelMock as any,
  };

  return {
    api: api as ExtensionAPI,
    handlers,
    commands,
    sentMessages,
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
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: mock(() => {}),
    hasPendingMessages: () => false,
    shutdown: mock(() => {}),
    getContextUsage: () => undefined,
    compact: mock(async () => {}),
    getSystemPrompt: () => [],
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
    expect(handlers.has("agent_end")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });

  it("simulates full persistent retry flow: prompt -> failure -> retry -> failure -> retry -> success -> remains enabled", async () => {
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

    // 1. User enters /pvp
    const pvpCmd = commands.get("pvp");
    await pvpCmd.handler("", ctx);
    expect(ctx.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
    expect(ctx.widgets[PVP_WIDGET_KEY]?.options).toEqual({ placement: "belowEditor" });
    expect(ctx.notifications[0]?.msg).toBe("PVP ON");

    // 2. User submits prompt
    const beforeAgentStart = handlers.get("before_agent_start")![0];
    beforeAgentStart({ type: "before_agent_start", prompt: "Build a feature", systemPrompt: [] }, ctx);

    // 3. Turn 1 fails
    const turnEnd = handlers.get("turn_end")![0];
    const agentEnd = handlers.get("agent_end")![0];

    const errorMsg = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "HTTP 500 Server Error",
    };

    turnEnd({ type: "turn_end", turnIndex: 0, message: errorMsg, toolResults: [] }, ctx);

    // Agent run ends in OMP with willContinue: false -> schedules immediate retry
    agentEnd({ type: "agent_end", messages: [], willContinue: false }, ctx);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content).toBe("Build a feature");
    expect(sentMessages[0].options?.deliverAs).toBe("followUp");

    // 4. Turn 2 fails again (infinite retry)
    turnEnd({ type: "turn_end", turnIndex: 1, message: errorMsg, toolResults: [] }, ctx);
    agentEnd({ type: "agent_end", messages: [], willContinue: false }, ctx);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1].content).toBe("Build a feature");

    // 5. Turn 3 succeeds
    const successMsg = {
      role: "assistant",
      content: [{ type: "text", text: "Done!" }],
      stopReason: "stop",
    };
    turnEnd({ type: "turn_end", turnIndex: 2, message: successMsg, toolResults: [] }, ctx);

    // Persistent mode keeps status bar and widget active
    // Persistent mode keeps widget active and avoids duplicate statusLine render in OMP
    expect(ctx.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
  });

  it("simulates /pvp one flow: failure -> retry -> success -> automatically closes", async () => {
    const { api, handlers, commands, sentMessages } = createMockExtensionApi();
    pvpExtension(api);
    const ctx = createMockContext();

    // 1. User enters /pvp one
    const pvpCmd = commands.get("pvp");
    await pvpCmd.handler("one", ctx);
    expect(ctx.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp one"]);
    expect(ctx.widgets[PVP_WIDGET_KEY]?.options).toEqual({ placement: "belowEditor" });
    expect(ctx.notifications[0]?.msg).toBe("PVP ONE");

    // 2. User submits prompt
    const beforeAgentStart = handlers.get("before_agent_start")![0];
    beforeAgentStart({ type: "before_agent_start", prompt: "One shot prompt", systemPrompt: [] }, ctx);

    // 3. Turn fails
    const turnEnd = handlers.get("turn_end")![0];
    const agentEnd = handlers.get("agent_end")![0];

    const errorMsg = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Network timeout",
    };

    turnEnd({ type: "turn_end", turnIndex: 0, message: errorMsg, toolResults: [] }, ctx);
    agentEnd({ type: "agent_end", messages: [], willContinue: false }, ctx);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sentMessages).toHaveLength(1);
    expect(ctx.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp one (第 1 次重试)"]);

    // 4. Retry turn succeeds
    const successMsg = {
      role: "assistant",
      content: [{ type: "text", text: "Success" }],
      stopReason: "stop",
    };
    turnEnd({ type: "turn_end", turnIndex: 1, message: successMsg, toolResults: [] }, ctx);

    // Status bar and widget must be cleared automatically
    expect(ctx.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toBeUndefined();
    expect(ctx.notifications.some((n) => n.msg === "PVP OFF")).toBe(true);
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

  it("does not trigger retry when agent_end has willContinue: true", async () => {
    const { api, handlers, commands, sentMessages } = createMockExtensionApi();
    pvpExtension(api);
    const ctx = createMockContext();

    const pvpCmd = commands.get("pvp");
    await pvpCmd.handler("on", ctx);

    const beforeAgentStart = handlers.get("before_agent_start")![0];
    beforeAgentStart({ type: "before_agent_start", prompt: "Continuing turn", systemPrompt: [] }, ctx);

    const turnEnd = handlers.get("turn_end")![0];
    const agentEnd = handlers.get("agent_end")![0];

    const errorMsg = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Transient error",
    };

    turnEnd({ type: "turn_end", turnIndex: 0, message: errorMsg, toolResults: [] }, ctx);

    // agent_end with willContinue: true should NOT schedule retry
    agentEnd({ type: "agent_end", messages: [], willContinue: true }, ctx);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sentMessages).toHaveLength(0);
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
});
