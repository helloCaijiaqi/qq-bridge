// QQ 会话的工具权限硬边界：注册期隐藏危险工具 + 执行期白名单兜底。
//
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 本文件是 qq-agent-presets bundle 里的**唯一权威实现**（2026-11-16 起没有第二份拷贝：
// 以前的 re-export 壳与 qq-chat-v2 / qq-chat-lite 两个预设已删除）。
// 源在仓库 `dsh/qq/bundle/`，由 `npm run setup:dsh` 物化到 `<DSH_HOME>/plugins/qq-agent-presets/`，
// 唯一引用方是预设源 `dsh/qq/agent-presets/qq-chat/agent.cordis.yml` 里的
// `- id: qq-tool-restrict / name: ./qq-tool-restrict.mjs` 行（生成器会改写成裸说明符）。
//
// 为什么引用方式是「包名/子路径」而不是 `./qq-tool-restrict.mjs`（DSH 0.1.7 的机制变化）：
//   0.1.5 的 preset 是 ~/.dsh/.agent-presets/<preset>/ 目录，相对名按 preset 目录解析；
//   0.1.7 的 preset 变成一条 loader 行，子行 name 按**声明它的 loader 上下文**
//   （= profile 目录 file:///…/.dsh/profiles/<profile>/）解析，因此 `./x.mjs` 会去找
//   profile 根目录下的文件（不存在）。bundle patch 文件只对 insert 行自己的 name 做
//   「相对 patch 文件锚定」（dsh-app-boot 的 anchorInsertedPluginNames），不会走进
//   preset 行的 config.plugins —— 所以守卫只能用**从 profile 目录可解析的裸说明符**。
//   该包以 link: 依赖注册在 profile package.json，node_modules junction 由
//   scripts/setup-dsh.mjs（或 dsh-super-injector 的 dev_heal_links）维护：
//   不写死任何绝对路径，仓库搬家后重建链接即可。
// 作用：
//  1) 用 tools.restrict 把本地执行/文件类工具与开发工具从**工具清单**里隐藏（注册期）；
//  2) 用 tools.guard 白名单兜底：任何不在允许范围内的工具，执行时一律拒绝。
//
// ⚠️ 第 1 条是铁律 L7 的落点，不是"附注"：仿真会话的 preset 永不包含本地工具。
//    `tools.guard` 只能拒绝**执行**，工具名仍会出现在模型的 schema 里——
//    那既不满足"仿真会话不得拥有本地执行能力"的注册期要求，也会诱导模型去调它。
//    所以本地工具必须同时出现在下面的 restrict 名单里。
//
// ── 名单分三层（2026-11-16 重构）─────────────────────────────────────────────
// 为什么分层：`tools.restrict()` 只作用于**继承的全局工具**，名字不在全局层就抛
// `unknown global tool`。旧实现把 82 个名字一把梭全量尝试、所有异常都算失败，于是
// 每个会话都刷「restrict ok=4 failed=78」——真正的失败淹没在噪音里。
//
//   A 层 `critical`：当前 DSH 版本确定存在的继承全局工具。缺失 = DSH 改名/移层，
//                    保护可能已失效 ⇒ 记 `missing` 并 console.error（不阻断会话）。
//   B 层 `injected`：注入器在运行时注册（`dev_*`）。不存在属正常；晚注册有可能，
//                    所以失败项保留一次 3 秒静默补试。
//   C 层 `net`     ：回归网。当前 composition 里不存在，一旦被别的组合包装进全局层
//                    就立刻挡住。不存在只计数，不报警、不重试。
//
// 为什么不再维护「静态存在性清单」：全局工具名只有 DSH 运行时才知道（restrict 的
// 报错里会回显 `known global tools: …`）。任何硬编码的「现在存在」集合都会随 DSH
// 升级漂移，且用扫描 node_modules 的方式去对账既慢又脆（实测会卡住 shell）。
// 因此：**运行时探测 + 错误分类**是唯一真相，静态名单只表达「危险语义」。
export const name = 'qq-tool-restrict'

