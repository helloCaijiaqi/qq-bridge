# 安全基线与威胁模型（qq-bridge → QSH）

> 本文把项目里**已经实现的**安全边界、**已知的**残余风险、以及**每次发布必须回归**的
> 检查项集中到一处。与之配套的承诺性文档是 [../RULES.md](../RULES.md)（面向使用者的
> 权限说明）；本文偏工程实现，供改动代码前后对照。
>
> 维护规则：任何改动如果改变了下面任一条目，**必须在同一个 PR 里更新本文**。

---

## 一、威胁模型（我们要防谁、防什么）

| 威胁主体 | 能力假设 | 我们不防的 |
| --- | --- | --- |
| **QQ 群友 / 陌生人** | 能给机器人发任意文本、图片、表情、拍一拍；能尝试提示注入 | 他们能看到的公开信息 |
| **被注入的模型** | 会尝试调用任意工具名、传任意参数、尝试外发本机内容 | —— |
| **本机其他用户** | 能登录同一台机器，能读文件系统 | 已取得管理员/root 的主体 |
| **本机其他进程 / 浏览器页面** | 能访问 `127.0.0.1`，能构造任意 HTTP 请求 | 已能读写本项目 `state/` 的主体 |
| **DSH 侧 agent（QQ 会话）** | 拥有 MCP 工具面，但**没有**本地工具 | —— |

**不在此模型的范围内**：QQ 账号本身被盗、SnowLuma 网关被攻陷、DSH 本体漏洞、
操作系统级攻击者。这些情况下本项目无法提供额外保护，README 中已声明。

---

## 二、已实现的边界（按攻击面）

### 1. 准入（谁能触发 agent）

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 白名单 | `src/bridge.js` `allowed()` | `deny` 优先于 `allow`；两侧统一 `String()` 比较（兼容 OneBot int64 的数字/字符串差异）；allow 为空时返回 `allowAllWhenEmpty`（**默认 false**）。注意这是发送动作的**第二道闸**：入站路由由网关 `GATEWAY_CONVERSATIONS` 裁决 |
| 配置失败 | `loadConfig()` | `config.json` 缺失/解析失败 → **fail-fast 退出**（不是"用默认值继续跑"）；`gateway.url/secret/adapterId` 三项缺失同样**启动即失败** |
| 管理员识别 | 入站处理 | `String(event.user_id) === String(cfg.ownerQQ ?? '')`；未配置 `ownerQQ` 时启动日志明确告警（管理命令不可用） |

### 2. 动作面（agent 能做什么）

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 动作面 = 网关清单 | `src/gateway/actions-manifest.json` + `action-handlers.js` | agent 的全部工具面 = 网关 `/v1/actions/manifest` 里 `enabled` 的 QQ 动作（`chat_qq_*` 一族）。桥接**零本地工具、零自带 MCP**——不存在 bash/文件/子代理面可供诱导。每条动作带 `enabled`（实现覆盖 + `socialV2.tools.*` configFlag 现算），未启用的动作网关不注册 |
| 发送强制白名单 | 所有发送类动作 handler | 目标必须命中 `allow.groups` / `allow.private`（每次都重新校验，不做缓存） |
| 动态 ACL | `resolveVoicePathForV2()` / `voicePathInsideLibrary()` | 语音只能取语音库目录内的文件；贴纸只能发收藏库内的表情；图片只能读 SnowLuma home 内的本地文件（realpath 复核防符号链接逃逸） |
| **只探测、不部署**（设计不变量） | `src/integrations/snowluma-conn.js` | 桥接对 SnowLuma **只做 OneBot 收发与只读探活**（`get_login_info` / `get_status` / 心跳）。⚠️ SnowLuma EULA §5.4 规定「将其并入第三方安装包或 Docker 镜像、**通过自动化脚本部署**」须事先书面授权，原生组件属**专有组件**。⇒ 本程序不安装、不复制、不打包、不程序化启停 SnowLuma；用户自行安装与启动。详见 `LICENSE` |

### 3. 出站内容（模型能说什么、能发什么）

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 敏感信息拦截 | `auditAndSend()` / `SENSITIVE_RE` / `assertOutboundAuditOk()` | 回复含本机路径、UNC、凭据赋值形态 → **整条拦截不发**；语音按文件名审计；错误文本、审批理由、工具名同样过审 |
| 会话令牌防外发 | `redactKnownTokensOnly()` + `onebotSend()` | 所有已知 agent token 在发送前脱敏；文本里若仍出现已知令牌则**直接抛错不发** |
| CQ 注入 | `onebotSend()` | 出站文本一律包成 `{type:'text'}` 段并做 `[CQ:` → `[CQ：` 转义，杜绝 CQ 码注入 |
| @ 限制 | `onebotSend()` | `atUserId` 只接受正整数，禁止 `@all` |
| 发送限流 | `socialV2.send.*` / `voice.*` / `sticker.collect.*` | 每分钟/每小时硬上限，超限拒绝并退避 |

