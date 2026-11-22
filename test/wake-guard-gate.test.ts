import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import pvpExtension from "../src/index.js";
import {
  installPvpRetryHook,
  PvpController,
  PVP_WAKE_GUARD_CHANNEL,
  type PvpRetryGateRequest,
} from "../src/pvp-controller.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const MODEL: Model = {
  id: "fixture",
  name: "Fixture",
  provider: "pvp-fixture",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:9/v1",
  contextWindow: 32000,
  maxTokens: 100,
  reasoning: false,
  inputPrice: 0,
  outputPrice: 0,
} as Model;

const FAILURE = {
  role: "assistant" as const,
  stopReason: "error" as const,
  errorMessage: "Upstream stream disconnected",
  content: [],
};

function createUi() {
  const notifications: Array<{ msg: string; type?: string }> = [];
  const statuses: Record<string, string | undefined> = {};
  const widgets: Record<string, { content: string[] | undefined; options?: any }> = {};
  return {
    notifications,
    statuses,
    widgets,
    setStatus: mock((key: string, value: string | undefined) => {
      statuses[key] = value;
    }),
    setWidget: mock((key: string, content: any, options?: any) => {
      let resolved: string[] | undefined;
      if (typeof content === "function") resolved = content({}, undefined)?.render?.(80);
      else resolved = content;
      widgets[key] = { content: resolved, options };
    }),
    notify: mock((msg: string, type?: "info" | "warning" | "error") => {
      notifications.push({ msg, type });
    }),
  };
}

function install(options?: Parameters<typeof installPvpRetryHook>[1]) {
  const controller = new PvpController();
  cleanups.push(installPvpRetryHook(controller, options));
  return controller;
}

/** One shared gate: whatever a listener parks, every dispatcher joins it. */
function parkable() {
  const waits: Array<{ promise: Promise<boolean>; resolve: (value: boolean) => void; signal: AbortSignal }> = [];
  return {
    waits,
    emit: (request: PvpRetryGateRequest) => {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      waits.push({ promise, resolve, signal: request.signal });
      request.wait = promise;
    },
  };
}

