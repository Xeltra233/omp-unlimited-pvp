import { expect, it } from "bun:test";
import { adaptSettings, createInstanceSettingsAdapter, type SettingLookup } from "../src/settings-compat.js";

it("uses legacy API without loading the new registry", async () => {
  const legacy = { override() {}, clearOverride() {} };
  const adapter = await adaptSettings(legacy, {
    loadLookup: async () => {
      throw new Error("must not load");
    },
    loadInstance: async () => {
      throw new Error("must not load");
    },
  });
  expect(adapter).toBe(legacy);
});

it("writes overrides through the host settings instance when there is no legacy API", async () => {
  // OMP >=18.4: Settings exposes writeValue/clearOverrideValue instead of override(path, value).
  const writes: Array<{ id: string; value: unknown }> = [];
  const cleared: string[] = [];
  const scope = {
    writeValue(handle: { id: string }, value: unknown, layer: string) {
      expect(layer).toBe("override");
      writes.push({ id: handle.id, value });
    },
    clearOverrideValue(handle: { id: string }) {
      cleared.push(handle.id);
    },
  };

  const adapter = await adaptSettings(scope);
  adapter.override("retry.maxRetries", 999999);
  adapter.override("retry.fallbackChains", {});
  adapter.clearOverride("retry.maxRetries");

  expect(writes).toEqual([
    { id: "retry.maxRetries", value: 999999 },
    { id: "retry.fallbackChains", value: {} },
  ]);
  expect(cleared).toEqual(["retry.maxRetries"]);
});

it("builds setting handles that carry dotted segments for the host instance", () => {
  const seen: Array<{ segments: string[]; slot: string }> = [];
  const adapter = createInstanceSettingsAdapter({
    writeValue(handle: { segments: string[]; slot: string }) {
      seen.push({ segments: handle.segments, slot: handle.slot });
    },
    clearOverrideValue() {},
  });

  adapter.override("retry.baseDelayMs", 0);

  expect(seen).toEqual([{ segments: ["retry", "baseDelayMs"], slot: "pvp:retry.baseDelayMs" }]);
});

it("routes new registry handles through the same host scope", async () => {
  const scope = {};
  const values = new Map<string, unknown>();
  const lookup: SettingLookup = id => ({
    override(host, value) {
      expect(host).toBe(scope);
      values.set(id, value);
    },
    clearOverride(host) {
      expect(host).toBe(scope);
      values.delete(id);
    },
    get(host) {
      expect(host).toBe(scope);
      return values.get(id);
    },
  });

  const adapter = await adaptSettings(scope, { loadInstance: async () => undefined, loadLookup: async () => lookup });
  adapter.override("retry.enabled", true);
  expect(adapter.get?.("retry.enabled")).toBe(true);
  adapter.clearOverride("retry.enabled");
  expect(values.size).toBe(0);
});

it("falls back to registry handles when the host instance is unavailable", async () => {
  const adapter = await adaptSettings(
    {},
    {
      loadInstance: async () => undefined,
      loadLookup: async () => id => ({
        override() {},
        clearOverride() {},
        get: () => id,
      }),
    },
  );
  expect(adapter.get?.("retry.enabled")).toBe("retry.enabled");
});

it("reports missing registry settings rather than silently ignoring them", async () => {
  const adapter = await adaptSettings(
    {},
    {
      loadInstance: async () => undefined,
      loadLookup: async () => id => (id === "retry.modelFallback" ? { override() {}, clearOverride() {}, get: () => 1 } : undefined),
    },
  );
  expect(() => adapter.override("retry.enabled", true)).toThrow("Unsupported OMP setting");
});

it("fails loudly when no override API is reachable", async () => {
  await expect(
    adaptSettings(
      {},
      {
        loadInstance: async () => undefined,
        loadLookup: async () => () => undefined,
      },
    ),
  ).rejects.toThrow("settings registry has no host handles");
});
