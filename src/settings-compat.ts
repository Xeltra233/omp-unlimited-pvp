import type { SettingsLike } from "./settings-guard.js";
import {
  cfgRetryEnabled,
  cfgRetryMaxRetries,
  cfgRetryBaseDelayMs,
  cfgRetryMaxDelayMs,
  cfgRetryModelFallback,
  cfgRetryFallbackChains,
} from "@oh-my-pi/pi-coding-agent/session/settings";

/**
 * Real registry settings used by OMP's retry pipeline. These are the genuine
 * `Setting` objects from the SDK (not synthesised stand-ins): their `segments`
 * and `slot` are the ones the live Settings instance reads from its layers and
 * value cache. A hand-built handle with a made-up slot writes to a cache entry
 * nobody reads and was the cause of the previous false "applied" result.
 */
const GENUINE_HANDLES: Record<string, unknown> = {
  "retry.enabled": cfgRetryEnabled,
  "retry.maxRetries": cfgRetryMaxRetries,
  "retry.baseDelayMs": cfgRetryBaseDelayMs,
  "retry.maxDelayMs": cfgRetryMaxDelayMs,
  "retry.modelFallback": cfgRetryModelFallback,
  "retry.fallbackChains": cfgRetryFallbackChains,
};

export interface SettingsInstanceLike {
  writeValue(handle: unknown, value: unknown, layer: "global" | "override"): void;
  clearOverrideValue(handle: unknown): void;
  rawValue?(handle: unknown): unknown;
  getProvenance?(handle: unknown): string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function genuineHandle(id: string): unknown {
  const handle = GENUINE_HANDLES[id];
  if (!handle) throw new Error(`Unsupported OMP setting: ${id}`);
  return handle;
}

/**
 * Adapt the real session's Settings instance to the override interface used by
 * SettingsGuard. `scope` must be the session's own settings object
 * (`session.settings`), never the namespace-level `pi.pi.settings`: the two are
 * distinct instances in the bundled CLI.
 */
export function createInstanceSettingsAdapter(scope: SettingsInstanceLike): SettingsLike {
  return {
    override: (id, value) => scope.writeValue(genuineHandle(id), value, "override"),
    clearOverride: id => scope.clearOverrideValue(genuineHandle(id)),
    get: id => {
      try {
        return scope.rawValue?.(genuineHandle(id));
      } catch {
        return undefined;
      }
    },
    provenance: id => {
      try {
        return scope.getProvenance?.(genuineHandle(id));
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Resolve the adapter for the supplied live scope. Legacy dotted-path settings
 * are still honoured when present; otherwise the genuine-handle instance API
 * is used. No module-level singleton is consulted.
 */
export function adaptSettings(scope: unknown): SettingsLike {
  const legacy = scope as Partial<SettingsLike> | undefined;
  if (typeof legacy?.override === "function" && typeof legacy?.clearOverride === "function") {
    return legacy as SettingsLike;
  }
  const instance = scope as Partial<SettingsInstanceLike> | undefined;
  if (typeof instance?.writeValue !== "function" || typeof instance?.clearOverrideValue !== "function") {
    throw new Error("live session settings instance unavailable");
  }
  return createInstanceSettingsAdapter(instance as SettingsInstanceLike);
}

export { errorText };