export const inject = ['tools']

/**
 * 本地执行 / 文件访问 / 进程控制类工具：仿真会话**不得**拥有。
 *
 * 名字**逐个核对过** DSH 0.1.7-rc.2 实际注册的工具名（来源包见每条注释），
 * 不是凭印象列举。教训：本名单初版把 `pwsh_persistent`/`bash_persistent`/
 * `cordis`/`goal_write`/`goal_read` 当成工具名，这五个**根本不存在**——
 * 而 `tools.restrict()` 对未知名字会抛错、被下面的 try/catch 逐个吞掉，
 * 于是坏名字**静默失效**。`test-preset-local-tools.mjs` 现在会把本数组与
 * DSH 真实工具名集合求差，专门防这类拼写假名。
 *
 * 2026-09-27 针对 0.1.7-rc.2 重新对账（不是逐个打补丁）：`dsh-tool-cordis` 仍在，
 * 但 `cordis_define`/`cordis_undefine`/`cordis_run`/`cordis_stop` 四个名字**已被删除**，
 * 现在只注册 `cordis_inspect_list`/`cordis_inspect_query`——旧名字留在名单里
 * 只会换来四条静默失效的 restrict（正是本名单最怕的失败模式），
 * 而新名字能读宿主运行期状态，属于必须隐藏的那一类，所以是**替换**不是删除。
 * 同一轮对账还补上了 0.1.7 新增的两个能力：
 *   - `load_workspace_dependencies`（自带 Python/Node/pnpm 的绝对路径 ⇒ 等于递上执行能力）
 *   - `list_subagent_models`（派生 agent 家族，暴露宿主模型路由配置）
 *
 * 来源包（0.1.7-rc.2）：
 *   dsh-tool-pwsh / -pwsh-persistent   → pwsh（persistent 变体注册的就是 "pwsh"）
 *   dsh-tool-bash / -bash-persistent   → bash（同上）
 *   dsh-tool-fs                        → read / read_image / write / edit
 *   dsh-tool-fs-search                 → glob / grep
 *   dsh-tool-str-replace-editor        → str_replace_editor
 *   dsh-tool-workspace-dependencies    → load_workspace_dependencies
 *                                        （返回内置 Python/Node/pnpm 的绝对路径）
 *   dsh-tool-subagent                  → subagent / subagent_fork / list_subagent_models
 *   dsh-tool-subagent-control          → send_message / interrupt_agent / list_agents
 *   dsh-tool-workflow / -ralph         → workflow / ralph
 *   dsh-tool-jobs                      → job_list / job_output / job_kill
 *   dsh-tool-todo / -skill / -present  → todo_write / skill / present
 *   dsh-tool-goal                      → get_goal / create_goal / update_goal
 *   dsh-tool-cordis                    → cordis_inspect_list / cordis_inspect_query
 *                                        （读宿主运行期状态；0.1.7 已无装载类工具名）
 *   dsh-plugin-guard（web profile bundle）→ dsh_snapshot / dsh_rollback / incident_resolved
 *                                        （读写 package.json/lockfile/patch 并 **spawn pnpm**）
 *   dsh-mode-boost（已装插件，当前未进 bundles）→ dev_mode_set / _status / _subagent
 *                                        （dev_mode_subagent 会派生 agent）
 *
 * ⚠️ 硬证据：2026-08-29 的一次 **qq-chat-v2 仿真会话**记录下来的工具清单里，
 * 除了 MCP 工具就只有 `ask_user_question`、`todo_write`、`dev_mode_*`、
 * `dsh_rollback`、`dsh_snapshot`、`incident_resolved`。也就是说
 * **`dsh_snapshot`/`dsh_rollback` 真的进过仿真会话的 schema**——本名单初版漏了它们。
 *
 * 2026-09-29 针对 DSH 0.2.0-rc.2 重新对账（同样不是逐个打补丁，而是拿安装包重扫）。
 * 对账工具：`node scripts/scan-dsh-tool-names.mjs`（可重复运行；它从已安装的
 * `@deepseek-ai/dsh-*` 里抽真实工具名，与本名单求双向差）。
 * 该轮结论：**旧名字全部还在**（0 个假名，0.1.7 那次替换后没有再次改名），
 * 但 0.2.0 的包里多出 13 个「危险语义」名字是名单没覆盖的，逐条判定如下：
 *
 *   ① 真的会进仿真会话、必须隐藏的（它们在**全局层**，所有 preset 都继承）：
 *      · `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`
 *        —— `dsh-base` 的 `mcp-resources` 行**默认启用**（cordis.patch.yml 里没有
 *        disabled），所以每个 QQ 会话都会继承这三个工具。`read_mcp_resource` 的
 *        `server` 参数可以指向**任意已配置的 MCP server**：用户一旦挂了
 *        filesystem 之类的能力型 MCP，QQ 群就通过它拿到了文件读取权。
 *        这正是 L7 要挡的那类越权路径，因此必须从 schema 里隐藏。
 *   ② 会派生 agent / 执行外部代码（当前只在 DSH 自带 preset 里挂载，QQ preset 不挂；
 *      列进来是**回归网**：别的 composition 一旦把它们推进全局层就被挡住）：
 *      · `subagent_codex` / `subagent_claude_code`（Codex / Claude Code 子智能体）
 *      · `spawn_teammate` / `team_task_create|get|list|update`（实验性 Team 模式）
 *   ③ 等于把插件装载权交出去 ⇒ 任意代码执行：
 *      · `plugin_manager`（安装/卸载/启停插件，内部会 spawn pnpm）
 *   ④ 无人值守的自我调度（`dsh-schedule`，0.2.0 起是可选 bundle）：
 *      · `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`
 *
 * 2026-10-22 针对 DSH 0.2.1-rc.2 重新对账（`node scripts/scan-dsh-tool-names.mjs`）。
 * DSH 这轮把不少能力从「实验组合包」转正，工具面因此变了三处：
 *   ① **新增一个真的会进仿真会话的全局工具**：`dsh-base` 现在默认挂
 *      `working-directory` + `tool-working-directory` 两行，于是 `working_directory`
 *      和 `list_mcp_resources` 一样属于**全局层继承**——QQ 会话一定拿得到，
 *      必须从 schema 隐藏（`state/tool-restrict.log` 的 known global tools 实测可见）。
 *   ② 新增终端能力 `dsh-tool-terminal`（`terminal_open|send|read|signal|close|list`）：
 *      终端 = 直接 shell，是本名单第一优先级要挡的东西；当前 composition 没启用，
 *      列进来是**回归网**（一旦被插件市场/组合包装上就自动挡）。
 *   ③ 新增会话历史检索 `dsh-tool-session-query`
 *      （`session_search|trace`、`session_event_read|search|trace`）：
 *      能跨会话读事件正文 ⇒ 等于把别的聊天记录递给 QQ 群，列进来。
 *   另有两个「装载权」入口同轮补上：`plugin_market`（插件市场，等价 plugin_manager）
 *   与 `create_worktree`（写盘 + 起 git 进程）、`wait_agent`（team 家族同族）。
 *
 * ⚠️ 0.2.1 把 Codex / Claude Code 从内置 preset 改成**按需安装的可选插件**，
 *    因此 `subagent_codex` / `subagent_claude_code` 在默认安装里**不存在**——
 *    restrict 对它们必然抛错。但用户一旦装上那两个组合包，名字就会回到全局层，
 *    所以仍然保留为**可选项名单**（{@link OPTIONAL_BUNDLE_TOOL_NAMES}）而不是删掉；
 *    扫描器/测试把这一组排除在「拼错假名」判定之外，其余名字照旧逐个对账。
 */
