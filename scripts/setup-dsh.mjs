#!/usr/bin/env node
// setup-dsh.mjs — 在目标设备上安装 qq-bridge 的 DSH 端配置
//
// 功能：
//   1. 安装两套 agent preset：qq-chat、qq-chat-v2
//      （DSH 0.1.7 机制：作为 qq-agent-presets bundle 的 patch 层插入
//        @deepseek-ai/dsh-agent-preset 行；~/.dsh/.agent-presets/ 目录已不再被读取）
//   2. 在 DSH profile 的 cordis.patch.yml 中挂载本仓库的三个 MCP server：
//      mcp-snowluma / mcp-snowluma-host / mcp-web-search-safe（具体 id 见 MANAGED_MCP_IDS）
//      平级部署的 ../memory-mcp、../rolecard-mcp **不在这里挂**：它们各有自己的
//      scripts/install-dsh.mjs，谁的能力谁负责装。本脚本只负责把历史代管的那两条清掉
//      （见 LEGACY_MCP_IDS），避免同一条 id 被两个安装器各写一份。
//   3. 在 profile package.json 中注册两个 bundle：qq-mode-console、qq-agent-presets
//
// 用法：
//   node scripts/setup-dsh.mjs [profile]
//
// 默认 profile 为 web；可用环境变量 DSH_HOME 指定 DSH 根目录。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { BUNDLE_DIR, PRESETS, buildPatches, patchFileFor } from './build-agent-preset-patches.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = process.argv[2] || 'web';

