// 模拟 DSH 的 dsh-mcp-client：以 stdio 拉起桥接的 MCP server，握手并列出工具，
// 验证五个 MCP server 在新版 DSH 环境下仍能被正常接入（不需要 SnowLuma 在线）：
// 本仓库三个 + 平级兄弟包两个（后者没装就跳过，是跳过不是通过，见 SERVERS 的 optional）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

const SERVERS = [
  { serverName: 'snowluma', script: 'src/mcp-snowluma-safe.js' },
  { serverName: 'snowluma-host', script: 'src/mcp-host-server.js' },
  { serverName: 'web-search-safe', script: 'src/mcp-web-search-safe.js' },
  // 两个外部服务是**平级部署**的兄弟包，不属于本仓库：没装就跳过（不是失败），
  // 装了就必须能被 DSH 以同样的方式拉起来 —— 否则 setup-dsh 登记了也是白登记。
  {
    serverName: 'memory',
    script: path.join(ROOT, '..', 'memory-mcp', 'src', 'server.mjs'),
    cwd: path.join(ROOT, '..', 'memory-mcp'),
    env: { MEMORY_MCP_HTTP_PORT: '0' },
    optional: true,
  },
  {
    serverName: 'rolecard',
    script: path.join(ROOT, '..', 'rolecard-mcp', 'src', 'server.mjs'),
    cwd: path.join(ROOT, '..', 'rolecard-mcp'),
    env: { ROLECARD_MCP_HTTP_PORT: '0' },
    optional: true,
  },
];

let failures = 0;
for (const { serverName, script, cwd = ROOT, env, optional } of SERVERS) {
  if (optional && !fs.existsSync(script)) {
    console.log(`⏭  ${serverName}: 未找到 ${script}，跳过（这是跳过，不是通过）`);
    continue;
  }
  const transport = new StdioClientTransport({
    command: NODE,
    args: [path.isAbsolute(script) ? script : path.join(ROOT, script)],
    cwd,
    stderr: 'pipe',
    env: env ? { ...process.env, ...env } : undefined,
  });
  const client = new Client({ name: 'dsh-mcp-probe', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.log(`✅ ${serverName}: ${names.length} tools`);
    console.log(`   ${names.join(', ')}`);
    // 校验 DSH 的命名契约：mcp__<serverName>__<rawName>
    const bad = names.filter((n) => !/^[A-Za-z0-9_-]{1,64}$/.test(n));
    if (bad.length) { console.log(`   ⚠️ 不符合 DSH 工具名契约: ${bad.join(', ')}`); failures += 1; }
  } catch (error) {
    console.log(`❌ ${serverName}: ${error?.message ?? error}`);
    failures += 1;
  } finally {
    try { await client.close(); } catch {}
  }
}
console.log(failures === 0 ? '\n全部 MCP server 接入正常' : `\n${failures} 个 MCP server 异常`);
process.exit(failures === 0 ? 0 : 1);
