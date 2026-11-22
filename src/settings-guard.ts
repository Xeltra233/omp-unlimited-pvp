import { adaptSettings } from "./settings-compat.js";

export interface SettingsLike {
  override<P extends string>(path: P, value: unknown): void;
  clearOverride(path: string): void;
  get?(path: string): unknown;
  /** Where the effective value comes from: the SDK reports a taken runtime override as `runtime`. */
  provenance?(path: string): string | undefined;
}

/** The retry knobs PVP pins so OMP never falls back to another model. */
const ANTI_FALLBACK_OVERRIDES: Array<[string, unknown]> = [
  ["retry.modelFallback", false],
  ["retry.fallbackChains", {}],
  ["retry.enabled", true],
  ["retry.maxRetries", 999999],
  ["retry.baseDelayMs", 0],
  ["retry.maxDelayMs", 0],
];

/** Every override id, for the reverse path. */
const OVERRIDE_IDS: string[] = ANTI_FALLBACK_OVERRIDES.map(([id]) => id);

/**
 * Applies runtime retry overrides on the *live session's* settings instance.
 * The namespace-level settings object is a different instance in the bundled
 * CLI, so the scope must be supplied explicitly once the real session is seen.
 */
export class SettingsGuard {
  private customSettings?: SettingsLike;
  private scope?: unknown;
  private overridesApplied: boolean = false;

  constructor(customSettings?: SettingsLike) {
    this.customSettings = customSettings;
  }

  /** Bind to a real session settings scope (or an explicit adapter in tests). */
  prepare(scope?: unknown): void {
    if (scope === undefined) return;
    if (this.customSettings === undefined || this.scope !== scope) {
      this.scope = scope;
      this.customSettings = adaptSettings(scope);
      this.prepareError = undefined;
    }
  }

  prepareError: string | undefined = undefined;
  overrideError: string | undefined = undefined;

  /**
   * True once a live session settings scope has been supplied. Before that the
   * guard cannot touch anything: the bundled CLI keeps the session's settings
   * instance separate from the namespace-level `settings`, and only a live
   * prompt reveals it. Enabling PVP earlier must defer, not fail.
   */
  get hasScope(): boolean {
    return this.scope !== undefined;
  }

  private resolveSettings(): SettingsLike | undefined {
    if (this.customSettings === undefined && this.scope !== undefined) {
      try {
        this.prepare(this.scope);
      } catch (error) {
        this.prepareError = error instanceof Error ? error.message : String(error);
      }
    }
    return this.customSettings;
  }

  /**
   * Write every anti-fallback override, then prove each one landed by reading
   * the effective value back from the instance. A write that only reached a
   * value cache nobody reads would still report `applied`, which is the false
   * success this readback exists to reject.
   */
  applyAntiFallbackOverrides(): boolean {
    const s = this.resolveSettings();
    if (!s) return false;

    try {
      for (const [id, value] of ANTI_FALLBACK_OVERRIDES) s.override(id, value);
    } catch (error) {
      this.overrideError = error instanceof Error ? error.message : String(error);
      return false;
    }

    const unproven = OVERRIDE_IDS.filter(id => !this.isOverrideEffective(s, id));
    if (unproven.length > 0) {
      this.overrideError = `readback did not confirm override: ${unproven.join(", ")}`;
      return false;
    }
    this.overrideError = undefined;
    this.overridesApplied = true;
    return true;
  }

  /** An override is effective only when the instance reports the real `runtime` source. */
  private isOverrideEffective(s: SettingsLike, id: string): boolean {
    if (!s.provenance) return false;
    try {
      return s.provenance(id) === "runtime";
    } catch {
      return false;
    }
  }

  /** Restore every knob to whatever the host had before PVP touched it. */
  clearAntiFallbackOverrides(): boolean {
    const s = this.resolveSettings();
    if (!s) return false;

    try {
      for (const id of OVERRIDE_IDS) s.clearOverride(id);
      this.overridesApplied = false;
      return true;
    } catch {
      return false;
    }
  }

  get isApplied(): boolean {
    return this.overridesApplied;
  }
}
