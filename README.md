# qq-bridge monorepo

QQ 个人号 → agent-gateway 的桥接系统（同仓两进程）。

```
QQ.exe ←(hook) driver/ SnowLuma ←(OneBot 11: HTTP 3000 / WS 3001) bridge/ ←(gateway 契约, 7190) agent-gateway → DSH
```

## 分层规则（R1-R4，详见 `bridge/docs/plans/bridge-monorepo-plan.md`）

| 规则 | 内容 |
|---|---|
**R1 driver 隔离** | `driver/` 是闭源 SnowLuma vendor（不入库，gitignore）。任何代码不得 import driver 内部；唯一访问方式 = OneBot 11 端口。升级 = 整体替换 runtime + 更新 driver/README 版本记录 |
**R2 桥接纯适配器** | `bridge/` 上游唯一 agent-gateway、下游唯一 OneBot 11；无本地会话、零 DSH 直连（`npm run verify:decouple` 固化） |
**R3 OneBot 11 唯一层间接口** | token 自发现自愈（bridge/src/integrations/snowluma-conn.js，扫描 driver/config/onebot_*.json）；层间禁止其它通道 |
**R4 配置按层隔离** | bridge 的 config.json/gateway.json/state 与 driver 的 config/data/logs 各自独立、互不写入 |

## 快速入口

| 命令 | 作用 |
|---|---|
**`start.bat`（仓库根，推荐）** | 合并启动器：QQ 检查 → SnowLuma(driver) 与 qq-bridge(bridge) 双守护窗口启动（已运行则跳过） |
`driver/` 内 `start-driver.bat` | 仅启动驱动层守护（5s 自动重启 + 3000 端口单实例预检 + node 门禁） |
`bridge/` 内 `start-bridge.bat` | 仅启动桥接层守护（5s 自动重启 + 单实例锁） |
`npm start` / `npm test`（根） | 代理到 bridge/ |
`npm run test:offline` | 离线测试子集（gateway 契约 95 用例 + 审计 + md + src 布局） |
`npm run probe:heartbeat` | SnowLuma 心跳探测 |
`npm run verify:decouple` | 解耦回归断言（R2） |
`npm run setup-driver` | driver vendor 完整性校验 |

> 2026-11-23：start-all/stop-all 已按用户决策删除，由根 `start.bat` 取代（编排器——两层各自有守护器自愈）。DSH 与 agent-gateway 由各自进程独立管理，不在启动器范围。

## 关键路径

- 桥接层文档：`bridge/README.md`（原始项目 README，含完整功能说明）
- 配置样例：`bridge/config.example.json`、`bridge/gateway.example.json`
- 实施方案与评审记录：`bridge/docs/plans/bridge-monorepo-plan.md`
- SnowLuma 版本记录与升级步骤：`driver/README.md`（runtime 不入库；版本留存靠 `C:\Backups\SnowLuma-full-*.zip` 快照）

## 端口契约（不可变更）

OneBot HTTP 3000 / WS 3001 ｜ bridge console 3100 ｜ driver WebUI 5099 ｜ agent-gateway 7190 ｜ DSH 3080
