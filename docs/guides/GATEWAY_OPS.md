# agent-gateway 运维与迁移手册

> 面向「已经跑起来、现在要灰度/排障/回滚」的人。设计与契约见
> [../design/AGENT_GATEWAY.md](../design/AGENT_GATEWAY.md)，本文只讲怎么操作与怎么判断。

## 1. 拓扑与进程

```text
QQ ── OneBot WS ──> qq-bridge ──┐
                                 ├─ HMAC /v1/inbound ──> agent-gateway ──> DSH
微信 ── wxbot push ──> wx-adapter ┘                            │
        ▲                        ▲                            │
        └── /v1/actions（签名回投）┘                            └─ memory-mcp / rolecard-mcp
```

| 进程 | 默认端口 | 职责 | 不负责 |
|---|---|---|---|
| `agent-gateway`（`npm start` → `src/main.mjs`） | 7190 | 鉴权、turn 编排、上下文拼装、工具面、状态枢纽 | 平台登录、平台发送细节 |
| `qq-bridge` | 3100（控制台） | QQ 平台 I/O、发送、本地状态权威副本 | 不再自己拼 prompt（`context=on` 后） |
| `wx-adapter` | 7192 | 微信平台 I/O、身份断言、动作执行 | DSH、上下文、唤醒 |

启动顺序：网关 → 适配器 → DSH 侧无要求。适配器先起、网关后起也可（入站会 502，框架可重试）。

## 2. 开关矩阵

网关侧全部是环境变量（`src/core/config.mjs`），适配器侧是 `config.json` 的 `gateway` 块 / `WX_*` 环境变量。

| 开关 | 取值 | 关掉后的行为 | 回滚动作 |
|---|---|---|---|
| `GATEWAY_MODE` | `off`(默认)/`shadow`/`on` | 入站 503 `E_DISABLED`，适配器走本地路径 | 置 `off` 重启网关 |
| `GATEWAY_CONVERSATIONS` | 逗号分隔 sessionKey，支持 `*` 与 `前缀*` | 未命中返回 202 `routed:false`，不接管 | 从列表移除该会话 |
| `GATEWAY_DISABLED_ADAPTERS` | `wx-main` 等 id | 该适配器不注册，入站 401、动作 `E_UNSUPPORTED` | 移除 id 重启 |
| `GATEWAY_CONTEXT` | `off`(默认)/`shadow`/`on` | off：prompt 透传；shadow：只对比不替换 | `off` |
| `GATEWAY_TOOLS` | `off`(默认)/`on` | `/v1/tools`、`/v1/tools/call` 503 | `off` |
| `GATEWAY_STATE` | `off`(默认)/`on` | `/v1/state*` 503；适配器镜像写入失败但本地不受影响 | `off` |
| 回合投递 | 已移除 | 网关**不再**把回合文本回调适配器：模型必须调用 `chat_qq_send_*` 工具；`/v1/turns` 的 `result.tools` 记录 calls/sent | 回滚 = `git revert` + 重启（没有运行期开关） |
| `adapters.json` 的 `enabled` | `true`/`false` | 长期摘除某平台适配器 | 改回 `true` |

配套参数：`GATEWAY_CONTEXT_BUDGET`、`GATEWAY_MEMORY_URL/TOKEN/TIMEOUT_MS`、`GATEWAY_MCP_BUS_TOKEN`、
`GATEWAY_TOOL_MAX_CALLS_PER_TURN`、`GATEWAY_TOOL_CALL_TIMEOUT_MS`、`GATEWAY_REPLAY_WINDOW_MS`、
`GATEWAY_DSH_BASE_URL/TOKEN/TIMEOUT_MS/ALLOW_REMOTE`、`GATEWAY_PRESET/PROVIDER/MODEL/WORKSPACE_DIR`、
`GATEWAY_TURN_TIMEOUT_MS`。

适配器侧（qq-bridge `config.json`）：

```json
{
  "gateway": {
    "mode": "on",
    "delivery": "actions",
    "url": "http://127.0.0.1:7190",
    "adapterId": "qq-main",
    "platform": "qq",
    "secret": "<与网关 state/gateway/qq-main.secret 相同>",
    "state": "on",
    "conversations": ["qq:group:123456"]
  }
}
```

