# 仓库目录地图（FOLDER_MAP）

> 一句话说明每个顶层目录干什么、`scripts/` 里的命名约定是什么。
> 本文**只描述现状**，不构成改动指令。文档索引见 [README.md](README.md)。
>
> 最后核对：2026-11-07（gateway-only 精简重构后）。新增目录/脚本时请顺手补一行。

---

## 一、顶层布局

```
工作区根（不是仓库根）
├── qq-bridge/               ← 本仓库（QQ 适配器：SnowLuma ↔ agent-gateway）
├── agent-gateway/           ← 平台网关：/v1/inbound 入站 + /v1/actions 动作回调（本仓库的唯一上游）
├── voice-tool/              ← 独立「发语音」工具（从 qq-bridge 拆出；不依赖桥接运行）
└── 发语音-图形界面.cmd      ← 工作区根的双击启动器 → 进 voice-tool/ 起图形界面
```

> 旧平级服务 `memory-mcp/` / `rolecard-mcp/`（会话记忆 / 角色卡人格段）**qq-bridge 已不再引用**：
> 桥接侧的记忆/角色/黑话实现与客户端已随精简重构删除，相关能力归网关侧（见 `docs/design/AGENT_GATEWAY.md`）。

`qq-bridge/` 内部：

| 目录 | 作用 | 能不能删/动 |
| --- | --- | --- |
| `src/` | **桥接内核**：入口 `bridge.js` + 七个功能子目录（见下） | 不能动。`bridge.js` 是主程序（约 8,100 行）；`voice-core.js` 与 `snowluma-conn.js` 是**独立工具也在用的单一实现** |
| `scripts/` | 测试 / 运维 / 一次性脚本（见第二节命名约定） | 测试脚本不能删；`test-audit.mjs` 清单改动需同步 |
| `public/` | 浏览器静态资源：`console.html`（桥接自带控制台，127.0.0.1:3100，四页单文件） | 目录里只应有这一个文件 |
| `assets/` | 仓库用图片等资源 | 别加体积大的二进制 |
| `state/` | **运行时数据**（会话/仿真状态、日志、锁、令牌）。`.gitignore` 排除 | **用户数据，绝不删除/移动** |
| `docs/` | 全部文档，按用途分子目录（见第三节） | 见第三节 |
| `node_modules/` `.npm-cache/` | 依赖与 npm 缓存 | 忽略 |
| `config.json` | 运行配置（真实配置**不入库**）；模板是 `config.example.json` | 值属于用户，别改 |

> 精简重构已删除的目录：`dsh/`（agent preset 模板）、`plugins/`（DSH 插件）、`roles/`（人格卡）、
> `audio/`（语音库，用户自建）——preset/人格/记忆/黑话全部上移到网关与智能体侧。
> 语音库目录在开启 AI 发语音时按 `socialV2.voice.dir` 自行创建。
> 2026-11-16 补充：若本地仍存在 `plugins/`，它是**历史归档（未入库）**——DSH 侧 preset/插件已自托管在
> `~/.dsh/plugins/`，仓库这份不再被任何 junction 指向，可随时手工删除。

### `src/` 内部结构

顶层只放入口 `bridge.js`；其余文件按功能域进子目录。**新增文件请落到对应域，不要平铺回顶层**（`scripts/test-src-layout.mjs` 会拦）。

| 子目录 | 职责 | 包含 |
| --- | --- | --- |
| `core/` | 网关接线配置：加载 / 迁移 / 热加载 `gateway.json`（纯适配器形态下唯一的核心配置件） | `gateway-config.js` |
| `gateway/` | 与 agent-gateway 的全部契约（HTTP + WS 双栈：`gateway.transport=http|ws|auto`，WS 连接管理收在 client 内部） | `gateway-client.js`、`gateway-actions.js`、`action-handlers.js`、`actions-manifest.js`、`actions-manifest.json`、`actions-manifest.schema.json`、`wait-registry.js` |
| `chat/` | 聊天内容加工 | `md-to-plain.js`、`qq-model-view.js`、`forward.js`、`sensitive.js`、`sticker-lib.js`、`v2-wait.js` |
| `media/` | 语音、图片与安全传输 | `voice-core.js`、`send-voice-lib.js`、`media-normalize.js`、`safe-fetch.js` |
| `integrations/` | 外部服务客户端 | `snowluma-conn.js` |
| `ops/` | 运维 | `state-acl.mjs` |
| `shared/` | 跨域小件 | `http-client.js` |

