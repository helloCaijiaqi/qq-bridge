// qq-bridge → rolecard-mcp 的回环 HTTP 客户端（取【人格】段）。
//
// 与 memory-client.js 同一套约定：只取现成段落，失败返回空串由调用方回落本地人格卡，
// 绝不伪造人格内容；热路径上有熔断，服务没起时不拖慢每条消息。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_TIMEOUT_MS = 3000;
const BREAKER_FAILURES = 3;
const BREAKER_COOLDOWN_MS = 60 * 1000;

function truthyDisabled(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

function readTokenFromFile(env) {
  const candidates = [
    env.ROLECARD_MCP_TOKEN_FILE,
    path.join(ROOT, '..', 'rolecard-mcp', 'state', 'http-token'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {
      // 猜错路径不该变成报错，缺令牌就由服务端自己决定是否校验。
    }
  }
  return '';
}

export function createRolecardClient({ env = process.env, logger, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const log = logger ?? (() => {});
  const port = Number(env.ROLECARD_MCP_HTTP_PORT ?? 7182);
  const baseUrl = String(env.ROLECARD_MCP_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  const token = String(env.ROLECARD_MCP_TOKEN ?? '').trim() || readTokenFromFile(env);
  const enabled = !truthyDisabled(env.ROLECARD_MCP_ENABLED);

  let failures = 0;
  let disabledUntil = 0;
  let openCount = 0;

  function available() {
    if (!enabled) return false;
    return Date.now() >= disabledUntil;
  }

  function noteFailure(error) {
    failures += 1;
    if (failures < BREAKER_FAILURES) return;
    // 只在「刚打开熔断」这一刻提示一次：服务长期没起时，每条消息都刷同一句没有意义。
    // 冷却时长按打开次数递增（上限 10 分钟），长期缺席的服务最终几乎不再产生日志与请求。
    openCount += 1;
    disabledUntil = Date.now() + BREAKER_COOLDOWN_MS * Math.min(openCount, 10);
    failures = 0;
    log(`⚠️ rolecard-mcp 不可用，已回落本地人格卡（${error?.message ?? error}）；${Math.round((disabledUntil - Date.now()) / 1000)} 秒内不再重试`);
  }

  function noteSuccess() {
    // 与 memory-client 同一语义：只有「熔断打开过后的首次成功」才记一行。
    const wasOpen = openCount > 0;
    failures = 0;
    disabledUntil = 0;
    if (!wasOpen) return;
    openCount = 0;
    log(`rolecard-mcp 已恢复（${baseUrl}），外部人格卡重新生效`);
  }

  async function request(route, args = {}, method = 'POST') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = method === 'GET'
        ? `${baseUrl}${route}?${new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)])).toString()}`
        : `${baseUrl}${route}`;
      const res = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-mcp-token': token } : {}),
        },
        body: method === 'POST' ? JSON.stringify(args ?? {}) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`rolecard-mcp 返回了非 JSON（HTTP ${res.status}）`);
      }
      if (!res.ok) throw new Error(payload?.error ?? `rolecard-mcp HTTP ${res.status}`);
      noteSuccess();
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    enabled,
    baseUrl,
    available,

    async health() {
      if (!available()) return { ok: false, reason: 'disabled' };
      try {
        const data = await request('/api/health', {}, 'GET');
        return { ok: true, stats: data?.stats ?? null };
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? error) };
      }
    },

    /** 取【人格】段：mode 为 v1 / v2，取不到返回空串（调用方回落本地）。 */
    async renderBlock({ mode = 'v1', maxChars } = {}) {
      if (!available()) return '';
      try {
        const args = { mode };
        if (Number(maxChars) > 0) args.maxChars = Number(maxChars);
        const data = await request('/api/blocks/render', args);
        const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
        return blocks.find((b) => b?.name === '人格')?.text ?? '';
      } catch (error) {
        noteFailure(error);
        return '';
      }
    },

    /** 两个模式的段落一次取回，省掉热路径上的第二次往返。 */
    async renderBoth({ maxChars } = {}) {
      if (!available()) return { v1: '', v2: '' };
      const [v1, v2] = await Promise.all([
        this.renderBlock({ mode: 'v1', maxChars }),
        this.renderBlock({ mode: 'v2', maxChars }),
      ]);
      return { v1, v2 };
    },
  };
}
