#!/usr/bin/env node
// 一条命令验收两个兄弟 MCP 服务：端口在听吗、健康检查 200 吗、令牌链路通吗。
//
// 为什么需要它：这两个服务的进程由 DSH 派生，桥接只是 HTTP 客户端，
// 出问题时「服务没起」「端口被别的进程占了」「令牌不对」三种表象一模一样（都是取不到段）。
// 这里把三种情况明确区分开，部署后跑一次就知道链路处于哪一层。
//
// 只读：只发 GET，不写文件、不改状态。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  {
    name: 'memory-mcp',
    base: String(process.env.MEMORY_MCP_URL ?? 'http://127.0.0.1:7181').replace(/\/+$/, ''),
    tokenFile: process.env.MEMORY_MCP_TOKEN_FILE ?? path.join(ROOT, '..', 'memory-mcp', 'state', 'http-token'),
    token: process.env.MEMORY_MCP_TOKEN ?? '',
  },
  {
    name: 'rolecard-mcp',
    base: String(process.env.ROLECARD_MCP_URL ?? 'http://127.0.0.1:7182').replace(/\/+$/, ''),
    tokenFile: process.env.ROLECARD_MCP_TOKEN_FILE ?? path.join(ROOT, '..', 'rolecard-mcp', 'state', 'http-token'),
    token: process.env.ROLECARD_MCP_TOKEN ?? '',
  },
];

const STATE = {
  OK: 'OK',
  NOT_LISTENING: '未监听',
  BAD_RESPONSE: '响应异常',
  AUTH_FAILED: '监听但鉴权失败',
};

async function request(url, token) {
  const res = await fetch(url, {
    headers: token ? { 'x-mcp-token': token } : {},
    signal: AbortSignal.timeout(2000),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function readToken(target) {
  if (target.token) return target.token;
  try {
    return fs.readFileSync(target.tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

async function probe(target) {
  let health;
  try {
    health = await request(`${target.base}/api/health`);
  } catch (error) {
    // 连接被拒 / 超时：进程根本没在听。
    return { state: STATE.NOT_LISTENING, detail: `${target.base}（${error?.cause?.code ?? error?.name ?? error?.message ?? error}）` };
  }
  if (health.status !== 200 || health.body?.ok !== true) {
    return { state: STATE.BAD_RESPONSE, detail: `${target.base}/api/health → HTTP ${health.status}` };
  }

  const facts = [
    health.body.version ? `v${health.body.version}` : null,
    health.body.pid ? `pid=${health.body.pid}` : null,
    Number.isFinite(health.body.uptimeMs) ? `uptime=${Math.round(health.body.uptimeMs / 1000)}s` : null,
  ].filter(Boolean).join(' ');

  // 令牌链路：找个需要令牌的路由打一次。没有令牌文件就只报「未校验」，不假装通过。
  const token = readToken(target);
  if (!token) {
    return { state: STATE.OK, detail: `${target.base} ${facts}（未找到令牌文件，鉴权未校验）` };
  }
  try {
    const stats = await request(`${target.base}/api/stats`, token);
    if (stats.status === 401) {
      return { state: STATE.AUTH_FAILED, detail: `${target.base} ${facts}（令牌与 state/http-token 不一致）` };
    }
    if (stats.status !== 200) {
      return { state: STATE.BAD_RESPONSE, detail: `${target.base} ${facts}（/api/stats → HTTP ${stats.status}）` };
    }
    return { state: STATE.OK, detail: `${target.base} ${facts}（令牌可用）` };
  } catch (error) {
    return { state: STATE.BAD_RESPONSE, detail: `${target.base} ${facts}（/api/stats 请求失败：${error?.message ?? error}）` };
  }
}

const rows = [];
for (const target of TARGETS) {
  const result = await probe(target);
  rows.push({ target, result });
  const mark = result.state === STATE.OK ? '✓' : '✗';
  console.log(`[mcp-health] ${mark} ${target.name}：${result.state} — ${result.detail}`);
}

const bad = rows.filter((row) => row.result.state !== STATE.OK);
console.log(`[mcp-health] 结论：${bad.length ? `${bad.length}/${rows.length} 个服务不可用` : `${rows.length}/${rows.length} 个服务可用`}`);
if (bad.length) process.exitCode = 1;
