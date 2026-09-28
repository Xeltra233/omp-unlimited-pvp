/** Run explicitly in an isolated OMP installation; real SDK loop, synthetic provider stream. */
import assert from "node:assert/strict";
import { Settings, SessionManager, createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import * as catalog from "@oh-my-pi/pi-catalog";
import pvp from "../src/index.ts";
import { adaptSettings } from "../src/settings-compat.ts";
import { TurnRecovery } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
const originalRecovery = TurnRecovery.prototype.handleRetryableError;

const settings = await Settings.init({ inMemory: true, overrides: { "retry.enabled": false } });
const adapter = await adaptSettings(settings);
const baseline = adapter.get?.("retry.maxRetries");
const model = catalog.getBundledModel("openai", "gpt-4o");
assert(model, "bundled fixture model exists");
const { session, extensionsResult } = await createAgentSession({
  cwd: process.cwd(), agentDir: `${process.cwd()}/isolated`, settings, model,
  sessionManager: SessionManager.inMemory(), extensions: [pvp],
  disableExtensionDiscovery: true, enableMCP: false, enableLsp: false, enableIrc: false,
  skipPythonPreflight: true, toolNames: [], skills: [], rules: [], contextFiles: [],
  promptTemplates: [], slashCommands: [],
});
assert.equal(extensionsResult.errors.length, 0);
assert(session.extensionRunner?.getCommand("pvp"), "extension really loaded");
let attempts = 0;
let failures = 6;
let abortOnRetry = false;
let aborted: Promise<void> | undefined;
const events: string[] = [];
const delays: number[] = [];
session.subscribe(event => {
  events.push(event.type);
  if (event.type === "auto_retry_start") {
    delays.push(event.delayMs);
    if (abortOnRetry) {
      abortOnRetry = false;
      queueMicrotask(() => { aborted = session.abort(); });
    }
  }
});
session.agent.streamFn = () => {
  const stream = new AssistantMessageEventStream();
  queueMicrotask(() => {
    attempts++;
    assert(attempts < 30, "bounded test: runaway retry");
    const failed = attempts <= failures;
    const message: any = {
      role: "assistant", content: failed ? [] : [{ type: "text", text: "fixture ok" }],
      api: model.api, provider: model.provider, model: model.id,
      stopReason: failed ? "error" : "stop", errorMessage: failed ? "503 Service unavailable" : undefined,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now(),
    };
    stream.push(failed ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message });
    stream.end();
  });
  return stream;
};
const users = () => session.agent.state.messages.filter(m => m.role === "user").length;
try {
  await session.prompt("/pvp on");
  assert.equal(adapter.get?.("retry.enabled"), true);
  assert.equal(adapter.get?.("retry.modelFallback"), false);
  assert.equal(adapter.get?.("retry.maxRetries"), 999999);
  await session.prompt("persistent fixture");
  await session.waitForIdle();
  assert.equal(attempts, 7);
  assert.equal(users(), 1, "retries must not resend user messages");
  assert(delays.every(ms => ms === 0), "ordinary 503 retries have no backoff");
  assert(!events.includes("retry_fallback_applied"));
  assert.equal(session.model?.id, model.id);

  await session.prompt("/pvp one");
  attempts = 0; failures = 2;
  await session.prompt("one fixture");
  await session.waitForIdle();
  assert.equal(attempts, 3);
  assert.equal(users(), 2);
  assert.equal(adapter.get?.("retry.maxRetries"), baseline, "one mode restores retry settings");

  await session.prompt("/pvp on");
  attempts = 0; failures = 20; abortOnRetry = true;
  await session.prompt("abort fixture");
  await aborted;
  await session.waitForIdle();
  assert(attempts < 20, "abort stops retries");
  const stoppedAt = attempts;
  await Bun.sleep(30);
  assert.equal(attempts, stoppedAt, "no retry after abort");
  await session.prompt("/pvp off");
  assert.equal(adapter.get?.("retry.maxRetries"), baseline);
  assert.equal(users(), 3);
  await session.prompt("/pvp on");
  console.log(JSON.stringify({ result: "PASS", persistentAttempts: 7, oneAttempts: 3,
    abortAttempts: attempts, userMessages: users(), model: session.model?.id, retryDelays: delays }));
} finally {
  await session.dispose();
}
assert.equal(adapter.get?.("retry.maxRetries"), baseline, "shutdown restores settings");
assert.equal(TurnRecovery.prototype.handleRetryableError, originalRecovery, "shutdown removes recovery hook");
console.log("shutdown cleanup PASS");