describe("OMP wake-guard retry gate", () => {
  it("keeps the pre-gate behaviour when no emitter is injected", async () => {
    const controller = install();
    const ui = createUi();
    controller.handleCommand("on", { ui });

    const continuation = await controller.handleSessionStop(FAILURE as any, ui as any);
    expect(continuation?.reason).toContain("pvp-auto-retry");
    expect(controller.currentAttempt).toBe(1);
  });

  it("keeps the native retry when a listener does not attach a wait", async () => {
    const emit = mock((_request: PvpRetryGateRequest) => {});
    const controller = install({ emitRetryGate: emit });
    const ui = createUi();
    controller.handleCommand("on", { ui });

    expect(await controller.handleSessionStop(FAILURE as any, ui as any)).toBeDefined();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(controller.currentAttempt).toBe(1);
    expect(controller.isAwaitingRetryWait).toBe(false);
  });

  it("parks without counting, then resumes the same failure on true", async () => {
    const gate = parkable();
    const controller = install({ emitRetryGate: gate.emit });
    const ui = createUi();
    controller.handleCommand("on", { ui });

    const pending = controller.handleSessionStop(FAILURE as any, ui as any);
    expect(controller.isAwaitingRetryWait).toBe(true);
    expect(controller.currentAttempt).toBe(0);
    expect(gate.waits).toHaveLength(1);

    gate.waits[0]!.resolve(true);
    expect((await pending)?.reason).toContain("pvp-auto-retry");
    expect(controller.currentAttempt).toBe(1);
    expect(controller.isAwaitingRetryWait).toBe(false);
  });

  it("cancels only this run on false and keeps mode/counters intact", async () => {
    const controller = install({ emitRetryGate: (request) => { request.wait = Promise.resolve(false); } });
    const ui = createUi();
    controller.handleCommand("2", { ui });
    controller.handleSuccess(ui as any);
    expect(controller.currentSuccessCount).toBe(1);

    expect(await controller.handleSessionStop(FAILURE as any, ui as any)).toBeUndefined();
    expect(controller.currentAttempt).toBe(0);
    expect(controller.currentMode).toBe("limited");
    expect(controller.currentSuccessCount).toBe(1);
    expect(controller.consumePendingRetry()).toBe(false);
  });

  it("treats a rejected wait as 'do not retry' and leaks no probe details", async () => {
    const ui = createUi();
    const controller = install({
      emitRetryGate: (request) => { request.wait = Promise.reject(new Error("secret-token-abc")); },
    });
    controller.handleCommand("on", { ui });

    // A rejected wait must cancel this run, not crash it and not restart it.
    expect(await controller.handleSessionStop(FAILURE as any, ui as any)).toBeUndefined();
    expect(controller.currentAttempt).toBe(0);
    expect(controller.isAwaitingRetryWait).toBe(false);
    // Whatever the listener rejected with stays out of everything the user sees.
    expect(JSON.stringify(ui.notifications)).not.toContain("secret-token-abc");
    expect(JSON.stringify(ui.widgets)).not.toContain("secret-token-abc");
    expect(JSON.stringify(ui.statuses)).not.toContain("secret-token-abc");
  });

  it("shares exactly one wait per failing message across dispatchers", async () => {
    const gate = parkable();
    const controller = install({ emitRetryGate: gate.emit });
    const ui = createUi();
    controller.handleCommand("on", { ui });

    const first = controller.handleSessionStop(FAILURE as any, ui as any);
    const second = controller.awaitRetryGate(FAILURE as any, FAILURE.errorMessage, ui as any);
    expect(gate.waits).toHaveLength(1);

    gate.waits[0]!.resolve(true);
    expect(await first).toBeDefined();
    expect(await second).toBe(true);
    // One probe, one wait, one recorded attempt: the second dispatcher joined
    // the parked wait instead of emitting a second request.
    expect(controller.currentAttempt).toBe(1);

    // A late dispatcher for this same failure must not open a fresh gate.
    expect(await controller.awaitRetryGate(FAILURE, FAILURE.errorMessage, ui)).toBe(true);
    expect(gate.waits).toHaveLength(1);
  });

  it("shares one wait between a message-keyed and an error-only dispatcher", async () => {
    const gate = parkable();
    const controller = install({ emitRetryGate: gate.emit });
    const ui = createUi();
    controller.handleCommand("on", { ui });

    const parked = controller.handleSessionStop(FAILURE as any, ui as any);
    // The settled-turn restart only knows the error text, never the message object.
    const fallback = controller.awaitRetryGate(undefined, FAILURE.errorMessage, ui as any);
    expect(gate.waits).toHaveLength(1);

    gate.waits[0]!.resolve(false);
    expect(await parked).toBeUndefined();
    expect(await fallback).toBe(false);
    expect(controller.currentAttempt).toBe(0);
  });

  it("never revives a cancelled gate after /pvp off and a late resume", async () => {
    const gate = parkable();
    const controller = install({ emitRetryGate: gate.emit });
    const ui = createUi();
    controller.handleCommand("on", { ui });

    const pending = controller.handleSessionStop(FAILURE as any, ui as any);
    expect(controller.isAwaitingRetryWait).toBe(true);

    controller.disable(ui as any);
    expect(gate.waits[0]!.signal.aborted).toBe(true);
    gate.waits[0]!.resolve(true);
    expect(await pending).toBeUndefined();
    expect(controller.currentMode).toBe("off");
    expect(controller.currentAttempt).toBe(0);
  });

  it("never revives after the extension teardown sequence runs", async () => {
    const gate = parkable();
    const controller = install({ emitRetryGate: gate.emit });
    const ui = createUi();
    controller.handleCommand("on", { ui });

    const pending = controller.handleSessionStop(FAILURE as any, ui as any);
    expect(controller.isAwaitingRetryWait).toBe(true);

    // Controller-level teardown only. A real OMP shutdown/reload is proven by
    // the SDK + HTTP smoke run against a live session, not here.
    controller.cleanup(ui as any);
    gate.waits[0]!.resolve(true);
    expect(await pending).toBeUndefined();
    expect(controller.currentAttempt).toBe(0);
    expect(controller.currentMode).toBe("off");
  });

  it("cancels a parked gate when a new prompt starts", async () => {
    const gate = parkable();
    const controller = install({ emitRetryGate: gate.emit });
    const ui = createUi();
    controller.handleCommand("on", { ui });

    const pending = controller.handleSessionStop(FAILURE as any, ui as any);
    controller.handleNewPrompt(ui as any);
    gate.waits[0]!.resolve(true);
    expect(await pending).toBeUndefined();
    expect(controller.currentAttempt).toBe(0);
  });

  it("ends a parked gate when the real retry signal aborts (session.abort)", async () => {
    const gate = parkable();
    const controller = install({ emitRetryGate: gate.emit });
    const ui = createUi();
    controller.handleCommand("on", { ui });

    // This is exactly the signal `_prepareRetry` hands over: the session's own
    // retry abort controller, aborted by user cancel.
    const sessionAbort = new AbortController();
    const proceed = controller.awaitRetryGate(FAILURE as any, FAILURE.errorMessage, ui, sessionAbort.signal);
    expect(gate.waits).toHaveLength(1);
    expect(controller.isAwaitingRetryWait).toBe(true);

    sessionAbort.abort();
    expect(gate.waits[0]!.signal.aborted).toBe(true);
    expect(await proceed).toBe(false);
    expect(controller.isAwaitingRetryWait).toBe(false);

    // A listener that wakes late must not restart the run the user cancelled.
    gate.waits[0]!.resolve(true);
    await Bun.sleep(10);
    expect(controller.currentAttempt).toBe(0);
    expect(controller.currentMode).toBe("persistent");
  });

  it("re-gates a new failure with the same error text after recovery", async () => {
    const gate = parkable();
    const controller = install({ emitRetryGate: gate.emit });
    const ui = createUi();
    controller.handleCommand("on", { ui });

    // In-process failed-turn fixture; this seam consumes its error fields only.
    const failedTurn = FAILURE as NonNullable<Parameters<PvpController["handleSessionStop"]>[0]>;
    const first = controller.handleSessionStop(failedTurn, ui);
    gate.waits[0]!.resolve(true);
    expect(await first).toBeDefined();
    expect(controller.currentAttempt).toBe(1);

    const second = controller.handleSessionStop({ ...failedTurn }, ui);
    expect(gate.waits).toHaveLength(2);
    expect(controller.currentAttempt).toBe(1);
    expect(controller.isAwaitingRetryWait).toBe(true);

    gate.waits[1]!.resolve(true);
    expect(await second).toBeDefined();
    expect(controller.currentAttempt).toBe(2);
    expect(controller.isAwaitingRetryWait).toBe(false);
  });

  it("keeps a newer active gate when an older same-error gate settles", async () => {
    const gate = parkable();
    const controller = install({ emitRetryGate: gate.emit });
    const ui = createUi();
    controller.handleCommand("on", { ui });

    const old = controller.awaitRetryGate(FAILURE, FAILURE.errorMessage, ui);
    const replacement = controller.awaitRetryGate({ ...FAILURE }, FAILURE.errorMessage, ui, undefined, true);
    gate.waits[0]!.resolve(true);
    expect(await old).toBe(true);

    const fallback = controller.awaitRetryGate(undefined, FAILURE.errorMessage, ui);
    expect(gate.waits).toHaveLength(2);
    expect(controller.isAwaitingRetryWait).toBe(true);
    gate.waits[1]!.resolve(false);
    expect(await replacement).toBe(false);
    expect(await fallback).toBe(false);
    expect(controller.isAwaitingRetryWait).toBe(false);
  });

  it("re-gates the same message after a cancelled epoch", async () => {
    const gate = parkable();
    const controller = install({ emitRetryGate: gate.emit });
    const ui = createUi();
    controller.handleCommand("on", { ui });

    const parked = controller.handleSessionStop(FAILURE as any, ui as any);
    controller.handleNewPrompt(ui as any);
    gate.waits[0]!.resolve(true);
    expect(await parked).toBeUndefined();

    // Same object, same error text, new epoch: the stale wait must not be reused.
    const again = controller.handleSessionStop(FAILURE as any, ui as any);
    expect(gate.waits).toHaveLength(2);
    gate.waits[1]!.resolve(true);
    expect(await again).toBeDefined();
    expect(controller.currentAttempt).toBe(1);
  });
});

