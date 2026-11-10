# QQ ↔ agent-gateway 桥接（QQ 适配器）

**English**: [README.en.md](README.en.md) | **中文**: [README.md](README.md)

> 📌 **来源说明**：本项目基于 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT）二次开发，
> 原作者为 **Derpyu520** 及 qq-bridge / QSH 贡献者。本仓库为个人维护的衍生发布，与上游版本不保证同步；
> 版权与许可声明见 [LICENSE](LICENSE)；第三方组件与合规边界见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。项目介绍视频等早期资产仍托管在上游仓库的 Release 附件中。

> 🗂️ 文档索引（全部文档一句话说明 + 是否仍然有效）见 **[docs/README.md](docs/README.md)**；仓库目录/脚本命名约定见 **[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)**。
>
> 🔒 QQ 会话的权限边界与安全承诺见 **[RULES.md](RULES.md)**。
>
> 🎤 独立的「发语音」工具已拆到仓库上一级的 **`../voice-tool/`**（命令行 `voice-cli.mjs` / 图形界面 `voice-gui.mjs`），不再依赖 qq-bridge 运行。

把 QQ 消息接入 agent-gateway：QQ 好友/群发来的消息经网关 `POST /v1/inbound` 投给智能体，
智能体只能通过网关回调 `POST /v1/actions` 的动作读写 QQ。桥接是**纯 QQ 适配器**——
不直连任何智能体运行时，也不自带 MCP server；「二代仿真」的自主收发/等待/唤醒是唯一行为形态，无模式开关。

```
QQ 消息 ──► SnowLuma（OneBot v11 WS）──► 本桥接进程 ──► agent-gateway /v1/inbound ──► 智能体
                                                ▲                                        │
                                                └──── /v1/actions（模型工具回调）◄── 网关 ◄──┘
```

> **网关形态（唯一形态，无回退）**：
> - 入站消息与 proactive/wait 合成事件统一投 `POST /v1/inbound`（适配器 HMAC 签名）；
>   模型的发送/读取动作由网关回调 `POST /v1/actions`；回合文本**不产生任何出站动作**——
>   要说话必须调用 `mcp__agent-gateway__chat_qq_send_message` 等工具。
> - `config.gateway` 的 `url` / `secret` / `adapterId` 三项**缺一不可，缺失启动即失败**
>   （绝不出现「启动成功但静默丢消息」）；网关不可达时入站**如实失败**（不落回本地）。
> - 白名单是**双闸**：路由由网关 `GATEWAY_CONVERSATIONS` 裁决，桥接侧 `config.allow/deny`
>   对发送动作做第二道校验。
> - `/v1/actions/manifest` 的每条动作带 `enabled`（桥接按「实现覆盖 + configFlag」现算）；
>   新增能力 = 清单加条目 + `src/gateway/action-handlers.js` 加一行映射。

## 项目展示