> `gateway/actions-manifest.js` 用自身所在目录定位同目录的 `actions-manifest.json` 与 `.schema.json`：三者必须一起移动。
> `media/` 下的 `safe-fetch.js` 是唯一的出站 HTTP 传输（SSRF 防护），带 SSRF 需求的新代码一律复用它。

---

## 二、`scripts/` 命名约定

脚本共 55 个文件（52 个 `.mjs` + 2 个 JSON 基线 + 1 个示例规则，另有 `fixtures/` 目录）。按前缀区分用途：

| 前缀 / 形态 | 含义 | 归宿 |
| --- | --- | --- |
| `test-*.mjs` | **自动化测试**。其中被 `scripts/test-audit.mjs` 列进 `tests[]` 的那些会跑在 `npm run test:audit` 里（离线、不发真 QQ 消息、不用生产凭据）。表末 4 个 `test-*` 是手动脚本，**不**在自动清单里 | 保留，改动需同步 test-audit 清单 |
| `test-audit-*.mjs` | test-audit 的子模块（`test-audit-bridge` / `-security` / `-protocol-helpers`），被上一个直接运行 | 保留 |
| `test-gateway-*.mjs` / `test-action-layer.mjs` / `test-wait-*.mjs` / `test-wake-synthetic.mjs` | **网关契约面**：`test-gateway-contracts`（/v1/inbound + /v1/actions 契约）、`test-gateway-state`（mailbox 快照）、动作层与等待注册表。`npm run test:gateway` 聚合运行 | 保留 |
| `test-console-ui.mjs` + `console-ui-*.json` / `console-ui-fixture.mjs` / `fixtures/` | 控制台**离线浏览器回归**与契约（`npm run test:console-ui` / `npm run preview:console`），说明见 [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md)。基线两份：`console-ui-legacy-ids.json`（DOM id 钉子）与 `console-ui-contracts.json`（写端点计数基线） | 保留（契约真变时才重生成） |
| `send-*.mjs` | 面向 SnowLuma/QQ 的**真发送**小工具（`send-voice.mjs` 走桥接；`send-test-group.mjs` 发测试群） | 保留，但注意会真的发消息 |
| `verify-*.mjs` | **一致性校验**：`verify-decouple.mjs`（平台解耦守卫，默认离线静态契约；`npm run verify:decouple`） | 保留 |
| `probe-snowluma-heartbeat.mjs` | 只读探针：连 SnowLuma 的 OneBot WS，等一个 `meta_event/heartbeat`，打印载荷里的 `status.online` / **`status.good`**。桥接的上游健康主信号就是这个字段——它存不存在、拼写对不对只能拿**真实运行时**验证（SDK 不校验 data 载荷，取错字段不会报错）。不发消息 | 保留（`npm run probe:heartbeat`） |
| `voice-tool-locator.mjs` | 「发语音」独立工具（在仓库上一级 `../voice-tool/`）的位置解析 + 「它不在本仓库」时的统一跳过口径；支持 `QQ_BRIDGE_VOICE_TOOL_DIR` 覆盖 | 保留（被多个测试引用） |
| `audit-bridge-harness.mjs` | 虚拟网关 + 沙箱化的桥接行为审计脚手架（被 `test-audit-bridge.mjs` / `test-token-economy.mjs` 使用） | 保留 |
| `harden-state-acl.mjs` | 收紧 `state/` 目录权限（Windows 上 `mode 0o600` 是空操作，必须动 ACL）。直接试 → 失败提权重试 → 仍失败则打印可复制命令；**任何路径都以 0 退出，绝不阻断启动**。被 `start.bat` 调用 | 保留（`start.bat` 依赖） |
| `diagnose-acl.mjs` | 只读盘点：列出仓库里所有被**切断 ACL 继承**的路径，分「有意收紧（`state/`、`config.json`）」与「非预期收紧」两类，并对后者打印恢复继承的命令。背景见 [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md)。**必须在无沙箱终端跑**（沙箱禁止以管道 stdio 拉起 icacls） | 保留（`npm run diagnose:acl`） |
| `check-onebot-status.mjs` | 手工排查：查 OneBot 连通性 | 保留（运维常用） |
| `patch-snowluma-sdk.mjs` | `postinstall` 的 SDK ESM 打包 bug 补丁 | **必须保留**（postinstall 依赖） |
| `privacy-scan.mjs` + `privacy-rules.example.json` | 隐私扫描（`npm run privacy-scan`） | 保留 |
| `console-ui-fixture.mjs` | 控制台离线预览/回归夹具（`--port` / `--html` 可覆盖；`npm run preview:console`） | 保留 |
| `test-onebot-connection.mjs` | 手工探测：用 `@snowluma/sdk` 直连 SnowLuma 的 OneBot WS，验证 `wsUrl` / 端口 / `accessToken` 是否可用（读 `config.json`，成功即打印并退出） | 保留（手动脚本，未纳入自动测试） |
| `test-wait-backlog.mjs` | 手工回归：「漏消息窗口」（2026-10-18 修）——未进水位的一条都不许漏、补发从最老开始、超上限截断时 `partial=true`，并校验沉睡前观察闸门与 `chat_qq_wait` 提示参数 | 保留（手动脚本，未纳入自动测试） |
| `test-sticker-http-fallback.mjs` | 手工回归：表情库同步的「WS 挂掉」兜底——WS 正常时不多打一次 HTTP，WS 失败时自动改走 HTTP 且结果标 `via=http` | 保留（手动脚本，未纳入自动测试） |
| `test-voice-preview.mjs` | 手工 live 验证（`QQ_BRIDGE_TEST_LIVE=1`）：`/api/preview` 必须真的按音量产出不同音频，需 GUI 已在运行（`node voice-gui.mjs --no-open --port 3215`） | 保留（手动脚本，未纳入自动测试） |

