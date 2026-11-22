import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
  AgentSession,
  type BeforeAgentStartEvent,
  type ExtensionCommandContext,
  type ExtensionUIContext,
  type TurnEndEvent,
} from "@oh-my-pi/pi-coding-agent";
import { SettingsGuard, type SettingsLike } from "./settings-guard.js";
export { SettingsGuard, type SettingsLike };

export const PVP_STATUS_KEY = "omp-unlimited-pvp";
export const PVP_WIDGET_KEY = "omp-unlimited-pvp";
export type PvpMode = "off" | "persistent" | "limited";

export type PvpAgentMessage = TurnEndEvent["message"];
export type PvpImageContent = ImageContent;

export type PvpUi = Pick<ExtensionUIContext, "notify" | "setStatus"> & {
  setWidget?: ExtensionUIContext["setWidget"];
  theme?: ExtensionUIContext["theme"];
};
export type PvpCommandContext = Pick<ExtensionCommandContext, "ui">;

const COMMAND_MODES = ["on", "off"] as const;

/** Custom message type used when PVP has to restart a turn the host already settled. */
export const PVP_RETRY_MESSAGE_TYPE = "pvp-auto-retry";

const PVP_CONTINUATION_TAG = "<pvp-auto-retry>";

/**
 * Event-bus channel the optional wake guard (`omp-wakeguard`) listens on to take
 * over retry pacing. Emitted synchronously before every PVP retry attempt.
 */
export const PVP_WAKE_GUARD_CHANNEL = "omp-wakeguard:before-retry:v1";

const PVP_GATE_REJECTED_NOTICE = "PVP: 看门狗探测失败，本次不重试";

/** Model facts handed to the wake guard so it can probe the exact failing endpoint. */
export interface PvpRetryGateModel {
  provider: string;
  id: string;
  api: string;
  baseUrl: string;
}

/**
 * Retry gate request. A listener takes over by assigning `wait` synchronously
 * inside the emit callback; leaving it unset means "not installed" and keeps
 * PVP's pre-gate behaviour byte for byte.
 *
 * - `wait` resolves `true`: continue the original retry path unchanged.
 * - `wait` resolves `false`: cancel this run only; PVP keeps its mode, its
 *   success count, and its settings overrides.
 * - `wait` rejects: treated as a probe failure with a fixed user notice.
 * - `signal` aborts when PVP cancels the retry (off/abort/model or session
 *   change/shutdown/new prompt), so a listener can stop probing.
 */
export interface PvpRetryGateRequest {
  version: 1;
  errorMessage: string;
  model?: PvpRetryGateModel;
  signal: AbortSignal;
  wait?: Promise<boolean>;
  /** Evidence from THIS failed attempt; never inherited from an earlier response. */
  status?: number;
  contentType?: string;
}

/**
 * Synchronous publisher of one gate request. The host adapter owns the channel
 * name (OMP's bus adapter binds {@link PVP_WAKE_GUARD_CHANNEL}); the controller
 * publishes the request alone so there is a single calling convention.
 */
export type PvpRetryGateEmitter = (request: PvpRetryGateRequest) => void;

/** Optional host integrations for {@link installPvpRetryHook}. */
export interface PvpRetryHookOptions {
  /** Synchronous gate publisher; omitted when the host exposes no event bus. */
  emitRetryGate?: PvpRetryGateEmitter;
  /**
   * The live SDK namespace (`pi.pi`). The bundled CLI builds its own copy of
   * `AgentSession`, so the class this module imports is *not* the one running.
   * Only patch the class the host actually instantiates.
   */
  sdk?: { AgentSession?: unknown };
  /**
   * Called with the real session and agent captured from a live prompt. The
   * caller binds the session's own settings scope here; the namespace-level
   * `settings` is a different instance in the bundled CLI.
   */
  onSession?: (session: unknown) => void;
}

export interface TurnEndResult {
  shouldRetry: boolean;
  success: boolean;
}

/** Continuation instruction handed to OMP's `session_stop` hook when the host gives up on a failed turn. */
export interface PvpContinuation {
  reason: string;
}

/**
 * Aborts and context overflows must keep the host's own handling: PVP never
 * retries them, so both the prototype hook and the `session_stop` continuation
 * stay out of the way.
 */
export function isPvpNonRetryableMessage(message: PvpAgentMessage | undefined): boolean {
  if (!message) return true;
  const stopReason = "stopReason" in message ? message.stopReason : undefined;
  if (stopReason === "aborted") return true;
  const raw = "errorMessage" in message ? message.errorMessage : undefined;
  const errorText = (typeof raw === "string" ? raw : "").toLowerCase();
  return (
    errorText.includes("context") &&
    (errorText.includes("overflow") || errorText.includes("too long") || errorText.includes("exceed"))
  );
}