const LOCAL_EXECUTION_TOOLS = [
  // shell / 进程
  'pwsh', 'bash',
  // 文件读写
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  // 文件检索
  'glob', 'grep',
  // 自带运行时（Python/Node/pnpm 的绝对路径）⇒ 等于把"跑代码"递给模型
  'load_workspace_dependencies',
  // 派生 agent 与编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // 插件/cordis 运行期检查：能读宿主状态（0.1.7 起只有这两个名字）
  'cordis_inspect_list', 'cordis_inspect_query',
  // 本机文件 + 进程：plugin-guard 会改写配置并 spawn pnpm
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话/交付/任务面
  // 注意：`todo_write` 与 `ask_user_question` **故意不在**此名单——它们是下面
  // SAFE_EXACT 允许的无害模型侧工具，两边不能自相矛盾。
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // 0.2.0 新增对账（见上方长注释的 4 类判定）：
  //   ① 全局层默认启用 ⇒ 真的会进仿真会话
  //      （这 3 个已升到 A 层 CRITICAL_GLOBAL_TOOL_NAMES：它们当前真实存在）
  //   ② 派生 agent / 执行外部代码
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  //   ③ 插件装载权（= 任意代码执行）
  'plugin_manager',
  //   ④ 无人值守的自我调度
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 0.2.1 新增对账（2026-10-22，见上方长注释）：
  //   ① dsh-base 默认启用 ⇒ 全局层继承
  //      （working_directory 已升到 A 层 CRITICAL_GLOBAL_TOOL_NAMES）
  //   ② 终端（= shell）
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  //   ③ 会话历史检索（能读别的会话的事件正文）
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  //   ④ 装载权 / 写盘起进程
  'plugin_market', 'create_worktree',
  //   ⑤ team 家族同族补齐
  'wait_agent',
  // 已装但当前未进 bundles 的插件（一旦加回就是新口子）
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
]

