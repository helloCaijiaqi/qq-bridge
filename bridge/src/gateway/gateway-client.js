/**
 * 适配器侧的网关客户端（P0 → WS 双栈）。
 *
 * 职责边界：
 *   - 签名并转发请求（HTTP 统一走 src/shared/http-client.js——axios 薄封装，
 *     2026-11-06 起「不要手动构建请求」的仓库规约）；
 *   - 传输层双栈：`transport = http | ws | auto`（默认 http，现行为零变化）。
 *       http —— 只走 HTTP，不建 WS 连接；
 *       ws   —— 强制 WS，连接未就绪/超时/断开即如实失败，绝不回落（联调用）；
 *       auto —— 优先 WS，失败回落 HTTP 重投一次（幂等键兜底），并带半死熔断；
 *     WS 连接管理（握手签名/心跳/重连退避/熔断）全部收在本文件内部，
 *     公开 API 与返回形状保持不变，调用方无感知协议；
 *   - 把「网关不可达」翻译成可降级的结果，绝不向上抛网络异常。
 *
 * WS 线缆契约（agent-gateway src/core/ws-hub.mjs）：
 *   - 握手：`GET /v1/ws?adapterId&ts&nonce&sign`，sign =
 *     `v1=<hmac_sha256(secret, ts + "\n" + nonce + "\n" + sha256(""))>`（body 空串）；
 *   - 上行：`{v:1,type:'inbound',envelope,callId}` → `{v:1,type:'inbound/ack',callId?,adapterId?,ok,turnId,status,deduped?,routed?}`；
 *     callId 由本端生成、网关原样回带——ack 按 callId 精确关联；旧网关不回带时
 *     退回 FIFO（并放弃超时后的顺序假设，见 inboundViaWs）；
 *   - ack 语义 = 网关已受理落盘，**不含 turn 执行等待**（ws-hub 同步展开 onInbound 返回值）；
 *   - 心跳：网关 `{v:1,type:'ping'}` → 本端回 `{v:1,type:'pong',at}`；
 *   - 下行动作：`{v:1,type:'action',callId,envelope,sign:{ts,nonce,signature}}` →
 *     本端执行后回 `{v:1,type:'action/result',callId,...receipt}`（receipt 含 actionId 自检）。
 *
 * 健康探测带 5 秒冷却：入站是高频路径，每条消息都发一次 /health 会把
 * 探测本身变成主要流量。冷却期内沿用上一次结果。
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { WebSocket as WsClient } from 'ws';
import { createHttpClient } from '../shared/http-client.js';

const DEFAULT_TIMEOUT_MS = 1500;
const HEALTH_COOLDOWN_MS = 5000;

/** transport 三态白名单：非法值启动即失败（fail-closed，不静默降级）。 */
const TRANSPORTS = new Set(['http', 'ws', 'auto']);

const WS_RECONNECT_MIN_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;
/** auto 半死熔断：连续 3 次 WS 失败 → 2 分钟内直接走 HTTP。 */
const WS_BREAKER_THRESHOLD = 3;
const WS_BREAKER_COOLDOWN_MS = 2 * 60 * 1000;
/** 信封体积上限：ws-hub maxPayload=4MB，但信封只能带媒体 ref（不允许 base64）。 */
const MAX_ENVELOPE_BYTES = 64 * 1024;

/**
 * 与网关（agent-gateway 仓库 src/auth.mjs）共用的签名格式，**刻意本地实现、
 * 不跨包 import**：本次改造的目标就是消除 qq-bridge 对兄弟包的运行时依赖，
 * 协议一致性改由 agent-gateway/scripts/test-gateway-contracts.mjs 里的
 * 两侧互认测试钉住——任何一侧单独改格式，测试会立刻失败。
 *
 *   signature = v1=<hex hmac_sha256(secret, ts + "\n" + nonce + "\n" + sha256(body))>
 */
