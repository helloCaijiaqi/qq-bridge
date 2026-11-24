/**
 * gateway.json —— 桥接「怎么连网关」的唯一事实源。
 *
 * 为什么不再放在 config.json 里：config.json 会被多处整份重写（白名单/令牌编辑、
 * SnowLuma token 与端点自愈回写），把网关地址和密钥混在里面，等于把它们放在一个
 * 别人随时会覆盖的文件里；同时桥接与两个 MCP 需要完全相同的四个字段，独立成文件
 * 后可以由网关生成、直接复制。
 *
 * 文件由 agent-gateway 生成（state/gateway/handoff/<adapterId>.gateway.json），
 * 复制到本仓库根目录并保持文件名 gateway.json 即可。
 *
 * 零依赖：只读文件、只做形状校验，不引入任何校验库。
 */
import fs from 'node:fs';
import path from 'node:path';

export const GATEWAY_CONFIG_FILE = 'gateway.json';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TRANSPORTS = new Set(['http', 'ws', 'auto']);
const MIN_SECRET_LENGTH = 16;

/** gateway.json 的绝对路径（root = 仓库根目录）。 */
export function gatewayConfigPath(root) {
  return path.join(root, GATEWAY_CONFIG_FILE);
}

/** 读 JSON：容忍 BOM（Windows 记事本/编辑器常见），解析失败抛出带路径的错误。 */
function readJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} 不是合法 JSON：${error?.message ?? error}`);
  }
}

function requireString(value, field, file) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${file} 缺少必填字段 ${field}`);
  return text;
}

/**
 * 解析密钥：secretFile 优先，secret 兼容。
 *
 * 两者同时存在时以 secretFile 为准并告警——网关生成的默认形态就是 secretFile，
 * 明文 secret 是跨机复制的临时形态；两份不一致时按「文件引用」走，避免一份过期
 * 明文悄悄覆盖真实密钥。
 */
function resolveSecret(doc, file, logger) {
  const inline = typeof doc.secret === 'string' && doc.secret.trim() ? doc.secret.trim() : '';
  const referenced = typeof doc.secretFile === 'string' && doc.secretFile.trim() ? doc.secretFile.trim() : '';
  if (!inline && !referenced) {
    throw new Error(
      `${file} 没有密钥：需要 secretFile（指向网关侧 *.secret 的路径）或 secret（内联明文）。`
      + '跨机复制请用网关的 --inline-secret 重新生成。',
    );
  }
  if (inline || referenced) {
    const secretFile = referenced ? path.resolve(path.dirname(file), referenced) : null;
    if (secretFile) {
      let text = '';
      try {
        text = fs.readFileSync(secretFile, 'utf8').trim();
      } catch (error) {
        throw new Error(
          `${file} 的 secretFile 无法读取：${secretFile}（${error?.code ?? error?.message ?? error}）。`
          + '同机部署请确认网关 state/gateway 下的密钥文件存在；跨机复制请改用内联密钥重新生成。',
        );
      }
      if (inline && inline !== text) {
        logger?.(`⚠️ ${file} 同时含 secret 与 secretFile：以 secretFile 为准（${secretFile}）`);
      }
      if (text.length < MIN_SECRET_LENGTH) {
        throw new Error(`密钥长度不足（${text.length} < ${MIN_SECRET_LENGTH}）：${secretFile}`);
      }
      return { secret: text, auth: 'secretFile', secretFile };
    }
    if (inline.length < MIN_SECRET_LENGTH) {
      throw new Error(`${file} 的 secret 太短（${inline.length} < ${MIN_SECRET_LENGTH}）`);
    }
    return { secret: inline, auth: 'inline', secretFile: null };
  }
  /* c8 ignore next */
  throw new Error(`${file} 的密钥解析失败`);
}

/**
 * 读取并校验 gateway.json。
 *
 * 文件缺失 → 抛错（桥接没有「脱机模式」：网关是它唯一出口，缺配置不能猜）。
 * 返回的形状刻意与旧 cfg.gateway 一致（url/adapterId/platform/transport/secret），
 * 让下游消费点零改动。
 *
 * @returns {{url: string, adapterId: string, platform: string, transport: string,
 *            secret: string, auth: 'secretFile'|'inline', file: string, secretFile: string|null}}
 */