/**
 * 0.2.1 起改为「按需安装」的可选能力包里才会注册的全局工具名。
 *
 * 它们默认**不存在**于安装树里（0.2.0 时写在 `dsh-web-app/presets/*.patch.yml`），
 * `tools.restrict()` 对它们必然抛错——守卫逐个 try/catch 正是为这种名字设计的。
 * 保留的收益：用户装上 Codex / Claude Code 组合包后，名字回到全局层时**立刻**被挡，
 * 不必等下一次对账。
 *
 * 扫描器与测试用这一组把「可选项」和「拼错的假名」区分开：只有不在本组、又扫不到的
 * 名字才判成假名。
 */
export const OPTIONAL_BUNDLE_TOOL_NAMES = Object.freeze([
  'subagent_codex',
  'subagent_claude_code',
])

/**
 * A 层 · 关键全局工具：当前 DSH 版本**确定存在**的继承全局工具。
 *
 * 依据：`tools.restrict()` 的报错会回显 `known global tools: …`，2026-11-16 实测
 * 全局层就是这四个（restrict ok=4 的那四条）。它们对 QQ 会话都是越权路径：
 *   - `read_mcp_resource`：`server` 参数可指向任意已配置 MCP server ⇒ 用户挂个
 *     filesystem 就等于把文件读取权递给 QQ 群；
 *   - `list_mcp_resources*`：暴露宿主 MCP 配置；
 *   - `working_directory`：暴露宿主路径。
 *
 * 语义：缺失 ⇒ `missing`（DSH 改名/移层的信号），console.error + 诊断一行，但**不阻断**
 * 建会话——插件加载失败会让整个预设装不上，比降级更糟。
 */
export const CRITICAL_GLOBAL_TOOL_NAMES = Object.freeze([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'working_directory',
])

/**
 * B 层 · 运行时注入工具（dsh-super-injector，0.1.7-rc.2 实测注册）。
 *
 * 这些名字**注入即注册、卸载即消失**，所以「当前不存在」是常态；但注入器可能比
 * preset 晚 apply，因此不存在的项保留一次 3 秒静默补试（不能计入失败）。
 * 真正的边界仍是下面的执行期白名单。
 */
export const RUNTIME_INJECTED_TOOL_NAMES = Object.freeze([
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
])

