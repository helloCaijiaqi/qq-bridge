# memory-mcp（会话记忆 + 黑话学习）

`memory-mcp` 是与 qq-bridge **平级部署**的独立 MCP 服务，负责两件与 QQ 无关的事：
**会话记忆**（短期 / 长期分层 + 遗忘机制）和**黑话与网络用语学习**。

拆出来的理由：这两块能力将来接微信时要直接用，留在 qq-bridge 里就只能在 QQ 上用；
而且它们不该知道任何 QQ 概念（群号、QQ 号、OneBot）。

---

## 一、部署位置与入口

```
工作区根/
├── qq-bridge/
├── memory-mcp/     ← 本服务
└── rolecard-mcp/
```

同一份 service 层挂两种入口，**业务实现不重复**：

| 入口 | 谁在用 | 说明 |
| --- | --- | --- |
| stdio MCP | DSH（通过 `cordis.patch.yml` 的 `mcp-memory` 条目挂载，由**本服务自己的** `scripts/install-dsh.mjs` 登记） | 工具面：`memory_*` / `slang_*` / `memory_context_render` |
| 回环 HTTP（默认 `127.0.0.1:7181`） | qq-bridge（`src/memory-client.js`） | 只监听回环；非回环来源 403；除 `/api/health` 外都要本地令牌 |

启动：

```bash
cd memory-mcp && npm install && npm start
```

## 二、环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MEMORY_MCP_HTTP_PORT` | `7181` | 回环 HTTP 端口 |
| `MEMORY_MCP_TOKEN` | 自动生成 | 令牌缺省时写入 `state/http-token`（`0o600`）并复用 |
| `MEMORY_MCP_DATA_DIR` | `<包>/state` | 数据目录 |

qq-bridge 侧（读这些变量的是 `src/memory-client.js`）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MEMORY_MCP_URL` | `http://127.0.0.1:7181` | 服务地址 |
| `MEMORY_MCP_TOKEN` / `MEMORY_MCP_TOKEN_FILE` | 读 `../memory-mcp/state/http-token` | 本地令牌 |
| `MEMORY_MCP_ENABLED` | 开 | 置 `0` / `false` 可一键关闭外部取段（回落本地实现） |

## 三、数据模型

**sessionId 是平台中性的**：`platform:scope:id`，例如 `qq:group:123456`、`qq:private:10001`。
`group:群号` → `qq:group:群号` 的映射由 qq-bridge 做（`src/memory-client.js` 的 `toSessionId`），
服务自己不认识 QQ —— 将来接微信时只需要加一个 `wx:` 前缀分支。

**记忆分两层**：

| 层 | 谁写进去 | 特点 |
| --- | --- | --- |
| 短期（`tier='short'`） | 话题、待说的话等会话内工作记忆 | 默认 TTL 一天，到期淘汰 |
| 长期（`tier='long'`） | 由短期**巩固**而来，或群友画像这类跨会话事实 | 无 TTL，基础权重更高 |

**遗忘四件套**（全在 `src/service/forgetting.js`）：

1. **时间衰减**：`score = baseWeight × exp(-λ × 距上次触及天数) + 命中加成`，读取时惰性计算，不做定时全表刷新；
2. **容量淘汰**：超过 `maxShort` / `maxLong` 时按最低 score 淘汰；
3. **软遗忘**：`status='archived'`，不注入提示词但可恢复；
4. **硬删除**：物理 `DELETE`，服务于被遗忘权（见 `docs/guides/PRIVACY.md`）。

## 四、检索：FTS5 + 短查询降级

存储用 Node 内置的 `node:sqlite`（Node 24 起免 `--experimental-sqlite`），
编译项含 `ENABLE_FTS5`，主索引用 `tokenize='trigram'`。

**必须记住的一条实测约束**：trigram 对**少于 3 个字符**的查询会**静默返回 0 条**——
`"记忆"` / `"黑话"` / `"新梗"` 这类中文 2 字词正是主力查询词，不处理就会出现
「明明存过这条记忆却搜不到」。