> `delivery=actions`（默认）时 `conversations` 不再参与路由：白名单由网关
> `GATEWAY_CONVERSATIONS` 裁决，未命中的会话回 `routed:false`，桥接如实失败。
> 完整语义、验证与分层回滚步骤见 [PLATFORM_DECOUPLE.md](PLATFORM_DECOUPLE.md)。

## 3. 健康检查与观测

```bash
curl -s http://127.0.0.1:7190/v1/health   # 免鉴权，仅回环
curl -s -H "x-adapter-id: qq-main" ... http://127.0.0.1:7190/v1/metrics   # 需 HMAC
```

`/v1/health` 关键字段：

| 字段 | 读法 |
|---|---|
| `mode` | `off` 表示所有业务面关闭；`on` 表示 runtime 已装配 |
| `adapters[]` | 每个适配器的 `platform`、`capabilities`（`all` = 未声明）、`actionsEndpoint`（`null` = 不回投） |
| `tools/state` | 子开关状态与 liveTurns / sessions 计数 |

`/v1/metrics` 里优先看：`gateway_context_shadow_total{diff}`（影子期 diff 数，只增不减正常，
但**实际 prompt 不应变化**，由 `npm run verify:shadow` 演示）、`gateway_turn_total{result}`、
`gateway_turn_ms`。

日志关键字（网关）：`ready:`、`runtime assembled`、`mux connection failed`、`context shadow diff`、
`context assemble failed`、`adapter returned a non-conforming receipt`。

## 4. 排障表

| 症状 | 先查 | 处理 |
|---|---|---|
| 入站 401 `E_AUTH` | `x-adapter-id` 是否在 `adapters.json`；两侧密钥是否同一份；时间戳是否在 `GATEWAY_REPLAY_WINDOW_MS` 内 | 修登记/密钥；重放错误（`E_REPLAY`）不要重试同一 nonce |
| 入站 202 但 `routed:false` | `GATEWAY_CONVERSATIONS` 与适配器 `gateway.conversations` 是否一致 | 两边同时加白名单条目 |
| 模型说了但消息没发出 | `/v1/health` 的 `actionsEndpoint`；适配器日志有无 `/v1/actions`；回执是否 `E_UNSUPPORTED` | 能力未声明 → 补 `capabilities` 并确认适配器真实现；`callbackBase` 缺失 → 配地址 |
| 动作回执被判失败 | 网关日志 `non-conforming receipt` | 适配器必须回 `{v:1, actionId, ok}` 且 actionId 一致 |
| 微信推送 401 | `X-Wx-Signature` 三头是否齐；`WX_PLATFORM_TOKEN` 与框架是否一致 | 对齐 token；时间窗 `WX_PUSH_WINDOW_MS` |
| 微信推送 502 | 适配器到网关不通（`WX_GATEWAY_URL`） | 先修网关，框架会重试 |
| `/v1/tools` 503 | `GATEWAY_TOOLS`、`GATEWAY_MCP_BUS_TOKEN` | 打开开关并给 mcp-bus 同一密钥 |
| `/v1/state*` 503 | `GATEWAY_STATE`；适配器 `gateway.state` | 打开；P4 灰度前不删本地 `social-v2.json` |
| turn 一直不结束 | DSH 连接（`mux connection failed`）、preset 是否存在于 DSH | 修 DSH；`GATEWAY_TURN_TIMEOUT_MS` 到点会返回 error 而不是挂住 |

## 5. 密钥与轮换

- 一个适配器一个密钥，≥16 位随机串：`openssl rand -hex 32`。
- 网关侧放 `state/gateway/<id>.secret`（`adapters.json` 的 `secretFile`，相对该目录）；适配器侧放同一串。
- 轮换步骤：两端同时改 → 重启适配器 → 重启网关。中间窗口会 401，属于预期；**不要**只改一端。
- `WX_PLATFORM_TOKEN`（框架↔适配器）与网关密钥是两把，分开轮换。
- 密钥文件不要进版本库（`wx-adapter/.gitignore` 已含 `*.secret`；网关 `state/` 不在仓库内）。

## 6. 备份与恢复

需要备份的只有「丢了无法重建」的：