> 精简重构删除的脚本：`setup-dsh.mjs`、`build-agent-preset-patches.mjs`、`dsh-modules.mjs`、
> `scan-dsh-tool-names.mjs` / `dsh-tool-names.mjs` / `test-preset-local-tools.mjs`、
> `test-dsh-auth.mjs` / `test-dsh-inbox-projection.mjs`、`verify-persona-config.mjs`、
> 全部 DSH 协议探针（`probe-*`）、一次性 `cleanup-*` / `fix-*` / `diag-*` / `debug-*` / `patch-qq-chat-*` 等。

---

## 三、`docs/` 结构

```
docs/
├── README.md     # 文档索引（每篇一句话 + 是否仍然有效）  ← 先看这个
├── FOLDER_MAP.md # 本文件
├── guides/       # 面向使用者/运维：GATEWAY_OPS / PLATFORM_DECOUPLE / SECURITY_BASELINE / CONSOLE-UI-TESTING / PRIVACY / VOICE
└── design/       # 设计文档：AGENT_GATEWAY（网关总体设计）/ MEMORY_LAYERS（网关侧记忆分层）/ ROLLBACK_LOG
```

> 精简重构删除的指南：`DSH_SETUP.md`、`DSH_020_ADAPTATION.md`、`DSH_021_ADAPTATION.md`（DSH 直连面已退役）、
> `MEMORY_MCP.md`、`ROLECARD_MCP.md`（桥接不再引用这两个平级服务）、`TOKEN_USAGE_CONSOLE.md`（计费看板已删）。

规则：**根目录只留 `README.md` / `README.en.md` / `RULES.md` 三个文档**，其余一律进 `docs/` 对应子目录，
并在 [docs/README.md](README.md) 索引里登记一行（含「仍然有效 / 被谁取代」）。

---

## 四、独立工具 `voice-tool/`（不在本仓库内）

| 路径 | 作用 |
| --- | --- |
| `voice-tool/voice-cli.mjs` | 命令行：交互菜单 / `send` / `list` / `check` / `remove` / `status` |
| `voice-tool/voice-gui.mjs` | 图形界面：只监听 127.0.0.1 的本地小服务 + 一次性令牌 + 浏览器 UI |
| `voice-tool/public/voice.html` | 图形界面前端（拖拽上传、试听、音量、发送、历史） |
| `voice-tool/发语音.cmd` | 命令行启动器（纯 ASCII，双击即用） |
| `voice-tool/config.json` | 工具自己的配置（**可选**）。本机显式把 `voice.voiceDir` 指向 `../qq-bridge/audio`，让已有音频继续可见 |
| `voice-tool/config.example.json` | 配置模板 |
| `voice-tool/state/` | 运行时：`voice-gui-url.txt`（当前界面地址 + 一次性令牌） |

共享内核**不复制**：工具经 `../qq-bridge/src/media/voice-core.js` 与 `../qq-bridge/src/integrations/snowluma-conn.js`
引同一份实现（qq-bridge 里的 `src/media/send-voice-lib.js` 也是转发这同一份）。
