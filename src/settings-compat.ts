import type { SettingsLike } from "./settings-guard.js";

export interface SettingHandle {
  override(scope: unknown, value: unknown): void;
  clearOverride(scope: unknown): void;
  get(scope: unknown): unknown;
}
export type SettingLookup = (id: string) => SettingHandle | undefined;

/** Adapt OMP's legacy dotted-path API or its newer setting-handle registry. */
export async function adaptSettings(
  scope: unknown,
  loadLookup: () => Promise<SettingLookup> = async () => {
    // Variable import keeps older OMP installations independent of this new subpath.
    const path = "@oh-my-pi/pi-coding-agent/config/registry";
    return (await import(path)).lookup;
  },
): Promise<SettingsLike> {
  const legacy = scope as Partial<SettingsLike> | undefined;
  if (typeof legacy?.override === "function" && typeof legacy.clearOverride === "function") {
    return legacy as SettingsLike;
  }
  const lookup = await loadLookup();
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
