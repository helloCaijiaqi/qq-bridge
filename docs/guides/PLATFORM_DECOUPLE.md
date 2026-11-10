# 平台解耦（dsh-decouple）：桥接只连网关

> 状态：**已落地**（2026-11-05）。设计背景见
> [../design/AGENT_GATEWAY.md](../design/AGENT_GATEWAY.md)，灰度/排障见
> [GATEWAY_OPS.md](GATEWAY_OPS.md)。本文只讲：解耦后消息怎么走、开关怎么配、
> 怎么验证、怎么回滚、以及**哪些事情现在绝对不做**。

## 1. 目标与不变量

解耦前：桥接 → DSH Web API 建会话、提交 prompt、消费 `/api/remote.mux` 事件流并把回合
文本转发回 QQ。也就是说，DSH 与桥接之间有三条绕过网关的通道。

解耦后只有一条：

```text
入站：SnowLuma ──► 桥接 ──► POST /v1/inbound ──► 网关 ──► DSH
发送：DSH 回合 ──► 模型调 chat_qq_* 工具 ──► 网关 ──► POST /v1/actions ──► 桥接 ──► QQ
唤醒：桥接 proactive / wait 定时器 ──► 合成事件 ──► POST /v1/inbound ──► 网关 ──► DSH
账本：桥接 ──► GET /v1/usage（30s 轮询）──► token 账本（按 turnId 幂等）
```

三条硬不变量（改代码时先看这三条）：

1. 桥接**不再**建本地 DSH 会话、提交 prompt、订阅 mux 事件；
2. 回合文本**不再**由桥接自动转发——模型必须显式调用发送工具，否则就是「不说话」；
3. 网关不可达时入站**如实失败**（按会话 30s 限流提示），不落回本地、不排队补投。

### 1.1 直连残留的彻底清除（2026-11-06）

首版解耦后，桥接进程内仍残留若干**绕过网关的 DSH 直连**（黑话学习器自建 DSH 会话、
控制台 DSH 控制面端点、web-search 直读 DSH 凭据文件等）。现已全部删除：

- **黑话学习器整链路下线**（管理决策，回滚形态也不保留）：`ensureSlangLearnerSession`
  及提取/研究/注入全链路、`chat_slang_submit` / `chat_slang_query` 工具（桥接 handler、
  MCP 工具、动作清单与网关执行器同步删除）、`/api/slang*` 端点与控制台面板。
- **控制台 DSH 控制面删除**：`/api/presets`、`/api/preset/sim-prompt*`、`/api/sessions`、
  `/api/pending`、`/api/dsh/model|effort`、后台提醒直推（`/api/console/notify-ai`）及对应前端面板；
  桥接模式真源收敛为本地 `state/mode.json`，不再读写 DSH settings。
- **web-search 不再读 DSH 文件**：密钥只认 `config.json` 的 `webSearch.apiKey` 与环境变量
  （默认 `DEEPSEEK_API_KEY`）；都没有时回落 Bing。
- **api 客户端按形态创建**：`gateway.mode=on` 且 `delivery=actions` 时不再实例化
  `NodeApiClient`，也不再去翻 DSH 启动日志猜 token——误触回滚路径会得到显式的
  `E_DSH_DECOUPLED` 报错。

`gateway.mode=off` 回滚形态不受影响：本地 DSH 驱动（`ensureSession` / `selectModel` /
本地投递 / 审批应答）原样保留，退役时随灰度收尾一并拆除。

## 2. 开关

### 2.1 桥接（`config.json` 的 `gateway` 块）

| 字段 | 取值 | 说明 |
|---|---|---|
| `mode` | `on` / `off` | `on` = 解耦形态（生产）；`off` = 旧本地 DSH 路径，仅回滚用 |
| `delivery` | `actions`(默认) / `mux-tap` | 正式形态固定 `actions`（回合文本不再投递，只由模型工具发送）；`mux-tap` 仅保留给旧 tag 回滚窗口，新网关已没有对应开关 |
| `url` / `adapterId` / `secret` | — | 与网关 `state/gateway/<adapterId>.secret` 一致 |
| `conversations` | sessionKey 列表 | `delivery=actions` 时**不再生效**（白名单由网关裁决）；保留给回滚形态 |

### 2.2 网关（环境变量）

