# omp-unlimited-pvp

Unlimited automatic retry plugin specifically crafted for **oh-my-pi (OMP)** with anti-fallback model locking and zero-cooldown scheduling.

Enter `/pvp` to raise the native retry budget, disable base backoff and model fallback chains, and retry in place until success or user cancellation. When OMP's native recovery settles a failure first, the plugin takes over instead of leaving the provider error in the chat. See the implementation limits below.

## Compatibility (v0.3.1)

Individually verified **29 releases**: **18.1.14–18.1.22, 18.2.0–18.2.11, 18.3.0–18.3.5, 18.4.0–18.4.1**. 18.1.14 is the version pinned by the original lockfile and the verified compatibility floor from that batch; earlier and future versions are not verified. That 29-version result comes from a prior standalone compatibility pass, not a re-run of every version in this round; the current watchdog-gate changes do not automatically inherit it.

- Settings overrides adapt to the live session settings object via two channels: the legacy dotted-path `override`/`clearOverride` API, or the session's own `session.settings` instance using `writeValue`/`clearOverrideValue` with the SDK's genuine `retry.*` handles (`cfgRetry*`). No module-level singleton or synthetic handles are used, and no separate `config/registry` copy is looked up inside the plugin loader. A failed override only warns: the plugin still enables, because the continuation backstop does not depend on it. Deferred imports can no longer reinstall hooks after teardown.

