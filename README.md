# omp-unlimited-pvp

**oh-my-pi (OMP)** 专用的无限自动重试插件，支持防模型 Fallback 锁定与 0 延迟无冷却调度。

用户在 OMP 中输入 `/pvp` 即可开启无限自动重试模式：在模型请求或网络失败时**无限自动重试**、**不用冷却**（0 延迟调度）、**不受默认重试次数限制**，并且**坚决锁定当前所选模型，绝不触发 OMP 的模型 Fallback 降级切换**，直到请求成功或用户主动停止。

---

## 🌟 核心特性

- ⚡ **无冷却立即重试（Zero Cooldown）**：绕过 OMP 内置的指数回退延迟（2s、4s、8s 等），在请求失败并结算后立即重新发起。
- ♾️ **无限次重试（Unlimited Retries）**：突破 OMP 默认 3 次重试上限，自动循环重试直至成功。
- 🛡️ **原生防 Fallback 保障（Anti-Fallback Protection）**：
  - **动态运行时覆盖**：开启 PVP 时，自动通过 OMP 原生 `Settings.override` 机制临时关闭 `retry.modelFallback` 与 `retry.enabled`，并置空 `retry.fallbackChains`。
  - **模型锁定与还原**：在会话启动时记录活跃模型，若捕获到任何意外的 `retry_fallback_applied` 事件，立即发出通知并强制通过 `pi.setModel` 切回原始模型。
  - **纯内存安全运行**：退出 PVP 或会话注销（`session_shutdown`）时自动完整清除 override 覆盖，绝不污染用户的 `config.yml` 或 `settings.json` 本地物理配置文件。
  - **绝不污染错误消息**：杜绝传统插件强行注入 `"quota exceeded"` 伪造额度耗尽的做法（该做法在 OMP 中会被识别为 `Flag.UsageLimit` 导致账号被锁），完全以纯净合规的系统级方式接管重试。
- 🎯 **双重运行模式**：
  - **常驻模式（`/pvp` 或 `/pvp on`）**：PVP 状态持续生效；单次请求成功后依然保持开启，适合不稳定渠道或高频调优。
  - **一次性模式（`/pvp one`）**：开启后遇到失败无限自动重试，**一旦模型请求成功便自动关闭 PVP 模式**并恢复 OMP 原始设置。
- 📌 **无缝融入原生 TUI 的固定指示（防滚走）**：
  - 采用组件工厂直接渲染，消除内置字符串组件的强制左侧边距，实现 **0 缩进顶格对齐**，与上方的 Git 分支及终端左边缘 100% 垂直平齐。
  - 严格遵循 OMP 原生状态栏设计规范，使用标准小写字形（`pvp on` / `pvp one`）与主题中性灰阶（`theme.fg("muted")` / `theme.fg("dim")`），字体大小、行高、基线完全对齐。
  - 采用 UI Widget 机制（`placement: "belowEditor"`）将状态挂载在输入框下方，并同步更新底部状态栏 `setStatus`，即使聊天产生海量文本向上滚动，状态依然清晰常驻。
  - 关闭 PVP 或一次性模式成功后，挂件与状态栏标记均自动彻底移除。
- 💬 **极简明了的切换提示**：
  - 切换模式时统一以最简洁的形式提示：`PVP ON`、`PVP ONE`、`PVP OFF`，绝不输出啰嗦多余的长句子。
- 🛡️ **安全清理与中断响应**：
  - 用户按下 `Ctrl+C` 主动 abort 或关闭时，立即取消待执行重试并清理计时器。
  - 会话退出或切换（`session_shutdown`）自动完成全量状态清理与设置还原。

---

## 📦 安装方法

### 方式 1：通过 Git 远程一键安装（推荐）

在终端中运行以下命令，OMP 会自动克隆并添加到全局配置中：

```bash
omp install https://github.com/Xeltra233/omp-unlimited-pvp
# 或使用 git 协议简写
omp install git:github.com/Xeltra233/omp-unlimited-pvp
```

如果只想在当前项目生效，可加上 `-l` 参数：

