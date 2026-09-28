import { expect, it } from "bun:test";
import { TurnRecovery } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { installPvpRetryHook, PvpController } from "../src/pvp-controller.js";

it("does not install a deferred hook after immediate teardown", async () => {
  const before = TurnRecovery.prototype.handleRetryableError;
  const cleanup = installPvpRetryHook(new PvpController());
  cleanup();
  await cleanup.ready;
  expect(TurnRecovery.prototype.handleRetryableError).toBe(before);
});

it("restores the actual OMP recovery prototype and tolerates repeated teardown", async () => {
  const before = TurnRecovery.prototype.handleRetryableError;
  const cleanup = installPvpRetryHook(new PvpController());
  await cleanup.ready;
  expect(TurnRecovery.prototype.handleRetryableError).not.toBe(before);
  cleanup();
  cleanup();
  expect(TurnRecovery.prototype.handleRetryableError).toBe(before);
});
