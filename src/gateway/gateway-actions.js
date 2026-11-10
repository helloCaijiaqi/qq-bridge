/**
 * agent-gateway → qq-bridge 的动作回投（`POST /v1/actions`）。
 *
 * 为什么单独成文件而不是塞进 bridge.js 的路由分支：
 *  1. 这段逻辑唯一依赖「签名 + 幂等 + 回执」三件事，与 QQ 的具体发送实现只在
 *     两个回调（sendText / markRead）上相交——测试可以注入假回调，不必起整个桥接；
 *  2. 回执形状是**跨进程契约**（agent-gateway `receiptSchema`），必须能被单独钉住。
 *
 * 鉴权用的是网关方向签名，与控制台令牌无关：
 *
 *   X-Gateway-Secret: v1=<hex hmac_sha256(gateway.secret, ts + "\n" + nonce + "\n" + sha256(body))>
 *
 * 与 `agent-gateway/src/executors/platform-actions.mjs` 的签名格式保持一致；
 * 两侧一致性由 `agent-gateway/scripts/test-adapter-conformance.mjs` 钉住。
 *
 * 幂等语义：同一个 `idempotencyKey`（网关用 `turnId:action` 生成）只真正执行一次，
 * 重试返回缓存回执。没有这一层，网关超时重投就会让同一句话在群里出现两次。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { validatePayload } from './actions-manifest.js';

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_NONCE_CAPACITY = 10_000;

const MAX_TEXT = 4000;
/**
 * 成功回执的 data 上限：ws-hub maxPayload 4MB，但回执会进网关的 turn 结果与
 * 模型上下文，几 MB 的 base64 会同时压爆帧与上下文。媒体一律回 ref。
 */
const MAX_RESULT_BYTES = 512 * 1024;
/** 业务失败（参数/能力/限流）缓存窗口：短 TTL，避免瞬时错误被锁死 10 分钟。 */
const FAILURE_TTL_MS = 30 * 1000;
/** 传输/未知失败：不缓存，重试应重新执行。 */
const RETRYABLE_CODES = new Set(['E_PLATFORM', 'E_NETWORK', 'E_TIMEOUT', 'E_INTERNAL']);

function sha256Hex(body) {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 有界 nonce 缓存：5 分钟窗口内的重放必须被拒，容量上限防止本机进程刷爆内存。 */
function createNonceCache({ windowMs, capacity, now }) {
  const seen = new Map();
  function prune(at) {
    for (const [nonce, expiresAt] of seen) {
      if (expiresAt > at) break;
      seen.delete(nonce);
    }
    while (seen.size > capacity) seen.delete(seen.keys().next().value);
  }
  return {
    /** true = 首次出现；false = 重放。 */
    check(nonce, at) {
      prune(at);
      if (seen.has(nonce)) return false;
      seen.set(nonce, at + windowMs);
      return true;
    },
    get size() { return seen.size; },
  };
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      const error = new Error(message);
      error.statusCode = status;
      reject(error);
    };
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      fail(413, `body exceeds ${maxBytes} bytes`);
      return;
    }
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        req.pause();
        fail(413, `body exceeds ${maxBytes} bytes`);
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => fail(400, 'failed to read request body'));
    req.on('aborted', () => fail(400, 'request aborted'));
  });
}

/**
 * @param {object} options
 * @param {string} options.secret         与网关共享的密钥（>=16 字符）
 * @param {string} [options.platform]     本适配器绑定的平台（默认 qq）
 * @param {string[]} [options.capabilities] 真正能执行的动作；未声明的动作回 E_UNSUPPORTED
 *   （仅内置分发模式使用；传入 manifest 后能力面以清单为准）
 * @param {object|null} [options.manifest]  actions-manifest（清单驱动模式）：
 *   {v, platform, actions:[{type, summary, kind, wired?, configFlag?, payloadSchema?}]}。
 *   传入后：能力门控 = 清单条目；payload 校验 = 条目 payloadSchema；执行 = handlers[type]，
 *   wired:false 或无 handler 一律 E_UNSUPPORTED（宁可缺动作不可静默串线）。
 * @param {Record<string, Function>} [options.handlers] 清单模式的 handler 注册表：
 *   type → async ({key, kind, conversationId, payload, envelope}) =>
 *     {ok?:boolean, messageId?, data?, error?:{code?,message?}}。
 *   send_text/reply/mark_read 有内置实现兜底（沿用 sendText/markRead 回调）。
 * @param {(entry: object) => boolean} [options.enabledOf] 可用性判定（缺省看 wired + handler）：
 *   桥接把它接到共享动作层（实现覆盖 + configFlag），`GET /v1/actions/manifest` 会
 *   逐条输出 `enabled`，网关与 UI 只注册 enabled 的条目。
 * @param {(args: {key: string, text: string, conversationId: string, kind: string}) => Promise<{ok?: boolean, messageId?: string, error?: {code?: string, message?: string}}>} options.sendText
 * @param {(args: {key: string, throughSeq: number}) => Promise<void>} [options.markRead]
 * @param {(line: string) => void} [options.logger]
 */
