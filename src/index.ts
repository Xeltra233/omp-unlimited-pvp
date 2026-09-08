import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  formatPvpStatus,
  getPvpArgumentCompletions,
  PvpController,
  PVP_STATUS_KEY,
  PVP_WIDGET_KEY,
  type PvpAgentMessage,
  type PvpCommandContext,
  type PvpImageContent,
  type PvpMode,
  type PvpUi,
  type TurnEndResult,
} from "./pvp-controller.js";
import { SettingsGuard, type SettingsLike } from "./settings-guard.js";

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
  let originalModel: Model | undefined = undefined;

  pi.registerCommand("pvp", {
    description: "Enable resident or one-success unlimited retry mode (/pvp, /pvp on, /pvp one, /pvp off)",
    getArgumentCompletions: getPvpArgumentCompletions,
    handler: async (args, ctx) => {
      controller.handleCommand(args, ctx);
    },
  });

  // Track the most recent user prompt and any attached images, and capture the active model
  pi.on("before_agent_start", (event, ctx) => {
    controller.recordPrompt(event.prompt, event.images, ctx.ui);
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

  // Observe turn results: error triggers pending retry; success resets or closes
  pi.on("turn_end", (event, ctx) => {
    controller.handleTurnEnd(event.message, ctx.ui);
  });

  // Dispatch immediate retry once the agent run has settled:
  // In OMP, agent_end is emitted when an agent finishes. If willContinue is true,
  // an internal auto-continuation was scheduled, so we wait for the terminal settle.
  const triggerRetryIfPending = (ui: PvpUi) => {
    controller.scheduleRetry((prompt, images) => {
      try {
        if (images && images.length > 0) {
          pi.sendUserMessage(
            [{ type: "text", text: prompt }, ...images],
            { deliverAs: "followUp" }
          );
        } else {
          pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        }
      } catch {
        // Guard against unexpected send failures
      }
    }, ui);
  };

  pi.on("agent_end", (event, ctx) => {
    if (event.willContinue) {
      return;
    }
    triggerRetryIfPending(ctx.ui);
  });

  // Backward compatibility with runtimes or Pi forks that emit agent_settled
  try {
    (pi as any).on?.("agent_settled", (_event: any, ctx: ExtensionContext) => {
      triggerRetryIfPending(ctx.ui);
    });
  } catch {
    // Ignore if agent_settled is unsupported
  }

  // Ensure clean teardown when session shuts down
  pi.on("session_shutdown", (_event, ctx) => {
    controller.cleanup(ctx.ui);
    originalModel = undefined;
  });
}

export {
  formatPvpStatus,
  getPvpArgumentCompletions,
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