function readErrorMessage(message: PvpAgentMessage | undefined): string {
  if (!message || !("errorMessage" in message)) return "Unknown error";
  const raw = message.errorMessage;
  return typeof raw === "string" && raw.length > 0 ? raw : "Unknown error";
}
/**
 * Format status indicator text conforming to OMP native TUI styling.
 * Uses native theme muted/dim colors, clean lowercase text ('pvp on' / 'pvp <n>'),
 * matching the exact font size, baseline, and gray tone of native status bar items.
 */
export function formatPvpStatus(
  mode: Exclude<PvpMode, "off">,
  attemptCount: number = 0,
  theme?: ExtensionUIContext["theme"],
  successTarget?: number,
  successCount: number = 0
): string {
  const label = mode === "persistent" ? "pvp on" : `pvp ${successTarget ?? 0}`;

  const fg = (color: "accent" | "warning" | "muted" | "dim", text: string): string => {
    return theme ? theme.fg(color as any, text) : text;
  };

  let status = fg("muted", label);
  if (mode === "limited" && successCount > 0) {
    status += ` ${fg("dim", `(${successCount}/${successTarget ?? 0})`)}`;
  }
  if (attemptCount > 0) {
    status += ` ${fg("dim", `(第 ${attemptCount} 次重试)`)}`;
  }
  return status;
}

/**
 * Owns the PVP state machine, zero-delay retry orchestration,
 * and OMP anti-fallback protection.
 *
 * Supported modes:
 * - "persistent": /pvp or /pvp on. Reconnects without cooldown upon failure with no limit,
 *   disables OMP model fallback, and remains enabled even after success until manually turned off.
 * - "limited": /pvp <n>. Reconnects without cooldown upon failure and automatically turns off
 *   after n successful turns (failures never consume the target), restoring OMP settings.
 * - "off": disabled, no retries, status bar hidden, original OMP settings active.
 */
export class PvpController {
  private mode: PvpMode = "off";
  private successTarget: number | undefined = undefined;
  private successCount: number = 0;
  private lastPrompt: string | undefined = undefined;
  private lastImages: PvpImageContent[] | undefined = undefined;
  private pendingRetry: boolean = false;
  private retryTimer: NodeJS.Timeout | undefined = undefined;
  private attemptCount: number = 0;
  private retryInFlight: boolean = false;
  private lastError: string | undefined = undefined;
  private settingsGuard: SettingsGuard;
  private activeUi: PvpUi | undefined = undefined;
  private retryGateEmitter: PvpRetryGateEmitter | undefined = undefined;
  /** Invalidate in-flight gates; a late `resolve(true)` must never revive a cancelled run. */
  private gateEpoch: number = 0;
  private readonly gateWaits: Set<AbortController> = new Set();
  /** One shared wait per failing message object, so every dispatcher reuses it. */
  private gateByMessage: WeakMap<object, Promise<boolean>> = new WeakMap();
  /**
   * Active waits indexed by error text, so an error-only dispatcher joins the
   * message-shaped dispatcher without reusing an earlier failure's result.
   */
  private gateByError: Map<string, Promise<boolean>> = new Map();
  private awaitingRetryWait: boolean = false;
  private gateModel: PvpRetryGateModel | undefined = undefined;
  /**
   * The last observed failure, kept as its own envelope because the host may
   * drop the error tail from the transcript before the retry path runs.
   */
  private failedEnvelope:
    | { message: object; error: string; status: number; contentType: string }
    | undefined = undefined;

  constructor(settings?: SettingsLike | SettingsGuard) {
    if (settings instanceof SettingsGuard) {
      this.settingsGuard = settings;
    } else {
      this.settingsGuard = new SettingsGuard(settings);
    }
  }

  get currentMode(): PvpMode {
    return this.mode;
  }

  /** Success target configured by /pvp <n>; undefined in persistent mode. */
  get currentSuccessTarget(): number | undefined {
    return this.successTarget;
  }

  /** Successful turns credited toward the target while in limited mode. */
  get currentSuccessCount(): number {
    return this.successCount;
  }

  get enabled(): boolean {
    return this.mode !== "off";
  }

  get isPendingRetry(): boolean {
    return this.pendingRetry;
  }

  get isRetryInFlight(): boolean {
    return this.retryInFlight;
  }

  get currentAttempt(): number {
    return this.attemptCount;
  }

  get recordedPrompt(): string | undefined {
    return this.lastPrompt;
  }

  get recordedImages(): PvpImageContent[] | undefined {
    return this.lastImages;
  }

  get hasTimer(): boolean {
    return this.retryTimer !== undefined;
  }

  get lastErrorMessage(): string | undefined {
    return this.lastError;
  }

