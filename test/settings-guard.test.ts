import { describe, expect, it, mock } from "bun:test";
import { SettingsGuard, type SettingsLike } from "../src/settings-guard.js";

describe("SettingsGuard Anti-Fallback", () => {
  it("applies anti-fallback runtime overrides to settings", () => {
    const overrides: Record<string, unknown> = {};
    const mockSettings: SettingsLike = {
      override: mock((path: string, val: unknown) => {
        overrides[path] = val;
      }),
      clearOverride: mock((path: string) => {
        delete overrides[path];
      }),
    };

    const guard = new SettingsGuard(mockSettings);
    expect(guard.isApplied).toBe(false);

    const applied = guard.applyAntiFallbackOverrides();
    expect(applied).toBe(true);
    expect(guard.isApplied).toBe(true);
    expect(overrides["retry.modelFallback"]).toBe(false);
    expect(overrides["retry.enabled"]).toBe(false);
    expect(overrides["retry.fallbackChains"]).toEqual({});

    const cleared = guard.clearAntiFallbackOverrides();
    expect(cleared).toBe(true);
    expect(guard.isApplied).toBe(false);
    expect(overrides["retry.modelFallback"]).toBeUndefined();
    expect(overrides["retry.enabled"]).toBeUndefined();
    expect(overrides["retry.fallbackChains"]).toBeUndefined();
  });

  it("handles uninitialized settings gracefully without throwing", () => {
    // When no settings is provided and global settings is not initialized
    const guard = new SettingsGuard();
    expect(() => guard.applyAntiFallbackOverrides()).not.toThrow();
    expect(() => guard.clearAntiFallbackOverrides()).not.toThrow();
  });

  it("handles errors thrown by override gracefully", () => {
    const brokenSettings: SettingsLike = {
      override: () => {
        throw new Error("Settings error");
      },
      clearOverride: () => {
        throw new Error("Settings error");
      },
    };

    const guard = new SettingsGuard(brokenSettings);
    expect(guard.applyAntiFallbackOverrides()).toBe(false);
    expect(guard.clearAntiFallbackOverrides()).toBe(false);
  });
});
