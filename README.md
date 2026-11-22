# omp-unlimited-pvp

**oh-my-pi (OMP)** 专用的无限自动重试插件，支持防模型 Fallback 锁定与 0 延迟无冷却调度。

在 OMP 中输入 `/pvp`，可提高原生重试预算、关闭基础退避并禁用模型 Fallback 链，在失败后就地继续请求，直到成功或用户停止。OMP 原生恢复逻辑提前结算时，插件会接管续跑，不把供应商失败留在聊天里。具体边界见下文。

## 版本兼容（v0.3.1）

已逐版本验证共 **29 个发布版本**：**18.1.14～18.1.22、18.2.0～18.2.11、18.3.0～18.3.5、18.4.0～18.4.1**。18.1.14 是原项目锁文件版本，也是该批兼容性验证确认的工作下限；更早版本及未来版本未验收。该 29 版本结论来自此前单独的兼容性验证，并非本轮逐版重跑；当前看门狗门禁相关改动不自动继承该结论。

- 设置覆写按当前会话的设置对象自动适配两条通道：旧版点分路径 `override`/`clearOverride`；或会话自身 `session.settings` 实例的 `writeValue`/`clearOverrideValue`，配合 SDK 导出的真实 `retry.*` handle（`cfgRetry*`）。不使用模块级单例或自建 handle，也不会在插件加载器里查一份独立的 `config/registry` 副本。
- 设置覆写不可用时只告警、不再拒绝开启：续跑由插件兜底，不依赖覆写是否成功。
- 修复插件先卸载、异步 import 后完成造成 Hook 残留的问题。
- 修复 OMP 判为不可重试的错误（如 `upstream_http2_stream_error`）导致的终结：`session_stop` 以 `decision: "block"` 强制续跑，绕过 OMP 的 8 次续跑上限；`auto_retry_end` 失败后 1.2s 内没有新回合时由插件重启该回合。
- 此前独立兼容性批次使用真实 `omp` 二进制加载已安装插件 + 本地合成供应商流：连续 9 次与连续 12 次 `upstream_http2_stream_error` 都以成功收尾（第 11 次重试已超过 OMP 的 8 次续跑上限），计数模式、abort、模型保持、用户消息不重复。该结论仅属那一批次，不自动代表当前 wiring 改动或后续 native 场景；外部供应商未验收。

- 同一 live `session.settings` 已实测：`/pvp on` 后六项 `retry.*` 生效（`prov=runtime`），`PVP ON` 通知 1 次、误告警 0；`/pvp off` 后六项按同 scope 精确还原到 baseline（`retry.enabled=false/global`，其余 `undefined/default`）。覆写只存在于当前会话内存，不写用户的 `config.yml` 或 `settings.json` 本地物理配置文件。
- 真 bundled CLI 上，9 次 JSON 503 后第 10 次 POST 返回 200，`prompt_result` completed、`agentInvoked` / `sessionSettled` 为 true；10 次 POST 每次 1 条用户消息。该卡 startup 的 `/pvp on` 早于 live 绑定并出现宿主 0.5/1/2/4/8s 退避，不作为零冷却证据。
- 真 bundled CLI 的同文 HTML 503 在同一回合恢复后再次故障时重新停泊；最终原请求完成。同会话下一条请求再次故障也恢复完成：共三个门禁、5 次 POST（503/503/200/503/200），每次请求只包含一份当前用户提示。
- 真 `abort_and_prompt` 替换中，旧请求返回 `aborted`；新请求独立停泊，恢复后由新请求自己的 POST 200 与 `prompt_result completed` 收尾，不复活旧请求。

**实现边界**：原生重试预算为 `999999`，并非数学意义上的无限；普通 503 的基础退避为 0。供应商 Retry-After、额度等待、上下文恢复等仍由 OMP 原生逻辑决定。abort 与上下文溢出始终交给 OMP 处理，PVP 不重试。零延迟只保证在事件触发后立即续跑，不保证每次派发时间完全一致。


---

## 🌟 核心特性