  get isAntiFallbackApplied(): boolean {
    return this.settingsGuard.isApplied;
  }

  get lastUi(): PvpUi | undefined {
    return this.activeUi;
  }

  /** True while a retry is parked on a wake-guard gate. */
  get isAwaitingRetryWait(): boolean {
    return this.awaitingRetryWait;
  }

  /**
   * The failure the next native retry belongs to. The host may drop the error
   * tail from the transcript before `agent.continue` runs, so this envelope is
   * recorded the moment an HTTP wire attempt fails and outlives the tail.
   */
  get pendingFailureEnvelope():
    | { message: object; error: string; status: number; contentType: string }
    | undefined {
    return this.failedEnvelope;
  }

  /** Record a wire-level failure so the retry that follows it is gateable. */
  noteFailedEnvelope(
    message: object,
    error: string,
    status: number,
    contentType: string
  ): void {
    this.failedEnvelope = { message, error, status, contentType };
  }

  /** Forget the recorded failure once it has been retried or abandoned. */
  clearFailedEnvelope(): void {
    this.failedEnvelope = undefined;
  }

  /** Inject the host event bus once, at extension install time. */
  setRetryGateEmitter(emitter: PvpRetryGateEmitter | undefined): void {
    this.retryGateEmitter = emitter;
  }

  get hasRetryGateEmitter(): boolean {
    return this.retryGateEmitter !== undefined;
  }

  /**
   * Abort every parked gate and forget the cached waits.
   *
   * The epoch bump is what makes cancellation stick: a wait that settles after
   * this call can no longer resume the run it belonged to.
   */
  abortRetryWaits(): void {
    this.gateEpoch++;
    this.awaitingRetryWait = false;
    for (const controller of this.gateWaits) {
      controller.abort();
    }
    this.gateWaits.clear();
    // WeakMap entries cannot be enumerated, so the cache is replaced wholesale:
    // a stale wait must never satisfy a dispatch from the next epoch.
    this.gateByMessage = new WeakMap();
    this.gateByError.clear();
  }

  /**
   * The single retry gate shared by every dispatch path: the native
   * `agent.continue` wrapper, the request-local provider fetch wrapper, the
   * `session_stop` continuation, and the settled-turn restart fallback.
   *
   * One failing message yields exactly one `wait`; callers that only pass the
   * error text share one wait per error string. Returns `true` when PVP should
   * proceed exactly as it did before this gate existed.
   */
  awaitRetryGate(
    message?: PvpAgentMessage | object,
    error?: string,
    ui?: PvpUi,
    externalSignal?: AbortSignal,
    forceNew: boolean = false,
    evidence?: { status: number; contentType: string }
  ): Promise<boolean> {
    const emit = this.retryGateEmitter;
    if (!this.enabled) return Promise.resolve(true);
    if (!emit) return Promise.resolve(true);

    const errorText = error ?? readErrorMessage(message as PvpAgentMessage | undefined);
    const messageKey =
      message !== undefined && (typeof message === "object" || typeof message === "function")
        ? (message as object)
        : undefined;

    if (!forceNew) {
      const cached =
        (messageKey !== undefined ? this.gateByMessage.get(messageKey) : undefined) ??
        (errorText !== undefined ? this.gateByError.get(errorText) : undefined);
      if (cached !== undefined) {
        return this.trackGateWait(cached, externalSignal);
      }
    }

    const gateController = new AbortController();
    const request: PvpRetryGateRequest = {
      version: 1,
      errorMessage: errorText,
      model: this.gateModel,
      signal: gateController.signal,
      status: evidence?.status,
      contentType: evidence?.contentType,
    };
    try {
      emit(request);
    } catch {
      // A throwing listener must not break the retry path.
    }

    const wait = request.wait;
    if (wait === undefined) {
      return Promise.resolve(true);
    }

    const epoch = this.gateEpoch;
    const settled = this.trackGateWait(
      Promise.resolve(wait).then(
        value => value === true,
        failure => {
          if (epoch !== this.gateEpoch) return false;
          const targetUi = ui ?? this.activeUi;
          targetUi?.notify(PVP_GATE_REJECTED_NOTICE, "warning");
          void failure;
          return false;
        }
      ),
      externalSignal,
      gateController,
      epoch
    );

    // Index by both keys so a message-shaped dispatcher and an error-only
    // dispatcher (the settled-turn restart) share this single probe.
    if (messageKey !== undefined) {
      this.gateByMessage.set(messageKey, settled);
    }
    if (errorText !== undefined) {
      this.gateByError.set(errorText, settled);
      void settled.then(() => {
        if (this.gateByError.get(errorText) === settled) {
          this.gateByError.delete(errorText);
        }
      });
    }
    return settled;
  }