/**
 * C 层 · 回归网：当前 composition 里不存在，但语义上必须挡。
 *
 * 一旦别的组合包/插件市场把它们注册进全局层（或 DSH 升级后改名回全局），
 * 这里会自动命中并隐藏；不存在时只计数，不报警也不重试。
 *
 * `purge_*` 按 2026-11-16 的决定放这一层（而不是 A 层）：它们可能是 dsh-purge 的
 * **可选能力**，不适合硬断言存在；实测当前全局层确实出现过，因此会被顺带隐藏。
 */
export const REGRESSION_NET_TOOL_NAMES = Object.freeze([
  ...LOCAL_EXECUTION_TOOLS,
  ...OPTIONAL_BUNDLE_TOOL_NAMES,
  'purge_apply',
  'purge_revert',
  'purge_status',
])

/**
 * 探测计划：层名 → 名字列表。分层只影响**失败的解释方式**，不影响尝试顺序。
 * 导出它便于单测与审计脚本在不加载 DSH 的情况下复算清单。
 */
export const RESTRICT_TIERS = Object.freeze([
  Object.freeze({ tier: 'critical', names: CRITICAL_GLOBAL_TOOL_NAMES }),
  Object.freeze({ tier: 'injected', names: RUNTIME_INJECTED_TOOL_NAMES }),
  Object.freeze({ tier: 'net', names: REGRESSION_NET_TOOL_NAMES }),
])

// 三层并集（去重）：给审计脚本/测试与文档用的「全部受限名字」视图。
export const RESTRICTED_TOOL_NAMES = Object.freeze([
  ...new Set(RESTRICT_TIERS.flatMap(({ names }) => names)),
])

// 执行期白名单：不在这些范围内的工具一律拒绝。
// 前缀覆盖 DSH MCP client 暴露的命名空间工具。
export const SAFE_PREFIXES = Object.freeze([
  // 平台解耦（dsh-decouple）：QQ 工具面唯一入口——DSH 只挂 mcp-gateway-bus
  // （serverName=agent-gateway），能力由网关按适配器清单动态生成。
  'mcp__agent-gateway__',
  // 旧直连 MCP 命名空间：回滚窗口内仍可解析（新版 setup-dsh 不再注册它们）。
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
])

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，
// todo_write 仅维护任务列表。若后续 preset 不再挂载这些工具，保留无害。
export const SAFE_EXACT = Object.freeze(new Set([
  'ask_user_question',
  'todo_write',
]))

/**
 * 这个工具名是否被**刻意**放行（守卫白名单）。
 *
 * 与 restrict 名单的关系：放行的工具当然不挡；反过来，`mcp__agent-gateway__chat_qq_*`
 * 这些名字会出现在**全局层**（实测诊断里有 `mcp__agent-gateway__chat_qq_approve`），
 * 对账脚本必须把它们算作「有意可见」，否则每次审计都会误报 uncovered。
 */
export function isExplicitlyAllowed(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (SAFE_EXACT.has(name)) return true
  return SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))
}

// ── 诊断落盘：restrict 到底挡了什么、漏了什么 ──────────────────────────────
//
// 为什么必须落盘（2026-10-18 实测）：重启之后新建的 QQ 会话 schema 里，
// `dev_*` **仍然是 18 个**——说明 `ctx.tools.restrict({deny})` 根本没生效，
// 而失败被 per-name try/catch 吞掉了。DSH 的 stderr 不落日志文件（只有启动失败
// 才会写 ~/.dsh/logs），所以「为什么失败」在现网完全不可观测。
//
// 2026-11-16 起口径变了：**没挡住 ≠ 出错**。名字不在全局层（`unknown global tool`）
// 是回归网/可选包的常态，只计入 `skipped`；每次 apply 最多写 3 行：
//   1) 汇总：`restrict hidden=4 skipped=79 missing=0 failed=0`
//   2) 权威全局层清单：`known global tools(N): …`（DSH 报错里回显，供审计脚本对账）
//   3) 只有真出问题时才有失败明细 / 关键工具缺失警告
// 文件有界（最近 20 行）；单行上限放宽到 2000 字符，否则全局层清单会被截断、
// 审计脚本就看不到全貌了。
const DIAG_FILE = (() => {
  // 测试可用 QQ_TOOL_RESTRICT_LOG 改到临时文件，避免污染真实 state/
  if (process.env.QQ_TOOL_RESTRICT_LOG) return path.resolve(process.env.QQ_TOOL_RESTRICT_LOG)
  try {
    // 判定基准是**安装位置**：setup:dsh 把本文件物化到 <DSH_HOME>/plugins/<bundle>/，
    // 往上两层就是 <DSH_HOME>，因此诊断落在 <DSH_HOME>/state/tool-restrict.log。
    // （仓库里的副本是源，不会被执行；不要按仓库层级去数目录。）
    return fileURLToPath(new URL('../../state/tool-restrict.log', import.meta.url))
  } catch { return '' }
})()