- ⚡ **无冷却立即重试（Zero Cooldown）**：绕过 OMP 内置的指数回退延迟（2s、4s、8s 等），在请求失败并结算后立即重新发起。
- ♾️ **无限次重试（Unlimited Retries）**：突破 OMP 默认 3 次重试上限，自动循环重试直至成功。
- 🛡️ **原生防 Fallback 保障（Anti-Fallback Protection）**：
  - **动态运行时覆盖**：按当前会话设置对象自动适配两条通道——旧版点分路径 `override`/`clearOverride`，或 OMP 18.4 会话 `session.settings` 实例的 `writeValue`/`clearOverrideValue` 配合 SDK 导出的真实 `retry.*` handle（`cfgRetry*`）；不使用独立 `config/registry` 副本查找。覆盖内容为关闭 `retry.modelFallback`、清空 `retry.fallbackChains`，并保持 `retry.enabled = true` 以使用原生就地重试；
  - **模型锁定与还原**：在会话启动时记录活跃模型，若捕获到任何意外的 `retry_fallback_applied` 事件，立即发出通知并强制通过 `pi.setModel` 切回原始模型。实时 `pi.setModel` 会在执行原操作**之前**先取消旧 gate（OMP 没有 `model_select` 事件），避免过期 `wait` 影响新模型回合。
  - **纯内存安全运行**：退出 PVP 或会话注销（`session_shutdown`）时自动完整清除 override 覆盖，绝不污染用户的 `config.yml` 或 `settings.json` 本地物理配置文件。
  - **绝不污染错误消息**：杜绝传统插件强行注入 `"quota exceeded"` 伪造额度耗尽的做法（该做法在 OMP 中会被识别为 `Flag.UsageLimit` 导致账号被锁），完全以纯净合规的系统级方式接管重试。
- 🎯 **双重运行模式**：
  - **常驻模式（`/pvp` 或 `/pvp on`）**：PVP 状态持续生效；单次请求成功后依然保持开启，适合不稳定渠道或高频调优。
  - **计数模式（`/pvp <n>`）**：开启后遇到失败无限自动重试（失败不计次），**累计成功 n 次后自动关闭 PVP 模式**并恢复 OMP 原始设置。
- 📌 **无缝融入原生 TUI 的固定指示（防滚走）**：
  - 采用组件工厂直接渲染状态行，尽量贴近终端左边缘，避免内置字符串组件的强制左侧边距；具体像素级对齐/外观未做截图验收，以实际宿主主题与终端渲染为准。
  - 使用小写字形（`pvp on` / `pvp <n>`）与主题中性灰阶（`theme.fg("muted")` / `theme.fg("dim")`），沿用原生状态栏的视觉风格；不承诺与内置组件在所有主题下逐像素一致。
  - 采用 UI Widget 机制（`placement: "belowEditor"`）将状态挂载在输入框下方，并同步更新底部状态栏 `setStatus`，即使聊天产生海量文本向上滚动，状态依然清晰常驻。
  - 关闭 PVP 或计数模式达成目标后，挂件与状态栏标记均自动彻底移除。
- 💬 **极简明了的切换提示**：
  - 切换模式时统一以最简洁的形式提示：`PVP ON`、`PVP <n>`、`PVP OFF`，绝不输出啰嗦多余的长句子。
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

项目级安装只对 marketplace 源（`name@marketplace`）生效：`omp install --scope=project name@marketplace`。本地目录安装使用下面的 `omp install <path>` 入口；项目内安装请改用已验证的插件入口 `omp plugin install` / `omp plugin link`。

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
| `/pvp <n>` | 计数模式 | `PVP <n>` | 开启计数重试模式，输入框下方与状态栏均原生呈现顶格对齐的 `pvp <n>`（进度显示为 `(x/n)`）；**累计成功 n 次后自动关闭并提示 `PVP OFF`，恢复 OMP 原生设置**。 |
| `/pvp off` | 关闭 | `PVP OFF` | 手动关闭 PVP 模式，取消所有挂起重试，彻底清理常驻挂件与状态栏，恢复 OMP 原始设置。 |

### 参数补全

输入 `/pvp ` 并按 `Tab` 键即可自动补全参数：`on`、`off`。

---

## 🔍 工作原理

1. **原生就地重试（In-Place Retry）**：当开启 PVP 模式时，插件深度联动 OMP / Pi 核心运行循环，在模型请求或网络失败时就地移除报错 assistant 消息并直接在底层状态机就地重试（`agent.continue()`）。OMP 原生链接管不了失败时（重试预算耗尽、判定不可重试、Fallback 路径先结算），插件用 `session_stop` 续跑接管；最后兜底才发一条 `display: false` 的隐藏消息重启回合，因此聊天记录里不会出现重复的用户消息或重试噪声。
2. **防 Fallback 拦截与设置覆盖**：开启 PVP 时，`SettingsGuard` 通过当前 OMP 版本可用的通道写入内存级覆写：禁用 `retry.modelFallback`、清空 `retry.fallbackChains`、保持重试链路就绪、解除次数上限（`retry.maxRetries = 999999`）与退避延迟（`retry.baseDelayMs`/`retry.maxDelayMs = 0`），锁定当前所选模型。覆写只是加速手段；写不进去时 PVP 依旧开启，由续跑兜底保证不终结。
3. **状态同步与尝试计数**：重试发生时实时更新挂载在输入框下方的 widget 与底部状态栏标记（`pvp on (第 X 次重试)`），清楚感知当前重试进度。
4. **成功判定与生命周期**：
   - 收到 `stop` 或 `length` 等正常终结信号即判定为成功，重试计数清零。
   - 计数模式（`<n>`）累计成功达到目标后自动执行 `disable()`、还原 OMP 原始设置并发送 `PVP OFF` 通知。
   - 用户主动按下 `Ctrl+C` 中断时立即停止重试，重试计数清零。