  /** Register a gate wait so cancellation aborts it and a stale epoch cannot resume. */
  private trackGateWait(
    wait: Promise<boolean>,
    externalSignal?: AbortSignal,
    gateController?: AbortController,
    epoch: number = this.gateEpoch
  ): Promise<boolean> {
    if (externalSignal?.aborted) {
      gateController?.abort();
      return Promise.resolve(false);
    }

    const ownController = gateController ?? new AbortController();
    this.gateWaits.add(ownController);
    this.awaitingRetryWait = true;

    return new Promise<boolean>(resolve => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        ownController.signal.removeEventListener("abort", onAbort);
        externalSignal?.removeEventListener("abort", onAbort);
        this.gateWaits.delete(ownController);
        if (this.gateWaits.size === 0) {
          this.awaitingRetryWait = false;
        }
        resolve(epoch === this.gateEpoch ? value : false);
      };
      const onAbort = () => {
        ownController.abort();
        finish(false);
      };
      ownController.signal.addEventListener("abort", onAbort, { once: true });
      externalSignal?.addEventListener("abort", onAbort, { once: true });
      void wait.then(finish, () => finish(false));
    });
  }

  /** Record the live model facts so gate requests name the failing endpoint. */
  setRetryGateModel(model: unknown): void {
    const candidate = model as Partial<PvpRetryGateModel> | undefined;
    if (!candidate || typeof candidate.provider !== "string" || typeof candidate.id !== "string") {
      return;
    }
    this.gateModel = {
      provider: candidate.provider,
      id: candidate.id,
      api: typeof candidate.api === "string" ? candidate.api : "",
      baseUrl: typeof candidate.baseUrl === "string" ? candidate.baseUrl : "",
    };
  }


  /** Update footer status and persistent widget docked below the editor with native styling and zero indentation. */
  updateUi(ui?: PvpUi): void {
    const targetUi = ui ?? this.activeUi;
    if (!targetUi) {
      return;
    }
    this.activeUi = targetUi;

    if (this.mode === "off") {
      targetUi.setStatus(PVP_STATUS_KEY, undefined);
      if (typeof targetUi.setWidget === "function") {
        targetUi.setWidget(PVP_WIDGET_KEY, undefined);
      }
      return;
    }

    const styledText = formatPvpStatus(
      this.mode,
      this.attemptCount,
      targetUi.theme,
      this.successTarget,
      this.successCount
    );
    if (typeof targetUi.setWidget === "function") {
      // In OMP, statusLine renders hookStatuses in statusHost directly adjacent to hookWidgetContainerBelow.
      // Calling both setStatus and setWidget causes OMP to render duplicate "pvp on" lines.
      // Therefore, prefer the native belowEditor widget and ensure statusLine hook status is cleared.
      targetUi.setStatus(PVP_STATUS_KEY, undefined);
      const mode = this.mode;
      const attemptCount = this.attemptCount;
      const successTarget = this.successTarget;
      const successCount = this.successCount;
      targetUi.setWidget(
        PVP_WIDGET_KEY,
        (_tui, theme) => ({
          render(_width: number): string[] {
            return [formatPvpStatus(mode, attemptCount, theme, successTarget, successCount)];
          },
          invalidate(): void {},
        }),
        { placement: "belowEditor" }
      );
    } else {
      targetUi.setStatus(PVP_STATUS_KEY, styledText);
    }
  }

  /** Enable persistent mode (unlimited) or limited mode (auto-off after n successful turns), with anti-fallback protection. */
  enable(mode: Exclude<PvpMode, "off">, ui?: PvpUi, successTarget?: number): void {
    this.cancelRetry();
    this.mode = mode;
    this.successTarget = mode === "limited" ? successTarget : undefined;
    this.successCount = 0;
    this.attemptCount = 0;
    this.retryInFlight = false;
    this.lastError = undefined;
    if (ui) {
      this.activeUi = ui;
    }
    this.settingsGuard.applyAntiFallbackOverrides();
    this.updateUi(ui);
  }

  /** Disable PVP, cancel pending retries, clear status/widget, and restore OMP settings. */
  disable(ui?: PvpUi): void {
    this.cancelRetry();
    this.mode = "off";
    this.successTarget = undefined;
    this.successCount = 0;
    this.lastPrompt = undefined;
    this.lastImages = undefined;
    this.attemptCount = 0;
    this.retryInFlight = false;
    this.lastError = undefined;
    if (ui) {
      this.activeUi = ui;
    }
    this.settingsGuard.clearAntiFallbackOverrides();
    this.updateUi(ui);
  }

  /** Record prompt and images submitted by the user or agent run. */
  recordPrompt(prompt: string, images?: PvpImageContent[], ui?: PvpUi): void {
    this.lastPrompt = prompt;
    this.lastImages = images && images.length > 0 ? [...images] : undefined;

    if (this.retryInFlight) {
      this.retryInFlight = false;
    } else {
      this.cancelRetry();
      const hadAttempts = this.attemptCount > 0 || this.lastError !== undefined;
      this.attemptCount = 0;
      this.lastError = undefined;
      if (hadAttempts && (ui || this.activeUi) && this.enabled) {
        this.updateUi(ui);
      }
    }
  }

  /**
   * Optional helper to mark an error message as quota exceeded if external callers request it.
   */
  handleMessageEnd(message: PvpAgentMessage): PvpAgentMessage | undefined {
    if (
      this.enabled &&
      message &&
      message.role === "assistant" &&
      "stopReason" in message &&
      message.stopReason === "error" &&
      "errorMessage" in message &&
      typeof message.errorMessage === "string" &&
      message.errorMessage.length > 0 &&
      !message.errorMessage.includes("quota exceeded")
    ) {
      return {
        ...message,
        errorMessage: `${message.errorMessage} <!-- quota exceeded -->`,
      };
    }
    return undefined;
  }

  /**
   * Record a retry attempt during native in-place retry.
   * Increments attempt counter, updates UI, and emits notification.
   */
  recordRetryAttempt(ui?: PvpUi, error?: string): number {
    if (!this.enabled) {
      return 0;
    }
    this.attemptCount++;
    if (error) {
      this.lastError = error;
    }
    if (ui) {
      this.activeUi = ui;
    }
    this.updateUi(ui);
    const targetUi = ui ?? this.activeUi;
    if (targetUi) {
      targetUi.notify(`PVP: 请求失败，正在无延迟重试 (第 ${this.attemptCount} 次)...`, "info");
    }
    return this.attemptCount;
  }

  /**
  /**
   * Handle turn completion with success.
   * Resets the retry attempt counter, credits one success in limited mode, and
   * automatically disables PVP once the configured success target is reached.
   */
  handleSuccess(ui?: PvpUi): void {
    if (!this.enabled) {
      return;
    }
    this.pendingRetry = false;
    this.attemptCount = 0;
    this.retryInFlight = false;
    this.lastError = undefined;

    if (this.mode === "limited") {
      this.successCount++;
      if (this.successTarget !== undefined && this.successCount >= this.successTarget) {
        const completed = this.successCount;
        this.disable(ui);
        const targetUi = ui ?? this.activeUi;
        targetUi?.notify(`PVP OFF (已达 ${completed} 次成功)`, "info");
        return;
      }
    }
    this.updateUi(ui);
  }

  /**
   * Handle user abort (Ctrl+C).
   * Resets retry attempt count and restores clean UI.
   */
  handleAbort(ui?: PvpUi): void {
    this.cancelRetry();
    this.attemptCount = 0;
    this.lastError = undefined;
    this.retryInFlight = false;
    if (this.enabled) {
      this.updateUi(ui);
    }
  }

  /**
   * Handle submission of a new prompt by the user.
   * Resets retry count to zero.
   */
  handleNewPrompt(ui?: PvpUi): void {
    if (ui) {
      this.activeUi = ui;
    }
    this.abortRetryWaits();
    const hadAttempts = this.attemptCount > 0 || this.lastError !== undefined;
    this.attemptCount = 0;
    this.lastError = undefined;
    if (hadAttempts && this.enabled) {
      this.updateUi(ui);
    }
  }

  /**
   * Handle turn_end event. Detects failures, successes, and aborts.
   */
  handleTurnEnd(message: PvpAgentMessage, ui?: PvpUi): TurnEndResult {
    if (!this.enabled) {
      return { shouldRetry: false, success: false };
    }

    if (!message || message.role !== "assistant") {
      return { shouldRetry: false, success: false };
    }

    const stopReason = "stopReason" in message ? message.stopReason : undefined;

    // User or system abort: cancel any retry and clean up
    if (stopReason === "aborted") {
      this.handleAbort(ui);
      return { shouldRetry: false, success: false };
    }

    // Model turn failed: flag for retry
    if (stopReason === "error") {
      this.pendingRetry = true;
      this.retryInFlight = false;
      this.lastError =
        "errorMessage" in message && typeof message.errorMessage === "string"
          ? message.errorMessage
          : "Unknown error";
      return { shouldRetry: true, success: false };
    }

    // Model turn succeeded with final answer (stop) or max length limit
    if (stopReason === "stop" || stopReason === "length") {
      this.handleSuccess(ui);
      return { shouldRetry: false, success: true };
    }

    return { shouldRetry: false, success: false };
  }

  /**
   * Schedule retry helper for manual dispatchers or unit tests.
   */
  scheduleRetry(
    sendFn: (prompt: string, images?: PvpImageContent[]) => void,
    ui?: PvpUi
  ): boolean {
    const targetUi = ui ?? this.activeUi;
    if (!this.enabled || !this.pendingRetry || this.retryTimer !== undefined) {
      return false;
    }

    if (this.lastPrompt === undefined) {
      this.pendingRetry = false;
      return false;
    }

    this.pendingRetry = false;
    this.attemptCount++;
    const currentAttempt = this.attemptCount;
    const promptToRetry = this.lastPrompt;
    const imagesToRetry = this.lastImages ? [...this.lastImages] : undefined;

    this.updateUi(targetUi);
    if (targetUi) {
      targetUi.notify(`PVP: 请求失败，正在无延迟重试 (第 ${currentAttempt} 次)...`, "info");
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.enabled) {
        return;
      }

      this.retryInFlight = true;
      try {
        sendFn(promptToRetry, imagesToRetry);
      } catch (error) {
        this.retryInFlight = false;
        throw error;
      }
    }, 0);

    return true;
  }

  /** Cancel any pending retry timer and clear the pending retry flag. */
  cancelRetry(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.pendingRetry = false;
    this.retryInFlight = false;
    this.abortRetryWaits();
  }

  /** Apply the public `/pvp [on|off|<n>]` command grammar. */
  handleCommand(args: string, ctx: PvpCommandContext): void {
    this.activeUi = ctx.ui;
    const command = args.trim().toLowerCase();

    if (command === "" || command === "on") {
      this.enable("persistent", ctx.ui);
      ctx.ui.notify("PVP ON", "info");
      return;
    }

    if (/^\d+$/.test(command)) {
      const target = Number(command);
      if (Number.isSafeInteger(target) && target >= 1) {
        this.enable("limited", ctx.ui, target);
        ctx.ui.notify(`PVP ${target}`, "info");
        return;
      }
    }

    if (command === "off") {
      this.disable(ctx.ui);
      ctx.ui.notify("PVP OFF", "info");
      return;
    }

    ctx.ui.notify("用法：/pvp、/pvp on、/pvp <n>（n 次成功后自动关闭）或 /pvp off", "warning");
  }

  /**
   * Host gave up on a failed turn and is settling the session. Returning a
   * continuation keeps PVP's unlimited-retry contract when OMP's own retry
   * saga ends before the prototype hook is consulted (hard-error fallback,
   * budget backstop, or any future bypass).
   */
  async handleSessionStop(
    message: PvpAgentMessage | undefined,
    ui?: PvpUi
  ): Promise<PvpContinuation | undefined> {
    if (!this.enabled) return undefined;
    if (!message || message.role !== "assistant") return undefined;
    const stopReason = "stopReason" in message ? message.stopReason : undefined;
    if (stopReason !== "error") return undefined;
    if (isPvpNonRetryableMessage(message)) return undefined;

    const error = readErrorMessage(message);
    const proceed = await this.awaitRetryGate(message, error, ui ?? this.activeUi);
    if (!proceed) {
      // The gate already decided this failure stays settled: drop the pending
      // retry so no other dispatcher can revive it.
      this.cancelRetry();
      return undefined;
    }
    this.pendingRetry = false;
    this.retryInFlight = false;
    this.recordRetryAttempt(ui ?? this.activeUi, error);
    return {
      reason: `${PVP_CONTINUATION_TAG} 上一次请求失败：${error}。继续完成被打断的任务，不要复述这条错误。`,
    };
  }

  /**
   * True when the last settled turn failed and PVP still owns a retry for it.
   * Clears the flag so only one dispatcher can claim the retry.
   */
  consumePendingRetry(): boolean {
    if (!this.pendingRetry) return false;
    this.pendingRetry = false;
    return true;
  }

  /** Clear state during shutdown or other terminal cleanup paths. */
  cleanup(ui?: PvpUi): void {
    this.disable(ui);
  }
}