function writeDiagnostics(lines) {
  if (!DIAG_FILE || !lines.length) return
  // 单行截断：DSH 的报错里会把**整份** known global tools 清单拼进去，上限放宽到 2000
  // 字符——既要能容纳整份清单（审计脚本靠它算 uncovered），又要防止异常长行撑爆日志。
  const trim = (line) => (line.length > 2000 ? `${line.slice(0, 2000)}…` : line)
  try {
    const previous = (() => {
      try { return fs.readFileSync(DIAG_FILE, 'utf8').split('\n').filter(Boolean) } catch { return [] }
    })()
    // 有界：只保留最近 20 条（每次 agent 创建都会写一轮，别让文件无限长）
    const next = [...previous, ...lines.map(trim)].slice(-20)
    fs.mkdirSync(path.dirname(DIAG_FILE), { recursive: true })
    fs.writeFileSync(DIAG_FILE, next.join('\n') + '\n', 'utf8')
  } catch {}
}

// ── 探测逻辑（纯函数，可脱离 DSH 单测）─────────────────────────────────────

/**
 * DSH 对「名字不在全局层」的报错措辞。
 * 改动这里等于承认对账失效，所以测试用真实报错样例把它钉住。
 */
export function isUnknownToolError(message) {
  return /unknown global tool/i.test(String(message ?? ''))
}

/**
 * 从 restrict 报错里抠出**权威**全局工具清单。
 *
 * DSH 原文：`tools.restrict() names unknown global tool "x"; known global tools: a, b, c`
 * 这是运行时唯一可信的「当前全局层有什么」，审计脚本靠它算 uncovered。
 * @returns {string[]} 解析不出时返回 []
 */
export function parseKnownGlobalTools(message) {
  const matched = /known global tools:\s*(.+)$/is.exec(String(message ?? ''))
  if (!matched) return []
  return matched[1]
    .split(',')
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z0-9_.:-]+$/.test(name))
}

/**
 * 按层探测全局工具（纯函数；`restrict` 由调用方注入，便于单测与审计复算）。
 *
 * 分类口径：
 *   - 成功 → hidden
 *   - `unknown global tool` → skipped（A 层额外进 missingCritical）
 *   - 其它异常 → failed（这才是需要人看的问题，例如 context 不是 scoped、空 filter）
 *
 * @param {{tiers: {tier: string, names: readonly string[]}[], restrict: (name: string) => void}} input
 * @returns {{
 *   hidden: string[],
 *   skipped: {name: string, tier: string}[],
 *   failed: {name: string, tier: string, message: string}[],
 *   missingCritical: string[],
 *   knownGlobal: string[],
 * }}
 */
export function runRestrictPlan({ tiers, restrict }) {
  const hidden = []
  const skipped = []
  const failed = []
  const missingCritical = []
  let knownGlobal = []

  for (const { tier, names } of tiers) {
    for (const name of names) {
      try {
        restrict(name)
        hidden.push(name)
      } catch (error) {
        const message = String(error?.message ?? error)
        if (isUnknownToolError(message)) {
          skipped.push({ name, tier })
          if (tier === 'critical') missingCritical.push(name)
        } else {
          failed.push({ name, tier, message })
        }
        const parsed = parseKnownGlobalTools(message)
        if (parsed.length) knownGlobal = parsed
      }
    }
  }
  return { hidden, skipped, failed, missingCritical, knownGlobal }
}