5. **可选看门狗协调（不装则行为完全不变）**：若同时加载 `omp-wakeguard`，PVP 在每次原生重试前通过事件总线频道 `omp-wakeguard:before-retry:v1` 同步发布一条门禁请求：

   ```text
   PvpRetryGateRequest = {
     version: 1;
     errorMessage: string;
     model?: { provider: string; id: string; api: string; baseUrl: string };
     signal: AbortSignal;
     status?: number;           // 同一次失败 HTTP 响应的状态码，绝不沿用上一响应
     contentType?: string;      // 同一次失败响应的 content-type（供结构化错误分类）
     wait?: Promise<boolean>;   // 仅由监听方同步赋值
   }
   ```

   每次原生重试前由 `options.fetch` 包装器在失败的那次 HTTP 响应上就地取证：`status` / `contentType` 都来自这**同一次 attempt 的同一个响应**（响应体预览会修正 JSON/HTML 判定），绝不继承更早响应的 metadata；没有拿到本次 HTTP Response 时这两个字段缺省，看门狗不得沿用旧 `status`/`contentType` 去分类。据此区分「服务端在应答的 JSON 错误，继续 PVP」与「误标为 json 的 HTML 关站页，继续 park 探测」。

   - 没有监听方赋值 `wait`：PVP 完全按原逻辑重试（零行为变化；不装看门狗就是这个状态）。
   - `wait` 尚未落定：本次 run 就地挂起——不 omit 上下文、不计重试次数、不动计数模式的成功计数；看门狗探测到接口恢复后 `resolve(true)`，同一个 run 继续原生重试。
   - 同一次失败的多个重试入口共享等待；恢复后新一轮失败即使错误文本完全相同，也重新进入门禁，不复用上一次的放行结果。
   - `resolve(false)`：取消本次 run，不重试，不关闭 PVP、不改变成功计数与模式。
   - reject：取消本次 run，只提示固定文案 `PVP: 看门狗探测失败，本次不重试`，不回显可能含秘密的错误文本。
   - `signal` 会在 `/pvp off`、用户 abort、**模型切换**、切换/分叉会话或 tree 切换、`session_shutdown`、提交新 prompt 时中止；被取消的门禁即使之后才 `resolve(true)` 也不会复活旧 run（PVP 用 epoch 递增丢弃过期 `wait`）。模型切换指活跃模型 `provider`/`id`/`baseUrl` 变化：OMP 没有 `model_select`，看门狗在 `session_switch`（模型纪元边界）里既 `bindModel`（判定改变即清空响应元数据），也 `cancelGate`，避免把旧模型的失败证据归到新模型。
   - 看门狗加载后默认 `off`，只有用户显式 `/wakeguard on` 才启用，并且**立即探测一次**，之后按默认 `600000`ms（10 分钟）节律探测，可用 `/wakeguard interval` 调整。
   - 探针是一次**不带凭据的 `GET <baseUrl>/models`**（带硬超时）。它只能证明端点可达、**不能证明模型真的可用**（鉴权、额度、模型态不在探针覆盖范围内）；恢复后仍由原生重试做真正的裁决。
   - 分类边界：结构化的 `401` / `403` / `429` / `503` JSON 响应属于**供应商错误**，接口是活的，PVP 照常自行重试，看门狗不停泊；只有非结构化的错误页面（如网关 HTML）或传输层/网络故障才触发暂停等待探测。
   - 该协调只依赖事件总线，不修改 OMP 的 settings/凭据，也不改变 `retry.enabled` 语义。

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
   omp plugin uninstall omp-unlimited-pvp
   ```
   `omp remove` **不是**有效命令：它没有子命令实现，会把参数当作消息直接启动会话。查看已装插件用 `omp plugin list`。
2. 若在配置文件的 `extensions` 数组中配置：从数组中删除对应路径即可。

---

## 📄 开源许可

[MIT License](LICENSE)
