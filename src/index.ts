import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  formatPvpStatus,
  getPvpArgumentCompletions,
  isPvpNonRetryableMessage,
  installPvpRetryHook,
  PvpController,
  PVP_RETRY_MESSAGE_TYPE,
  PVP_STATUS_KEY,
  PVP_WAKE_GUARD_CHANNEL,
  PVP_WIDGET_KEY,
  SettingsGuard,
  type PvpAgentMessage,
  type PvpCommandContext,
  type PvpImageContent,
  type PvpMode,
  type PvpUi,
  type SettingsLike,
  type TurnEndResult,
} from "./pvp-controller.js";

/**
 * How long PVP waits after OMP reports a terminated retry saga before restarting
 * the turn itself. A native retry (or the `session_stop` continuation) starts a
 * new turn well within this window and cancels the timer.
 */
const PVP_RESUME_FALLBACK_DELAY_MS = 1200;

const PVP_RESUME_CONTENT = "<pvp-auto-retry>上一条请求失败，继续完成被打断的任务。</pvp-auto-retry>";

/** Narrow a captured live session to the `setModel` surface the cancel path wraps. */
function isModelSwitchable(session: object): session is { setModel: (...args: unknown[]) => unknown } {
  return "setModel" in session && typeof (session as { setModel?: unknown }).setModel === "function";
}

/**
 * OMP Unlimited PVP Extension.
 *
 * Provides unlimited automatic retry mode for OMP (Oh My Pi) without cooldown,
 * without default retry count limits, and without triggering OMP's model fallback mode:
 * - `/pvp` or `/pvp on`: enables resident (persistent) PVP mode.
 * - `/pvp <n>`: enables limited PVP mode (automatically turns off after n successful turns).
 * - `/pvp off`: turns off PVP mode, clears status/widgets, and restores OMP settings.
 */
