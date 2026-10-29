// 按 preset 配置裁剪 MCP 工具（注册期隐藏，不是调用期拒绝）。
//
// 为什么要有这个文件：MCP 工具描述 + 参数 schema 会随 system prompt 在**每一次** LLM 请求
// 里重发。实测口径（见 src/mcp-snowluma-safe.js 注释）：41 个工具约 8.8k token。全局唯一的
// `socialV2.tools` 开关只能给出「一套工具面」，做不到「管理员全量、其他人精简」。
//
// 本插件挂在 preset 内，`ctx.tools.restrict({deny})` 在 **preset scope** 生效：只影响
// 用这个 preset 创建的 agent，不污染全局层，也不影响其它 preset。MCP 连接仍然是
// profile 级全局单实例（不要挪进 preset——那会每个会话拉起一个 stdio 子进程）。
//
// 用法（preset 的 agent.cordis.yml）：
//   - id: tool-deny-lite
//     name: qq-agent-presets/qq-tool-deny.mjs
//     config:
//       deny:
//         - mcp__snowluma__qq_send_sticker
//
// 注意工具名必须是**公开名**（`mcp__<serverName>__<rawName>`），不是源码里的裸名。

export const name = 'qq-tool-deny'

export const inject = ['tools']

/** MCP 工具比 preset apply 晚注册，restrict 对未知名会抛错，故分几轮重试。 */
const RETRY_DELAYS_MS = [3000, 8000, 16000]

export function apply(ctx, config) {
  const deny = Array.isArray(config?.deny) ? config.deny.filter((n) => typeof n === 'string' && n) : []
  if (deny.length === 0) return

  const pending = new Set(deny)
  const failures = []

  const attempt = (names) => {
    let ok = 0
    for (const toolName of names) {
      try {
        ctx.tools.restrict({ deny: [toolName] })
        pending.delete(toolName)
        ok += 1
      } catch (error) {
        failures.push({ toolName, message: String(error?.message ?? error) })
      }
    }
    return ok
  }

  const firstOk = attempt(deny)
  console.error(`[qq-tool-deny] 首轮隐藏 ${firstOk}/${deny.length} 个工具`)

  if (pending.size === 0) return

  // 剩余的名字可能只是还没注册。分轮重试，每轮只挑还剩下的。
  RETRY_DELAYS_MS.forEach((delayMs, index) => {
    const timer = setTimeout(() => {
      const stillPending = [...pending]
      if (stillPending.length === 0) return
      const ok = attempt(stillPending)
      if (ok > 0) {
        console.error(`[qq-tool-deny] 第 ${index + 1} 轮补藏 ${ok} 个（剩余 ${pending.size}）`)
      }
      if (pending.size === 0) return
      if (index === RETRY_DELAYS_MS.length - 1) {
        // 最后一轮仍失败：多半是名字写错（例如漏了 mcp__serverName__ 前缀），落一行诊断。
        const reasons = [...new Set(failures.map((f) => f.message))].slice(0, 2)
        console.error(
          `[qq-tool-deny] ⚠️ ${pending.size} 个工具始终未能隐藏：${[...pending].slice(0, 5).join(', ')}`
          + `（原因示例：${reasons.join(' | ') || '未知'}）`
        )
      }
    }, delayMs)
    timer?.unref?.()
  })
}