### 4. 控制台（本机最高权限入口）

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 只监听回环 | `server.listen(port, '127.0.0.1')` | 永不绑 `0.0.0.0` |
| 令牌门 | 请求最前面 | **所有**路由（读+写）都要 `x-console-token` 或 `?token=`；未配置时启动自动生成 192 bit 随机值 |
| 定长比较 | `crypto.timingSafeEqual` | 比较前先比长度，避免 `!==` 短路带来的时延侧信道 |
| Host 校验 | 请求最前面 | Host 必须是 `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`，否则 403（DNS rebinding 硬化） |
| CSRF | 非 GET 请求 | 必须 `content-type: application/json`；若带 `Origin`，其 host 必须等于本机 |
| agent 令牌隔离 | 请求前缀白名单 | 带 `x-agent-token` 的请求默认拒绝，仅放行只读面（`/api/status`、`/api/socialV2/*`、`/api/send/*`、`/api/images/*`、`/api/authorize/read`）；管理端点（白名单/安全设置/重启/令牌等）一律 403 |
| 空令牌拒绝 | `x-agent-token === ''` | 一律 403，避免"空 = 管理端"的绕过 |
| 写操作不挂 GET | 全路由审查 | 会触发副作用的接口（表情强制同步、语音同步）一律 POST；GET 只读 |
| 请求体限制 | `readBody()` | 声明长度或实际累计超过 1 MB → 413；30 秒读取超时 |
| 安全响应头 | 全部响应 | `X-Frame-Options: DENY`、CSP、`nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store` |

### 5. 秘密与落盘

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 原子写 | `atomicWriteJson/Text()` | 唯一随机临时名 + rename（Windows EPERM 退避重试），不会写坏配置 |
| Windows ACL 收紧 | `hardenStateDirAcl()` + `scripts/harden-state-acl.mjs` | Windows 上 `mode: 0o600` 是**空操作**，因此启动时切断 `state/` 的继承链，只保留当前用户/SYSTEM/Administrators。改 ACL 需要 WRITE_DAC —— **目录属主通常本来就有，所以一般不弹 UAC**；失败时用 `Start-Process -Verb RunAs` 提权重试一次（`--elevated` 短路自身，杜绝递归），再失败就打印可复制命令并**以 0 退出、绝不阻断启动**。控制台「访问与安全」页显示告警条与「重新检测」按钮 |
| 令牌不回显 | 日志/活动/工具日志 | 控制台令牌只打前 6 位；活动日志与工具调用参数过 `redactSensitiveText` / `redactSensitive`（递归处理 JSON 字符串叶子） |
| 令牌只发网关 | `gateway.secret` HMAC | 桥接对网关的全部请求（`/v1/inbound`、`/v1/actions` 回执）都用 `gateway.secret` 做 HMAC 签名；secret 只存在 `config.json`（ACL 收紧对象），不出现在任何出站文本或日志里 |
| 原型污染 | 状态 JSON 加载 | `__proto__` / `constructor` / `prototype` 键在加载侧被拒绝；配置合并用对象展开（不触发 setter） |

### 6. state/ 的 Windows ACL（防本机其他用户读令牌）

桥接不再拉起任何沙箱进程（智能体运行时在网关侧），但 `state/` 里仍有明文凭据
（控制台令牌、SnowLuma OneBot 令牌、聊天记录）。Windows 上 `mode 0o600` 是**空操作**，
所以收紧只能动 ACL：

| 事实 | 后果 |
| --- | --- |
| `harden-state-acl.mjs` 用 `/inheritance:r` 切断 `state/` 与 `config.json` 的继承链，只留当前用户/SYSTEM/Administrators | 本机其他已登录用户读不到凭据与聊天记录 |
| 切断继承需要 WRITE_DAC | 目录属主通常本来就有，一般不弹 UAC；失败时提权重试一次，再失败就打印可复制命令并**以 0 退出、绝不阻断启动** |

> ⛔ **绝不要用 `/inheritance:e` 去"修好" `state/` 的权限**：恢复继承会把父目录的
> 可继承 ACE 一起带回来，其中包含 `NT AUTHORITY\Authenticated Users: Modify` 与
> `BUILTIN\Users: ReadAndExecute` —— 那正是收紧时要摘掉的两条，等于把控制台令牌、
> SnowLuma OneBot 令牌与全部 QQ 聊天记录重新开放给本机任何已登录用户。

诊断：`npm run diagnose:acl` —— 只读扫描，列出全部被切断继承的路径并分成
「有意收紧（`state/`、`config.json`）」与「非预期收紧」两类。

### 7. 网络

`src/media/safe-fetch.js`（桥接全部出站 HTTP 的统一传输：表情/图片/媒体下载）：

