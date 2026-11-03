// qq-bridge → memory-mcp 的回环 HTTP 客户端。
//
// 定位：这只是一层「取段 + 写入镜像」的薄壳，业务语义（分层、遗忘、黑话发现）全在
// memory-mcp 里，桥接不复制一份。所有失败都必须**显式降级**：
//   - 取段失败 → 返回空串，调用方回落本地实现（绝不伪造内容）；
//   - 写入失败 → 抛错，由调用方决定是否透传给 AI。
//
// 熔断是必须的：注入点在每条消息的投递热路径上，服务没起时若每次都等超时，
// 一条消息就要多花几百毫秒。连续失败后直接跳一段时间，期间不再发请求。
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

/**
 * 会话 key → 平台中性的 sessionId。
 *
 * 桥接内部的 key 是 `group:群号` / `private:QQ号`（QQ 语义），服务端只认
 * `platform:scope:id`。映射放在桥接侧是刻意的：memory-mcp 不该认识 QQ，
 * 将来接微信时这里是唯一要加分支的地方。
 */
export function toSessionId(key) {
  const raw = String(key ?? '').trim();
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const scope = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  if (!id) return null;
  if (scope === 'group' || scope === 'private') return `qq:${scope}:${id}`;
  return null;
}

function readTokenFromFile(env) {
  const candidates = [
    env.MEMORY_MCP_TOKEN_FILE,
    // 默认布局是 qq-bridge 与 memory-mcp 平级部署，令牌文件由服务端自己生成。
    path.join(ROOT, '..', 'memory-mcp', 'state', 'http-token'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {
      // 读不到就当没有：服务端没配令牌时本来就不校验，这里不该因为猜错路径而报错。
    }
  }
  return '';
}

export function createMemoryClient({ env = process.env, logger, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const log = logger ?? (() => {});
  const port = Number(env.MEMORY_MCP_HTTP_PORT ?? 7181);
  const baseUrl = String(env.MEMORY_MCP_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  const token = String(env.MEMORY_MCP_TOKEN ?? '').trim() || readTokenFromFile(env);
  const enabled = !truthyDisabled(env.MEMORY_MCP_ENABLED);

  // 熔断状态：连续失败后冷却一段时间，冷却期内一律直接降级，不再发请求。
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
    log(`⚠️ memory-mcp 不可用，已回落本地实现（${error?.message ?? error}）；${Math.round((disabledUntil - Date.now()) / 1000)} 秒内不再重试`);
  }

  function noteSuccess() {
    // 熔断打开过才值得记一行：单次网络抖动不该刷日志。
    // 没有这一行时，「服务回来了」在日志里完全不可见，只能靠后续行为反推。
    const wasOpen = openCount > 0;
    failures = 0;
    disabledUntil = 0;
    if (!wasOpen) return;
    openCount = 0;
    log(`memory-mcp 已恢复（${baseUrl}），外部取段重新生效`);
  }

  async function request(route, args = {}, method = 'POST') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = method === 'GET'
        ? `${baseUrl}${route}?${new URLSearchParams(Object.entries(args).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString()}`
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
        throw new Error(`memory-mcp 返回了非 JSON（HTTP ${res.status}）`);
      }
      if (!res.ok) throw new Error(payload?.error ?? `memory-mcp HTTP ${res.status}`);
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
    toSessionId,

    /** 健康检查：只用于启动探测与控制台展示，不参与热路径判定。 */
    async health() {
      if (!available()) return { ok: false, reason: 'disabled' };
      try {
        const data = await request('/api/health', {}, 'GET');
        return { ok: true, stats: data?.stats ?? null };
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? error) };
      }
    },

    /**
     * 取【记忆】+【黑话】两段。返回 { memory, slang }，任一段取不到就是空串
     * —— 空串代表「外部没有可用内容」，调用方应回落到本地，而不是当成"记忆为空"。
     */
    async renderBlocks({ key, maxChars = 1500, slangMaxChars = 800 } = {}) {
      const sessionId = toSessionId(key);
      if (!available() || !sessionId) return { memory: '', slang: '' };
      try {
        const data = await request('/api/blocks/render', { sessionId, maxChars, slangMaxChars });
        const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
        const pick = (name) => blocks.find((b) => b?.name === name)?.text ?? '';
        return { memory: pick('记忆'), slang: pick('黑话') };
      } catch (error) {
        noteFailure(error);
        return { memory: '', slang: '' };
      }
    },

    /** 只取【黑话】段（无会话上下文时使用）。 */
    async renderSlang({ maxChars = 800 } = {}) {
      if (!available()) return '';
      try {
        const data = await request('/api/slang/query', { status: 'confirmed', limit: 50 });
        const rows = Array.isArray(data?.rows) ? data.rows : [];
        if (!rows.length) return '';
        const lines = rows.slice(0, 30).map((r) => `- ${r.content}：${r.meaning}${r.usage ? `（${r.usage}）` : ''}`);
        const text = `【群聊黑话表】\n${lines.join('\n')}`;
        return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 12))}\n…（已截断）` : text;
      } catch (error) {
        noteFailure(error);
        return '';
      }
    },

    /**
     * 写入镜像：桥接侧的 qq_memory_* 仍以本地状态为准（控制台契约不能变），
     * 这里把同一条记忆同步一份到 memory-mcp，让外部服务在灰度期就有真实数据可用。
     * 失败只记日志，不影响主流程。
     */
    async mirrorAppend({ key, category, content, extra = {} } = {}) {
      const sessionId = toSessionId(key);
      if (!available() || !sessionId) return null;
      try {
        const tier = category === 'memberImpression' ? 'long' : 'short';
        const text = category === 'memberImpression'
          ? `${String(extra.target ?? '').trim()}：${content}`
          : content;
        return await request('/api/memory/append', {
          sessionId,
          tier,
          category: String(category || 'note'),
          content: text,
          extra: extra ?? {},
          expiresAt: category === 'pendingThought' && Number(extra.expiresAtMs) > 0
            ? Date.now() + Number(extra.expiresAtMs)
            : undefined,
        });
      } catch (error) {
        noteFailure(error);
        return null;
      }
    },

    /**
     * 删除镜像：本地删掉一条后，外部不该继续把它渲染进【记忆】段，
     * 否则会出现「删了还在」的静默不一致。
     */
    async mirrorRemove({ key, category, content, target } = {}) {
      const sessionId = toSessionId(key);
      if (!available() || !sessionId) return 0;
      const want = String(content ?? '').trim();
      const who = String(target ?? '').trim();
      try {
        const { rows } = await request('/api/memory/query', { sessionId, limit: 500, includeArchived: false });
        const targets = (rows ?? []).filter((row) => {
          if (category && row.category !== category) return false;
          // 群友印象在写入时被拼成「名字：内容」，这里按同样的形状比对。
          if (category === 'memberImpression') return who && String(row.content ?? '').startsWith(`${who}：`);
          return String(row.content ?? '').trim() === want;
        });
        for (const row of targets) {
          await request('/api/memory/forget', { id: row.id, mode: 'hard' });
        }
        return targets.length;
      } catch (error) {
        noteFailure(error);
        return 0;
      }
    },

    /** 清除镜像：本地清空后外部不该继续留着旧内容。 */
    async mirrorClear({ key, category } = {}) {
      const sessionId = toSessionId(key);
      if (!available() || !sessionId) return 0;
      try {
        const { rows } = await request('/api/memory/query', { sessionId, limit: 500, includeArchived: false });
        const targets = (rows ?? []).filter((r) => !category || r.category === category);
        for (const row of targets) {
          await request('/api/memory/forget', { id: row.id, mode: 'hard' });
        }
        return targets.length;
      } catch (error) {
        noteFailure(error);
        return 0;
      }
    },
  };
}
