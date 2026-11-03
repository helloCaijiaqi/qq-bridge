# rolecard-mcp（角色卡 / 人格）

`rolecard-mcp` 与 qq-bridge **平级部署**，是 `memory-mcp` 的兄弟包，只管一件事：
**角色卡管理与【人格】段产出**。

人格卡是从 qq-bridge 迁来的（`roles/*.md`），但服务本身不认识 QQ —— 换任何平台桥接都能直接用。

---

## 一、部署位置与入口

```
工作区根/
├── qq-bridge/
├── memory-mcp/
└── rolecard-mcp/     ← 本服务
```

| 入口 | 谁在用 | 说明 |
| --- | --- | --- |
| stdio MCP | DSH（`cordis.patch.yml` 的 `mcp-rolecard` 条目，由 `qq-bridge/scripts/setup-dsh.mjs` 登记） | 工具面：`role_list` / `role_get` / `role_set_current` / `role_sections` / `role_clear_current` / `role_context_render` |
| 回环 HTTP（默认 `127.0.0.1:7182`） | qq-bridge（`src/rolecard-client.js`） | 只监听回环；非回环来源 403；除 `/api/health` 外都要本地令牌 |

启动：

```bash
cd rolecard-mcp && npm install && npm start
```

## 二、环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ROLECARD_MCP_HTTP_PORT` | `7182` | 回环 HTTP 端口 |
| `ROLECARD_MCP_TOKEN` | 自动生成 | 令牌缺省时写入 `state/http-token`（`0o600`）并复用 |
| `ROLECARD_MCP_DATA_DIR` | `<包>/roles` | 角色卡目录 |

qq-bridge 侧（读这些变量的是 `src/rolecard-client.js`）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ROLECARD_MCP_URL` | `http://127.0.0.1:7182` | 服务地址 |
| `ROLECARD_MCP_TOKEN` / `ROLECARD_MCP_TOKEN_FILE` | 读 `../rolecard-mcp/state/http-token` | 本地令牌 |
| `ROLECARD_MCP_ENABLED` | 开 | 置 `0` / `false` 可一键回落本地人格卡 |

## 三、小节解析与两段取用

角色卡按标题里的 **〔一代〕/〔二代〕** 标记筛掉另一模式的专属小节（`src/role-card.js`，
从 qq-bridge 原样迁来的纯函数），再按注入上限截断 —— 这样另一模式的内容不会白白占掉
本次的注入预算。

- `mode='v1'`：一代仿真用，保留原样；
- `mode='v2'`：二代用，额外过滤一代状态机指令行（`GEN1_ROLE_LINE_RE`），
  并把「回复示例」里表示分条的中文空格改写成逗号（避免 AI 照抄单条消息里的中文空格）。

## 四、缓存

读人格卡的缓存 key 必须含 **文件名 + mtime + size**（`src/store.js`）。
原因与 qq-bridge 时期一致：有些文件系统 mtime 只有秒级粒度（或时钟回拨），
同一 tick 内把角色卡重写成新人格时两个 mtime 可能完全相同 —— 只按 mtime 缓存会命中旧值，
于是**每条提示词都注入旧人格**。带上名字后切换角色永远不会误命中。

## 五、与 qq-bridge 的契约

```js
role_context_render({ mode: 'v1' | 'v2', maxChars })
  -> { blocks: [{ name: '人格', text, chars }], truncated }
```

qq-bridge 的 `currentRoleHint()` / `currentRoleHintV2()` 优先用这里的段落，
**取不到就回落到本地人格卡**（空串 = 外部没有可用内容，不是"人格为空"）。
客户端自带熔断（连续失败 3 次后按递增冷却跳过，上限 10 分钟），服务没起时不拖慢消息投递。

灰度回退：设 `ROLECARD_MCP_ENABLED=0` 即可全部走本地实现，不需要改代码。

## 六、迁移与测试

```bash
cd rolecard-mcp
npm run migrate          # 从 qq-bridge/roles 复制式导入（README 不算角色；原件不动，留 .bak）
npm test                 # rolecard / interfaces / migrate
```

已存在的同名卡默认不覆盖，防止误伤已有的修改；当前角色指向的卡不存在时不写入。

## 七、生产部署与验收

### 进程归属