/**
 * 汇总行（诊断与审计共用同一个格式，审计脚本按正则解析）：
 * `restrict hidden=4 skipped=79 missing=0 failed=0`
 */
export function formatRestrictSummary({ hidden = [], skipped = [], missingCritical = [], failed = [] }) {
  return `restrict hidden=${hidden.length} skipped=${skipped.length}`
    + ` missing=${missingCritical.length} failed=${failed.length}`
}

export function apply(ctx) {
  // 1) 把危险全局工具从 schema 隐藏（restrict 只影响继承的全局层，
  //    不会误删 preset 自己注册的 scoped 工具）。
  //    逐个 restrict：DSH 的 unknown 校验是整批原子性的，只能一个一个试。
  const stamp = new Date().toISOString()
  const result = runRestrictPlan({
    tiers: RESTRICT_TIERS,
    restrict: (name) => ctx.tools.restrict({ deny: [name] }),
  })
  const summary = formatRestrictSummary(result)

  const lines = [`${stamp} ${summary}`]
  if (result.knownGlobal.length > 0) {
    lines.push(`${stamp} known global tools(${result.knownGlobal.length}): ${result.knownGlobal.join(', ')}`)
  }
  if (result.failed.length > 0) {
    const detail = result.failed
      .slice(0, 3)
      .map((f) => `${f.name}[${f.tier}]: ${f.message}`)
      .join(' | ')
    lines.push(`${stamp} 失败 ${result.failed.length} 项: ${detail}`)
  }
  if (result.missingCritical.length > 0) {
    lines.push(`${stamp} 警告: 关键全局工具缺失 ${result.missingCritical.join(', ')}`
      + '（DSH 可能改名/移层，注册期隐藏或已降级）')
  }

  // console 只在需要人看时出声：正常情况下每个会话静默（旧实现每会话刷 2KB 报错）。
  if (result.failed.length > 0 || result.missingCritical.length > 0) {
    console.error(`[qq-tool-restrict] ${summary}`
      + (result.missingCritical.length ? ` 缺失=${result.missingCritical.join(',')}` : ''))
  }
  writeDiagnostics(lines)

  // 2) 时序兜底：只重试「可能晚注册」的两类——B 层（注入器）与真正的失败。
  //    C 层不存在属预期（回归网没被触发），重试纯属浪费。
  const retryNames = [
    ...result.skipped.filter((item) => item.tier === 'injected').map((item) => item.name),
    ...result.failed.map((item) => item.name),
  ]
  if (retryNames.length > 0) {
    const timer = setTimeout(() => {
      let ok = 0
      const still = []
      for (const name of retryNames) {
        try {
          ctx.tools.restrict({ deny: [name] })
          ok += 1
        } catch (error) {
          const message = String(error?.message ?? error)
          // unknown 在这里仍是预期（注入器没启用），只有别的错误才算真的还失败。
          if (!isUnknownToolError(message)) still.push(`${name}: ${message}`)
        }
      }
      // 只在有**变化**时落盘：`retried=18 ok=0 仍失败=0` 是稳态噪音
      // （这 18 个注入器工具没启用，事实已经体现在 skipped 计数里）。
      if (ok > 0 || still.length > 0) {
        if (ok > 0) console.error(`[qq-tool-restrict] 延迟重试补藏成功 ${ok} 个（注入器晚注册）`)
        writeDiagnostics([
          `${new Date().toISOString()} 延迟重试 retried=${retryNames.length} ok=${ok} 仍失败=${still.length}`
          + (still.length ? ` 原因: ${still[0]}` : ''),
        ])
      }
    }, 3000)
    timer?.unref?.()
  }

  // 3) 执行期白名单：任何不在允许范围内的工具调用都会被拒绝。
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
    if (isExplicitlyAllowed(name)) return
    return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`
  })
}
