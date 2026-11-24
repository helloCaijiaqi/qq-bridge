/**
 * 清单动作 → 桥接内部实现（共享动作层）。
 *
 * 为什么要有这一层：
 *   网关的 `/v1/actions` 只认清单里的 `type`，而桥接真正的业务实现一直长在
 *   `/api/socialV2/*` 的路由里。此前只有 send_text/reply/mark_read 三个内置兜底，
 *   清单里其余动作一律 E_UNSUPPORTED——工具面看起来齐全，实际调用全失败。
 *
 * 设计取舍：
 *   1. **不复制实现**：这里不重写发送/读取逻辑，而是把动作翻译成一个内部请求，
 *      交给同一个 `handleHttpRequest` 处理。因此 `/v1/actions` 与 `/api/socialV2/*`
 *      走的永远是同一段代码、同一套校验、同一份状态机。
 *   2. **不走网络**：内部请求是进程内的合成 req/res（不占端口、不受控制台端口
 *      配置影响），也不依赖模型侧 MCP 进程是否存活。
 *   3. **清单是唯一事实源**：动作是否有实现由本模块的映射表决定，网关拿到的
 *      清单里 `enabled` 字段据此现算（见 gateway-actions.js），UI 与网关只注册
 *      `enabled !== false` 的条目，声明与实现不再可能长期漂移。
 *
 * 新增能力 = 清单加条目 + 这里加一行映射（必要时写 run 自定义多步）。
 */
import { EventEmitter } from 'node:events';

/**
 * 动作 → 内部路由。字段映射刻意显式写出：
 *   - 清单 payloadSchema 用的是模型语义字段名（text/messages/replyToMessageId…），
 *     路由用的是它自己的字段名，别名只在必要处转换；
 *   - `query` 用于 GET，`body` 用于 POST；`key` 由调用方统一注入。
 */