describe("OMP index wiring for the wake guard", () => {
  function createHarness() {
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    const commands = new Map<string, any>();
    const sentCustomMessages: Array<{ message: any; options?: any }> = [];
    let listener: ((request: PvpRetryGateRequest) => void) | undefined;
    // The host bus adapter is the only place that knows the channel name.
    const emit = mock((channel: string, request: PvpRetryGateRequest) => {
      if (channel !== PVP_WAKE_GUARD_CHANNEL) throw new Error(`unexpected channel ${channel}`);
      listener?.(request);
    });
    const api = {
      on(event: string, handler: (event: any, ctx: any) => any) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerCommand(name: string, definition: any) {
        commands.set(name, definition);
      },
      sendMessage(message: any, options?: any) {
        sentCustomMessages.push({ message, options });
      },
      setModel: mock(async () => true),
      events: { emit },
    } as unknown as ExtensionAPI;
    pvpExtension(api);
    cleanups.push(() => handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, { ui: createUi() }));
    return {
      handlers,
      commands,
      emit,
      sentCustomMessages,
      listen(next: (request: PvpRetryGateRequest) => void) {
        listener = next;
      },
    };
  }

  /** Context shaped like the real one: settings overrides are unnecessary for gate tests. */
  function context(model: Model = MODEL): ExtensionContext {
    const ui = createUi();
    return { ...({ ui, model, models: { current: () => model } } as any), ui } as ExtensionContext;
  }

  it("parks the real session_stop continuation and drops it on deny", async () => {
    const harness = createHarness();
    const ctx = context();
    await harness.commands.get("pvp").handler("on", ctx);
    harness.listen((request) => { request.wait = Promise.resolve(false); });

    const result = await harness.handlers.get("session_stop")![0]!(
      { type: "session_stop", last_assistant_message: FAILURE },
      ctx
    );
    expect(harness.emit).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
    expect(harness.sentCustomMessages).toHaveLength(0);
  });

  it("cancels a parked gate on session switch, branch and tree walk", async () => {
    for (const event of ["session_before_switch", "session_before_branch", "session_before_tree"]) {
      const harness = createHarness();
      const ctx = context();
      await harness.commands.get("pvp").handler("on", ctx);
      const gate = parkable();
      harness.listen(gate.emit);

      const pending = harness.handlers.get("session_stop")![0]!(
        { type: "session_stop", last_assistant_message: FAILURE },
        ctx
      );
      expect(gate.waits).toHaveLength(1);

      harness.handlers.get(event)![0]!({}, ctx);
      gate.waits[0]!.resolve(true);
      expect(await pending).toBeUndefined();
      expect(harness.sentCustomMessages).toHaveLength(0);
    }
  });

  it("keeps the settled-turn fallback behind the same gate", async () => {
    const harness = createHarness();
    const ctx = context();
    await harness.commands.get("pvp").handler("on", ctx);

    // A turn that already failed while PVP was on leaves a pending retry behind.
    harness.handlers.get("turn_end")![0]!({ type: "turn_end", message: FAILURE, toolResults: [] }, ctx);

    const gate = parkable();
    harness.listen(gate.emit);
    harness.handlers.get("auto_retry_end")![0]!({ type: "auto_retry_end", success: false, attempt: 2 }, ctx);

    // The fallback is armed on a timer; let it fire so the gate is actually reached.
    await Bun.sleep(1400);
    expect(gate.waits).toHaveLength(1);

    gate.waits[0]!.resolve(false);
    await Bun.sleep(50);
    expect(harness.sentCustomMessages).toHaveLength(0);
    expect(harness.emit).toHaveBeenCalledTimes(1);
  });
});