📽️ [AI 仿真群友 - 项目介绍视频](https://github.com/Derpyu520/qq-bridge/releases/download/v0.1.5/project-intro.mp4)（约 11 MB，附件托管在上游仓库）

> 视频以 **Release 附件**形式托管，不在本仓库里——只想安装桥接的人不必再下载这 11 MB。

## 架构

- **QQ 侧**：`@snowluma/sdk` 的 `SnowLumaWebSocketClient`（OneBot v11 WebSocket 客户端，自动重连；token/端点自愈）
- **网关侧**：`src/gateway/` 的 `gateway-client.js`（HMAC 签名、重试、健康探活）+ `actions-manifest.json`（动作清单及 schema）+ `action-handlers.js`（动作 → QQ 能力映射）。发送/读取动作与入站投递全部经网关，桥接自身不持有任何模型凭据
- **二代仿真（唯一行为形态）**：AI 通过 `chat_qq_get_unread` / `chat_qq_get_recent` / `chat_qq_send_message`（数组分条）/ `chat_qq_wait` / `chat_qq_set_wake` 等工具自主看消息、发言、等待、设置唤醒与潜水（主名由网关按 `chat_<platform>_<action>` 生成，旧名 `qq_*` 与 `chat_*` 仍作兼容别名）；桥接负责水位、唤醒限频、发送节奏与白名单硬闸
- **本地控制台**：桥接自带 Web 控制台 `http://127.0.0.1:3100`，按操作任务分为四页——
  **运行总览**（网关连接 / SnowLuma 上游健康 / 二代 AI 会话状态 / 活动日志）、
  **访问与安全**（白名单与管理员、安全设置、state 目录 ACL、控制台令牌）、
  **调试与运维**（测试发送、二代仿真会话控制与工具开关、唤醒参数、初始提示词、会话状态、语音调试、工作区重置）、
  **工具参考**（网关动作清单）；右上角搜索框可跨页定位；浅色 / 深色双主题（跟随系统）。
  访问需要令牌（`config.json` 的 `consoleToken`；未配置时自动生成并写入 `state/console-token`——启动日志只提示位置，**不打印令牌**）
- **媒体与表情**：表情包优先走 QQ 的 CDN 直链，`get_image` 失败时用 `emoji_id` 推出 CDN 地址兜底；
  下载走统一 SSRF 防护传输（仅 http/https、禁止私有地址、逐跳校验、IPv4 优先逐地址故障切换）；
  单条消息上限默认 8MB / 64MP / 5 张（`socialV2.media`）
- **语音**：AI 发语音只能发**语音库**（`socialV2.voice.dir`，默认 `audio/`）里的文件，
  有独立的时长/体积/频率上限；默认关闭（`socialV2.voice.enabled` 与 `tools.sendVoice`）。详见 [docs/guides/VOICE.md](docs/guides/VOICE.md)

## 前置条件

1. 运行中的 agent-gateway（默认 `http://127.0.0.1:7190`；`adapterId` / `secret` 与桥接配置一致，网关侧需注册本适配器）
2. 运行中的 SnowLuma，且配置好 OneBot WebSocket 与 HTTP API（默认 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`，`accessToken` 视配置填写）
3. Node.js ≥ 22.13

## 安装与配置

```bash
npm install        # 安装依赖（postinstall 会自动修补 @snowluma/sdk 的 ESM 打包 bug）
```

复制 `config.example.json` 为 `config.json` 后编辑：

> Windows CMD 用户请用：`copy config.example.json config.json`

> ⚠️ 真实 `config.json` 与 `state/` 不会进入公开仓库，仓库只提供脱敏的 `config.example.json` 模板。

| 字段 | 说明 |
| --- | --- |
| `gateway.url` | agent-gateway 地址，默认 `http://127.0.0.1:7190`。**必填**，缺失启动即失败 |
| `gateway.secret` | 适配器 HMAC 密钥，必须与网关侧一致。**必填** |
| `gateway.adapterId` | 本适配器在网关侧的注册 id，默认 `qq-main`。**必填** |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** 地址（如 `ws://127.0.0.1:3001`） |
| `snowluma.httpUrl` | OneBot **HTTP API** 地址（如 `http://127.0.0.1:3000`）；不要填 WebSocket 端口，否则会报 HTTP 426 |
| `snowluma.accessToken` | OneBot accessToken，未配置留空 |
| `snowluma.followDiscoveredEndpoint` | 默认 `true`。换 QQ 账号后 token 与端口都会变，桥接会自愈：重新发现并**跟随** SnowLuma 的端点（同时写回 `config.json`）。**想跑第二个实例 / 指向另一份 SnowLuma 安装（多账号、测试）时设为 `false`** —— 那时只自愈 token，绝不动 URL，也不写回 URL。详见「已知行为」 |
| `snowluma.silenceWarnMs` | 上游静默告警阈值（毫秒），默认 `600000`（10 分钟）。已连接但这么久没收到任何事件包（含心跳）时打警告；这只是**提示**，不确定性的判断交给 `good` |
| `snowluma.launcherPath` / `homeDir` | SnowLuma 安装目录（用于 token/端点自发现）。⚠️ 桥接**不会**启动或停止 SnowLuma（见 `LICENSE`） |
| `ownerQQ` | 管理员 QQ 号；管理命令（`/status` / `/reset` 等）只认这个号 |
| `allow.private` / `allow.groups` | 白名单（QQ 号/群号数组）；留空且 `allowAllWhenEmpty: true` 时放行全部。发送动作的第二道闸 |
| `deny.*` | 黑名单，优先于白名单 |
| `sendDelayMs` | QQ 连续发送间隔，防止触发频率限制 |
| `consolePort` | 本地控制台端口，默认 `3100` |
| `consoleToken` | 控制台访问令牌；留空时启动自动生成并保存到 `state/console-token` |
| `socialV2.*` | 二代仿真参数（唤醒 / 发送节奏 / 等待 / 表情 / 语音 / 媒体 / 初始提示词），控制台「调试与运维」页可视化编辑 |
| `socialV2.initialPromptMaxChars` | 会话「初始提示词」（控制台为某个群/私聊预写的环境说明）的字数上限，默认 2000，允许 100~8000。越界值会在启动时收敛并保持原文件不动 |
| `socialV2.media` | 图片/表情的上限：`maxBytes`（单条消息总字节，默认 8MB）、`maxPixels`（单张像素，默认 64MP）、`maxCount`（单条最多处理几张，默认 5）。越界值启动时收敛 |

> ⚠️ `allowAllWhenEmpty: true` 表示「白名单没填就全部放行」——把 agent 接入 QQ 等于把账号控制权交给了模型，建议先填白名单。注意网关侧的 `GATEWAY_CONVERSATIONS` 才是路由裁决者：桥接白名单只拦「发出去」。

## 完整启动流程（从零开始）

1. **启动 agent-gateway**，在网关侧注册适配器（记下 `adapterId` 与 `secret`），并配置 `GATEWAY_CONVERSATIONS` 路由白名单。
2. **装桥接并复制配置**
   ```bash
   git clone https://github.com/helloCaijiaqi/qq-bridge.git
   cd qq-bridge
   npm install
   ```
   Windows CMD 用 `copy config.example.json config.json`，其他平台用 `cp config.example.json config.json`。
   填好 `gateway` 三项；**示例模板里 `allow.private` / `allow.groups` 是空数组**——空白名单 + `allowAllWhenEmpty: false` 时桥接拒绝一切发送（这是刻意的 fail-closed 默认值）。
3. **下载并解压 SnowLuma**
   - 下载：<https://github.com/SnowLuma/SnowLuma/releases/latest> 选 `SnowLuma-v<版本>-win-x64.zip`（完整版，自带 Node 运行时；Lite 版需本机 Node 22.13+）
   - 解压到任意目录（例如 `C:\SnowLuma`），双击 `launcher.bat`
4. **首次引导（WebUI）+ 填写桥接配置**
   - 打开启动日志里的 WebUI 地址（README 写的是 `http://localhost:5099`，以你启动日志里实际打印的为准）
   - 用**启动日志中的初始密码**登录，按引导：同意条款 → 设置密码 → 接入 QQ 进程（扫码登录）
   - 在 WebUI 里配置 OneBot 连接：开启 **WebSocket 服务端** 和 **HTTP API**，分别记下**端口**（默认 WS `3001`、HTTP `3000`）和 **accessToken**（若配置了）
   - 回到 `config.json` 填好 `snowluma` 段，并把 `allow.private` / `allow.groups` 换成**你自己的 QQ 号 / 群号**：

     ```json
     "snowluma": {
       "wsUrl": "ws://127.0.0.1:3001",
       "httpUrl": "http://127.0.0.1:3000",
       "accessToken": "你在 WebUI 里配置的 token（没配置就留空）"
     }
     ```

   `wsUrl` 是 OneBot **WebSocket** 端口，`httpUrl` 是 OneBot **HTTP API** 端口（不要填成同一个 WS 端口，否则动作会报 HTTP 426）。
5. **启动桥接**
   ```bash
   npm start          # 前台运行（崩溃不自动重启）
   ```
   看到 `SnowLuma 已连接` 且控制台总览显示网关已连接即成功；然后 QQ 上给机器人账号发条消息测试。
   Windows 想要「崩溃自动重启」请改用 `start.bat`（见下节）。

## 运行与运维

```bash
npm start          # 或双击 start.bat（守护模式：崩溃自动重启，关闭窗口即停止）
```

**⚠️ 重要**：
- **桥接只能运行一个实例**（有单实例锁，重复启动会被拒绝并提示"已有实例在运行"）
- **用 start.bat 启动**（守护模式），窗口别关——桥接崩溃会在 5 秒后自动拉起
- 桥接异常/消息无反应时：双击 `restart.bat`（自动杀旧实例 → 清理锁 → 重新启动守护）
- **重启网关通常不需要动桥接**：网关不可达期间入站如实失败，恢复后自动续上；网关侧会话/游标状态由网关自己的持久化负责
- 修改 `config.json` 后重启桥接生效；控制台里的白名单 / 安全设置 / 二代仿真参数保存即热更新

日志示例：

```
12:00:01 [bridge] SnowLuma 已连接：ws://127.0.0.1:3001
12:00:02 [bridge] 网关形态：adapter=qq-main → http://127.0.0.1:7190（桥接不连接智能体运行时）
12:00:03 [bridge] 入站 private:12345678 → POST /v1/inbound（routed）
```

## 自测（不需要 SnowLuma / QQ / 网关）

离线回归（使用临时目录和模拟服务，不读取真实配置、不发 QQ 消息）：

```bash
npm run test:audit          # 离线审计套件（行为、安全、媒体、协议层）
npm run verify:decouple     # 平台解耦契约静态校验（桥接零 DSH 直连、动作面 = QQ 能力）
npm run test:gateway        # 网关契约 / 状态 / 唤醒合成 / 动作层离线测试
npm run test:console-ui     # 控制台离线浏览器回归（需本机 Chrome/Edge，见 docs/guides/CONSOLE-UI-TESTING.md）
npm run preview:console     # 不启动桥接离线预览控制台（全部数据为合成数据）
```

## 目录结构

```
qq-bridge/
  config.example.json   # 配置模板（脱敏占位符；真实 config.json 不入库）
  README.md / README.en.md / RULES.md   # 根目录只留这三个文档，其余全在 docs/
  docs/                 # 文档（索引见 docs/README.md，目录约定见 docs/FOLDER_MAP.md）
  public/console.html   # 桥接自带控制台（127.0.0.1:3100，单文件：四页 + 内联 JS/CSS）
  src/
    bridge.js           # 主程序（入站投递、二代仿真、控制台后端）
    gateway/            # 网关客户端、动作清单与映射（actions-manifest.json / .schema.json 必须同目录）
    chat/               # 消息/提示词加工（md-to-plain、qq-model-view、sticker-lib、v2-wait 等）
    media/              # 语音与图片（voice-core、send-voice-lib、media-normalize、safe-fetch）
    ops/                # state 目录 ACL
    core/               # 会话路由基础设施
  scripts/              # 测试/运维脚本（约定见 docs/FOLDER_MAP.md；含 postinstall 的 patch-snowluma-sdk.mjs）
  assets/               # 仓库用图片等资源
  state/                # 运行时数据（不入库）
```

> 🎤 **独立的「发语音」工具不在这里**：它是仓库上一级的 [`../voice-tool/`](../voice-tool/)。共享内核不复制：
> 工具经 `../qq-bridge/src/media/voice-core.js` 与 `../qq-bridge/src/integrations/snowluma-conn.js` 引同一份实现。
>
> ```bash
> cd ../voice-tool
> node voice-cli.mjs status     # 账号/token 自动发现 + 连通性
> node voice-cli.mjs list       # 可发的群聊/私聊 + 语音库
> node voice-cli.mjs            # 交互菜单
> node voice-gui.mjs            # 图形界面（本地小服务 + 浏览器 UI）
> ```

## SnowLuma 版本与上游健康（「连上了但收不到消息」）

「注入」在这个技术栈里只发生在一处：**SnowLuma 用原生组件挂进 QQ 客户端进程**（它自己日志里叫
`[Hook]`，载体是安装目录的 `native/snowluma-win32-x64.{dll,node}`）。**本桥接没有任何原生/注入面**
（依赖全为纯 JS，源码里没有 `.dll` / `.node` / FFI / 进程注入），也不启动、不控制 SnowLuma 或 QQ ——
所以「QQ 注入失败」不可能是本桥接造成的。但**桥接过去无法把这个失败讲清楚**，于是它经常被误报成
「qq-bridge 的问题」。现在桥接会主动把上游健康报出来。

### 已知行为：连上了 ≠ 收得到

SnowLuma 的 `[Hook]` 会退化：它的进程和 OneBot WebSocket **都还活着**，但收不到 QQ 侧的数据。
它自己的日志长这样：

```
WARN [Hook] receive path stale: PID=… UIN=… silentFor=136193ms; reporting good=false
WARN [Hook] process enumeration timed out after 4000ms (worker abandoned)
```

这时桥接这边**一切正常**：WebSocket 通、日志打过 `SnowLuma 已连接`、控制台没有异常，但群里一条消息都不来。
桥接现在对此做两件事：

1. **主信号**：每 30 秒一次的 `meta_event/heartbeat` 载荷里的 `status.good`（SnowLuma 对「QQ → 原生 hook → 我」这条**接收链路**的自评，静默约 105 秒后翻 `false`）。心跳是 SnowLuma 自己的定时器无条件发的，所以这条信号免费且及时，且不需要较新的运行时。
   兜底：每 60 秒问一次 `get_status`（`{online, good}`）。加分项：`bot_status`（账号会话上下线，**SnowLuma 1.14.20 才真的有**）+「距最近一个事件包的时长」（只能证明进程/WS 还活着，**不能**证明收得到 QQ 数据 —— 心跳会一直来）。
   > ⚠️ **不要用 `get_login_info` 取 `good`**：它只返回 `{user_id, nickname}`，而 SDK 不校验 data 载荷 ⇒ 不会报错、`good` 永远是 `null`、这条判断变成永不触发的死代码。（本功能的第一版实现正是这么写错的，回归里已加反面断言钉住。）
2. 判定退化时：日志打**明确指向 SnowLuma `[Hook]`** 的警告、控制台「运行总览」出现 `SnowLuma 上游` 卡片、
   「访问与安全」页出现告警条，`GET /api/status` 的 `snowluma` 字段给出 `degraded` / `good` / `hint`。

排查顺序：控制台看 `SnowLuma 上游` 卡片 → 看 SnowLuma 的 `logs/snowluma-*.log` 里的 `[Hook]` 行 → 再考虑升级 SnowLuma（**升级不换原生组件，见下**）。

### 版本要求

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| SnowLuma **运行时**（QQ 网关本体） | **1.14.20 已实测**（1.14.9 亦兼容） | **实测记录（2026-10-03，SnowLuma 1.14.20 + QQ 在线）**：包 SHA256 与官方发布摘要一致；心跳 `status.good=true`／`interval=30000`；桥接走完「首次 1006 → 自愈 WS token → 已连接」；收到群消息（`lastPacketKind: message/group`）；完整往返成功。 ⚠️ **升级运行时不会更换注入用的原生组件**：实测 `native/snowluma-win32-x64.{dll,node}` 与 `websocket-win32-x64.node` 在 **1.14.9 与 1.14.20 之间逐字节完全相同**，变的只有 `index.mjs`（+414 KB）等 JS 层。所以**升级能带来 OneBot 事件流水线、收发与新区块链路上的修复（`bot_status`、markdown 带 text、事件种类订阅更全），但不会修「原生 hook 挂不上 QQ」这类问题** —— 那种要走 SnowLuma 自己的排查。**升级 SnowLuma 是使用者自己的事**：本桥接只探测、不部署（见 [LICENSE](LICENSE) 与 [RULES.md](RULES.md)） |
| `@snowluma/sdk`（本仓库依赖） | 已钉 `^1.14.20` | 客户端库；OneBot v11 是稳定契约，新库可连旧运行时（本项目实测：库 1.14.20 + 运行时 1.14.9 可正常收发） |
| `bot_status`（账号上下线） | **1.14.20 有；1.14.9 没有** | 逐一核对的只有这两个版本：`bot_status` 在 1.14.9 的 `index.mjs` 里出现 **0** 次、1.14.20 里 **3** 次（带 `sub_type`/`user_id`）。**具体从哪个版本引入未逐版核对**。桥接对老运行时**优雅降级**：订阅不到就只靠心跳 `good` 与 `get_status` |

### 已知行为：HTTP token 与 WS token 是**两个不同的值**

SnowLuma 同一个账号的 **HTTP token（默认 3000 端口）与 WebSocket token（默认 3001 端口）并不相同**
（实测；`snowluma.accessToken` 里通常只能存一个 —— 存的是 HTTP 那个）。因此：

- **桥接每次启动的首次 WS 连接几乎必然失败一次**（日志里 `SnowLuma 连接断开（code=1006）` →
  `SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）`），随后自愈重新发现 WS token、
  重连成功，才打出 `SnowLuma 已连接`。**这条序列是正常的，不是故障。**
- 真正会一直连不上的情况：**自愈无从下手** —— `snowluma.homeDir` 没配 / 被移动 / 读不到
  SnowLuma 的 `config/onebot_<QQ号>.json`，或权限不足。这时日志里会有 `token 自愈失败`，
  而 QQ 侧表现为**完全收不到消息**。先确认 `homeDir` 指向真正的 SnowLuma 安装目录。

### 已知行为：端点自愈会覆盖你写的 `wsUrl`

换 QQ 账号后 OneBot 端口与 token 都会变，所以桥接在连不上时会自愈：重新发现 SnowLuma 的端点并
**写回 `config.json`**。这在主场景下是对的，但它不区分「配置里是个过期值」和「你就是要指向别处」——
想跑第二个实例或指向另一份 SnowLuma 安装时会连错账号。要关掉：

```json
"snowluma": { "followDiscoveredEndpoint": false }
```

关掉后**只自愈 token**（换账号仍能恢复），绝不动 URL、也不写回 URL。

### 控制台令牌怎么传（2026-11 起）

优先级：`x-console-token` 头 > 会话 Cookie > `?token=`（**仅** `GET /` 首次引导）。用浏览器打开
`http://127.0.0.1:3100/?token=<令牌>` 时，服务端种一个 `HttpOnly; SameSite=Strict` 的
`qqb_console` Cookie 并 303 到不带令牌的 `/`——令牌不会留在浏览器历史 / Referer 里。
脚本调用请直接带 `x-console-token: <令牌>`；API 上带 `?token=` 会被 401 拒绝。

## 已知限制

- AI 回复按工具调用逐条发送（`chat_qq_send_message` 数组分条），发送节奏由 `socialV2.send` 约束（条间间隔、每分钟/每小时上限、单条字数上限默认 500 字）
- 图片及部分表情可以通过安全下载接入多模态链路；语音/视频以及无法取得图片字节的消息仍使用占位文本
- **发**语音是支持的（独立工具的图形界面 / 命令行 / AI 工具，见 `docs/README.md` 的文档索引）；但**收**到的语音目前只显示占位文本，不做语音转写入上下文
- **AI 发语音默认关闭**（`socialV2.voice.enabled` 与 `tools.sendVoice` 默认 `false`）：先把音频放进 `audio/`，再到控制台打开开关；你自己发语音不受这个开关影响
- agent 的 Markdown 回复会转成纯文本（链接保留 `文字 (url)` 形式）
- `@snowluma/sdk` 的 npm 发布版存在 ESM 扩展名 bug，本仓库通过 postinstall 补丁修复（见 `scripts/patch-snowluma-sdk.mjs`）

## 合规提醒

SnowLuma 是独立第三方项目，与腾讯/QQ 无隶属关系，仅供学习与技术研究；使用前请阅读其 EULA 与《QQ 用户协议》。
