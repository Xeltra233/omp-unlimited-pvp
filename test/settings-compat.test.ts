import { expect, it } from "bun:test";
import { adaptSettings } from "../src/settings-compat.js";

it("uses legacy API without loading the new registry", async () => {
  const legacy = { override() {}, clearOverride() {} };
  expect(await adaptSettings(legacy, async () => { throw new Error("must not load"); })).toBe(legacy);
});

it("routes new registry handles through the same host scope", async () => {
  const scope = {};
  const values = new Map<string, unknown>();
  const adapter = await adaptSettings(scope, async () => id => ({
    override(host, value) { expect(host).toBe(scope); values.set(id, value); },
    clearOverride(host) { expect(host).toBe(scope); values.delete(id); },
    get(host) { expect(host).toBe(scope); return values.get(id); },
  }));
  adapter.override("retry.enabled", true);
  expect(adapter.get?.("retry.enabled")).toBe(true);
  adapter.clearOverride("retry.enabled");
  expect(values.size).toBe(0);
});

it("reports missing registry settings rather than silently ignoring them", async () => {
  const adapter = await adaptSettings({}, async () => () => undefined);
  expect(() => adapter.override("retry.enabled", true)).toThrow("Unsupported OMP setting");
});
