// preset-patches —— 把仓库里的人设源渲染成 DSH 0.1.7 的 bundle patch。
//
// 背景（为什么需要「生成」这一步）：
//   0.1.5：preset = ~/.dsh/.agent-presets/<preset>/{preset.yml,agent.cordis.yml} 目录，DSH 扫目录。
//   0.1.7：注册表既不扫目录也不接受 preset 路径，preset 变成一条普通 loader 行
//          （@deepseek-ai/dsh-agent-preset），它的 config.plugins 必须是**内联的行列表**，
//          只能由 bundle 的 patch 文件插入。于是同一份行列表必然存在两种表示：
//            源（人写/控制台改）：<repo>/dsh/<平台>/agent-presets/<preset>/{preset.yml,agent.cordis.yml}
//            产物（DSH 读）：    <DSH_HOME>/plugins/<bundle>/presets/<preset>.patch.yml
//          本模块是两者之间**唯一**的转换器：源是唯一权威，产物是纯生成物（文件头写明「请勿手工编辑」），
//          且**不落仓库**——仓库里只有源码，见 scripts/test-agent-preset-patches.mjs 的「零生成物」断言。
//          setup-dsh.mjs 安装时重生成；控制台保存人格后也重生成（preset-files.mjs）；
//          scripts/build-agent-preset-patches.mjs 只是 CLI 薄壳（--check 钉住不漂移）。
//
// 为什么放在 runtime 而不是 core：本模块依赖 js-yaml，而 core 层只允许 node 内置/zod/同目录模块
// （见 scripts/test-layering.mjs）。preset-files.mjs 也在 runtime，同目录引用即可。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { PLATFORMS, platforms as listPlatforms, presetsForPlatform } from './platforms.mjs';
import { resolveDshHome } from './dsh-bundle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 渲染目标：由平台注册表派生，平台 → 预设列表。
 *
 * 之所以从 `PLATFORMS` 派生而不是各写一份：仓库目录（`dsh/<平台>/…`）、守卫说明符
 * （`<bundle>/qq-tool-restrict.mjs`）、DSH 侧产物目录（`plugins/<bundle>/presets`）
 * 三处必须始终一致，写死两份迟早漂移。
 */
export function presetTargets({ platforms } = {}) {
  const list = platforms ?? listPlatforms();
  const targets = [];
  for (const platform of list) {
    const bundle = PLATFORMS[platform]?.bundle;
    if (!bundle) throw new Error(`平台 "${platform}" 未在 PLATFORMS 中登记 bundle 包名`);
    for (const name of presetsForPlatform(platform)) targets.push({ platform, bundle, name });
  }
  return targets;
}

/** 该平台的源码根：`<repo>/dsh/<platform>`。 */
export function platformDir(platform, repoRoot = REPO_ROOT) {
  return path.join(repoRoot, 'dsh', platform);
}

/** 预设源目录：`<repo>/dsh/<platform>/agent-presets/<name>`。 */
export function sourceDirFor(platform, name, repoRoot = REPO_ROOT) {
  return path.join(platformDir(platform, repoRoot), 'agent-presets', name);
}

/** bundle 源目录：`<repo>/dsh/<platform>/bundle`（含 package.json 与运行期代码）。 */
export function bundleDirFor(platform, repoRoot = REPO_ROOT) {
  return path.join(platformDir(platform, repoRoot), 'bundle');
}

/** preset 行 id：与 config.id（网关解析的 preset 名）区分开，方便在 profile patch 里按行定位。 */
export function presetRowId(name) {
  return `preset-${name}`;
}

/**
 * 守卫行的引用方式：从 profile 目录可解析的裸说明符。
 *
 * 子行 name 按声明它的 loader 上下文解析（profile 目录），不是按 patch 文件或 preset 目录；
 * bundle patch 的「相对路径锚定」只作用于 insert 行自身（见 dsh-app-boot 的
 * anchorInsertedPluginNames），走不进 preset 行的 config.plugins。因此这里用
 * `<bundle 包名>/<子路径>`：profile package.json 以 link: 依赖声明该包，
 * node_modules junction 由 setup-dsh.mjs 维护。
 */
export function guardSpecifier(platform) {
  const bundle = PLATFORMS[platform]?.bundle;
  if (!bundle) throw new Error(`平台 "${platform}" 未在 PLATFORMS 中登记 bundle 包名`);
  return `${bundle}/qq-tool-restrict.mjs`;
}

/** 源里允许出现的相对行名 → 新机制下的等价引用。其它相对名一律报错（避免静默装不上）。 */
function relativeRowRewrites(platform) {
  return new Map([
    ['./qq-tool-restrict.mjs', guardSpecifier(platform)],
    // 角色卡人格插件已独立化（2026-11-20）：迁到 rolecard-mcp/dsh-plugin/ 独立
    // bundle（顶层 entry 挂载、跨平台公用、零 yml 参数），不再随本 preset 装载。
  ]);
}

/** DSH 侧产物目录：`<DSH_HOME>/plugins/<bundle>/presets`。 */
export function presetsOutDir({ platform, home, env } = {}) {
  const bundle = PLATFORMS[platform]?.bundle;
  if (!bundle) throw new Error(`平台 "${platform}" 未在 PLATFORMS 中登记 bundle 包名`);
  return path.join(resolveDshHome({ home, env }), 'plugins', bundle, 'presets');
}

/** 某个 presets 目录下不属于该平台的 `*.patch.yml`（供安装期清理）。 */
export function listStalePatches({ platform, outDir }) {
  const keep = new Set(presetsForPlatform(platform).map((name) => `${name}.patch.yml`));
  let entries;
  try {
    entries = fs.readdirSync(outDir);
  } catch {
    return []; // 目录还不存在 → 没有陈旧产物
  }
  return entries
    .filter((file) => file.endsWith('.patch.yml') && !keep.has(file))
    .map((file) => path.join(outDir, file));
}