export function createGatewayActionsHandler({
  secret,
  platform = 'qq',
  capabilities = ['send_text', 'reply', 'mark_read'],
  manifest = null,
  handlers = {},
  enabledOf = null,
  sendText,
  markRead,
  logger = () => {},
  now = Date.now,
  windowMs = DEFAULT_WINDOW_MS,
  idempotencyTtlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  nonceCapacity = DEFAULT_NONCE_CAPACITY,
} = {}) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new TypeError('gateway-actions: secret must be at least 16 characters');
  }
  if (typeof sendText !== 'function') {
    throw new TypeError('gateway-actions: sendText callback is required');
  }
  const caps = new Set(Array.isArray(capabilities) ? capabilities : []);
  const nonces = createNonceCache({ windowMs, capacity: nonceCapacity, now });
  /**
   * 幂等表：key → { at, expiresAt, promise, receipt }。
   * promise 在**执行前**写入：并发/重投（WS ack 超时后 HTTP 重投）拿到的是同一个
   * promise，因此只执行一次；receipt 在执行完成后回填。
   * @type {Map<string, {at: number, expiresAt: number, promise: Promise<object>|null, receipt: object|null}>}
   */
  const receipts = new Map();

  // ── 清单驱动模式 ─────────────────────────────────────────────────────────
  /** 内置 handler 兜底：清单模式下 send_text/reply/mark_read 沿用 sendText/markRead 回调。 */
  const builtInHandlers = {
    send_text: async ({ key, payload, conversationId, kind }) => {
      const text = typeof payload.text === 'string' ? payload.text : '';
      if (!text.trim()) return { ok: false, error: { code: 'E_SCHEMA', message: 'payload.text is required' } };
      // 上限必须在两条分发路径上都生效：此前只有 legacy 分支检查，清单模式下
      // 超长文本会直接进 QQ 客户端（可能被截断或整条拒发）。
      if (text.length > MAX_TEXT) {
        return { ok: false, error: { code: 'E_SCHEMA', message: `payload.text exceeds ${MAX_TEXT} characters` } };
      }
      const result = await sendText({ key, text, conversationId, kind });
      if (result && result.ok === false) return result;
      return { ok: true, messageId: result?.messageId };
    },
    reply: null, // reply 走 legacyExecute？不行——清单模式下必须落 handler；见下。
    mark_read: async ({ key, payload }) => {
      const throughSeq = payload.throughSeq;
      if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) {
        return { ok: false, error: { code: 'E_SCHEMA', message: 'payload.throughSeq must be a non-negative integer' } };
      }
      if (typeof markRead !== 'function') {
        return { ok: false, error: { code: 'E_UNSUPPORTED', message: 'mark_read is not wired in this adapter' } };
      }
      await markRead({ key, throughSeq });
      return { ok: true };
    },
  };
  builtInHandlers.reply = builtInHandlers.send_text; // reply 与 send_text 同通道（引用语义由 payload 携带）
  const manifestIndex = manifest
    ? new Map(manifest.actions.map((entry) => [entry.type, entry]))
    : null;

  /**
   * 单条动作是否可用：wired 只是清单声明，真正的准绳是「有没有实现 + 开关是否开」。
   * 桥接侧把 enabledOf 接到共享动作层；不接时退化为「wired + 有 handler」。
   */
  function isEnabled(entry) {
    if (!entry) return false;
    if (typeof enabledOf === 'function') return enabledOf(entry) !== false;
    return entry.wired !== false && typeof (handlers[entry.type] ?? builtInHandlers[entry.type]) === 'function';
  }

  function pruneReceipts(at) {
    // 不能 break：失败条目是短 TTL，插入顺序不再等于过期顺序。
    for (const [key, entry] of receipts) {
      if (at >= entry.expiresAt) receipts.delete(key);
    }
    while (receipts.size > 1000) receipts.delete(receipts.keys().next().value);
  }

  /** 幂等键：`idempotencyKey` 单独不唯一（不同动作/目标可能复用），必须带 type+target。 */
  function cacheKeyOf(envelope) {
    const kind = envelope.target?.kind ?? 'group';
    return `${envelope.idempotencyKey}|${envelope.type}|${kind}:${envelope.target?.conversationId}`;
  }

  /**
   * 幂等执行：首次调用真正执行并登记 promise，重复调用 await 同一个 promise。
   *
   * 失败缓存策略：传输/未知失败不缓存（重试要能重来）；参数/能力/限流类短 TTL；
   * 成功按 idempotencyTtlMs。没有这一层，WS ack 超时（8s）后的 HTTP 重投会在
   * 第一次发送尚未返回时再执行一次 —— 同一句话发两遍。
   */
  async function runIdempotent(envelope, label) {
    const at = now();
    pruneReceipts(at);
    const cacheKey = cacheKeyOf(envelope);
    const existing = receipts.get(cacheKey);
    if (existing) {
      logger(`[gateway-actions] 命中幂等 ${cacheKey}（${envelope.type}，${label}）`);
      // 在途：等同一个 promise；已完结：直接返回缓存回执。
      return existing.receipt ?? existing.promise;
    }
    const entry = { at, expiresAt: at + idempotencyTtlMs, promise: null, receipt: null };
    entry.promise = (async () => {
      let receipt;
      try {
        receipt = await execute(envelope);
      } catch (error) {
        logger(`[gateway-actions] 执行异常 ${envelope.type}（${label}）: ${error?.message ?? error}`);
        receipt = failedReceipt(envelope.actionId, 'E_PLATFORM', String(error?.message ?? error));
      }
      if (receipt?.ok === false && RETRYABLE_CODES.has(receipt.error?.code)) {
        // 传输层/未知错误不缓存：重试必须重新执行。
        receipts.delete(cacheKey);
      } else {
        entry.receipt = receipt;
        entry.expiresAt = now() + (receipt?.ok === false ? FAILURE_TTL_MS : idempotencyTtlMs);
      }
      return receipt;
    })();
    receipts.set(cacheKey, entry);
    return entry.promise;
  }

  function send(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function reject(res, status, code, message) {
    send(res, status, { ok: false, error: { code, message } });
  }

  /** 失败回执：HTTP 200 + ok:false（网关按 receiptSchema 解析，不再看状态码）。 */
  function failedReceipt(actionId, code, message) {
    return { v: 1, actionId, ok: false, error: { code, message }, at: now() };
  }

  /**
   * 验签。`digestOverride` 用于 WS 帧：网关在帧里带 `bodyHash`（对序列化信封算的
   * 摘要），验签方直接用它，避免依赖「两端 JSON.stringify 逐字节一致」。
   * 不传则退回 HTTP 语义（对 rawBody 现算摘要）。
   */
  function verify(headers, rawBody, digestOverride = null) {
    const timestampRaw = headers['x-timestamp'];
    const nonce = headers['x-nonce'];
    const signatureRaw = headers['x-gateway-secret'];
    if (!timestampRaw || !nonce || !signatureRaw) {
      return { ok: false, code: 'E_AUTH', message: 'missing gateway authentication headers', status: 401 };
    }
    const timestamp = Number(timestampRaw);
    if (!Number.isSafeInteger(timestamp) || Math.abs(now() - timestamp) > windowMs) {
      return { ok: false, code: 'E_REPLAY', message: 'timestamp outside the replay window', status: 401 };
    }
    const digest = typeof digestOverride === 'string' && digestOverride ? digestOverride : sha256Hex(rawBody);
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}\n${nonce}\n${digest}`, 'utf8')
      .digest('hex');
    if (!String(signatureRaw).startsWith('v1=') || !safeEqualHex(String(signatureRaw).slice(3), expected)) {
      return { ok: false, code: 'E_AUTH', message: 'bad gateway signature', status: 401 };
    }
    // 先验签名再消费 nonce：伪造请求不该把合法 nonce 烧掉。
    if (!nonces.check(String(nonce), timestamp)) {
      return { ok: false, code: 'E_REPLAY', message: 'nonce already used', status: 401 };
    }
    return { ok: true };
  }

  /** 信封最小校验（与网关 actionSchema 对齐，但不过度重复那份实现）。 */
  function validateEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return 'body must be a JSON object';
    if (envelope.v !== 1) return 'unsupported protocol version';
    if (typeof envelope.actionId !== 'string' || !envelope.actionId) return 'actionId is required';
    if (typeof envelope.type !== 'string' || !envelope.type) return 'type is required';
    if (typeof envelope.idempotencyKey !== 'string' || !envelope.idempotencyKey) return 'idempotencyKey is required';
    const target = envelope.target;
    if (!target || typeof target !== 'object') return 'target is required';
    if (target.platform !== platform) return `target.platform must be "${platform}"`;
    const conversationId = String(target.conversationId ?? '');
    if (!conversationId || /[\u0000-\u001f]/.test(conversationId)) return 'target.conversationId is required';
    const kind = target.kind ?? 'group';
    if (!['group', 'private'].includes(kind)) return `target.kind must be group|private, got "${kind}"`;
    if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) return 'payload must be an object';
    return null;
  }

  async function execute(envelope) {
    // ── 内置三分发（无清单时的既有行为，conformance 契约钉住）─────────────
    const legacyExecute = async () => {
      const { actionId, type, target, payload } = envelope;
      if (!caps.has(type)) {
        return failedReceipt(actionId, 'E_UNSUPPORTED', `qq adapter does not support ${type}`);
      }
      const kind = target.kind ?? 'group';
      const key = `${kind}:${target.conversationId}`;
      if (type === 'send_text' || type === 'reply') {
        const text = typeof payload.text === 'string' ? payload.text : '';
        if (!text.trim()) return failedReceipt(actionId, 'E_SCHEMA', 'payload.text is required');
        if (text.length > MAX_TEXT) return failedReceipt(actionId, 'E_SCHEMA', `payload.text exceeds ${MAX_TEXT} characters`);
        const result = await sendText({ key, text, conversationId: String(target.conversationId), kind });
        if (result && result.ok === false) {
          return failedReceipt(actionId, result.error?.code ?? 'E_PLATFORM', result.error?.message ?? 'send failed');
        }
        const receipt = { v: 1, actionId, ok: true, at: now() };
        if (result?.messageId) receipt.platformMessageId = String(result.messageId);
        return receipt;
      }
      if (type === 'mark_read') {
        const throughSeq = payload.throughSeq;
        if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) {
          return failedReceipt(actionId, 'E_SCHEMA', 'payload.throughSeq must be a non-negative integer');
        }
        if (typeof markRead !== 'function') {
          return failedReceipt(actionId, 'E_UNSUPPORTED', 'mark_read is not wired in this adapter');
        }
        await markRead({ key, throughSeq });
        return { v: 1, actionId, ok: true, at: now() };
      }
      return failedReceipt(actionId, 'E_UNSUPPORTED', `unhandled action type: ${type}`);
    };

    // ── 清单驱动分发 ──────────────────────────────────────────────────────
    const manifestExecute = async () => {
      const { actionId, type, target, payload } = envelope;
      const entry = manifestIndex.get(type);
      if (!entry) {
        return failedReceipt(actionId, 'E_UNSUPPORTED', `qq adapter does not support ${type}`);
      }
      const handler = handlers[type] ?? builtInHandlers[type];
      if (!isEnabled(entry) || typeof handler !== 'function') {
        return failedReceipt(actionId, 'E_UNSUPPORTED', `${type} is declared in the manifest but not enabled in this adapter`);
      }
      const schemaError = validatePayload(entry.payloadSchema, payload);
      if (schemaError) return failedReceipt(actionId, 'E_SCHEMA', schemaError);
      const kind = target.kind ?? 'group';
      const key = `${kind}:${target.conversationId}`;
      const result = await handler({ key, kind, conversationId: String(target.conversationId), payload, envelope });
      if (result && result.ok === false) {
        return failedReceipt(actionId, result.error?.code ?? 'E_PLATFORM', result.error?.message ?? 'action failed');
      }
      const receipt = { v: 1, actionId, ok: true, at: now() };
      if (result?.messageId) receipt.platformMessageId = String(result.messageId);
      if (result?.data !== undefined) {
        // 回执体积上限：媒体只允许回 ref，base64 内联会同时压爆 ws 帧（4MB）
        // 与网关的 turn 上下文。
        const bytes = Buffer.byteLength(JSON.stringify(result.data), 'utf8');
        if (bytes > MAX_RESULT_BYTES) {
          return failedReceipt(
            actionId,
            'E_TOO_LARGE',
            `action result is ${bytes}B > ${MAX_RESULT_BYTES}B; return media refs instead of inline bytes`,
          );
        }
        receipt.data = result.data;
      }
      return receipt;
    };

    return manifestIndex ? manifestExecute() : legacyExecute();
  }

  /**
   * WS 帧入口（与 HTTP 入口共用同一实例：receipts 幂等表 / nonce 缓存 / 清单校验）。
   *
   * 帧形态（agent-gateway -> 桥接）：
   *   {v:1,type:'action',callId,envelope,sign:{ts,nonce,signature}}
   * 签名与 HTTP /v1/actions 完全同公式，对 `JSON.stringify(envelope)` 原文计算；
   * 验签失败/信封非法一律回失败回执（HTTP 200 同口径：网关按 receiptSchema 解析）。
   *
   * @returns {Promise<object>} receipt —— 永不抛。
   */
  async function handleFrame({ envelope, sign } = {}) {
    const actionId = typeof envelope?.actionId === 'string' ? envelope.actionId : '';
    if (!sign || typeof sign !== 'object') {
      return failedReceipt(actionId, 'E_AUTH', 'missing frame signature');
    }
    // 帧签名字段还原成 HTTP 同款 header 形状，直接复用 verify（含时间窗与 nonce 防重放）。
    // bodyHash 存在时直接按摘要验签，不再重新序列化信封（见 verify 注释）。
    const { ts, nonce, signature } = sign;
    const bodyHash = typeof sign.bodyHash === 'string' && sign.bodyHash ? sign.bodyHash : null;
    const auth = verify(
      { 'x-timestamp': ts, 'x-nonce': nonce, 'x-gateway-secret': signature },
      bodyHash ? '' : JSON.stringify(envelope ?? null),
      bodyHash,
    );
    if (!auth.ok) {
      return failedReceipt(actionId, auth.code, auth.message);
    }
    const invalid = validateEnvelope(envelope);
    if (invalid) {
      return failedReceipt(actionId, 'E_SCHEMA', invalid);
    }
    return runIdempotent(envelope, 'ws');
  }

  return {
    handleFrame,

    /**
     * HTTP handler，挂在 `POST /v1/actions` 与 `GET /v1/actions/manifest`。
     * 永不抛：所有失败都翻译成 JSON。
     */
    async handle(req, res) {
      const isManifestGet = req.method === 'GET'
        && new URL(req.url ?? '/', 'http://localhost').pathname === '/v1/actions/manifest';
      if (isManifestGet && !manifest) {
        reject(res, 503, 'E_DISABLED', 'actions manifest is not configured in this adapter');
        return;
      }
      let rawBody;
      try {
        rawBody = await readRawBody(req, maxBodyBytes);
      } catch (error) {
        reject(res, error?.statusCode ?? 400, 'E_SCHEMA', String(error?.message ?? error));
        return;
      }
      const auth = verify(req.headers, rawBody);
      if (!auth.ok) {
        reject(res, auth.status, auth.code, auth.message);
        return;
      }
      if (isManifestGet) {
        // 鉴权后的清单暴露：网关与 UI 按它注册工具面。
        // enabled 现算（实现 + configFlag），不落盘、不手写——清单与实现因此不会长期漂移。
        send(res, 200, {
          ...manifest,
          actions: manifest.actions.map((entry) => ({ ...entry, enabled: isEnabled(entry) })),
          servedAt: now(),
        });
        return;
      }
      let envelope;
      try {
        envelope = JSON.parse(rawBody || '{}');
      } catch {
        reject(res, 400, 'E_SCHEMA', 'body is not valid JSON');
        return;
      }
      const invalid = validateEnvelope(envelope);
      if (invalid) {
        reject(res, 400, 'E_SCHEMA', invalid);
        return;
      }
      // 与 WS 帧共享同一张幂等表：两条通道并发/重投只执行一次。
      const receipt = await runIdempotent(envelope, 'http');
      send(res, 200, receipt);
    },
    /** 测试/观测用：幂等表与 nonce 缓存当前大小。 */
    stats() {
      return {
        receipts: receipts.size,
        nonces: nonces.size,
        capabilities: [...caps],
        ...(manifestIndex ? {
          manifest: {
            platform: manifest.platform,
            declared: manifest.actions.length,
            enabled: manifest.actions.filter((entry) => isEnabled(entry)).length,
          },
        } : {}),
      };
    },
    /** 清单只读视图（观测/UI 注册用）。 */
    manifest: () => manifest,
    verify,
    execute,
  };
}