let activeHookCleanup: (() => void) | undefined = undefined;

/** Turn a gate denial into a request abort the provider already understands. */
function deniedRetryError(): Error {
  const error = new Error("PVP: retry declined by wake guard");
  error.name = "AbortError";
  return error;
}

/**
 * Maximum bytes read from a failed response clone. The body is used only to
 * decide JSON-vs-HTML; no body text is echoed into logs or error messages, so
 * credentials that happen to sit in a payload never leave this function.
 */
const FAILURE_BODY_PREVIEW_LIMIT = 1024;
/** A stalled response body must never hold the gate hostage. */
const FAILURE_BODY_PREVIEW_TIMEOUT_MS = 300;

/**
 * Read a bounded preview from a clone of a failed Response. Cloning tees the
 * body, so the original Response stays intact for the SDK's own error parsing.
 * The read is cancelled on the current request signal and on a short deadline.
 */
async function readFailureBodyPreview(response: Response, signal?: AbortSignal): Promise<string | undefined> {
  let clone: Response;
  try {
    clone = response.clone();
  } catch {
    return undefined;
  }
  const reader = clone.body?.getReader();
  if (!reader) return undefined;

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    void reader.cancel().catch(() => undefined);
  };
  const onAbort = () => stop();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(stop, FAILURE_BODY_PREVIEW_TIMEOUT_MS);
  timer.unref?.();

  const decoder = new TextDecoder();
  let preview = "";
  try {
    while (!stopped && preview.length < FAILURE_BODY_PREVIEW_LIMIT) {
      const { value, done } = await reader.read();
      if (done || stopped) break;
      preview += decoder.decode(value, { stream: true });
    }
    if (signal?.aborted) return undefined;
    return preview.slice(0, FAILURE_BODY_PREVIEW_LIMIT);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    stop();
  }
}