export function loadGatewayConfig({ root, logger } = {}) {
  if (!root) throw new Error('loadGatewayConfig 需要 root（仓库根目录）');
  const file = gatewayConfigPath(root);
  if (!fs.existsSync(file)) {
    throw new Error(
      `缺少 ${file}：桥接只支持网关形态，没有网关地址就无法启动。\n`
      + '  处理方式：在 agent-gateway 执行 npm run secrets:gen -- --id <适配器id>，'
      + '把生成的 state/gateway/handoff/<适配器id>.gateway.json 复制到本仓库根目录并命名为 gateway.json。',
    );
  }
  const doc = readJsonFile(file);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file} 必须是 JSON 对象`);

  if (doc.v !== 1) {
    throw new Error(`${file} 的 v=${JSON.stringify(doc.v)} 不受支持（当前只支持 v: 1）`);
  }
  const id = requireString(doc.id, 'id', file);
  if (!ID_PATTERN.test(id)) {
    // 不自动小写化：网关侧登记是逐字比对的，改大小写只会把错误推到 401 上。
    throw new Error(`${file} 的 id="${id}" 不合法：只允许小写字母/数字/连字符，且不超过 64 字符`);
  }
  const url = requireString(doc.url, 'url', file);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${file} 的 url 不合法：${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${file} 的 url 只支持 http/https：${url}`);
  }
  const transport = String(doc.transport ?? 'auto').trim().toLowerCase();
  if (!TRANSPORTS.has(transport)) {
    throw new Error(`${file} 的 transport="${doc.transport}" 不合法：只允许 ${[...TRANSPORTS].join(' | ')}`);
  }
  const { secret, auth, secretFile } = resolveSecret(doc, file, logger);
  return {
    url,
    adapterId: id,
    platform: String(doc.platform ?? 'qq').trim() || 'qq',
    transport,
    secret,
    auth,
    file,
    secretFile,
    // P4 会话状态镜像开关（mode+state 同时 on 才生效）。它不是「连接网关」的一部分，
    // 但迁移前就住在 gateway 段里，丢掉等于静默关掉用户的既有功能——原样透传，
    // 由后者自己判断。网关生成的交接文件不带这两项（=不镜像）。
    ...(doc.mode !== undefined ? { mode: String(doc.mode) } : {}),
    ...(doc.state !== undefined ? { state: String(doc.state) } : {}),
  };
}

/** 把旧 config.json 的 gateway 段改写出的文档（v1 形状 + 迁移说明）。 */
function legacySectionToDocument(legacy) {
  const doc = {
    v: 1,
    id: String(legacy.adapterId ?? legacy.id ?? 'qq-main').trim() || 'qq-main',
    kind: 'adapter',
    url: String(legacy.url ?? 'http://127.0.0.1:7190').trim(),
    transport: String(legacy.transport ?? 'auto').trim() || 'auto',
    platform: String(legacy.platform ?? 'qq').trim() || 'qq',
    _comment: '由 config.json 的 gateway 段自动迁移生成；复制/备份请保留本文件。'
      + ' url 是网关基址（不是本服务地址）。',
  };
  const secret = typeof legacy.secret === 'string' ? legacy.secret.trim() : '';
  if (secret) doc.secret = secret;
  const secretFile = typeof legacy.secretFile === 'string' ? legacy.secretFile.trim() : '';
  if (secretFile) doc.secretFile = secretFile;
  // P4 状态镜像开关仍然有效，随迁移保留（其余回滚开关无效，见下）。
  if (legacy.mode !== undefined) doc.mode = String(legacy.mode);
  if (legacy.state !== undefined) doc.state = String(legacy.state);
  return doc;
}

/**
 * 迁移：config.json 的 gateway 段 → gateway.json。
 *
 * 用户已选择「自动迁移」，但只做一次且不留双源：
 *   - 新文件不存在且旧段存在 → 写新文件（0600 原子写）→ 从 config.json 删键 → 写回；
 *   - 两者同时存在 → 报错（不静默覆盖，否则无法判断哪份是用户当前想要的）。
 *
 * @param {object} options
 * @param {string} options.root 仓库根目录
 * @param {(file: string, obj: object) => void} options.writeJson 原子写（复用 bridge.js 的 renameWithRetry）
 * @param {(msg: string) => void} [options.logger]
 * @returns {{migrated: boolean, file: string|null}}
 */
export function migrateLegacyGatewaySection({ root, writeJson, logger } = {}) {
  if (!root) throw new Error('migrateLegacyGatewaySection 需要 root（仓库根目录）');
  if (typeof writeJson !== 'function') throw new Error('migrateLegacyGatewaySection 需要 writeJson(file, obj)');
  const configFile = path.join(root, 'config.json');
  const gatewayFile = gatewayConfigPath(root);

  if (!fs.existsSync(configFile)) return { migrated: false, file: null };
  const config = readJsonFile(configFile);
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { migrated: false, file: null };
  const legacy = config.gateway;
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return { migrated: false, file: null };

  if (fs.existsSync(gatewayFile)) {
    throw new Error(
      `config.json 里仍有 gateway 段，而 ${gatewayFile} 也已存在：两处都会声称自己是网关配置。\n`
      + `  处理方式：删除 config.json 中的 "gateway" 段（只保留 ${GATEWAY_CONFIG_FILE}），然后重启。`,
    );
  }

  const doc = legacySectionToDocument(legacy);
  writeJson(gatewayFile, doc);
  const { gateway: _dropped, ...rest } = config;
  writeJson(configFile, rest);
  // 旧的回滚开关（delivery / conversations）不随迁移保留：桥接只有网关这一种形态。
  // 明确告警，避免用户以为它们还在生效。
  const retired = ['delivery', 'conversations'].filter((key) => legacy[key] !== undefined);
  if (retired.length) {
    logger?.(`⚠️ config.gateway 的 ${retired.join(' / ')} 已废弃并被忽略：桥接只支持网关形态（url / secret / id）`);
  }
  logger?.(
    `已把 config.json 的 gateway 段迁移到 ${GATEWAY_CONFIG_FILE}（config.json 不再包含该段）：`
    + `id=${doc.id} url=${doc.url} transport=${doc.transport}`,
  );
  return { migrated: true, file: gatewayFile };
}