// A profile is a directory name, never a path (same boundary as DSH itself).
if (PROFILE === '.' || PROFILE === '..' || PROFILE === 'node_modules'
    || /[\\/\x00-\x1f<>:"|?*]/.test(PROFILE) || /[. ]$/.test(PROFILE)) {
  fatal(`invalid profile name: ${JSON.stringify(PROFILE)}`);
}

function log(msg) {
  console.log(`[setup-dsh] ${msg}`);
}

function fatal(msg) {
  console.error(`[setup-dsh] ERROR: ${msg}`);
  process.exit(1);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * 备份一个即将被覆盖的文件。
 *
 * 为什么不用 `flag: 'wx'`（写一次就永不更新）：那样第一次安装会留下一个备份，
 * 之后每次 setup 都静默跳过 —— 用户后来手工改过的内容再被覆盖时，桌上那份备份
 * 早已过期，等于「有备份但救不回来」。改为每次覆盖前打时间戳快照，只保留最近 N 份。
 */
function backupBeforeOverwrite(file, keep = 5) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.bak-${stamp}`;
  try {
    fs.copyFileSync(file, dest);
  } catch (error) {
    log(`⚠️ 备份失败（${file}）：${error?.message ?? error}；继续但请自行确认原内容`);
    return null;
  }
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.bak-`;
    const snaps = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
    // 时间戳升序 ⇒ 前面的是最旧的，只保留最后 keep 份
    for (const f of snaps.slice(0, Math.max(0, snaps.length - keep))) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch {}
  return dest;
}

// ── agent preset：DSH 0.1.7 机制 ─────────────────────────────────────────────
//
// 0.1.5：preset 是 ~/.dsh/.agent-presets/<preset>/ 下的目录，DSH 启动时扫目录装载。
// 0.1.7：注册表既不扫目录也不接受 preset 路径；preset 是一条普通 loader 行
//        （@deepseek-ai/dsh-agent-preset，config.plugins 内联子行列表），
//        由 bundle 的 patch 文件插入。因此这里做两件事：
//          ① 把 qq-agent-presets bundle 注册进 profile（link: 依赖 + bundles + junction）；
//          ② 从仓库权威源（dsh/agent-presets/<preset>/）重新生成 patch 文件。
//        旧目录不再写入、也不删除（见 reportLegacyPresetDir）。
const BUNDLE_NAMES = ['qq-mode-console', 'qq-agent-presets'];

/** 从仓库源重新生成 bundle 里的 patch 文件（人格正文/工具面改了就必须重跑）。 */
function regeneratePresetPatches() {
  const results = buildPatches({ log: () => {} });
  for (const { file, changed } of results) {
    log(`preset patch ${changed ? '已生成' : '已是最新'}: ${path.relative(REPO_ROOT, file)}`);
  }
  for (const name of PRESETS) {
    const file = patchFileFor(name);
    if (!fs.existsSync(file)) fatal(`preset patch 未生成：${file}`);
  }
}

/**
 * 旧机制的安装目录：0.1.7 起 DSH 完全不再读它。
 *
 * 这里**只报告、不删除**——里面可能是用户手改过的人设（仓库源文件救不回来）。
 * 顺带对比仓库源：一致说明没丢东西，不一致说明用户改的那份已不再生效，需要人工合并。
 */
function reportLegacyPresetDir() {
  const legacy = path.join(DSH_HOME, '.agent-presets');
  if (!fs.existsSync(legacy)) return;
  log(`注意：${legacy} 是 DSH 0.1.5 的 preset 安装目录，0.1.7 起不再被读取（保留未删，可自行备份后清理）`);
  for (const name of PRESETS) {
    const installed = path.join(legacy, name, 'agent.cordis.yml');
    if (!fs.existsSync(installed)) continue;
    const source = path.join(REPO_ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
    const same = fs.existsSync(source) && fs.readFileSync(installed, 'utf8') === fs.readFileSync(source, 'utf8');
    log(same
      ? `  · ${name}：旧目录副本与仓库源一致（无内容丢失）`
      : `  ⚠️ ${name}：旧目录副本与仓库源**不一致**——那份手改内容不会再生效，请人工合并到 dsh/agent-presets/${name}/agent.cordis.yml`);
  }
}

function yamlSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// 由桥接托管的 MCP 条目 id：脚本对这几个 id 拥有所有权，可安全地按 id 增删。
// 忘了登记是"配了却看不见"的典型原因（删 mcp-qq-ui 时的教训：清理名单与写入名单要分清）。
const MANAGED_MCP_IDS = ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe'];

// 历史版本由本脚本代管的兄弟包条目：现在各自安装（../memory-mcp、../rolecard-mcp 的
// scripts/install-dsh.mjs），这里**主动删除**而不是沿用 —— 留着会变成两份 id 重复
// （DSH 遇到重复 loader id 会起不来），而且路径可能还指向别处的旧目录。
const LEGACY_MCP_IDS = ['mcp-memory', 'mcp-rolecard'];

// 旧条目对应的服务名（= 对方 install-dsh.mjs 写的区块标记里的名字）。
// 用途：如果对方已经接管（区块标记在文件里），就不要删这条 id。
const LEGACY_SERVICE_LABEL = { 'mcp-memory': 'memory-mcp', 'mcp-rolecard': 'rolecard-mcp' };

function mcpEntries() {
  const node = process.execPath;
  const servers = {
    'mcp-snowluma': { serverName: 'snowluma', script: path.join(REPO_ROOT, 'src', 'mcp-snowluma-safe.js'), toolCallTimeoutMs: 725000 },
    'mcp-snowluma-host': { serverName: 'snowluma-host', script: path.join(REPO_ROOT, 'src', 'mcp-host-server.js') },
    'mcp-web-search-safe': { serverName: 'web-search-safe', script: path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js') },
  };
  let out = '# === qq-bridge MCP BEGIN ===\n';
  out += '# 由 scripts/setup-dsh.mjs 维护；这段区块会被整体替换，请勿手工编辑内部条目。\n';
  for (const [id, s] of Object.entries(servers)) {
    out += `- insert:\n`;
    out += `    - id: ${id}\n`;
    out += `      name: '@deepseek-ai/dsh-mcp-client'\n`;
    out += `      config:\n`;
    out += `        serverName: ${s.serverName}\n`;
    out += `        transport: stdio\n`;
    out += `        command: ${yamlSingleQuote(node)}\n`;
    out += `        args:\n`;
    out += `          - ${yamlSingleQuote(s.script)}\n`;
    // qq_wait_for_messages 最长可等 10 分钟；DSH 默认 60s 会提前掐断工具调用。
    if (s.toolCallTimeoutMs) out += `        toolCallTimeoutMs: ${s.toolCallTimeoutMs}\n`;
  }
  out += '# === qq-bridge MCP END ===\n';
  return out;
}

function prepareCordisPatch() {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const original = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  const lines = original.replace(/^\uFEFF/, '').split(/\r?\n/);
  // Repair only the historical invalid *root* [] followed by block operations.
  // A nested [] or a line inside a literal scalar is user data and must survive.
  const first = lines.findIndex((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (first >= 0 && lines[first].trim() === '[]'
      && lines.slice(first + 1).some((line) => /^-\s/.test(line))) {
    lines.splice(first, 1);
  }
  let doc;
  try { doc = yaml.load(lines.join('\n')) ?? []; }
  catch (error) { fatal(`failed to parse ${patchFile}; file unchanged: ${error.message}`); }
  if (!Array.isArray(doc)) fatal(`${patchFile} must contain a YAML array; file unchanged`);
  let removed = 0;
  const legacyRemoved = [];
  // 已经在「各自安装器」手里的条目不能删：那两个 install-dsh.mjs 会写一段带标记的
  // 托管区块，标记在就说明这条 id 归它管。否则本脚本每跑一次就把人家装好的服务
  // 卸一次——而本脚本是「可重复运行」的，用户会经常回来跑。
  const adoptedByService = (id) => {
    const label = LEGACY_SERVICE_LABEL[id];
    return Boolean(label) && original.includes(`# === ${label} MCP BEGIN ===`);
  };
  const kept = [];
  for (const operation of doc) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      fatal(`invalid patch operation in ${patchFile}; file unchanged`);
    }
    if (!Object.hasOwn(operation, 'insert')) { kept.push(operation); continue; }
    if (!Array.isArray(operation.insert)) fatal(`insert must be an array in ${patchFile}; file unchanged`);
    const entries = operation.insert.filter((entry) => {
      if (LEGACY_MCP_IDS.includes(entry?.id)) {
        if (adoptedByService(entry.id)) return true;
        legacyRemoved.push(entry.id);
        return false;
      }
      if (!MANAGED_MCP_IDS.includes(entry?.id)) return true;
      removed++;
      return false;
    });
    // Retain shared insert parents and their selectors/other operation fields.
    if (entries.length || Object.keys(operation).length > 1) kept.push({ ...operation, insert: entries });
  }
  const text = (kept.length ? `${yaml.dump(kept, { lineWidth: -1, noRefs: true })}\n` : '') + mcpEntries();
  return { patchFile, original, text, removed, legacyRemoved };
}

function patchCordis({ patchFile, original, text, removed, legacyRemoved }) {
  ensureDir(path.dirname(patchFile));
  // Parsing/serialization normalizes formatting; keep the original text (including comments).
  if (original && original !== text) {
    backupBeforeOverwrite(patchFile);
  }
  const temporary = `${patchFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, patchFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  log(`cordis.patch.yml: MCP 条目已同步（清理旧条目 ${removed} 条，写入 ${MANAGED_MCP_IDS.length} 条）`);
  if (legacyRemoved.length) {
    // 只提醒、不代跑：两个兄弟包可能根本不在本机上（只部署 qq-bridge 的机器很常见）。
    log(`已移出历史代管的兄弟包条目：${[...new Set(legacyRemoved)].join(', ')}`);
    log('这两个服务现在各自安装，在上述目录里各跑一次：');
    log('  cd ../memory-mcp   && npm run install:dsh');
    log('  cd ../rolecard-mcp && npm run install:dsh');
    log('（不装也不影响桥接：桥接走的是它们的回环 HTTP。）');
  }
}

/**
 * 建一个指向本仓库的目录链接（Windows 用 junction，免管理员权限）。
 *
 * 链接已存在时校验指向：指向本仓库 ⇒ 跳过（幂等）；指向别处/悬空 ⇒ 重建。
 * 指向别处说明用户手工挪过文件，这里按"重装"处理并明确打印。
 */
function ensureDirLink(linkPath, targetDir, label) {
  if (!fs.existsSync(targetDir)) fatal(`${label} 源目录不存在: ${targetDir}`);
  ensureDir(path.dirname(linkPath));

  let existing = null;
  try {
    existing = fs.lstatSync(linkPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') fatal(`failed to inspect ${label}: ${error?.message ?? error}`);
  }

  if (existing) {
    if (!existing.isSymbolicLink()) {
      fatal(`${label} 已存在且不是符号链接/junction: ${linkPath}。请先手工移走或删除，然后重跑。`);
    }
    let sameTarget = false;
    try {
      const target = fs.realpathSync(linkPath);
      const expected = fs.realpathSync(targetDir);
      sameTarget = process.platform === 'win32'
        ? String(target).toLowerCase() === String(expected).toLowerCase()
        : String(target) === String(expected);
    } catch {}
    if (sameTarget) {
      log(`${label} 已存在且指向本仓库: ${linkPath}`);
      return linkPath;
    }
    log(`${label} 存在但指向别处/失效，重建: ${linkPath}`);
    fs.rmSync(linkPath, { recursive: true, force: true });
  }

  try {
    if (process.platform === 'win32') {
      fs.symlinkSync(targetDir, linkPath, 'junction');
    } else {
      fs.symlinkSync(targetDir, linkPath, 'dir');
    }
    log(`${label} 已创建: ${linkPath}`);
  } catch (e) {
    fatal(`failed to create ${label}: ${e.message}`);
  }
  return linkPath;
}

/**
 * 把仓库里的 bundle 包接进 profile。
 *
 * 两层链接，与 `dsh plugin install`（pnpm）物化出的形态一致：
 *   ~/.dsh/plugins/<name>  → 仓库目录（人工可读的"安装位"）
 *   <profile>/node_modules/<name> → ~/.dsh/plugins/<name>（Node 解析路径）
 * 第二层必须自己建：preset 子行按 profile 目录解析裸说明符
 * （qq-agent-presets/qq-tool-restrict.mjs），缺了它 preset 会整条挂载失败。
 */
function ensureBundle(name) {
  const repoDir = name === 'qq-agent-presets' ? BUNDLE_DIR : path.join(REPO_ROOT, 'plugins', name);
  const linkDir = ensureDirLink(path.join(DSH_HOME, 'plugins', name), repoDir, `bundle ${name} link`);
  ensureDirLink(path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', name), linkDir, `bundle ${name} node_modules link`);
  return linkDir;
}

function patchProfilePackage(links) {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const pkgFile = path.join(profileDir, 'package.json');
  ensureDir(profileDir);
  let pkg = { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  if (fs.existsSync(pkgFile)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    } catch (e) {
      fatal(`failed to parse ${pkgFile}: ${e.message}`);
    }
  }
  pkg.name = pkg.name || `dsh-profile-${PROFILE}`;
  pkg.private = pkg.private !== false;
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) pkg.dependencies = {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
  for (const [name, linkDir] of Object.entries(links)) {
    const linkVal = `link:${linkDir.replace(/\\/g, '/')}`;
    if (pkg.dependencies[name] !== linkVal) {
      pkg.dependencies[name] = linkVal;
      log(`package.json dependency ${name} -> ${linkVal}`);
    }
    if (!pkg.dsh.profile.bundles.includes(name)) {
      pkg.dsh.profile.bundles.push(name);
      log(`package.json bundle added: ${name}`);
    }
  }
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  log(`profile package.json ensured: ${pkgFile}`);
}

function ensureLocalModeFile() {
  const stateDir = path.join(REPO_ROOT, 'state');
  const modeFile = path.join(stateDir, 'mode.json');
  if (fs.existsSync(modeFile)) {
    log(`state/mode.json already exists; leave as-is (current mode may be user-configured)`);
    return;
  }
  ensureDir(stateDir);
  // DSH 0.1.5 起不再有 'router-standard' preset；留空表示「用 DSH 自己声明的默认 preset」，
  // 由 bridge.js 的 resolvePresetName() 兜底（硬编码已下线的名字只会换来每次启动的误导性告警）。
  fs.writeFileSync(modeFile, `${JSON.stringify({ mode: 'reserved2', closedAgentPreset: '' }, null, 2)}\n`, 'utf8');
  log(`state/mode.json created with mode=reserved2 (fallback if DSH settings are not available)`);
}

// qq-mode-console / qq-agent-presets 以 link: 依赖注册进 profile package.json 后，DSH 首次启动
// 需要先安装一次才能解析这些 bundle（否则 cold start 报 "cannot resolve profile bundle"）。
// dsh CLI 可用时自动执行。
function autoInstallProfileBundles() {
  if (process.env.QQ_BRIDGE_SKIP_DSH_INSTALL === '1') {
    log('auto-install skipped: QQ_BRIDGE_SKIP_DSH_INSTALL=1');
    return;
  }
  const windows = process.platform === 'win32';
  // Node cannot spawn npm's .cmd shim directly. Keep the shell command constant;
  // the validated (no quotes/control chars) profile travels through one quoted
  // environment expansion, with delayed expansion disabled to preserve '!'.
  const cmd = windows ? (process.env.ComSpec || 'cmd.exe') : 'dsh';
  const args = windows
    ? ['/d', '/v:off', '/s', '/c', 'dsh.cmd plugin --profile "%QQ_BRIDGE_SETUP_PROFILE%" install']
    : ['plugin', '--profile', PROFILE, 'install'];
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    windowsVerbatimArguments: windows,
    ...(windows ? { env: { ...process.env, QQ_BRIDGE_SETUP_PROFILE: PROFILE } } : {}),
  });
  if (r.error) {
    log(`auto-install failed to start/complete（${r.error.code || r.error.message}）。`);
    log(`若 DSH 启动报“cannot resolve profile bundle”，请手动执行：dsh plugin --profile ${PROFILE} install`);
    return;
  }
  if (r.status === 0) {
    log(`dsh plugin --profile ${PROFILE} install: OK`);
  } else {
    log(`dsh plugin --profile ${PROFILE} install 返回退出码 ${r.status}（若 DSH 启动报 bundle 解析失败，请手动重跑该命令）`);
  }
}

// Validate the existing YAML before changing any presets or configuration.
const cordisPatch = prepareCordisPatch();
regeneratePresetPatches();
patchCordis(cordisPatch);
const links = {};
for (const name of BUNDLE_NAMES) links[name] = ensureBundle(name);
patchProfilePackage(links);
reportLegacyPresetDir();
ensureLocalModeFile();
autoInstallProfileBundles();
log('Done. Restart DSH (or reload the profile) so the new presets/MCP take effect.');
