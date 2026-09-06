import { settings } from "@oh-my-pi/pi-coding-agent";

/**
 * Minimal interface compatible with OMP's Settings instance.
 */
export interface SettingsLike {
  override<P extends string>(path: P, value: unknown): void;
  clearOverride(path: string): void;
  get?(path: string): unknown;
}

/**
 * Manages runtime settings overrides to prevent OMP from:
 * 1. Triggering fallback model chains upon error (`retry.modelFallback = false`)
 * 2. Engaging internal backoff delays/retries (`retry.enabled = false`)
 * 3. Selecting alternative model candidates (`retry.fallbackChains = {}`)
 *
 * Overrides are purely in-memory runtime overlays and are cleanly restored
 * whenever PVP mode is turned off or the session shuts down.
 */
export class SettingsGuard {
  private customSettings?: SettingsLike;
  private overridesApplied: boolean = false;

  constructor(customSettings?: SettingsLike) {
    this.customSettings = customSettings;
  }

  private resolveSettings(): SettingsLike | undefined {
    if (this.customSettings) {
      return this.customSettings;
    }
    try {
      return settings as unknown as SettingsLike;
    } catch {
      return undefined;
    }
  }

  /**
   * Apply runtime overrides to prevent OMP fallback and internal delay.
   * Returns true if overrides were successfully applied.
   */
  applyAntiFallbackOverrides(): boolean {
    const s = this.resolveSettings();
    if (!s) return false;

    try {
      // Disable OMP's model fallback chain completely
      s.override("retry.modelFallback", false);
      // Disable OMP's internal backoff retry loop so failure immediately finishes turn
      s.override("retry.enabled", false);
      // Clear fallback chains to guarantee no candidate model switch
      s.override("retry.fallbackChains", {});
      this.overridesApplied = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear runtime overrides and restore OMP's original retry and fallback behavior.
   * Returns true if overrides were successfully cleared.
   */
  clearAntiFallbackOverrides(): boolean {
    const s = this.resolveSettings();
    if (!s) return false;

    try {
      s.clearOverride("retry.modelFallback");
      s.clearOverride("retry.enabled");
      s.clearOverride("retry.fallbackChains");
      this.overridesApplied = false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether anti-fallback overrides are currently active.
   */
  get isApplied(): boolean {
    return this.overridesApplied;
  }
}
