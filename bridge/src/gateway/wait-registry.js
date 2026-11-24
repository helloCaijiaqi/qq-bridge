/**
 * wait 挂起登记（事件回推，阶段 2）。
 *
 * 语义：模型调用 chat_qq_wait 时**立即**拿到「已登记」回执（不再阻塞长轮询）；
 * 新消息到达后，桥接在下一次唤醒投递时把登记消费掉，并在入站信封上附
 * `wake:{kind:'wait'}` 标记——网关据此把这一轮当作「等待结果回推」的唤醒回合。
 *
 * 本模块只做**状态机**：注册 / 推进 / 满足 / 消费 / 过期。不碰定时器、不碰网络、
 * 不读 social-v2 状态——时间与基线 seq 由调用方注入，因此可以按毫秒级单测。
 *
 * 边界（每条都对应一个具体的失败形态）：
 *   · 同一会话只允许一条挂起登记：后登记的覆盖前一条（旧登记的 expiresAt 作废，
 *     否则模型连调两次 wait 会出现「第二次先超时」的乱序回推）；
 *   · 基线快照在注册那一刻取 lastUnreadSeq：用「注册之后的新未读条数」判断满足，
 *     而不是「未读队列非空」——队列里本来就有的旧消息不该立刻唤醒；
 *   · 消费是**一次性**的：同一条登记只能回推一次，重复投递不允许；
 *   · 过期即静默作废：等待超时不额外唤醒一个空回合（模型下一轮会看到新消息，
 *     没有新消息时把模型叫醒只会烧 token）。
 */

const DEFAULTS = Object.freeze({
  defaultTimeoutMs: 30_000,
  minTimeoutMs: 5_000,
  maxTimeoutMs: 600_000,
  maxMinNewMessages: 50,
  maxQuietMs: 60_000,
});

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function createWaitRegistry({
  now = Date.now,
  defaultTimeoutMs = DEFAULTS.defaultTimeoutMs,
  minTimeoutMs = DEFAULTS.minTimeoutMs,
  maxTimeoutMs = DEFAULTS.maxTimeoutMs,
  maxMinNewMessages = DEFAULTS.maxMinNewMessages,
  maxQuietMs = DEFAULTS.maxQuietMs,
} = {}) {
  /** key（`group:456` / `private:789`）→ 登记 */
  const byKey = new Map();

  function prune() {
    const at = now();
    for (const [key, entry] of byKey) {
      if (at >= entry.expiresAt) byKey.delete(key);
    }
  }

  /** 过期登记在读取路径上惰性清理：没有后台清扫线程，读到的就是有效的。 */
  function peek(key) {
    prune();
    return byKey.get(key) ?? null;
  }

  /**
   * 登记一条等待。
   * @param {{key: string, payload?: object, baselineSeq?: number}} options
   */
  function register({ key, payload = {}, baselineSeq = 0 } = {}) {
    if (!key) throw new TypeError('wait registry: key is required');
    const timeoutMs = clampInt(payload.timeoutMs, minTimeoutMs, maxTimeoutMs, defaultTimeoutMs);
    const entry = Object.freeze({
      key,
      purpose: payload.purpose === 'reply' ? 'reply' : 'messages',
      minNewMessages: clampInt(payload.minNewMessages, 1, maxMinNewMessages, 1),
      quietMs: clampInt(payload.quietMs, 0, maxQuietMs, 0),
      baselineSeq: Number.isFinite(Number(baselineSeq)) ? Number(baselineSeq) : 0,
      timeoutMs,
      registeredAt: now(),
      expiresAt: now() + timeoutMs,
      // 覆盖语义：同一会话只留最新一条（见文件头）。
      replaced: byKey.has(key),
    });
    byKey.set(key, entry);
    return entry;
  }

  /**
   * 用当前未读水位推进判断。
   * @returns {null | {entry: object, observed: number, satisfied: boolean}}
   */
  function progress(key, seq) {
    const entry = peek(key);
    if (!entry) return null;
    const observed = Math.max(0, Number(seq) - entry.baselineSeq);
    return { entry, observed, satisfied: observed >= entry.minNewMessages };
  }

  /**
   * 消费登记（一次性）。只有**已满足**的登记能被消费；未满足时返回 null
   * 且保留登记——调用方（唤醒投递）不能把一条还在等的登记当成回推理由。
   */
  function consume(key, seq) {
    const current = progress(key, seq);
    if (!current || !current.satisfied) return null;
    byKey.delete(key);
    return { ...current.entry, satisfiedSeq: Number(seq), observed: current.observed };
  }

  function cancel(key) {
    return byKey.delete(key);
  }

  function list() {
    prune();
    return [...byKey.values()].map((entry) => ({ ...entry }));
  }

  return { register, peek, progress, consume, cancel, list, size: () => list().length };
}

/**
 * /v1/actions `type=wait` 的 handler（清单驱动分发调用）。
 *
 * 回执语义是契约的一部分：**登记即返回**，绝不在这里阻塞等消息——
 * 「消息到了」由唤醒通道以入站事件回推（见 bridge.js 的 deliverViaGateway）。
 * 模型拿到的 data.registered/expiresAt 就是它判断「已经挂上」的全部依据。
 *
 * @param {object} options
 * @param {ReturnType<typeof createWaitRegistry>} options.registry
 * @param {(key: string) => string|null} [options.guard] 返回字符串 = 拒绝原因（模式不对/已暂停）
 * @param {(key: string) => number} [options.baselineOf] 当前未读水位（注册那一刻的快照）
 * @param {(entry: object) => void} [options.onRegister] 登记后的副作用（桥接用来挂过期定时器）
 */
export function createWaitAction({ registry, guard = () => null, baselineOf = () => 0, onRegister = () => {}, log = () => {} } = {}) {
  if (!registry) throw new TypeError('createWaitAction: registry is required');
  return async function waitAction({ key, payload = {} }) {
    const blocked = guard(key);
    if (blocked) return { ok: false, error: { code: 'E_UNSUPPORTED', message: blocked } };
    const entry = registry.register({ key, payload, baselineSeq: baselineOf(key) });
    onRegister(entry);
    log(`[wait] 登记等待 ${key}（purpose=${entry.purpose} min=${entry.minNewMessages} quiet=${entry.quietMs}ms 基线=${entry.baselineSeq}，${Math.round(entry.timeoutMs / 1000)}s 过期）`);
    return {
      ok: true,
      data: {
        registered: true,
        key,
        purpose: entry.purpose,
        baselineSeq: entry.baselineSeq,
        minNewMessages: entry.minNewMessages,
        expiresAt: entry.expiresAt,
      },
    };
  };
}