/**
 * Turn a failed response into the error text carried by the gate request.
 * A JSON answer is a provider-level failure (PVP keeps retrying); a gateway
 * HTML page or an empty 5xx is an outage the optional wake guard may park.
 * Only a fixed marker is emitted for JSON - the response body itself is never
 * reproduced, so no secrets can leak through the error message.
 */
function failureEvidenceFromResponse(status: number, statusText: string, preview?: string): string {
  const base = `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
  if (preview === undefined) return base;
  const trimmed = preview.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return `${status}: {"providerError":true}`;
  }
  return base;
}

/** Live-session surface the hook needs; only shape facts are read. */
interface LiveAgent {
  continue?: (signal?: AbortSignal) => Promise<void>;
  streamFn?: StreamFnLike;
  __pvpContinueWrapped?: boolean;
  __pvpStreamWrapped?: boolean;
}

type StreamFnLike = (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;

interface LiveSession {
  agent?: LiveAgent;
  prompt?: (text: string, options?: unknown) => unknown;
  abort: (options?: { reason?: string }) => Promise<void>;
}

/**
 * Install the live retry gate.
 *
 * The bundled CLI's `pi.pi.AgentSession` is a *different* class object from the
 * one this module imports, so only the live class handed in by the host is
 * patched. Two seams cooperate:
 *
 * 1. `AgentSession.prototype.prompt` captures the real session (and its agent)
 *    the moment a turn starts.
 * 2. The captured agent's `continue` (native in-place retry) and the agent's
 *    `streamFn` are wrapped lazily. The provider performs its own transport
 *    retries *inside* one `streamFn` call — six HTTP attempts behind a single
 *    provider error — so the gate also sits in front of every HTTP wire
 *    attempt through a request-local `options.fetch` wrapper.
 */
export function installPvpRetryHook(
  controller: PvpController,
  options?: PvpRetryHookOptions
): (() => void) & { ready: Promise<void> } {
  activeHookCleanup?.();
  controller.setRetryGateEmitter(options?.emitRetryGate);

  const cleanups: Array<() => void> = [];
  let disposed = false;
  const ready: Promise<void> = Promise.resolve();
  void disposed;

  const liveSessionClass = (options?.sdk?.AgentSession as { prototype?: unknown } | undefined) ?? AgentSession;
  const sessionProto = (liveSessionClass as { prototype?: LiveSession } | undefined)?.prototype;

  if (sessionProto && typeof sessionProto.prompt === "function") {
    const origPrompt = sessionProto.prompt;

    sessionProto.prompt = function (this: LiveSession, text: string, promptOptions?: unknown): unknown {
      const agent = this.agent;
      const session = this;
      try {
        options?.onSession?.(this);
      } catch {
        // Binding the live settings scope must never break the prompt.
      }
      if (agent) {
        // Per-agent flags: re-wrapping would stack gates, and one agent outlives
        // many prompts and many native retries.
        if (!agent.__pvpContinueWrapped && typeof agent.continue === "function") {
          const origContinue = agent.continue;
          const wrappedContinue = async function (this: LiveAgent, signal?: AbortSignal) {
            const envelope = controller.pendingFailureEnvelope;
            if (!envelope) {
              return origContinue.call(this, signal);
            }
            const proceed = await controller.awaitRetryGate(
              envelope.message,
              envelope.error,
              controller.lastUi,
              signal
            );
            if (!proceed) {
              const error = deniedRetryError();
              if (signal?.aborted) throw error;
              // Native abort must start before this owned continuation ends:
              // its cancelled result must yield, not enter transport recovery.
              void session.abort({ reason: error.message });
              return origContinue.call(this, signal?.aborted ? signal : AbortSignal.abort(error));
            }
            controller.recordRetryAttempt(controller.lastUi, envelope.error);
            return origContinue.call(this, signal);
          };
          agent.continue = wrappedContinue;
          agent.__pvpContinueWrapped = true;
          cleanups.push(() => {
            if (agent.continue === wrappedContinue) {
              agent.continue = origContinue;
              delete agent.__pvpContinueWrapped;
            }
          });
        }

        if (!agent.__pvpStreamWrapped && typeof agent.streamFn === "function") {
          const origStreamFn = agent.streamFn;
          agent.streamFn = function (this: LiveAgent, model: unknown, context: unknown, streamOptions?: unknown) {
            const optionsRecord = (streamOptions ?? {}) as Record<string, unknown>;
            const requestSignal = optionsRecord.signal as AbortSignal | undefined;
            const baseFetch =
              (optionsRecord.fetch as typeof fetch | undefined) ??
              (globalThis.fetch as typeof fetch).bind(globalThis);
            const contentTypeOf = (response: Response): string => {
              try { return response.headers?.get?.("content-type") ?? ""; } catch { return ""; }
            };
            // One envelope per *failed HTTP response*: a later transport
            // retry is a new failure and therefore a new gate even when the
            // error text is identical. The envelope is cleared on success.
            let failure: string | undefined;
            let attemptStatus = 0;
            let attemptContentType = "";
            let envelope: object | undefined;
            let parkedBodyRead: Promise<void> | undefined;

            const wrappedFetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
              const signal = init?.signal ?? requestSignal;
              if (failure !== undefined) {
                // Wait for the bounded preview without holding the provider's
                // Response: the SDK has already received it and may consume it
                // while this runs. The preview only refines classification.
                if (parkedBodyRead) await parkedBodyRead;
                if (signal?.aborted) throw signal.reason;
                const gateEnvelope = envelope ?? {};
                const proceed = await controller.awaitRetryGate(
                  gateEnvelope, failure, controller.lastUi, signal, false,
                  { status: attemptStatus, contentType: attemptContentType }
                );
                if (!proceed) {
                  const error = deniedRetryError();
                  // Start native cancellation before the provider emits its abort,
                  // so the original turn yields instead of entering transport recovery.
                  // An already-cancelled signal belongs to a superseded run.
                  if (!requestSignal?.aborted) void session.abort({ reason: error.message });
                  throw error;
                }
                controller.recordRetryAttempt(controller.lastUi, failure);
                failure = undefined;
                envelope = undefined;
                parkedBodyRead = undefined;
              }
              let response: Response;
              try {
                response = await baseFetch(input as string, init);
              } catch (error) {
                // An unreachable endpoint never yields a Response; that is the
                // "station closed" case the watch dog has to see.
                failure = error instanceof Error ? error.message : String(error);
                attemptStatus = 0;
                attemptContentType = "";
                envelope = {};
                controller.noteFailedEnvelope(envelope, failure, attemptStatus, attemptContentType);
                throw error;
              }
              if (!response.ok) {
                attemptStatus = response.status;
                attemptContentType = contentTypeOf(response);
                failure = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
                envelope = {};
                controller.noteFailedEnvelope(envelope, failure, attemptStatus, attemptContentType);
                // Never await the returned promise here: a clone's cancel may
                // wait for the original reader, which the native provider owns.
                parkedBodyRead = readFailureBodyPreview(response, signal)
                  .then(preview => {
                    if (envelope === undefined) return;
                    failure = failureEvidenceFromResponse(response.status, response.statusText, preview);
                    // A mislabelled JSON header must not hide an HTML body:
                    // clear it when the bounded preview is not JSON.
                    const trimmed = preview?.trimStart() ?? "";
                    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) attemptContentType = "";
                    if (envelope) controller.noteFailedEnvelope(envelope, failure, attemptStatus, attemptContentType);
                  })
                  .catch(() => undefined);
              }
              return response;
            };

            return origStreamFn.call(this, model, context, { ...optionsRecord, fetch: wrappedFetch });
          };
          agent.__pvpStreamWrapped = true;
          cleanups.push(() => {
            agent.streamFn = origStreamFn;
            delete agent.__pvpStreamWrapped;
          });
        }
      }
      return origPrompt.call(this, text, promptOptions);
    };

    cleanups.push(() => {
      sessionProto.prompt = origPrompt;
    });
  }

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    for (const c of cleanups.splice(0).reverse()) {
      try {
        c();
      } catch {
        // Ignore teardown failures: restoring a patch must never throw.
      }
    }
  };
  activeHookCleanup = cleanup;
  return Object.assign(cleanup, { ready });
}

export function getPvpArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const values = COMMAND_MODES.filter((value) => value.startsWith(normalizedPrefix));
  return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
}
