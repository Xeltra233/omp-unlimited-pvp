# omp-unlimited-pvp

Unlimited automatic retry plugin specifically crafted for **oh-my-pi (OMP)** with anti-fallback model locking and zero-cooldown scheduling.

Enter `/pvp` to raise the native retry budget, disable base backoff and model fallback chains, and retry in place until success or user cancellation. When OMP's native recovery settles a failure first, the plugin takes over instead of leaving the provider error in the chat. See the implementation limits below.

## Compatibility (v0.3.1)

Individually verified **29 releases**: **18.1.14–18.1.22, 18.2.0–18.2.11, 18.3.0–18.3.5, 18.4.0–18.4.1**. The original lockfile pinned 18.1.14, now the verified compatibility floor. Earlier and future versions are not verified.

Three override channels are detected at runtime: the legacy string-path API, the OMP 18.4 host `Settings` instance (`writeValue`), and `config/registry` handles. Under the plugin loader the registry is a separate module copy whose lookups are always empty, so the instance channel is the one that works on 18.4. A failed override only warns: the plugin still enables, because the continuation backstop does not depend on it. Deferred imports can no longer reinstall hooks after teardown.

Verification loads the installed plugin with the real `omp` binary against a local synthetic provider: nine and twelve consecutive `upstream_http2_stream_error` failures both ended in success (retry 11 exceeded OMP's eight-continuation cap), counted mode, abort, unchanged model, and no duplicate user prompts. External providers are not covered.

**Limits:** the native retry budget is `999999`, not mathematical infinity. Ordinary 503 base backoff is zero; provider Retry-After, quota waits and context recovery remain governed by OMP. Aborts and context overflows are always left to OMP. Zero delay means continuing immediately once the failure is observed, not identical dispatch timing every round.


---

## 🌟 Key Features

- ⚡ **Zero-Cooldown Immediate Retry**: Completely bypasses OMP's built-in exponential backoff delays (2s, 4s, 8s, etc.), re-dispatching immediately after turn settle.
- ♾️ **Unlimited Retries**: Removes OMP's default retry limit, continuously retrying until success.
- 🛡️ **Native Anti-Fallback Protection**:
  - **Dynamic Runtime Overrides**: Uses legacy `Settings.override` or modern setting-registry handles. Disables `retry.modelFallback`, clears `retry.fallbackChains`, and keeps `retry.enabled = true` for native in-place recovery.
  - **Model Locking & Restoration**: Snapshots the active model on agent start. If any unexpected `retry_fallback_applied` event is detected, it alerts the UI and forcibly switches back via `pi.setModel`.
  - **Clean In-Memory Operation**: All overrides are cleared in memory upon disabling PVP or session shutdown (`session_shutdown`), leaving user configuration files untouched.
  - **No Error Message Pollution**: Avoids injecting dummy `"quota exceeded"` markers that would otherwise trigger OMP's `Flag.UsageLimit` and lock API credentials.
- 🎯 **Dual Modes**:
  - **Persistent Mode (`/pvp` or `/pvp on`)**: Keeps retrying upon failures, remains enabled even after success.
  - **Counted Mode (`/pvp <n>`)**: Retries on failure without limit (failures are never counted); **automatically turns off after n successful turns** and restores OMP settings.
- 📌 **Native TUI Integration (Anti-Scroll)**:
  - Custom component factory rendering with **zero indentation**, aligned with the terminal edge and status bar.
  - Conforms to OMP native design: lowercase dim text (`pvp on` / `pvp <n>`) and `theme.fg("muted")`.
  - Mounted via UI widget (`placement: "belowEditor"`) and synchronized with `setStatus`.
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

For current project only, add `-l`:

```bash
omp install -l https://github.com/Xeltra233/omp-unlimited-pvp
```

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
