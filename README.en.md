# omp-unlimited-pvp

Unlimited automatic retry plugin specifically crafted for **oh-my-pi (OMP)** with anti-fallback model locking and zero-cooldown scheduling.

By entering `/pvp` in OMP, you can activate the unlimited retry mode: on model or network request failure, it will **retry infinitely without cooldown** (0-delay dispatch), **without default retry limits**, and **strictly lock the selected model without triggering OMP's model fallback / downgrade chains**, until the request succeeds or the user aborts.

---

## 🌟 Key Features

- ⚡ **Zero-Cooldown Immediate Retry**: Completely bypasses OMP's built-in exponential backoff delays (2s, 4s, 8s, etc.), re-dispatching immediately after turn settle.
- ♾️ **Unlimited Retries**: Removes OMP's default retry limit, continuously retrying until success.
- 🛡️ **Native Anti-Fallback Protection**:
  - **Dynamic Runtime Overrides**: When PVP is enabled, OMP's native `Settings.override` is invoked to temporarily set `retry.modelFallback = false`, `retry.enabled = false`, and clear `retry.fallbackChains`.
  - **Model Locking & Restoration**: Snapshots the active model on agent start. If any unexpected `retry_fallback_applied` event is detected, it alerts the UI and forcibly switches back via `pi.setModel`.
  - **Clean In-Memory Operation**: All overrides are cleared in memory upon disabling PVP or session shutdown (`session_shutdown`), leaving user configuration files untouched.
  - **No Error Message Pollution**: Avoids injecting dummy `"quota exceeded"` markers that would otherwise trigger OMP's `Flag.UsageLimit` and lock API credentials.
- 🎯 **Dual Modes**:
  - **Persistent Mode (`/pvp` or `/pvp on`)**: Keeps retrying upon failures, remains enabled even after success.
  - **One-Shot Mode (`/pvp one`)**: Retries on failure, but **automatically turns off PVP once the model succeeds**.
- 📌 **Native TUI Integration (Anti-Scroll)**:
  - Custom component factory rendering with **zero indentation**, aligned with the terminal edge and status bar.
  - Conforms to OMP native design: lowercase dim text (`pvp on` / `pvp one`) and `theme.fg("muted")`.
  - Mounted via UI widget (`placement: "belowEditor"`) and synchronized with `setStatus`.
- 💬 **Minimalist Feedback**:
  - Direct and clean status notifications: `PVP ON`, `PVP ONE`, `PVP OFF`.
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
| `/pvp one` | One-shot | `PVP ONE` | Infinite retries on failure, **automatically disables upon success and notifies `PVP OFF`**. |
| `/pvp off` | Disabled | `PVP OFF` | Disables PVP, clears status widgets, and restores original OMP settings. |

### Argument Completion

Type `/pvp ` and press `Tab` to autocomplete `on`, `one`, `off`.

---

## 🔍 How It Works

1. **Native In-Place Retry**: When PVP is enabled, the plugin hooks into the underlying agent execution loop. Upon error, it removes the failed assistant message and retries in place (`agent.continue()`), **never dispatching duplicate user messages** into the chat transcript.
2. **Anti-Fallback & Zero Delay**: Overrides OMP runtime settings via `Settings.override` to disable model fallback (`retry.modelFallback = false`) and fallback chains, while eliminating retry delay (`retry.baseDelayMs = 0`) and removing attempt caps (`retry.maxRetries = 999999`).
3. **Live Status Synchronization**: Real-time status update below the input editor (`pvp on (第 X 次重试)`).
4. **Lifecycle & Completion**: Resets retry count to zero upon successful turn completion (`stop` / `length`). In one-shot mode (`/pvp one`), automatically turns off and restores original settings.

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