function readYaml(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`读取失败 ${file}：${error?.message ?? error}`);
  }
  try {
    return yaml.load(text);
  } catch (error) {
    throw new Error(`${file} 不是合法 YAML：${error?.message ?? error}`);
  }
}

/**
 * 校验并改写行列表：只允许已知的相对行名（守卫），其余相对名视为错误。
 * @param {unknown} rows agent.cordis.yml 解析出的行列表
 * @param {string} preset preset 名（诊断用）
 * @param {string} platform 平台（决定守卫说明符）
 * @returns {object[]} 可写进 patch 的行列表（深拷贝后的新对象）
 */
function normalizeRows(rows, preset, platform) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${preset}: agent.cordis.yml 必须是「非空的插件行列表」（顶层数组）`);
  }
  const rewrites = relativeRowRewrites(platform);
  const seen = new Set();
  const walk = (list, at) => list.map((row, index) => {
    const label = `${preset}: ${at} 第 ${index + 1} 行`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${label} 不是插件行（应为带 name 的映射）`);
    if (typeof row.name !== 'string' || row.name === '') throw new Error(`${label} 缺少 name`);
    if (typeof row.id !== 'string' || row.id === '') throw new Error(`${label} 缺少 id`);
    if (seen.has(row.id)) throw new Error(`${preset}: 行 id 重复：${row.id}`);
    seen.add(row.id);
    const next = { ...row };
    if (next.name.startsWith('.') || path.isAbsolute(next.name)) {
      const rewrite = rewrites.get(next.name);
      if (rewrite === undefined) {
        throw new Error(`${label}: 相对/绝对插件名 ${JSON.stringify(next.name)} 在 0.1.7 下会按 profile 目录解析，`
          + '必须改写为「bundle 包名/子路径」或去掉；请在 preset-patches.mjs 的 relativeRowRewrites 里显式登记');
      }
      next.name = rewrite;
    }
    if (row.group === true) {
      if (!Array.isArray(row.config)) throw new Error(`${label} 是 group 行但 config 不是行列表`);
      next.config = walk(row.config, `${at}/${row.id}`);
    }
    return next;
  });
  const normalized = walk(rows, 'plugins');
  for (const required of ['persona', 'qq-tool-restrict']) {
    if (!seen.has(required)) throw new Error(`${preset}: 行列表缺少 ${required} 行（安全/人格边界不允许缺失）`);
  }
  return normalized;
}

/**
 * 渲染一个 preset 的 patch 文件内容。
 * `repoRoot` 仅供测试注入临时仓；`platform` 缺省从注册表反查。
 */
export function renderPatch(name, { platform, repoRoot = REPO_ROOT } = {}) {
  const plat = platform ?? presetTargets().find((t) => t.name === name)?.platform;
  if (!plat) throw new Error(`预设 "${name}" 未在任何平台登记（见 src/core/platforms.mjs）`);
  const dir = sourceDirFor(plat, name, repoRoot);
  const meta = readYaml(path.join(dir, 'preset.yml'));
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error(`${name}: preset.yml 必须是映射`);
  for (const field of ['name', 'description', 'order']) {
    if (meta[field] === undefined) throw new Error(`${name}: preset.yml 缺少 ${field}`);
  }
  const plugins = normalizeRows(readYaml(path.join(dir, 'agent.cordis.yml')), name, plat);
  const row = {
    id: presetRowId(name),
    name: '@deepseek-ai/dsh-agent-preset',
    config: {
      id: name,
      name: meta.name,
      description: meta.description,
      order: meta.order,
      plugins,
    },
  };
  const guard = guardSpecifier(plat);
  const header = [
    '# 本文件由 src/runtime/preset-patches.mjs 生成，请勿手工编辑。',
    `# 源：dsh/${plat}/agent-presets/${name}/preset.yml + agent.cordis.yml（人格正文与工具面都在那里改）。`,
    `# 作用：把 ${name} 作为一条 @deepseek-ai/dsh-agent-preset 行插入 profile（DSH 0.1.7+ 的 preset 机制）。`,
    `# 守卫行 qq-tool-restrict 用裸说明符 ${guard}：子行 name 按 profile 目录解析，`,
    `# 该包以 link: 依赖注册在 profile package.json（node_modules junction 由 setup-dsh.mjs 维护）。`,
    '',
  ].join('\n');
  // lineWidth: -1 —— 长行不折行，产物与源逐字对应，diff 只反映真实改动。
  return `${header}${yaml.dump([{ insert: [row] }], { lineWidth: -1, noRefs: true })}`;
}

/**
 * 生成（或校验）全部 patch 文件。
 *
 * 输出位置默认按平台取 `<DSH_HOME>/plugins/<bundle>/presets`；`outDir` 可整体覆盖
 * （测试与一次性渲染用），此时所有平台写进同一目录——平台多于一个时请勿这样用。
 *
 * @returns {{platform:string,name:string,file:string,changed:boolean}[]}
 */
export function buildPatches({ check = false, log = () => {}, repoRoot = REPO_ROOT, outDir, home, platforms } = {}) {
  const results = [];
  for (const { platform, name } of presetTargets({ platforms })) {
    const dir = outDir ?? presetsOutDir({ platform, home });
    const file = path.join(dir, `${name}.patch.yml`);
    const content = renderPatch(name, { platform, repoRoot });
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const changed = current !== content;
    if (changed && !check) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
    }
    const where = outDir ? file : path.basename(file);
    log(`${changed ? (check ? '✗ 需重新生成' : '✓ 已生成') : '· 已是最新'} ${where}`);
    results.push({ platform, name, file, changed });
  }
  return results;
}