function signRequest({ secret, adapterId, body }) {
  const timestamp = Date.now();
  const nonce = randomBytes(12).toString('hex');
  const digest = createHash('sha256').update(body, 'utf8').digest('hex');
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}\n${nonce}\n${digest}`, 'utf8')
    .digest('hex');
  return {
    'content-type': 'application/json; charset=utf-8',
    'x-adapter-id': String(adapterId),
    'x-timestamp': String(timestamp),
    'x-nonce': nonce,
    'x-signature': `v1=${signature}`,
  };
}

/** WS 握手签名（body 空串，与 ws-hub verifyHandshake 同公式）。 */
function signHandshake({ secret, adapterId, now }) {
  const timestamp = now();
  const nonce = randomBytes(9).toString('hex');
  const bodyHash = createHash('sha256').update('', 'utf8').digest('hex');
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}\n${nonce}\n${bodyHash}`, 'utf8')
    .digest('hex');
  return new URLSearchParams({
    adapterId: String(adapterId),
    ts: String(timestamp),
    nonce,
    sign: `v1=${signature}`,
  });
}

/** 测试注入口：fetch 形状的假传输层 → 共享客户端的 transport 契约。 */
function fetchTransport(fetchImpl) {
  return async ({ method, url, headers, body, timeoutMs }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : body,
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, text };
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      return {
        status: 0,
        error: aborted ? `timeout after ${timeoutMs}ms` : String(error?.message ?? error),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** ack → HTTP 同构结果（字段逐项映射；deduped 是降级重投的观测位，不能丢）。 */
function ackToResult(ack) {
  if (ack?.ok === true) {
    const body = {};
    for (const key of ['turnId', 'status', 'deduped', 'routed']) {
      if (ack[key] !== undefined) body[key] = ack[key];
    }
    return { ok: true, status: 200, body };
  }
  const code = ack?.error?.code ?? 'E_INTERNAL';
  return {
    ok: false,
    status: code === 'E_DISABLED' ? 503 : 400,
    code,
    error: String(ack?.error?.message ?? 'gateway rejected the inbound frame'),
  };
}

export function createGatewayClient({
  baseUrl,
  adapterId,
  platform,
  secret,
  transport = 'http',
  onAction = null,
  // 网关下行通知（2026-11-17）：turn/status 等单向事件。旧网关不推这个类型，
  // 回调缺省为 null 时静默忽略——新旧两端任意组合都兼容。
  onNotify = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  // 握手看门狗：ws 包在 401/半开握手时不保证触发 close，没有这个上限客户端会
  // 永久停在 "connecting"（ws 模式假死、auto 模式永久回落且熔断不打开）。
  handshakeTimeoutMs = 10_000,
  logger = () => {},
  now = Date.now,
  fetchImpl = null,
  wsImpl = WsClient,
} = {}) {
  if (!baseUrl) throw new TypeError('baseUrl is required');
  if (!adapterId || !platform || !secret) {
    throw new TypeError('adapterId, platform and secret are required');
  }
  const mode = String(transport);
  if (!TRANSPORTS.has(mode)) {
    throw new TypeError(`transport must be one of http|ws|auto (got "${mode}")`);
  }
  // 凭据可热轮换（gateway.json 热加载）：签名/握手每次现算，读这里的当前值。
  // baseUrl 变化时重建 http client（无状态）；transport 变化仍需重启——它决定
  // 整条收发通道的形态（ws/http/auto 分支遍布本文件），热切换不值得。
  let base = String(baseUrl).replace(/\/+$/, '');
  let currentAdapterId = String(adapterId);
  let currentPlatform = String(platform);
  let currentSecret = String(secret);

  const makeHttpClient = () => createHttpClient({
    baseUrl: base,
    timeoutMs,
    logger,
    sign: ({ body }) => signRequest({ secret: currentSecret, adapterId: currentAdapterId, body }),
    ...(fetchImpl ? { transport: fetchTransport(fetchImpl) } : {}),
  });
  let client = makeHttpClient();

  let lastHealth = { at: 0, ok: false, detail: null };

  // ── WS 连接状态（transport !== 'http' 时才激活）──────────────────────────
  let closed = false;
  let socket = null;
  let wsOpen = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let breakerUntil = 0;
  let consecutiveWsFailures = 0;
  // 2026-11-21 审计修复：半开连接检测——TCP 断但未发 close 帧时，wsOpen 恒真、
  // health() 以「open 即健康」短路，inbound 全部超时。心跳口径：任何入站活动
  // （message/pong）刷新 lastInboundAt；心跳 tick 发协议层 ping，90s 无活动判死
  // （terminate → onClose → 走既有退避重连）。
  let lastInboundAt = 0;
  let heartbeatTimer = null;
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const HEARTBEAT_STALE_MS = 90_000;
  /** @type {Array<{callId:string, resolve:Function, timer:any, dead:boolean}>} 发送顺序（旧网关 FIFO 兜底） */
  const pendingInbound = [];
  /** @type {Map<string, object>} callId → 在途请求（新网关精确关联） */
  const pendingByCallId = new Map();
  /** 是否见过带 callId 的 ack：灰度期决定超时后能否信任剩余请求的顺序。 */
  let callIdAckConfirmed = false;

  function wsEndpoint() {
    const target = base.replace(/^http/i, 'ws');
    return `${target}/v1/ws?${signHandshake({ secret: currentSecret, adapterId: currentAdapterId, now }).toString()}`;
  }

  function sendFrame(payload) {
    if (!socket || !wsOpen) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      logger(`gateway ws send failed: ${error?.message ?? error}`);
      return false;
    }
  }

  function dropPending(entry) {
    const index = pendingInbound.indexOf(entry);
    if (index >= 0) pendingInbound.splice(index, 1);
    if (entry.callId && pendingByCallId.get(entry.callId) === entry) {
      pendingByCallId.delete(entry.callId);
    }
    clearTimeout(entry.timer);
  }

  /**
   * ack 结算。新协议按 callId 精确关联；旧网关（ack 不带 callId）退回 FIFO。
   *
   * 为什么不能继续无条件 FIFO：ack 慢于 timeoutMs 时 A 的迟到 ack 会结算 B，
   * B 的 ack 再结算 C —— turnId 记错，且 B 的真实失败被吞掉（auto 不再回落
   * HTTP 重投 = 丢消息）。
   */
  function settlePendingInbound(ack) {
    const result = ackToResult(ack);
    const callId = typeof ack?.callId === 'string' && ack.callId ? ack.callId : null;
    if (callId) {
      callIdAckConfirmed = true;
      const entry = pendingByCallId.get(callId);
      // 迟到/重复 ack：直接丢弃，绝不能落到别的在途请求上。
      if (!entry) return;
      dropPending(entry);
      if (typeof ack.adapterId === 'string' && ack.adapterId !== currentAdapterId) {
        entry.resolve({
          ok: false, status: 0, code: 'E_AUTH',
          error: `inbound ack came from adapter "${ack.adapterId}", expected "${currentAdapterId}"`,
        });
        return;
      }
      entry.resolve(result);
      return;
    }
    // 旧网关：只能按发送顺序匹配（灰度期行为，与升级前一致）。
    while (pendingInbound.length > 0) {
      const entry = pendingInbound.shift();
      if (entry.dead) continue;
      clearTimeout(entry.timer);
      if (entry.callId && pendingByCallId.get(entry.callId) === entry) {
        pendingByCallId.delete(entry.callId);
      }
      entry.resolve(result);
      return;
    }
  }

  function failAllPending(error, code = 'E_NETWORK') {
    while (pendingInbound.length > 0) {
      const entry = pendingInbound.shift();
      clearTimeout(entry.timer);
      if (entry.dead) continue;
      entry.resolve({ ok: false, status: 0, code, error });
    }
    pendingByCallId.clear();
  }

  async function handleActionFrame(message) {
    const callId = typeof message.callId === 'string' ? message.callId : null;
    if (!callId) return;
    const reply = (receipt) => sendFrame({ v: 1, type: 'action/result', callId, ...receipt });
    if (typeof onAction !== 'function') {
      reply({ ok: false, error: { code: 'E_UNSUPPORTED', message: 'action frames are not enabled in this client' } });
      return;
    }
    try {
      const receipt = await onAction(message.envelope, message.sign);
      if (!receipt || typeof receipt !== 'object') {
        reply({ ok: false, error: { code: 'E_INTERNAL', message: 'action handler returned an empty receipt' } });
        return;
      }
      reply(receipt);
    } catch (error) {
      reply({ ok: false, error: { code: 'E_INTERNAL', message: String(error?.message ?? error) } });
    }
  }

  function handleFrame(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      logger('gateway ws: dropped a frame that is not valid JSON');
      return;
    }
    switch (message?.type) {
      case 'inbound/ack':
        settlePendingInbound(message);
        return;
      case 'ping':
        sendFrame({ v: 1, type: 'pong', at: now() });
        return;
      case 'action':
        void handleActionFrame(message);
        return;
      case 'turn/status':
        // 回合结束推送：适配器用它释放唤醒防重入标志并回放暂存唤醒（尽力而为）。
        try {
          onNotify?.(message);
        } catch (error) {
          logger(`turn/status handler threw: ${error?.message ?? error}`);
        }
        return;
      case 'error':
        logger(`gateway ws error frame: ${message?.error?.code ?? 'E_INTERNAL'} ${message?.error?.message ?? ''}`);
        return;
      default:
        return;
    }
  }

  /** 记录一次 WS 失败；连续 N 次后熔断一段时间（auto 专用，http/ws 模式不调用）。 */
  function noteWsFailure() {
    consecutiveWsFailures += 1;
    if (consecutiveWsFailures >= WS_BREAKER_THRESHOLD) {
      breakerUntil = now() + WS_BREAKER_COOLDOWN_MS;
      consecutiveWsFailures = 0;
      logger(`gateway ws circuit opened for ${Math.round(WS_BREAKER_COOLDOWN_MS / 1000)}s after repeated failures`);
    }
  }

  function scheduleReconnect() {
    if (closed || mode === 'http' || reconnectTimer) return;
    const delay = Math.min(WS_RECONNECT_MIN_MS * 2 ** reconnectAttempt, WS_RECONNECT_MAX_MS);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  /** 连接失效收口：清引用 → 拒掉在途 ack → 排下一次退避重连。 */
  function resetSocket(sock, reason) {
    if (socket !== sock) return;
    socket = null;
    wsOpen = false;
    // 2026-11-21 审计修复：连接关闭即停心跳，避免定时器持有旧 socket 引用。
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    failAllPending(reason);
    scheduleReconnect();
  }

  function connect() {
    if (closed || mode === 'http' || socket) return;
    let sock;
    try {
      // 只给真正的 `ws` 包传 options：浏览器/undici 形态的第二参是子协议，
      // 传对象会抛 SyntaxError。
      sock = wsImpl === WsClient
        ? new wsImpl(wsEndpoint(), { handshakeTimeout: handshakeTimeoutMs })
        : new wsImpl(wsEndpoint());
    } catch (error) {
      logger(`gateway ws connect failed: ${error?.message ?? error}`);
      scheduleReconnect();
      return;
    }
    socket = sock;
    let guard = null;
    const clearGuard = () => {
      if (guard) {
        clearTimeout(guard);
        guard = null;
      }
    };
    const onOpen = () => {
      // 归属守卫：旧 socket 的迟到事件不能污染当前连接状态。
      if (socket !== sock) return;
      clearGuard();
      wsOpen = true;
      reconnectAttempt = 0;
      consecutiveWsFailures = 0;
      lastInboundAt = now();
      // 2026-11-21 审计修复：启动心跳（半开连接检测）。定时器在 resetSocket 清理。
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (socket !== sock || !wsOpen) return;
        try { sock.ping?.(); } catch { /* 失败由 onError/onClose 收口 */ }
        if (now() - lastInboundAt > HEARTBEAT_STALE_MS) {
          logger('gateway ws stale (no inbound for 90s) — terminating for reconnect');
          try { sock.terminate?.(); } catch { /* 已断开 */ }
          resetSocket(sock, 'ws stale heartbeat');
        }
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
      logger('gateway ws connected');
    };
    const onMessage = (data) => {
      if (socket !== sock) return;
      lastInboundAt = now();
      handleFrame(typeof data === 'string' ? data : String(data));
    };
    const onClose = () => {
      if (socket !== sock) return;
      clearGuard();
      resetSocket(sock, 'ws connection closed before ack');
    };
    const onError = () => {
      if (socket !== sock) return;
      logger('gateway ws connection error');
      // `ws` 的 error 不保证再发 close（尤其握手阶段）：主动收口，否则
      // `socket` 非空会让 connect() 永远直接 return。
      try { sock.terminate?.(); } catch { /* 已断开 */ }
      resetSocket(sock, 'ws connection error');
    };
    if (typeof sock.on === 'function') {
      // `ws` 包形态
      sock.on('open', onOpen);
      sock.on('message', (data) => onMessage(String(data)));
      sock.on('close', onClose);
      sock.on('error', onError);
      // 2026-11-21 审计修复：pong 视为入站活性（心跳判死口径的一部分）。
      sock.on('pong', () => { if (socket === sock) lastInboundAt = now(); });
      // 401/403 握手拒绝：ws 只发 unexpected-response，不发 error/close。
      sock.on('unexpected-response', (_req, res) => {
        if (socket !== sock) return;
        logger(`gateway ws handshake rejected: HTTP ${res?.statusCode ?? '?'}`);
        res?.resume?.();
        try { sock.terminate?.(); } catch { /* 已断开 */ }
        resetSocket(sock, `handshake rejected (HTTP ${res?.statusCode ?? '?'})`);
      });
      // 看门狗兜底：既没 open 也没 error/close 的挂起握手。
      guard = setTimeout(() => {
        if (socket !== sock || wsOpen) return;
        logger(`gateway ws handshake timeout after ${handshakeTimeoutMs}ms`);
        try { sock.terminate?.(); } catch { /* 已断开 */ }
        resetSocket(sock, 'ws handshake timeout');
      }, handshakeTimeoutMs);
      guard.unref?.();
    } else {
      // 浏览器/undici 形态（测试 mock 也走这条）
      sock.onopen = onOpen;
      sock.onmessage = (event) => onMessage(typeof event?.data === 'string' ? event.data : String(event?.data));
      sock.onclose = onClose;
      sock.onerror = onError;
    }
  }

  function awaitWsOpen(ms) {
    if (wsOpen) return Promise.resolve(true);
    connect();
    return new Promise((resolve) => {
      const started = now();
      const tick = setInterval(() => {
        if (wsOpen) {
          clearInterval(tick);
          resolve(true);
          return;
        }
        if (now() - started >= ms) {
          clearInterval(tick);
          resolve(false);
        }
      }, 20);
      tick.unref?.();
    });
  }

  function inboundViaWs(envelope) {
    const callId = randomUUID();
    return new Promise((resolve) => {
      const entry = { callId, resolve, timer: null, dead: false };
      pendingByCallId.set(callId, entry);
      pendingInbound.push(entry);
      if (!sendFrame({ v: 1, type: 'inbound', callId, envelope })) {
        dropPending(entry);
        resolve({ ok: false, status: 0, code: 'E_NETWORK', error: 'ws transport is not connected' });
        return;
      }
      entry.timer = setTimeout(() => {
        entry.dead = true;
        dropPending(entry);
        resolve({ ok: false, status: 0, code: 'E_TIMEOUT', error: `ws inbound ack timeout after ${timeoutMs}ms` });
        // 还没见过带 callId 的 ack（旧网关或网关没回带）：剩余请求只能按 FIFO
        // 匹配，而超时说明顺序已不可信——整体作废，让调用方回落 HTTP（幂等键去重）。
        if (!callIdAckConfirmed) {
          failAllPending(
            'inbound ack ordering is not trustworthy after a timeout (gateway ack without callId)',
            'E_TIMEOUT',
          );
        }
      }, timeoutMs);
      entry.timer.unref?.();
    });
  }

  if (mode !== 'http') connect();

  return {
    /**
     * 探测网关健康；冷却期内返回缓存结果。
     * WS 已连接时短路为 ok（连接本身即存活证明，省一次 HTTP 往返）。
     */
    async health({ force = false } = {}) {
      // 2026-11-21 审计修复：open 短路加活性条件——半开连接（TCP 断未收 close）
      // 下 wsOpen 恒真但无任何入站活动，不能报健康；stale 时继续走 HTTP 探测。
      const wsStale = now() - lastInboundAt > HEARTBEAT_STALE_MS;
      if (mode !== 'http' && wsOpen && !wsStale) {
        lastHealth = { at: now(), ok: true, detail: { transport: 'ws', ws: 'open' } };
        return { ok: true, cached: false, detail: lastHealth.detail, error: null };
      }
      const at = now();
      if (!force && at - lastHealth.at < HEALTH_COOLDOWN_MS) {
        return { ok: lastHealth.ok, cached: true, detail: lastHealth.detail, error: lastHealth.ok ? null : lastHealth.detail };
      }
      const result = await client.get('/v1/health');
      lastHealth = { at, ok: result.ok, detail: result.ok ? result.body : result.error };
      if (!result.ok) {
        logger(`gateway health probe failed: ${result.error}`);
      }
      return {
        ok: result.ok,
        cached: false,
        detail: result.ok ? result.body : result.error,
        error: result.ok ? null : result.error,
      };
    },

    /**
     * 上报一条入站消息。成功即代表网关已持久化（幂等），适配器可以放心
     * 停止自己的旧路径处理。
     *
     * 传输选择（mode）：
     *   http —— client.post；
     *   ws   —— 强制 WS：连接未就绪/超时/断开即 `{ok:false}`，不回落；
     *   auto —— WS 优先（含等待建连一个超时窗），失败回落 HTTP 重投一次；
     *           E_DISABLED（网关 mode=off）按「网关拒绝」直接返回，不重投、不计熔断。
     */
    async inbound(envelope) {
      if (mode === 'http') return client.post('/v1/inbound', envelope);

      const bytes = Buffer.byteLength(JSON.stringify(envelope ?? null), 'utf8');
      if (bytes > MAX_ENVELOPE_BYTES) {
        return {
          ok: false,
          status: 0,
          code: 'E_SCHEMA',
          error: `envelope too large for a ws frame: ${bytes}B > ${MAX_ENVELOPE_BYTES}B (media must be a ref, not base64)`,
        };
      }

      if (mode === 'ws') {
        if (!wsOpen && !(await awaitWsOpen(timeoutMs))) {
          return { ok: false, status: 0, code: 'E_NETWORK', error: 'ws transport is not connected' };
        }
        return inboundViaWs(envelope);
      }

      // auto
      if (!wsOpen && now() < breakerUntil) {
        return client.post('/v1/inbound', envelope);
      }
      if (!wsOpen && !(await awaitWsOpen(timeoutMs))) {
        // 建连失败也是 WS 失败：不计的话，WS 长期挂掉时熔断永不打开，
        // 每条消息都要先付一个建连等待窗口再回落 HTTP。
        noteWsFailure();
        return client.post('/v1/inbound', envelope);
      }
      const wsResult = await inboundViaWs(envelope);
      if (wsResult.ok) {
        consecutiveWsFailures = 0;
        return wsResult;
      }
      if (wsResult.code === 'E_DISABLED') {
        // 网关拒绝（mode=off）：HTTP 同口径 503，重投没有意义。
        return wsResult;
      }
      noteWsFailure();
      return client.post('/v1/inbound', envelope);
    },

    turn(turnId) {
      return client.get(`/v1/turns/${encodeURIComponent(turnId)}`);
    },

    /**
     * turn 列表（控制台会话/回合视图的数据源）。不带正文：网关只落
     * textLength，正文从不进盘。
     */
    turns({ limit = 50, sessionKey } = {}) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (sessionKey) query.set('sessionKey', sessionKey);
      return client.get(`/v1/turns?${query.toString()}`);
    },

    /**
     * token 用量（桥接 token 账本的唯一数据源）。
     * 返回 `[{turnId, sessionKey, at, wake, usage}]`，按 turnId 幂等。
     */
    usage({ since = 0, limit = 200, sessionKey } = {}) {
      const query = new URLSearchParams({ since: String(since), limit: String(limit) });
      if (sessionKey) query.set('sessionKey', sessionKey);
      return client.get(`/v1/usage?${query.toString()}`);
    },

    // ── P4 会话状态镜像（保持 HTTP：低频 fire-and-forget，不走 WS）──────────
    // 镜像写：把「丢了无法重建」的状态（未读游标/已读水位/唤醒配置/agentToken）
    // 推给网关 mailbox。调用方（bridge）负责 fire-and-forget——网关不可达时
    // 拿到 {ok:false} 记日志即可，本地 social-v2.json 在 P4 仍是权威。
    // payload 形状由 agent-gateway 的 stateUpdateSchema 钉住（v 由这里补齐）。
    stateUpdate(payload) {
      return client.post('/v1/state/update', { v: 1, ...payload });
    },

    /** 只读快照（控制台 /api/socialV2/state 的网关数据源）。 */
    stateSnapshot(sessionKey) {
      return client.get(`/v1/state/${encodeURIComponent(sessionKey)}`);
    },

    /** 只读列表（控制台 /api/socialV2/states 的网关数据源）。 */
    stateList() {
      return client.get('/v1/state');
    },

    get healthy() { return lastHealth.ok; },

    /** 当前 WS 是否可用（auto 判定口径：open 即可用）。 */
    get connected() { return wsOpen; },

    /** 当前生效身份（热轮换后跟着变；日志与测试断言用）。 */
    get identity() { return { adapterId: currentAdapterId, platform: currentPlatform, baseUrl: base }; },

    /**
     * 原地热轮换凭据（gateway.json 热加载）：换 baseUrl/adapterId/platform/secret，
     * 立即断开旧连接 → 重连循环用新身份重新握手；退避与熔断清零（新身份是
     * 新起点）。transport 变化不在轮换范围内（仍需重启，构造参数固定）。
     * 非法新值整体拒收、保留旧值（fail-closed，避免半新半旧的中间态）。
     */
    rotate({ baseUrl: nextBase, adapterId: nextAdapterId, platform: nextPlatform, secret: nextSecret }) {
      for (const [name, value] of [['baseUrl', nextBase], ['adapterId', nextAdapterId], ['platform', nextPlatform], ['secret', nextSecret]]) {
        if (typeof value !== 'string' || value === '') {
          throw new TypeError(`rotate: ${name} is required`);
        }
      }
      if (nextSecret.length < 16) {
        throw new TypeError('rotate: secret must be at least 16 characters');
      }
      base = String(nextBase).replace(/\/+$/, '');
      currentAdapterId = String(nextAdapterId);
      currentPlatform = String(nextPlatform);
      currentSecret = String(nextSecret);
      client = makeHttpClient();
      reconnectAttempt = 0;
      breakerUntil = 0;
      consecutiveWsFailures = 0;
      if (socket) {
        // 先显式关闭旧 socket（resetSocket 只收口引用/在途请求，不负责关连接），
        // 再走 resetSocket 清引用、拒掉在途 ack 并排重连（新 wsEndpoint 用新凭据）。
        const old = socket;
        try { old.close(1000); } catch { /* 已断开 */ }
        try { old.terminate?.(); } catch { /* 已断开 */ }
        resetSocket(old, 'gateway.json rotated: reconnecting with new identity');
      } else if (mode !== 'http' && !closed) {
        scheduleReconnect();
      }
    },

    /** 传输状态快照（控制台/健康面板用）。 */
    get transportState() {
      return {
        transport: mode,
        ws: mode === 'http' ? 'off' : wsOpen ? 'open' : socket ? 'connecting' : 'closed',
        breakerOpen: now() < breakerUntil,
        pendingInbound: pendingInbound.length,
      };
    },

    /** 优雅关闭：停止重连、断开连接、拒掉在途 ack。 */
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      failAllPending('gateway client closed');
      if (socket) {
        try {
          socket.close(1000);
        } catch { /* 已断开 */ }
        socket = null;
      }
      wsOpen = false;
    },
  };
}