处理办法在 `src/store/sqlite-store.js` 的 `query()` 里：查询词 < 3 字符时自动降级为
`LIKE '%q%'`，返回值带 `strategy: 'fts5' | 'like'` 标注；上层无感。
`scripts/test-store.mjs` 里有对应用例钉住这个行为。

## 五、黑话学习

- **规则发现为主、零模型依赖**：n-gram 频次 + 互信息 + 左右熵挑候选（`src/slang-discover.js`，纯函数）；
- 状态流转：`candidate → confirmed / rejected`，证据合并、上限淘汰沿用既有语义；
- **可选 LLM 解释**（`src/llm-provider.js`）**默认关闭**：服务自带 provider 配置，
  不再借 qq-bridge 的模型编排（qq-bridge 侧原先调模型编排的位置已不再需要）。

## 六、与 qq-bridge 的契约

段落契约（两服务共用）：

```js
memory_context_render({ sessionId, maxChars })
  -> { blocks: [{ name: '记忆' | '黑话', text, chars }], truncated }
```

qq-bridge 用 `src/memory-client.js` 取段并拼进提示词。**降级语义**是这套设计的重点：

- 取段失败（服务没起 / 报错 / 库为空）→ 返回**空串**，桥接回落到本地实现，行为与改造前一致；
- 连续失败 3 次 → 客户端熔断（冷却时长按次数递增，上限 10 分钟），不再拖慢每条消息的投递；
- 写入（append / remove / clear）会**镜像**一份到本服务，本地状态仍是权威，控制台响应形状不变。

## 七、迁移与测试

```bash
cd memory-mcp
npm run migrate          # 从 qq-bridge 复制式导入（原件不动，留 .bak）
npm test                 # session-id / store / memory / slang / interfaces / migrate
```

迁移脚本只复制不移动，输出条目数对照与差异报告。

## 八、生产部署与验收

### 进程归属

两个入口跑在**同一个进程**里，进程由 DSH 派生（`cordis.patch.yml` 的 `mcp-memory` 条目 → `node <包>/src/server.mjs`，条目由 `npm run install:dsh` 维护）。
所以没有 systemd / 计划任务要装，"部署"= 装依赖 + 登记条目 + 验收。

- **同一时刻只能有一份**：再 `npm start` 一份会撞 7181。
- 端口抢不到时进程**不会**整体退出：`listen()` 失败降级为 stdio-only，
  DSH 的 `memory_*` 工具照常可用，桥接按既有语义回落本地实现。

### 安装

```bash
cd memory-mcp
npm ci                 # 用 lockfile 安装，不要 npm install（会改 lock）
npm run install:dsh    # 把 mcp-memory 条目写进 DSH 的 cordis.patch.yml
npm run preflight      # node 版本 / 依赖 / state 可写 / 令牌 / 端口 / DSH 登记
```

- **Node 必须 >= 24**：`node:sqlite` 在 24 之前需要 `--experimental-sqlite`，`engines` 已收紧到 `>=24.0.0`。
- `preflight` 对"端口已被占用"只提醒：若本服务已在跑属正常；若是别的进程占着，新实例会降级为 stdio-only。
- **安装器属于本服务自己**（`scripts/install-dsh.mjs`），不再由 `qq-bridge/scripts/setup-dsh.mjs` 代劳：只追加/替换自己那段带 `# === memory-mcp MCP BEGIN/END ===` 标记的区块，profile patch 里别人写的内容一个字节都不动。常用形式：
  ```bash
  npm run install:dsh              # 装进 web profile（默认）
  npm run install:dsh -- work      # 装进 work profile
  npm run install:dsh -- --global  # 装进 home 层（所有 profile 生效）
  npm run install:dsh -- --check   # 只检查；未登记或路径不符时退出码 1
  npm run install:dsh -- --remove  # 卸载
  ```
  改完**不用**重启 DSH、也不用 `npm install`：新建一个 DSH 会话就能看到 `mcp__memory__*` 工具。