Verification in an earlier standalone compatibility batch loaded the installed plugin with the real `omp` binary against a local synthetic provider: nine and twelve consecutive `upstream_http2_stream_error` failures both ended in success (retry 11 exceeded OMP's eight-continuation cap), counted mode, abort, unchanged model, and no duplicate user prompts. That result belongs only to that batch and does not automatically cover the current wiring changes or later native scenarios. External providers are not covered.

- Verified on the same live `session.settings`: `/pvp on` applies all six `retry.*` values (`prov=runtime`) with one `PVP ON` notification and no spurious warning; `/pvp off` restores the six values exactly to baseline at the same scope (`retry.enabled=false/global`, all others `undefined/default`). Overrides are memory-only for the session and do not write the user's `config.yml` or `settings.json`.
- On the real bundled CLI, nine JSON 503 responses were followed by a successful 10th POST, with `prompt_result` completed and `agentInvoked` / `sessionSettled` true; each of the 10 POSTs carried exactly one user message. In that scenario `/pvp on` happened at startup before live binding and showed the host's 0.5/1/2/4/8s backoff, so it is not evidence of zero cooldown.
- On the real bundled CLI, an identical HTML 503 after recovery in the same turn parks again and the original request completes. A subsequent prompt in the same session also recovers from a new outage: three gates and five POSTs (503/503/200/503/200), each carrying the current user prompt exactly once.
- With real `abort_and_prompt`, the old ticket is `aborted`; the replacement parks independently, then completes through its own successful POST and `prompt_result completed`. The old request is not revived.

**Limits:** the native retry budget is `999999`, not mathematical infinity. Ordinary 503 base backoff is zero; provider Retry-After, quota waits and context recovery remain governed by OMP. Aborts and context overflows are always left to OMP. Zero delay means continuing immediately once the failure is observed, not identical dispatch timing every round.


---

## 🌟 Key Features

- ⚡ **Zero-Cooldown Immediate Retry**: Completely bypasses OMP's built-in exponential backoff delays (2s, 4s, 8s, etc.), re-dispatching immediately after turn settle.
- ♾️ **Unlimited Retries**: Removes OMP's default retry limit, continuously retrying until success.
- 🛡️ **Native Anti-Fallback Protection**:
  - **Dynamic Runtime Overrides**: Adapts to the live session settings object via two channels — the legacy dotted-path `override`/`clearOverride` API, or the OMP 18.4 session `session.settings` instance using `writeValue`/`clearOverrideValue` with the SDK's genuine `retry.*` handles (`cfgRetry*`); no separate `config/registry` copy is looked up. Disables `retry.modelFallback`, clears `retry.fallbackChains`, and keeps `retry.enabled = true` for native in-place recovery.
  - **Model Locking & Restoration**: Snapshots the active model on agent start. If any unexpected `retry_fallback_applied` event is detected, it alerts the UI and forcibly switches back via `pi.setModel`. A live `pi.setModel` cancels old gates **before** performing the original operation; OMP has no `model_select` event, so this explicit cancellation is what prevents a stale `wait` from affecting the new model's run.
  - **Clean In-Memory Operation**: All overrides are cleared in memory upon disabling PVP or session shutdown (`session_shutdown`), leaving user configuration files untouched.
  - **No Error Message Pollution**: Avoids injecting dummy `"quota exceeded"` markers that would otherwise trigger OMP's `Flag.UsageLimit` and lock API credentials.
- 🎯 **Dual Modes**:
  - **Persistent Mode (`/pvp` or `/pvp on`)**: Keeps retrying upon failures, remains enabled even after success.
  - **Counted Mode (`/pvp <n>`)**: Retries on failure without limit (failures are never counted); **automatically turns off after n successful turns** and restores OMP settings.
- 📌 **Native TUI Integration (Anti-Scroll)**:
  - Custom component factory rendering avoids the built-in string component's forced left margin and stays close to the terminal edge; pixel-level alignment and appearance are not screenshot-verified and depend on the host theme and terminal rendering.
  - Uses lowercase glyphs (`pvp on` / `pvp <n>`) and neutral theme colors (`theme.fg("muted")` / `theme.fg("dim")`), following the native status bar style without promising pixel-identical results in every theme.
  - Mounted via UI widget (`placement: "belowEditor"`) and synchronized with `setStatus`, so the indicator remains visible while chat text scrolls.
- 💬 **Minimalist Feedback**:
  - Direct and clean status notifications: `PVP ON`, `PVP <n>`, `PVP OFF`.
- 🛡️ **Safe Teardown & Abort**:
  - Aborting with `Ctrl+C` immediately cancels pending retries.
  - Full cleanup on `session_shutdown`.

---

## 📦 Installation

### Option 1: Install via Remote Git (Recommended)

```bash
omp install https://github.com/Xeltra233/omp-unlimited-pvp
# or via git prefix
omp install git:github.com/Xeltra233/omp-unlimited-pvp
```

Project scope works for marketplace sources only (`omp install --scope=project name@marketplace`). For local directories use `omp install <path>` below; for project-local installation use the proven plugin entries `omp plugin install` / `omp plugin link`.

### Option 2: Local Path Installation

```bash
omp install /path/to/omp-unlimited-pvp
# or run in project root
omp install .
```

### Option 3: Ephemeral Run

```bash
omp -e git:github.com/Xeltra233/omp-unlimited-pvp
# or with local path
omp -e /path/to/omp-unlimited-pvp
```

---

## 🚀 Usage

Inside OMP interactive shell, enter:

| Command | Mode | Notification | Behavior |
| :--- | :--- | :--- | :--- |
| `/pvp` | Persistent | `PVP ON` | Activates persistent infinite retry mode with anti-fallback protection. |
| `/pvp on` | Persistent | `PVP ON` | Explicit alias for `/pvp`. |
| `/pvp <n>` | Counted | `PVP <n>` | Unlimited retries on failure; **automatically disables after n successful turns (progress shown as `(x/n)`) and notifies `PVP OFF`**. |
| `/pvp off` | Disabled | `PVP OFF` | Disables PVP, clears status widgets, and restores original OMP settings. |

### Argument Completion

Type `/pvp ` and press `Tab` to autocomplete `on`, `off`.

---

## 🔍 How It Works

1. **Native In-Place Retry**: When PVP is enabled, the plugin hooks into the underlying agent execution loop. Upon error, it removes the failed assistant message and retries in place (`agent.continue()`). When the native chain cannot continue (budget exhausted, error classified non-retryable, fallback path settled first), a `session_stop` continuation takes over; only as a last resort does the plugin restart the turn with one hidden `display: false` message, so no duplicate user messages or retry noise reach the transcript.
2. **Anti-Fallback & Zero Delay**: Writes in-memory overrides through whichever channel the running OMP version supports: model fallback off (`retry.modelFallback = false`), fallback chains cleared, retry delay removed (`retry.baseDelayMs`/`retry.maxDelayMs = 0`), attempt cap lifted (`retry.maxRetries = 999999`), which locks the selected model. Overrides are an accelerator; if they cannot be written, PVP still enables and the continuation backstop keeps turns alive.
3. **Live Status Synchronization**: Real-time status update below the input editor (`pvp on (第 X 次重试)`).
4. **Lifecycle & Completion**: Resets retry count to zero upon successful turn completion (`stop` / `length`). In counted mode (`/pvp <n>`), increments the success counter and automatically turns off once n successes are reached.
5. **Optional Wake-Guard Coordination** (nothing changes if it is not installed): when `omp-wakeguard` is loaded alongside, PVP synchronously publishes one gate request on the event-bus channel `omp-wakeguard:before-retry:v1` before every native retry:

   ```text
   PvpRetryGateRequest = {
     version: 1;
     errorMessage: string;
     model?: { provider: string; id: string; api: string; baseUrl: string };
     signal: AbortSignal;
     status?: number;           // HTTP status of THIS failed attempt, never an older response
     contentType?: string;      // content-type of THIS failed response (for structured-error classification)
     wait?: Promise<boolean>;   // assigned synchronously by the listener only
   }
   ```

   The `options.fetch` wrapper captures `status` / `contentType` on the **same failed attempt's same HTTP response** (a bounded body preview refines JSON-vs-HTML); they are never inherited from an earlier response, and when no HTTP Response is available both fields stay absent so the wake guard cannot fall back to stale metadata. This lets it tell "server is alive, JSON error — keep retrying natively (no park)" from "a JSON content-type header mislabelling an HTML outage page — clear the header and keep parking and probing".

   - No listener assigns `wait`: PVP retries exactly as before (zero behaviour change; this is the state without the wake guard).
   - `wait` still pending: the current run parks in place — the context is not omitted, no retry is counted, the counted-mode success counter does not move; once the wake guard proves the endpoint is back it calls `resolve(true)` and the same run continues its native retry.
   - Dispatchers for the same failure share the wait. A new failed attempt after recovery opens a new gate even when its error text is identical; it cannot reuse the earlier release result.
   - `resolve(false)`: cancels this run only; PVP stays enabled and the success count/mode are untouched.
   - Rejection: cancels this run and shows the fixed notice `PVP: 看门狗探测失败，本次不重试` without echoing any error text that may contain secrets.
   - `signal` aborts on `/pvp off`, user abort, **model switch**, session switch/fork/tree walk, `session_shutdown`, and a new prompt; a cancelled gate never revives an old run even if it calls `resolve(true)` later (PVP discards stale `wait`s via an epoch counter). A model switch means the active model's `provider`/`id`/`baseUrl` changed: OMP has no `model_select`, so the wake guard handles `session_switch` (the model-epoch boundary) by both `bindModel` (clearing response metadata on a real change) and `cancelGate`, preventing an old model's failure evidence from being attributed to the new one.
   - The wake guard loads as `off`; only an explicit `/wakeguard on` enables it, and it probes **immediately once**, then on a default cadence of `600000` ms (10 minutes), adjustable via `/wakeguard interval`.
   - The probe is a single **credential-free `GET <baseUrl>/models`** with a hard timeout. It proves the endpoint answers — it **cannot prove the model itself works** (auth, quota and model state are out of scope); the native retry remains the real arbiter after recovery.
   - Classification boundary: structured `401` / `403` / `429` / `503` JSON responses are **provider errors** — the API is alive, so PVP keeps retrying natively and the wake guard does not park. Only unstructured error pages (e.g. gateway HTML) or transport/network failures trigger the park-and-probe path.
   - The coordination depends on the event bus only: it does not touch OMP settings or credentials and does not change `retry.enabled` semantics.

---

## 🛠️ Development & Testing

```bash
# Run unit tests
bun test

# Run TypeScript typecheck
bun run typecheck

# Production build
bun run build
```

---

## 📄 License

[MIT License](LICENSE)