与 memory-mcp 完全同构：stdio 与回环 HTTP 跑在**同一个进程**里，进程由 DSH 派生
（`cordis.patch.yml` 的 `mcp-rolecard` 条目 → `node <包>/src/server.mjs`）。
没有独立守护进程，所以"部署"= 装依赖 + 登记条目 + 验收。

- **同一时刻只能有一份**：再 `npm start` 一份会撞 7182。
- 端口抢不到时进程**不会**整体退出：`listen()` 失败降级为 stdio-only，
  DSH 的 `role_*` 工具照常可用，桥接回落本地人格卡。

### 安装

```bash
cd rolecard-mcp
npm ci                 # 用 lockfile 安装，不要 npm install
npm run preflight      # node 版本 / 依赖 / roles 可读 / state 可写 / 令牌 / 端口
```

- **Node 必须 >= 24**（与 memory-mcp 一致，`engines` 已收紧到 `>=24.0.0`）。
- `preflight` 对"端口已被占用"只提醒：本服务已在跑属正常；被别的进程占着则新实例降级为 stdio-only。
- 角色卡目录为空时只提醒（`role_context_render` 会返回空段，桥接回落本地人格卡）。

### 数据与令牌

| 路径 | 内容 | 备份方式 |
| --- | --- | --- |
| `roles/*.md` | 角色卡（纯文本，`README.md` 不算卡） | `npm run backup` |
| `state/current-role.json` | 当前角色指针 | 随备份复制 |
| `state/http-token` | 本地令牌（`0o600`） | 复制为 `backups/http-token.bak` |

- 备份是**目录快照** `state/backups/roles-<时间>/`（纯文本不需要压缩，恢复时直接拷回），保留最近 **7** 份。
- 令牌被换掉后**桥接必须重启**才生效（客户端只在启动时读一次文件）。

### 备份的已知限制

以下三条是脚本的**已知边界**（代码暂不改），生产上按「规避」列处理即可。

| 限制 | 现象 | 规避 |
| --- | --- | --- |
| 时间戳精确到秒（`YYYYMMDD-HHmmss`） | 同一秒内第二次执行**复用同一目录并覆盖上一份**，日志仍报成功，历史快照静默少一份（比报错更隐蔽） | 调度间隔大于 1 秒；同一时刻只跑一份；需要保留两份时改目录名后再跑 |
| 轮转按目录 `mtime` 排序，不按目录名 | `state/backups/` 被同步 / 复制工具改动 `mtime` 后，轮转可能删新留旧 | 备份目录不纳入同步范围；人工清理时按目录名判断（目录名即时间戳，字典序 = 时间序） |
| 目录快照只复制文件内容 | 不携带 ACL / 属性：`roles/` 与 `state/` 若曾单独收紧过权限，恢复后需重新收紧 | 恢复后按原机器的做法重设权限（可参考 qq-bridge 的 `scripts/harden-state-acl.mjs`） |

恢复时按「回滚」小节：把快照里的 `*.md` 与 `current-role.json` 拷回 `roles/` 与 `state/`。

### 换机 / 迁目录

1. 拷 `src/`、`package.json`、`package-lock.json`，以及 `roles/`、`state/`；
2. 目标机 `npm ci`；
3. 在 qq-bridge 下跑 `node scripts/setup-dsh.mjs`（**必须**：patch 里写的是绝对路径）；
4. 重启 DSH；
5. 在 qq-bridge 下跑 `node scripts/check-mcp-health.mjs`，应 2/2 OK。

### 验收清单

```bash
cd rolecard-mcp && npm run preflight && npm test && npm run backup
cd ../qq-bridge && node scripts/check-mcp-health.mjs
```

- `check-mcp-health.mjs` 输出三态：`OK` / `未监听` / `监听但鉴权失败`；
- DSH 里能看到 `role_list` / `role_get` / `role_set_current` / `role_sections` / `role_clear_current` / `role_context_render`；
- 桥接日志出现 `外部服务取段已开启：… rolecard-mcp=…`；服务断掉时出现熔断行，恢复时出现 `已恢复` 行。

### 回滚

| 层级 | 做法 |
| --- | --- |
| 功能级 | `ROLECARD_MCP_ENABLED=0` → 桥接全部走本地人格卡，不改代码 |
| 代码级 | 本包已建 git 基线（`chore: 生产优化前基线快照`），`git checkout` / `git revert` |
| 数据级 | 从 `state/backups/roles-<时间>/` 把 `*.md` 与 `current-role.json` 拷回原位 |