- 只允许 `http` / `https`；拒绝 URL 内嵌凭据；拒绝 `file:` / `gopher:` 等 scheme
- 解析出的**每一个** DNS 结果都要过私有地址判定（含 IPv4-mapped IPv6、NAT64、6to4、ULA、link-local、zone-id、十进制/八进制/十六进制 IPv4）
- **连接到已校验的 IP**，同时保留原 `Host` 与 TLS SNI ⇒ 关闭 DNS rebinding 的检查-连接间隙
- 每一跳重定向都重新校验，最多 5 跳，重定向响应体立即销毁
- 响应体大小与图片像素上限；图片按 magic number 校验
- 不读取任何代理环境变量（不存在 `HTTP_PROXY` 绕过）

---

## 三、已知残余风险（明确不修 / 修不了，必须让用户知道）

| # | 风险 | 现状与缓解 | 为什么不修 |
| --- | --- | --- | --- |
| R1 | **敏感信息审计是启发式的** | 能抓"带赋值关系的凭据"和本机路径；抓不到任意形态的秘密 | 通用秘密检测无法在没有密钥的情况下做对；硬边界在白名单与动作面，审计是兜底 |
| R2 | **`state/` 里的令牌是明文** | Windows 已用 ACL 收紧；Linux 用 `0700` | 引入凭据库/DPAPI 会显著提高部署门槛 |
| R3 | **贴纸备注跨会话共享** | 只有注入路径做了加固，未做会话隔离 | 单一账号的贴纸库本就是全局的；多群互害场景很少 |
| R5 | **离线队列不保证送达** | 进程退出即丢 | 一致性代价过高；README 已写明 |
| R8 | **单人维护、无外部安全审计** | 有离线回归 + 本文档 | 计划做一次外部/对抗式复审 |
| R9 | **`state/` 的 ACL 收紧可能失败**（未提权且目录属主权限被策略收走时） | `scripts/harden-state-acl.mjs` 会自动提权重试一次；仍失败则明确告警 + 给出可复制命令 + 控制台告警条 | 改 ACL 属于需要特权的操作；**降级为"明确告警"而不是"阻断启动"**是刻意的取舍（否则用户会为了能启动而关掉整条安全链路） |

> 🗄️ 精简重构随能力删除而移除的风险项：R4（DSH 远程停止非原子）、R6（预设不变量子串检查）、
> R7（self-test）、R10/R11（DSH 沙箱与 `plugins/**` ACL 交互）——DSH 直连面与自带 MCP 已退役。

---

## 四、发布前必须跑的检查（回归清单）

```bash
npm run test:audit          # 离线审计套件（含安全专项），必须全绿
npm run verify:decouple     # 平台解耦契约（桥接零直连、动作面 = 网关清单）
npm run test:gateway        # 网关契约 / 状态 / 唤醒合成 / 动作层离线测试
npm run diagnose:acl        # ACL 收紧路径盘点（只读）
node --check src/bridge.js  # 语法门禁（大文件改动后必跑）
```

安全专项必须覆盖（缺一不可）：

- [x] 白名单/黑名单/空白名单 fail-closed（含单复数与字符串/数字两种写法）
- [x] `gateway.url/secret/adapterId` 缺失时**启动即失败**（绝不静默丢消息）
- [x] 动作面 = 网关清单中 `enabled` 的条目；未实现/未启用的动作不会注册
- [x] agent token 无法访问任何管理端点；空 agent token 被拒
- [x] 控制台伪造 `Host` 被拒；错令牌（含错长度、大小写、尾空格）被拒
- [x] `/api/authorize/read` 空令牌被拒
- [x] agent 令牌只能读自己会话；跨会话读返回 403
- [x] 语音只能取语音库内的文件（含 `allowAbsolutePath=true` 与相对穿越两种情形）
- [x] 出站文本命中敏感信息时整条拦截；含已知会话令牌时直接抛错
- [x] SSRF：scheme、URL 凭据、私有 IP、重定向、超时、大小限制（11 项）
- [x] `state/` ACL 助手：非阻断、防递归、`start.bat` 纯 ASCII+CRLF 且先于桥接调用（**结构级断言**）
- [ ] **`state/` ACL 的真实 icacls/UAC 行为**：需在普通终端手动复跑 `node scripts/harden-state-acl.mjs` 确认（CI 里改 ACL 会被拒，无法自动化）

---

## 五、改动检查单（每个 PR 自问）

1. 这次改动有没有让某个"不确定"变成"放行"？（违反 fail-closed 即阻断）
2. 有没有新增一个**只有控制台该用**的端点却没进 agent 白名单的默认拒绝？
3. 有没有新增读写文件的路径参数？它是否做了包含性校验与 realpath？
4. 有没有把外部数据（QQ 内容、文件名、配置值）直接插进 HTML / 日志 / 提示词？
5. 新增的定时器、Map/Set、监听器，在会话退役与进程退出路径上都清理了吗？
6. 是否更新了对应的测试与本文档？