| 变量 | 解耦形态取值 | 说明 |
|---|---|---|
| `GATEWAY_MODE` | `on` | 入站接管 |
| `GATEWAY_TOOLS` | `on` | mcp-bus 的工具目录（**必须** on，否则 DSH 没有 `chat_qq_*`） |
| 回合投递 | 已移除 | 网关不再回调投递回合文本；`/v1/turns` 的 `result.tools` 记录 calls/sent，`no-send` 日志用于排查 |
| `GATEWAY_CONTEXT` | `on` | 上下文由网关拼装（桥接不再送 prompt 终稿） |
| `GATEWAY_STATE` | 按需 | 控制台状态镜像；关掉不影响入站 |

### 2.3 DSH 安装期（已移出本仓库）

安装期的 MCP 注册不再由本仓库负责：原 `scripts/setup-dsh.mjs` 已在精简重构中删除
（删除清单见 [../FOLDER_MAP.md](../FOLDER_MAP.md)），配套的 `MCP_TOOLS` 三态开关随之失效。
现在只剩运行期一个开关——网关的 `GATEWAY_TOOLS=on`（`/v1/tools` 工具目录，见 2.2）：
关掉它，DSH 就调不到任何 `chat_qq_*` 工具。

## 3. 验证

```bash
# 离线契约（不需要 DSH；config.gateway.mode=on 时才追加活体探测）
npm run verify:decouple
```

> `verify:adaptation`（验 DSH 自身适配）已随 DSH 直连退役，本仓库不再提供该脚本；
> 上游健康请走网关 `/v1/health` 与 `/v1/turns`，见 [GATEWAY_OPS.md](GATEWAY_OPS.md)。

`verify:decouple` 失败时的常见含义：

| 失败项 | 说明 |
|---|---|
| 网关不再自动投递回合文本 | 有人恢复了 `deliveryActions`/`auto-text` 分支（会与工具发送双发） |
| 投递动作归 adapter-tools | 有人重新加回 `DELIVERY_ACTIONS` 过滤（工具面会缺发送能力） |
| 真实消息有网关入站通道 | `deliverInboundViaGateway` 被删/被改名，消息会走回本地 |
| 入站分支在本地 DSH 队列之前 | 分支顺序被改，网关形态下会先排队（消息静默丢失） |
| 账本按 turnId 幂等并落盘 gid | 重启后会重复计费 |
| preset 守卫放行 mcp__agent-gateway__ | DSH 调不到任何 `chat_qq_*` 工具 |
| 网关 GET /v1/usage、/v1/turns | 控制台与账本会空掉 |

## 4. 回滚

回滚不是「切一个开关就回到旧世界」，而是**按层回退**。顺序很重要：先让文本有人发，
再恢复本地 prompt 通道，最后才恢复 MCP 直连。

1. **只回滚投递**：回到包含 `platform-actions` 的旧 tag（`git revert` 本次删除）并重启网关；
   自动投递已没有运行期开关，不能再靠环境变量切回。
2. **恢复 MCP 直连**：`scripts/setup-dsh.mjs` 已从仓库删除（`npm run setup:dsh` 不存在了），
   需要回滚时先从 git 历史把它取回，再用 `MCP_TOOLS=on`（两套并存）或 `MCP_TOOLS=off`
   （只旧直连）在 DSH 侧执行，重启 DSH 使白名单生效。
3. **完全回到旧架构**：桥接 `gateway.mode=off` + 网关 `GATEWAY_MODE=off`，重启两端。
   这一步会让桥接重新建本地 DSH 会话并提交 prompt（即解耦前的行为）。

每一步都要跑：

```bash
cd ../agent-gateway && npm test
cd ../qq-bridge && npm run test:gateway && npm run test:audit && npm run verify:decouple
cd ../wx-adapter && npm test
```

### 已知不可回滚项

- 网关 `/v1/usage` 是账本唯一数据源：回滚到 `mode=off` 后账本重新看 mux，
  但**已入账的网关 turn 不会重复**（turnId 幂等），历史数据不会丢。
- 控制台「连接状态」在 `mode=on` 时只反映网关；DSH 是否健康要看网关
  `/v1/health` 与 `/v1/turns` 的 `degraded` 字段。

## 5. 明确不做的事（评审红线）

- 不在桥接里新增任何 `dsh-client` 调用（建会话、prompt、follow、mux 都算）；
- 不在桥接里缓存/重放「未送达的 prompt」——网关是单点，失败就是失败；
- 不让适配器送 prompt 终稿（`prompt.text` 只保留给旧版社交状态机的过渡窗口）；
- 不在 `common` 网关装配层写平台业务（能力归 `executors/adapter-tools/<platform>/`）。
