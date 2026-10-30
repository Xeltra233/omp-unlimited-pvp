import type { SettingsLike } from "./settings-guard.js";

export interface SettingHandle {
  override(scope: unknown, value: unknown): void;
  clearOverride(scope: unknown): void;
  get(scope: unknown): unknown;
}
export type SettingLookup = (id: string) => SettingHandle | undefined;

/**
 * OMP >=18.4 dropped `settings.override(path, value)` and moved runtime overrides
 * behind per-setting handles (`config/registry`). The `Settings` instance still
 * exposes the registry plumbing that those handles call, so a plugin can keep
 * working without importing the registry at all — which matters because a plugin
 * loaded through OMP's legacy specifier shim does not share the host's registry
 * module instance (its `lookup()` returns nothing, so every handle is "unsupported").
 */
export interface SettingsInstanceLike {
  writeValue(handle: unknown, value: unknown, layer: "global" | "override"): void;
  clearOverrideValue(handle: unknown): void;
  rawValue?(handle: unknown): unknown;
}

export interface SettingsAdapterDeps {
  loadLookup?: () => Promise<SettingLookup>;
  loadInstance?: () => Promise<SettingsInstanceLike | undefined>;
}

const PROBE_SETTING_ID = "retry.modelFallback";
const REGISTRY_SPECIFIER = "@oh-my-pi/pi-coding-agent/config/registry";
const HOST_SPECIFIER = "@oh-my-pi/pi-coding-agent";

/** Minimal stand-in for a registry setting handle; only the fields `Settings` reads. */
function createHandle(id: string): unknown {
  return {
    id,
    segments: id.split("."),
    slot: `pvp:${id}`,
    assertWritable: () => {},
    get: () => undefined,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Adapter for OMP >=18.4: write runtime overrides through the host settings instance. */
export function createInstanceSettingsAdapter(instance: SettingsInstanceLike): SettingsLike {
  const write = (id: string, value: unknown): void => instance.writeValue(createHandle(id), value, "override");
  return {
    override: (id: string, value: unknown) => write(id, value),
    clearOverride: (id: string) => instance.clearOverrideValue(createHandle(id)),
    get: (id: string) => {
      try {
        return instance.rawValue?.(createHandle(id));
      } catch {
        return undefined;
      }
    },
  };
}

/** Adapter for a registry whose `lookup()` actually knows the host's settings. */
function createRegistrySettingsAdapter(scope: unknown, lookup: SettingLookup): SettingsLike {
  const handle = (id: string): SettingHandle => {
    const setting = lookup(id);
    if (!setting) throw new Error(`Unsupported OMP setting: ${id}`);
    return setting;
  };
  return {
    override: (id, value) => handle(id).override(scope, value),
    clearOverride: id => handle(id).clearOverride(scope),
    get: id => handle(id).get(scope),
  };
}

async function defaultLoadLookup(): Promise<SettingLookup> {
  // Variable specifier keeps older OMP installations independent of this newer subpath.
  const path = REGISTRY_SPECIFIER;
  return (await import(path)).lookup as SettingLookup;
}

async function defaultLoadInstance(): Promise<SettingsInstanceLike | undefined> {
  const mod = (await import(HOST_SPECIFIER)) as { Settings?: { instance?: SettingsInstanceLike } };
  const instance = mod?.Settings?.instance;
  if (instance && typeof instance.writeValue === "function" && typeof instance.clearOverrideValue === "function") {
    return instance;
  }
  return undefined;
}

/**
 * Resolve a working runtime-override API for the running OMP version.
 *
 * Order: legacy dotted-path API -> host settings instance (18.4 handles plumbing)
 * -> registry handles. Throws with every attempted strategy when none works, so
 * callers can degrade to hook-only mode instead of pretending overrides applied.
 */
export async function adaptSettings(scope: unknown, deps: SettingsAdapterDeps = {}): Promise<SettingsLike> {
  const legacy = scope as Partial<SettingsLike> | undefined;
  if (typeof legacy?.override === "function" && typeof legacy?.clearOverride === "function") {
    return legacy as SettingsLike;
  }

  const instance = scope as Partial<SettingsInstanceLike> | undefined;
  if (typeof instance?.writeValue === "function" && typeof instance?.clearOverrideValue === "function") {
    return createInstanceSettingsAdapter(instance as SettingsInstanceLike);
  }

  const failures: string[] = [];

  try {
    const instance = await (deps.loadInstance ?? defaultLoadInstance)();
    if (instance) return createInstanceSettingsAdapter(instance);
    failures.push("host settings instance unavailable");
  } catch (error) {
    failures.push(`host settings instance: ${errorText(error)}`);
  }

  try {
    const lookup = await (deps.loadLookup ?? defaultLoadLookup)();
    if (lookup(PROBE_SETTING_ID)) return createRegistrySettingsAdapter(scope, lookup);
    failures.push("settings registry has no host handles");
  } catch (error) {
    failures.push(`settings registry: ${errorText(error)}`);
  }

  throw new Error(failures.join("; "));
}