const ROUTES = Object.freeze({
  // ── 发送类 ────────────────────────────────────────────────────────────────
  send_text: {
    method: 'POST',
    path: '/api/socialV2/send-message',
    body: (p) => ({ messages: [String(p?.text ?? '')] }),
  },
  reply: {
    method: 'POST',
    path: '/api/socialV2/send-message',
    body: (p) => ({
      messages: [String(p?.text ?? '')],
      ...(p?.replyToMessageId !== undefined && p?.replyToMessageId !== null
        ? { replyToMessageId: p.replyToMessageId } : {}),
      ...(p?.atUserId !== undefined && p?.atUserId !== null ? { atUserId: p.atUserId } : {}),
    }),
  },
  send_message: {
    method: 'POST',
    path: '/api/socialV2/send-message',
    body: (p) => ({ ...p }),
  },
  send_burst: {
    method: 'POST',
    path: '/api/socialV2/send-burst',
    body: (p) => ({ ...p }),
  },
  poke: {
    method: 'POST',
    path: '/api/socialV2/send-poke',
    body: (p) => ({ targetUserId: p?.targetUserId ?? p?.userId }),
  },
  send_voice: {
    method: 'POST',
    path: '/api/socialV2/send-voice',
    body: (p) => ({ voice: p?.voice ?? p?.file, label: p?.label }),
  },
  // 多媒体记忆层发送适配（2026-11-24）：gateway chat_media_send 转换后投递。
  send_image: {
    method: 'POST',
    path: '/api/socialV2/send-image',
    body: (p) => ({ ...p }),
  },
  // closed-agent 遗留直发：接口只在 closed-agent 模式放行，v2 下调到会如实回 403。
  send_group_message: {
    method: 'POST',
    path: '/api/send/group',
    body: (p) => ({ groupId: p?.groupId ?? p?.targetId, message: String(p?.text ?? p?.message ?? '') }),
  },
  send_private_message: {
    method: 'POST',
    path: '/api/send/private',
    body: (p) => ({ userId: p?.userId ?? p?.targetId, message: String(p?.text ?? p?.message ?? '') }),
  },

  // ── pending 转发（docs/console/dsh-pending/PLAN.md 第二阶段）───────────────
  // 网关把 DSH 的提问/审批请求作为出站动作投过来：这里只做**格式化文本 +
  // 走既有发送通道**，通知性质——不应答、不代批（应答须在网关控制台处置，
  // dsh-client 尚无应答 RPC）。跨会话转发在网关侧已被 sessionKey 映射挡住，
  // 这里 key 由 envelope.target 推导，收到的永远是原会话。
  ask: {
    run: async ({ dispatch, key, payload }) => {
      const questions = (Array.isArray(payload?.questions) ? payload.questions : [])
        .map((q) => String(q ?? '').trim())
        .filter(Boolean)
        .slice(0, 5);
      if (!questions.length) {
        return { status: 400, data: { ok: false, code: 'E_SCHEMA', error: 'payload.questions is required (1-5 non-empty strings)' } };
      }
      const lines = questions.map((q, i) => `${i + 1}. ${q}`);
      const text = ['【agent 提问】需要你的输入才能继续：', ...lines].join('\n');
      return dispatch({
        method: 'POST',
        path: '/api/socialV2/send-message',
        body: { messages: [text] },
        key,
      });
    },
  },
  approve: {
    run: async ({ dispatch, key, payload }) => {
      const toolName = String(payload?.toolName ?? '').trim();
      if (!toolName) {
        return { status: 400, data: { ok: false, code: 'E_SCHEMA', error: 'payload.toolName is required' } };
      }
      const reason = String(payload?.reason ?? '').trim();
      const text = [
        `【工具审批请求】agent 想调用工具「${toolName}」`,
        ...(reason ? [`理由：${reason}`] : []),
        '（此消息仅作同步；批准/拒绝请在网关控制台操作）',
      ].join('\n');
      return dispatch({
        method: 'POST',
        path: '/api/socialV2/send-message',
        body: { messages: [text] },
        key,
      });
    },
  },

  // ── 已读 / 唤醒 / 状态 ───────────────────────────────────────────────────
  mark_read: {
    method: 'POST',
    path: '/api/socialV2/mark-read',
    body: (p) => ({ throughSeq: p?.throughSeq }),
  },
  set_wake: {
    method: 'POST',
    path: '/api/socialV2/wake-config',
    body: (p) => ({ config: p?.config, throughSeq: p?.throughSeq }),
  },
  social_state: { method: 'GET', path: '/api/socialV2/state' },
  get_prompt: { method: 'GET', path: '/api/socialV2/prompt' },
  // 注意：wait 不在动作层——它有独立的登记/回推生命周期（wait-registry），
  // 由 bridge.js 直接装配；这里若也建一份，会把带 guard 的登记逻辑覆盖掉。

  // ── 消息读取 ─────────────────────────────────────────────────────────────
  get_unread: {
    method: 'GET',
    path: '/api/socialV2/unread',
    query: (p) => ({ afterSeq: p?.afterSeq, limit: p?.limit }),
  },
  get_recent: {
    method: 'GET',
    path: '/api/socialV2/recent',
    query: (p) => ({ offset: p?.offset, limit: p?.limit }),
  },
  get_my_recent: {
    method: 'GET',
    path: '/api/socialV2/my-recent',
    query: (p) => ({ limit: p?.limit }),
  },
  get_message_detail: {
    method: 'GET',
    path: '/api/socialV2/message-detail',
    query: (p) => ({ messageId: p?.messageId ?? p?.id }),
  },
  get_forward_msg: {
    method: 'GET',
    path: '/api/socialV2/forward-message',
    query: (p) => ({ id: p?.id ?? p?.forwardId }),
  },
  get_active_members: {
    method: 'GET',
    path: '/api/socialV2/active-members',
    query: (p) => ({ limit: p?.limit }),
  },
  get_group_members: {
    method: 'GET',
    path: '/api/socialV2/group-members',
    query: (p) => ({ limit: p?.limit }),
  },

  // sticker 8 件套与 get_message_images 已随多媒体迁移物理删除（2026-11-24）：
  // 发送统一走 send_image / chat_media_send，看图走 memory-mcp 媒体资产层。

  // ── 语音 ─────────────────────────────────────────────────────────────────
  list_voices: { method: 'GET', path: '/api/socialV2/voices' },
});

/**
 * 合成 req/res：让动作层复用 HTTP 路由实现，但不经过 socket、不占端口。
 *
 * 合成请求必须带三样东西才能过桥接的两道关卡：
 *   - `host`：监听器会校验 Host 只允许本机回环 + 实际绑定端口（DNS rebinding 硬化）；
 *   - `x-console-token`：控制台鉴权在 `/v1/actions` 之后仍会兜住所有 `/api/*`；
 *   - `x-agent-token`：会话级动作（发送/读取）要求令牌与会话绑定，否则退化成管理端全权。
 */