```bash
omp install -l https://github.com/Xeltra233/omp-unlimited-pvp
```

### 方式 2：本地目录指令安装

如果已经将代码克隆到本地，也可以直接使用 `omp install` 指定本地路径安装：

```bash
omp install /path/to/omp-unlimited-pvp
# 或在项目根目录下直接运行
omp install .
```

### 方式 3：单次免安装试用

无需安装到配置，仅在本次会话中加载：

```bash
omp -e git:github.com/Xeltra233/omp-unlimited-pvp
# 或指定本地路径
omp -e /path/to/omp-unlimited-pvp
```

---

## 🚀 使用指南

进入 OMP 交互会话后，直接在输入框输入以下命令：

| 命令 | 模式 | 交互提示 | 显示位置与行为 |
| :--- | :--- | :--- | :--- |
| `/pvp` | 常驻模式 | `PVP ON` | 开启无限重试常驻模式，输入框下方与状态栏均原生呈现顶格对齐的 `pvp on`（不随聊天滚动）；成功后继续保持。同时激活防 Fallback 保护。 |
| `/pvp on` | 常驻模式 | `PVP ON` | 与 `/pvp` 等价，显式开启常驻模式。 |
| `/pvp one` | 一次性模式 | `PVP ONE` | 开启一次性重试模式，输入框下方与状态栏均原生呈现顶格对齐的 `pvp one`；**模型成功后自动关闭并提示 `PVP OFF`，恢复 OMP 原生设置**。 |
| `/pvp off` | 关闭 | `PVP OFF` | 手动关闭 PVP 模式，取消所有挂起重试，彻底清理常驻挂件与状态栏，恢复 OMP 原始设置。 |

### 参数补全

输入 `/pvp ` 并按 `Tab` 键即可自动补全参数：`on`、`one`、`off`。

---

## 🔍 工作原理

1. **防 Fallback 拦截与设置覆盖**：
   - 开启 PVP 时，`SettingsGuard` 介入，通过内存级 `Settings.override` 接口禁用 `retry.modelFallback` 和 `retry.enabled`。
   - 这一方面阻止了 OMP 内核在报错后自动触发模型降级链，另一方面关闭了内核默认的 2s/4s 指数退避重试，使失败能立即交付给会话层。
2. **提示词与多模态快照**：
   - 在 `before_agent_start` 生命周期中记录用户输入的 prompt 文本与附带的多模态图片，同时记录当前会话的原始模型引用。
3. **异常检测与重试标记**：
   - 在 `turn_end` 捕获到模型错误（`stopReason === "error"`），标记 `pendingRetry = true` 并递增当前重试轮次，实时更新 UI 挂件显示 `(第 N 次重试)`。
4. **结算后零延迟派发**：
   - 在 OMP 的 `agent_end` 事件中（确认 `willContinue === false` 且会话完全结算），通过微任务 `setTimeout(..., 0)` 调用 `pi.sendUserMessage`（携带 `{ deliverAs: "followUp" }`），无延迟发起重试。
5. **成功重置与安全清理**：
   - 当模型返回 `stop` 或 `length` 时判定成功：
     - 若处于 `one` 模式，自动退出 PVP 模式、调用 `clearOverride` 还原配置，并提示 `PVP OFF`；
     - 若处于 `persistent` 模式，清空重试计数并维持 PVP 开启状态。
   - 用户主动 `Ctrl+C` 中断（`stopReason === "aborted"`）时立即取消任何计划中的重试。

---

## 🛠️ 本地开发与测试

本项目使用 TypeScript 与 Bun 构建：

```bash
# 运行单元测试套件
bun test

# 运行 TypeScript 类型检查
bun run typecheck

# 生产构建（输出到 dist/ 目录）
bun run build
```

---

## 🗑️ 卸载方法

1. 若通过 `omp install` 安装：
   ```bash
   omp remove omp-unlimited-pvp
   ```
2. 若在配置文件的 `extensions` 数组中配置：从数组中删除对应路径即可。

---

## 📄 开源许可

[MIT License](LICENSE)