| 路径 | 内容 | 备注 |
|---|---|---|
| `agent-gateway/state/gateway/adapters.json` + `*.secret` | 登记与密钥 | 手写，建议单独保管 |
| `agent-gateway/state/gateway/{turns.jsonl,idempotency.json,sessions.json}` | turn 索引、幂等表、DSH 会话映射 | 幂等表丢了最多重复处理，会话映射丢了会重建会话 |
| `agent-gateway/state/gateway/session-state.json` | P4 状态枢纽（游标/水位/唤醒配置/令牌） | **权威副本**（`GATEWAY_STATE=on` 时） |
| `qq-bridge/state/social-v2.json` | 适配器本地状态 | P4 起仍是全量本地权威，别删 |
| `wx-adapter/state/` | 媒体与本地状态 | 可重建，媒体视需要 |

备份前停进程或至少停写；`state-store` 是 200ms 合并写，热拷贝可能拿到半批。

恢复顺序：网关 → 适配器 → 验证 `/v1/health` 的 `adapters` 与 `tools/state`。

## 7. 迁移步骤

### 7.1 记忆单写（P2）

```bash
cd qq-bridge
npm run memory:export          # 导出 activeTopics/pendingThoughts/memberImpressions → memory-mcp ingest，留 .bak
# 观察一个发布周期，确认回忆内容无差异
npm run memory:revert          # 需要回退时反导出
```

判定：`GATEWAY_CONTEXT=on` 后 prompt 的【记忆】段来自 memory-mcp；`head` 每轮直取、
`tail` 每轮必拉；**不允许**出现「N 分钟前」这类相对时间（字节稳定性由测试钉住）。

### 7.2 状态镜像（P4）

1. 网关 `GATEWAY_STATE=on`，适配器 `gateway.state=on`，两者都要求 `mode=on`；
2. 重启适配器，观察 `POST /v1/state/update` 有 `agent_token/inbound/mark_read/set_wake_config` 四类回填；
3. 控制台 `state/states` 出现 `gatewayState:true`，`unreadCount` 来自网关快照；
4. 回滚：`gateway.state=off`，本地 `social-v2.json` 一直全量写，无数据损失。

### 7.3 文本只由工具发送（当前正式态）

1. 网关已删除回合文本自动投递，`/v1/turns` 的 `result.tools` 是「模型这一轮发没发」的证据；
2. 排查「用户没收到回复」：先看 `result.tools.sent`，再看网关日志里的 `no-send` 行；
3. 回滚 = 回到旧 tag / `git revert` 并重启（没有 `GATEWAY_DELIVERY` 这类运行期开关）。

### 7.4 新增第二个平台（微信）

1. 生成 `wx-main.secret`，放进网关 `state/gateway/`；
2. `adapters.json` 加条目（`capabilities` 只写真实实现的 `send_text/reply/send_media/send_file`），
   灰度期先 `"enabled": false`；
3. `WX_ENABLED=on` 起适配器，`WX_CONVERSATIONS` 与网关 `GATEWAY_CONVERSATIONS` 对齐；
4. 先单群灰度，再放开。

## 8. 回滚演练（每阶段必做）

```bash
cd agent-gateway
npm run verify:shadow      # 影子期零行为变化：off vs shadow 的实际 prompt 逐字节一致
npm run verify:rollback    # 四道闸门关闭后都回旧行为（9 项断言）
```

演练记录写进 [../design/ROLLBACK_LOG.md](../design/ROLLBACK_LOG.md)（日期、命令、结果、异常）。

人工复核项（脚本覆盖不到）：

1. 关开关重启后，QQ/微信真实收发各一条；
2. 控制台状态页仍能打开，`gatewayState` 标记与预期一致；
3. `.bak` 可读、反导出脚本可执行；
4. 记录演练时间与执行人。

## 9. 发布前验收清单

```bash
cd agent-gateway && npm test                # 契约/执行层/运行时/上下文/工具/状态/双适配器/分层
cd wx-adapter   && npm test                 # 微信适配器单元
cd qq-bridge    && npm run test:gateway     # 转发网关全量 + 适配器状态镜像
cd qq-bridge    && npm run test:audit       # 桥接审计（37 个脚本；环境缺 VOICE.md 时允许 36/37）
cd agent-gateway && npm run verify:shadow && npm run verify:rollback
```

全绿才允许把 `GATEWAY_MODE` 从 `shadow` 推到 `on`；任一红，先回滚再排查。