export function createHttpDispatch({ handleHttpRequest, consoleToken, tokenFor, hostFor }) {
  if (typeof handleHttpRequest !== 'function') throw new TypeError('createHttpDispatch: handleHttpRequest is required');
  return async function dispatch({ method, path, query = {}, body = null, key = null }) {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      search.set(name, String(value));
    }
    if (key) search.set('key', key);

    const token = key && typeof tokenFor === 'function' ? tokenFor(key) : null;
    const payload = body === null || body === undefined
      ? null
      : { ...body, ...(key ? { key } : {}), ...(token ? { token } : {}) };

    const headers = {
      host: typeof hostFor === 'function' ? hostFor() : '127.0.0.1',
      'content-type': 'application/json; charset=utf-8',
    };
    if (consoleToken) headers['x-console-token'] = consoleToken;
    if (token) headers['x-agent-token'] = token;
    if (payload !== null) headers['content-length'] = String(Buffer.byteLength(JSON.stringify(payload)));

    const req = new EventEmitter();
    req.method = method;
    req.url = `${path}${search.toString() ? `?${search.toString()}` : ''}`;
    req.headers = headers;
    req.pause = () => {};
    req.resume = () => {};
    req.destroy = () => {};

    // 合成响应实现成 EventEmitter：部分路由会挂 res.on('close'/'finish') 做清理，
    // 少了监听接口会在动作层里抛 "res.on is not a function"。
    const res = new EventEmitter();
    res.statusCode = 200;
    res.body = '';
    res.headers = {};
    res.writeHead = (status, extra) => {
      res.statusCode = status;
      res.headers = extra ?? {};
      return res;
    };
    res.setHeader = (name, value) => { res.headers[name] = value; return res; };
    res.getHeader = (name) => res.headers[name];
    res.write = (chunk) => {
      if (chunk !== undefined && chunk !== null) {
        res.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      }
      return true;
    };
    res.end = (chunk) => {
      if (chunk !== undefined && chunk !== null) res.write(chunk);
      res.finished = true;
      res.emit('finish');
      res.emit('close');
      return res;
    };

    // readBody 的监听器在 handleHttpRequest 同步执行期间挂载；nextTick 才投递数据。
    process.nextTick(() => {
      if (payload !== null) req.emit('data', Buffer.from(JSON.stringify(payload), 'utf8'));
      req.emit('end');
    });

    await handleHttpRequest(req, res);

    let data = null;
    if (res.body) {
      try { data = JSON.parse(res.body); } catch { data = { ok: false, error: '动作层收到非 JSON 响应' }; }
    }
    return { status: res.statusCode, data };
  };
}

/** HTTP 状态/回执 → 网关侧的 {ok, code} 语义（回执形状保持 {v:1, actionId, ok} 不变）。 */
function normalize(receipt) {
  const data = receipt?.data ?? {};
  if ((receipt?.status ?? 200) >= 400 || data.ok === false) {
    const status = receipt?.status ?? 500;
    const code = data.code
      ?? (status === 400 ? 'E_SCHEMA'
        // 403 = 明确拒绝（模式/白名单/凭证），不是「不支持」：折叠成 E_UNSUPPORTED
        // 会让模型以为工具不存在而不再重试，也不利于网关侧按 code 分流。
        : status === 403 ? 'E_FORBIDDEN'
          : status === 401 ? 'E_AUTH'
            : status === 404 ? 'E_NOT_FOUND'
              : status === 429 ? 'E_RATE_LIMITED'
                : 'E_PLATFORM');
    return { ok: false, error: { code, message: String(data.error ?? `HTTP ${status}`) } };
  }
  const messageId = data.messageId ?? data.platformMessageId;
  return { ok: true, ...(messageId !== undefined ? { messageId: String(messageId) } : {}), data };
}

/**
 * 按清单装配 handler 表。
 *
 * @param {object} options
 * @param {object|null} options.manifest       桥接清单（actions-manifest.json）
 * @param {Function} options.dispatch          内部派发（createHttpDispatch）
 * @param {(flag: string) => boolean} [options.flagEnabled]  configFlag 求值（桥接 v2ToolEnabled）
 * @param {(line: string) => void} [options.logger]
 * @returns {{ handlers: Record<string, Function>, isEnabled: (type: string) => boolean, missing: string[] }}
 */
export function createActionHandlers({ manifest, dispatch, flagEnabled = () => true, logger = () => {}, extraHandlers = [] } = {}) {
  const declared = Array.isArray(manifest?.actions) ? manifest.actions : [];
  const handlers = {};
  const missing = [];
  // 由调用方直接实现、不经动作层的动作（目前只有 wait：登记/回推需要闭包状态）。
  const external = new Set(extraHandlers);

  for (const entry of declared) {
    const type = entry?.type;
    if (typeof type !== 'string' || !type) continue;
    if (external.has(type)) continue; // 调用方自己装配，动作层不插手
    const route = ROUTES[type];
    if (!route) {
      // 声明了但没有实现：不注册 handler，由 enabled 计算把工具面挡掉（宁可缺工具不可静默串线）。
      missing.push(type);
      continue;
    }
    handlers[type] = async ({ key, kind, conversationId, payload }) => {
      const target = typeof key === 'string' && key ? key : `${kind ?? 'group'}:${conversationId}`;
      const args = payload ?? {};
      if (typeof route.run === 'function') {
        return normalize(await route.run({ dispatch, key: target, payload: args }));
      }
      return normalize(await dispatch({
        method: route.method,
        path: route.path,
        query: typeof route.query === 'function' ? route.query(args) : {},
        body: typeof route.body === 'function' ? route.body(args) : null,
        key: target,
      }));
    };
  }

  function isEnabled(type) {
    const entry = declared.find((item) => item?.type === type);
    if (!entry) return false;
    if (entry.wired === false) return false;
    if (!handlers[type] && !external.has(type)) return false;
    if (entry.configFlag && flagEnabled(entry.configFlag) === false) return false;
    return true;
  }

  if (missing.length) {
    logger(`[actions] 清单声明但未实现（不会注册给模型）: ${missing.join(', ')}`);
  }
  logger(`[actions] 动作实现覆盖 ${declared.length - missing.length}/${declared.length}`);
  return { handlers, isEnabled, missing };
}
