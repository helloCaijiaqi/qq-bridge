/**
 * gateway.json 热加载监视器（消费端语义，与 memory-mcp/rolecard-mcp 的资源端
 * watcher 同构但策略不同）。
 *
 * 资源端：文件缺失/非法 → 摘除接入（503），因为资源服务没有「旧凭据还能用」
 * 的价值，带着坏凭据服务比拒绝服务危险。
 * 消费端：**保留最后有效凭据 + 告警**——桥接的身份消失只会导致网关侧拒绝
 * （WS 握手 401），主动自断等于把「网关侧还没删登记」的窗口也浪费掉；保留
 * 旧值能撑到新文件出现，rotate 后自动换线。
 *
 * 变更检测按内容哈希轮询（2s；StatWatcher 已 unref，不阻塞进程退出）。
 * transport 变化不在热轮换范围内（gateway-client 构造期固定，仍需重启）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadGatewayConfig, gatewayConfigPath } from '../core/gateway-config.js';

/**
 * @param {object} options
 * @param {string} options.root 仓库根目录（gateway.json 所在目录）
 * @param {(msg: string) => void} [options.logger]
 * @param {number} [options.intervalMs] 轮询间隔（默认 2000）
 * @param {(config: object) => void} [options.onChange] 凭据发生变更时回调
 *  （仅「已有有效凭据 → 新有效凭据」的变更触发；初始加载与摘除不触发）。
 * @returns {{ current: () => {config: object|null, error: string|null, stale: boolean, file: string},
 *             file: string, refresh: () => void, stop: () => void }}
 *          config=最后有效凭据（从未有过则为 null）；stale=true 表示当前凭据可能
 *          已失效（文件被删/非法，但仍拿着旧值）。
 */
export function createGatewayWatcher({ root, logger = () => {}, intervalMs = 2000, onChange = null } = {}) {
  if (!root) throw new Error('createGatewayWatcher 需要 root（仓库根目录）');
  const file = gatewayConfigPath(root);
  let state = { config: null, error: null, stale: false, file };
  let lastSig = null;

  function probe(initial = false) {
    let sig;
    // 内容哈希做签名：mtime/size 在快速连续重写（同尺寸、同 mtime tick）下不可靠。
    try {
      sig = createHash('sha1').update(fs.readFileSync(file)).digest('hex');
    } catch {
      sig = 'missing';
    }
    if (sig === lastSig) return;
    if (sig === 'missing') {
      if (state.config) {
        // 保留最后有效凭据（消费端不自断身份），标记 stale 供排障。
        state = { ...state, error: 'gateway.json 已移除（保留最后有效凭据，网关侧若已删登记则 WS 握手会被拒）', stale: true };
        logger?.('gateway.json 已移除：保留最后有效凭据继续运行（网关侧若已注销该身份会握手 401）；'
          + '放入新文件后自动热轮换，无需重启');
      } else if (!initial) {
        state = { ...state, error: null, stale: false };
      }
    } else {
      try {
        const config = loadGatewayConfig({ root, logger });
        const changed = state.config !== null;
        state = { config, error: null, stale: false, file };
        logger?.(`${changed ? 'gateway.json 变更已热轮换' : 'gateway.json 已加载'}：`
          + `id=${config.adapterId ?? config.id} url=${config.url}${changed ? '（自动重连新身份，无需重启）' : ''}`);
        if (changed) onChange?.(config);
      } catch (error) {
        if (state.config) {
          // 保留最后有效凭据 + 告警（同「已移除」语义）。
          state = { ...state, error: String(error?.message ?? error), stale: true };
          logger?.(`gateway.json 非法，保留最后有效凭据继续运行（修复后自动热轮换，无需重启）：${error?.message ?? error}`);
        } else {
          state = { config: null, error: String(error?.message ?? error), stale: false, file };
          logger?.(`gateway.json 非法：${error?.message ?? error}`);
        }
      }
    }
    lastSig = sig;
  }

  probe(true);
  if (typeof fs.watchFile === 'function') {
    const statWatcher = fs.watchFile(file, { interval: intervalMs }, () => probe(false));
    // unref：轮询器不持有事件循环——进程生命周期由 stdio/WS 连接锚定。
    statWatcher?.unref?.();
  }

  return {
    current: () => state,
    file,
    /** 测试与运维用：立即重扫一次（不等下一个轮询周期）。 */
    refresh: () => probe(false),
    stop: () => fs.unwatchFile(file),
  };
}
