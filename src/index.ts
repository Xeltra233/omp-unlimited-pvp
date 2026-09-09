import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  formatPvpStatus,
  getPvpArgumentCompletions,
  installPvpRetryHook,
  PvpController,
  PVP_STATUS_KEY,
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
 * OMP Unlimited PVP Extension.
 *
 * Provides unlimited automatic retry mode for OMP (Oh My Pi) without cooldown,
 * without default retry count limits, and without triggering OMP's model fallback mode:
 * - `/pvp` or `/pvp on`: enables resident (persistent) PVP mode.
 * - `/pvp one`: enables one-success PVP mode (automatically turns off upon success).
 * - `/pvp off`: turns off PVP mode, clears status/widgets, and restores OMP settings.
 */
export default function pvpExtension(pi: ExtensionAPI): void {
  const controller = new PvpController();
  const uninstallHook = installPvpRetryHook(controller);
  let originalModel: Model | undefined = undefined;

  pi.registerCommand("pvp", {
    description: "Enable resident or one-success unlimited retry mode (/pvp, /pvp on, /pvp one, /pvp off)",
    getArgumentCompletions: getPvpArgumentCompletions,
    handler: async (args, ctx) => {
      controller.handleCommand(args, ctx);
    },
  });

  // Track new user prompt submission to reset retry count, and capture the active model
  pi.on("before_agent_start", (_event, ctx) => {
    controller.handleNewPrompt(ctx.ui);
    try {
      const current = (ctx as any)?.model ?? (ctx as any)?.models?.current?.();
      if (current) {
        originalModel = current;
      }
    } catch {
      // Ignore if model access fails
    }
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
    controller.handleTurnEnd(event.message, ctx.ui);
  });

  // Ensure clean teardown when session shuts down
  pi.on("session_shutdown", (_event, ctx) => {
    uninstallHook();
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