- **已知边界**：`qq-bridge/scripts/setup-dsh.mjs` 会 `yaml.load → yaml.dump` 整体重写 profile patch，注释会被抹掉。若先装本服务、后跑那个脚本，本服务的区块标记会消失（条目与 id 仍在，工具照常可用，`--check` 也能通过）；要让本脚本重新纳管，手工删掉那条 `mcp-memory` 条目再跑一次 `npm run install:dsh`。

### 数据与令牌

| 路径 | 内容 | 备份方式 |
| --- | --- | --- |
| `state/memory.db` | 记忆 + 黑话（SQLite，**WAL** 模式） | `npm run backup`（`VACUUM INTO` 一致性快照） |
| `state/http-token` | 本地令牌（`0o600`） | 随备份复制为 `backups/http-token.bak` |

- 快照保留最近 **7** 份，放在 `state/backups/`。
- **不要直接拷 `memory.db`**：WAL 模式下最新写入可能还在 `memory.db-wal` 里，直接拷会拿到旧数据。
- 令牌被换掉后**桥接必须重启**才生效（客户端只在启动时读一次文件）。
- 定时备份示例（Windows 计划任务）：每天 04:00 执行 `npm run backup`。

### 备份的已知限制

以下三条是脚本的**已知边界**（代码暂不改），生产上按「规避」列处理即可。

| 限制 | 现象 | 规避 |
| --- | --- | --- |
| 时间戳精确到秒（`YYYYMMDD-HHmmss`） | 同一秒内第二次执行：`VACUUM INTO` 因目标文件已存在而失败，退出码 1，**本次不产生新快照**（已有快照不受损） | 调度间隔大于 1 秒；不要手动连点；同一时刻只允许一份在跑 |
| 轮转按文件 `mtime` 排序，不按文件名 | `state/backups/` 被云同步 / `robocopy` / 复制还原工具改过 `mtime` 后，轮转可能删掉较新的、留下较旧的 | 备份目录不纳入同步范围；人工清理时按文件名判断（文件名即时间戳，字典序 = 时间序） |
| 快照只做存在性与大小检查 | 脚本不打开快照验证可读性，坏快照会一直占着轮转名额 | 定期抽查一次：能打开且 `PRAGMA integrity_check` 输出 `integrity_check: 'ok'` 即视为有效 |

抽查命令（在 `memory-mcp` 目录下执行，把 `<时间>` 换成待检查的快照；只查数据，不写文件）：

```bash
node --input-type=module -e "import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync('state/backups/memory-<时间>.db');console.log(d.prepare('PRAGMA integrity_check').get());d.close()"
```

恢复仍按「回滚」小节：停服务后覆盖 `memory.db`，并删除同目录的 `-wal` / `-shm`。

### 换机 / 迁目录

1. 拷 `src/`、`package.json`、`package-lock.json`，`state/`（含令牌）单独拷；
2. 目标机 `npm ci`；
3. 在 **memory-mcp** 下跑 `npm run install:dsh`（**必须**：patch 里写的是绝对路径，换机/换目录后旧路径就失效了）；
4. 新建 DSH 会话验证 `mcp__memory__*` 工具出现（不用重启 DSH）；
5. 在 qq-bridge 下跑 `node scripts/check-mcp-health.mjs`，应 2/2 OK。

### 验收清单

```bash
cd memory-mcp && npm run preflight && npm test && npm run backup
cd ../qq-bridge && node scripts/check-mcp-health.mjs
```

- `check-mcp-health.mjs` 输出三态：`OK` / `未监听` / `监听但鉴权失败`；
- DSH 里能看到 `memory_*` / `slang_*` 工具；
- 桥接日志出现 `外部服务取段已开启：memory-mcp=…`；服务断掉时出现熔断行，恢复时出现 `已恢复` 行。

### 回滚

| 层级 | 做法 |
| --- | --- |
| 功能级 | `MEMORY_MCP_ENABLED=0` → 桥接全部走本地实现，不改代码 |
| 代码级 | 本包已建 git 基线（`chore: 生产优化前基线快照`），`git checkout` / `git revert` |
| 数据级 | 从 `state/backups/` 取快照；停服务后覆盖 `memory.db`，并删除同目录的 `-wal` / `-shm` |
