import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { PVP_WAKE_GUARD_CHANNEL, type PvpRetryGateRequest } from "../src/pvp-controller.ts";

const say = (event: string): void => { process.stderr.write(`GATE_CANCEL_EVENT ${event}\n`); };

export default function gateCancelHost(pi: ExtensionAPI): void {
  pi.registerProvider("gate-cancel-fixture", {
    baseUrl: process.env.PVP_GATE_CANCEL_URL,
    apiKey: "fixture-not-a-secret",
    api: "openai-completions",
    models: [{
      id: "main", name: "Main", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000, maxTokens: 128,
    }],
  });

  let gate: ReturnType<typeof Promise.withResolvers<boolean>> | undefined;
  pi.events.on(PVP_WAKE_GUARD_CHANNEL, (request: PvpRetryGateRequest) => {
    if (process.env.PVP_GATE_CANCEL_NATIVE_ONLY === "1" && request.status !== undefined) {
      request.wait = Promise.resolve(true);
      return;
    }
    gate ??= Promise.withResolvers<boolean>();
    request.wait = gate.promise;
    say("parked");
  });
  pi.registerCommand("gate-deny", {
    description: "Resolve the fixture retry gate with false",
    handler: async () => {
      gate?.resolve(false);
      say("denied");
    },
  });
  pi.on("session_start", () => { say("ready"); });
  pi.on("session_shutdown", () => { gate?.resolve(false); });
}
