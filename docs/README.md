# 文档索引（docs/README.md）

> 根目录只留 `README.md` / `README.en.md` / `RULES.md` 三个文档，其余全部在本目录下。
> 仓库目录结构与 `scripts/` 命名约定见 **[FOLDER_MAP.md](FOLDER_MAP.md)**。
>
> **状态标记**：✅ 仍然有效（按它做就对） · ⚠️ 部分过时（见备注）

---

## guides/ —— 面向使用者 / 运维

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [guides/GATEWAY_OPS.md](guides/GATEWAY_OPS.md) | **agent-gateway 运维手册**：拓扑与端口、健康检查与排障表、密钥轮换、备份恢复、发布前验收清单 | ✅ |
| [guides/PLATFORM_DECOUPLE.md](guides/PLATFORM_DECOUPLE.md) | **平台解耦说明**：桥接只连网关后的消息流、硬不变量、`verify:decouple` 失败项读法 | ✅ |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | **安全基线与威胁模型**：威胁主体、已实现的边界（准入/动作面/出站/控制台/落盘/网络）、已知残余风险、发布前回归清单、改动检查单 | ✅ **改动安全相关代码前必读** |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览（`npm run preview:console`）与离线浏览器回归（`npm run test:console-ui`）怎么用 | ✅ |
| [guides/PRIVACY.md](guides/PRIVACY.md) | 隐私扫描（`npm run privacy-scan`）的规则与放行口径 | ✅ |
| [guides/VOICE.md](guides/VOICE.md) | 语音发送全解：独立工具（`voice-tool/` 的图形界面与命令行）、桥接 CLI、AI 工具、控制台面板，以及**工具拆出后的配置解析顺序** | ✅ |

## design/ —— 设计文档（读设计意图用）

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [design/AGENT_GATEWAY.md](design/AGENT_GATEWAY.md) | **网关化改造设计**：分层架构、线缆契约、状态归属表、阶段与回滚矩阵、测试计划 | ✅ 主线设计 |
| [design/MEMORY_LAYERS.md](design/MEMORY_LAYERS.md) | 网关侧记忆分层设计（短期/长期、单写者、spool→ingest） | ✅ 网关侧实现依据；桥接已无记忆代码 |
| [design/ROLLBACK_LOG.md](design/ROLLBACK_LOG.md) | 回滚与影子演练记录 | ✅ |

---

## 想找什么 → 去哪看

| 我想…… | 看这个 |
| --- | --- |
| 搞懂整体架构 / 全部配置项 | [../README.md](../README.md)、[FOLDER_MAP.md](FOLDER_MAP.md) |
| 权限边界与安全承诺 | [../RULES.md](../RULES.md) |
| 动安全相关代码 / 做发布前检查 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) |
| 网关运维、排障、密钥轮换、备份恢复 | [guides/GATEWAY_OPS.md](guides/GATEWAY_OPS.md) |
| 桥接/网关解耦后的投递语义与验证 | [guides/PLATFORM_DECOUPLE.md](guides/PLATFORM_DECOUPLE.md)、[design/AGENT_GATEWAY.md](design/AGENT_GATEWAY.md) |
| 改控制台界面并做离线回归 | [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) |
| 发语音 / 换 QQ 账号后语音工具 401 | [guides/VOICE.md](guides/VOICE.md)（独立工具在仓库上一级 `../voice-tool/`） |
| 知道某个目录/脚本是干什么的 | [FOLDER_MAP.md](FOLDER_MAP.md) |

> 🗄️ 精简重构删除的文档：DSH 端安装/适配三部曲（`DSH_SETUP` / `DSH_020_ADAPTATION` / `DSH_021_ADAPTATION`，
> DSH 直连面已退役）、`MEMORY_MCP` / `ROLECARD_MCP`（桥接不再引用这两个平级服务）、
> `TOKEN_USAGE_CONSOLE`（计费看板已删）、`PROJECT_GUIDE`（内容已并入根 README 与本目录现存文档）。
> 历史 audits/research/legacy 归档未随精简版仓库发布。