export default function pvpExtension(pi: ExtensionAPI): void {
  const guard = new SettingsGuard();
  const controller = new PvpController(guard);
  const bus = pi.events;
  // The bundled CLI's live SDK namespace. `pi.pi.AgentSession` is the class the
  // host actually instantiates; the one this module imports is a second copy.
  const liveSdk = pi.pi as { AgentSession?: unknown } | undefined;
  let boundSettingsScope: unknown = undefined;
  // One wrap per live session: stacking would abort the gate several times and
  // leak a wrapper per prompt.
  // Kept in a plain list: teardown must restore wrappers even though WeakMap
  // itself is not iterable.
  const setModelWraps: Array<{ session: object; orig: (...a: unknown[]) => unknown; wrapped: (...a: unknown[]) => unknown }> = [];
  const uninstallHook = installPvpRetryHook(controller, {
    emitRetryGate:
      bus && typeof bus.emit === "function"
        ? request => bus.emit(PVP_WAKE_GUARD_CHANNEL, request)
        : undefined,
    sdk: liveSdk,
    // Bind the *real* session settings scope once a live prompt reveals it.
    // The namespace-level `settings` is a different instance in the bundled CLI.
    onSession: session => {
      if (!session || typeof session !== "object" || !("settings" in session)) return;
      const sessionSettings = session.settings;
      if (sessionSettings !== undefined && sessionSettings !== boundSettingsScope) {
        boundSettingsScope = sessionSettings;
        guard.prepare(sessionSettings);
        if (controller.enabled) guard.applyAntiFallbackOverrides();
      }
      // A model switch must invalidate a parked gate: the wait belonged to the
      // old endpoint, and its late resume must never restart the new model's run.
      if (isModelSwitchable(session) && !setModelWraps.some(w => w.session === session)) {
        const origSetModel = session.setModel;
        const wrapped: (...args: unknown[]) => unknown = function (this: unknown, ...args: unknown[]) {
          controller.abortRetryWaits();
          settledError = undefined;
          return origSetModel.apply(this, args);
        };
        session.setModel = wrapped;
        setModelWraps.push({ session, orig: origSetModel, wrapped });
      }
    },
  });
  let originalModel: Model | undefined = undefined;
  // Last settled provider error, tracked even while PVP is off so enabling can resume it.
  let settledError: string | undefined = undefined;

  pi.registerCommand("pvp", {
    description: "Enable resident retry mode (/pvp, /pvp on) or auto-off after n successes (/pvp <n>); disable with /pvp off",
    getArgumentCompletions: getPvpArgumentCompletions,
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      const enabling = command === "" || command === "on" || /^\d+$/.test(command);
      // A turn that failed while PVP was off stays settled; remember it so enabling
      // can resume it instead of waiting for the user to send another message.
      const resumeSettledError = enabling ? settledError : undefined;
      if (enabling) {
        // PVP never refuses to enable: the session_stop continuation restarts a failed
        // turn on its own, so retry tuning is a speed-up, not a prerequisite.
        await uninstallHook.ready;
        // No live session has been captured yet on a cold enable: the settings
        // instance only appears with a prompt, so defer quietly and let
        // onSession apply the overrides then. Only a bound-but-failed write is
        // a real problem worth surfacing.
        if (guard.hasScope) {
          const overridesActive = guard.applyAntiFallbackOverrides();
          if (!overridesActive) {
            const overrideFailure = guard.prepareError ?? guard.overrideError ?? "设置覆盖被拒绝";
            ctx.ui.notify(`PVP: OMP 重试参数不可覆写（${overrideFailure}），续跑由插件兜底。`, "warning");
          }
        }
      }
      controller.handleCommand(args, ctx);
      if (resumeSettledError !== undefined && controller.enabled) {
        settledError = undefined;
        await restartSettledTurn(ctx.ui, resumeSettledError, true);
      }
    },
  });

  // When OMP settles a failed turn as terminal (its own retry budget exhausted, or
  // its hard-error fallback path finished first) the user would see
  // "✘ Retry failed after N attempts ... Dismissed when you send your next message".
  // PVP restarts that turn itself so a provider failure never becomes terminal.
  let resumeFallbackTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  const clearResumeFallback = () => {
    if (resumeFallbackTimer !== undefined) {
      clearTimeout(resumeFallbackTimer);
      resumeFallbackTimer = undefined;
    }
  };

  const restartSettledTurn = async (ui?: PvpUi, error?: string, force: boolean = false): Promise<boolean> => {
    if (!controller.enabled) return false;
    if (!controller.consumePendingRetry() && !force) return false;
    if (typeof pi.sendMessage !== "function") return false;
    const proceed = await controller.awaitRetryGate(undefined, error ?? "Unknown error", ui);
    if (!proceed) {
      // The gate declined: keep the turn settled and drop every pending restart.
      clearResumeFallback();
      controller.cancelRetry();
      return false;
    }
    controller.recordRetryAttempt(ui, error);
    pi.sendMessage(
      { customType: PVP_RETRY_MESSAGE_TYPE, content: PVP_RESUME_CONTENT, display: false },
      { deliverAs: "nextTurn", triggerTurn: true }
    );
    return true;
  };

  const armResumeFallback = (ui?: PvpUi, error?: string) => {
    if (!controller.enabled || resumeFallbackTimer !== undefined) return;
    resumeFallbackTimer = setTimeout(() => {
      resumeFallbackTimer = undefined;
      void restartSettledTurn(ui, error);
    }, PVP_RESUME_FALLBACK_DELAY_MS);
    (resumeFallbackTimer as { unref?: () => void }).unref?.();
  };

  // Track new user prompt submission to reset retry count, and capture the active model
  pi.on("before_agent_start", (_event, ctx) => {
    clearResumeFallback();
    settledError = undefined;
    controller.handleNewPrompt(ctx.ui);
    try {
      const current = (ctx as any)?.model ?? (ctx as any)?.models?.current?.();
      if (current) {
        originalModel = current;
        controller.setRetryGateModel(current);
      }
    } catch {
      // Ignore if model access fails
    }
  });

  // Primary guarantee: OMP reaches its stop tail with a pinned error, so hand it a
  // native continuation. `decision: "block"` bypasses OMP's 8-continuation cap,
  // which keeps PVP's retry truly unlimited.
  pi.on("session_stop", async (event, ctx) => {
    clearResumeFallback();
    const continuation = await controller.handleSessionStop(
      event.last_assistant_message as PvpAgentMessage,
      ctx.ui
    );
    if (!continuation) return undefined;
    return { decision: "block" as const, reason: continuation.reason };
  });

  // Secondary net: a terminal `auto_retry_end` means OMP's retry saga is over. If
  // no continuation started a fresh turn shortly after, restart the turn ourselves.
  pi.on("auto_retry_end", (event, ctx) => {
    if (event.success !== false) {
      clearResumeFallback();
      return;
    }
    armResumeFallback(ctx.ui, typeof event.finalError === "string" ? event.finalError : undefined);
  });

  // Any new turn invalidates a pending fallback restart.
  pi.on("turn_start", () => {
    clearResumeFallback();
  });

  // A session switch/branch/tree walk or shutdown must end a parked gate so a
  // late wake-guard resume can never restart the run the user already left.
  // OMP has no `model_select` event; `before_agent_start` below already aborts
  // parked waits on every new prompt, including after a model switch.
  pi.on("session_before_switch", () => {
    clearResumeFallback();
    controller.abortRetryWaits();
    settledError = undefined;
  });

  pi.on("session_before_branch", () => {
    clearResumeFallback();
    controller.abortRetryWaits();
    settledError = undefined;
  });

  pi.on("session_before_tree", () => {
    clearResumeFallback();
    controller.abortRetryWaits();
    settledError = undefined;
  });

  // Anti-Fallback safety net: if OMP emits retry_fallback_applied while PVP is enabled,
  // immediately restore the session to the original model.
  pi.on("retry_fallback_applied", async (event, ctx) => {
    if (controller.enabled && originalModel) {
      try {
        ctx.ui.notify(
          `PVP: 检测到模型 Fallback (${event.from} -> ${event.to})，已强制拦截并还原为原始模型`,
          "warning"
        );
        await pi.setModel(originalModel);
      } catch {
        // Fallback restoration failure guarded
      }
    }
  });

  // Observe turn results: success resets/closes mode; abort cancels
  pi.on("turn_end", (event, ctx) => {
    const message = event.message as PvpAgentMessage;
    controller.handleTurnEnd(message, ctx.ui);
    const failed =
      message?.role === "assistant" &&
      "stopReason" in message &&
      message.stopReason === "error" &&
      !isPvpNonRetryableMessage(message);
    settledError = failed
      ? "errorMessage" in message && typeof message.errorMessage === "string" && message.errorMessage.length > 0
        ? message.errorMessage
        : "Unknown error"
      : undefined;
  });

  // Ensure clean teardown when session shuts down
  pi.on("session_shutdown", (_event, ctx) => {
    clearResumeFallback();
    uninstallHook();
    for (const { session, orig, wrapped } of setModelWraps.splice(0)) {
      if ("setModel" in session && session.setModel === wrapped) {
        (session as { setModel: unknown }).setModel = orig;
      }
    }
    controller.cleanup(ctx.ui);
    originalModel = undefined;
  });
}

export {
  formatPvpStatus,
  getPvpArgumentCompletions,
  installPvpRetryHook,
  PvpController,
  PVP_STATUS_KEY,
  PVP_WIDGET_KEY,
  SettingsGuard,
};
export type {
  PvpAgentMessage,
  PvpCommandContext,
  PvpImageContent,
  PvpMode,
  PvpUi,
  SettingsLike,
  TurnEndResult,
};
