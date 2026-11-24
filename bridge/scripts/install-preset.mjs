#!/usr/bin/env node

/**
 * install:preset —— 把桥接收管的 DSH preset bundle 安装进 profile（一次性安装动作）。
 *
 * 2026-11-16 从 agent-gateway 的 setup:dsh 迁入桥接：**预设是平台知识**，源码
 * （`dsh/qq/agent-presets/*` + `dsh/qq/bundle/*`）与安装逻辑都归桥接；网关只保留
 * mcp-bus 注册块（见 agent-gateway 的 `npm run setup:dsh`），两边互不越界。
 *
 * 做的事（仓库只存源码，生成物只落 DSH 侧），对每个平台（见 scripts/lib/platforms.mjs）：
 *   a. `<DSH_HOME>/plugins/<bundle>` 物化为**真实目录**（原本是链接则只断链，不写穿仓库）
 *   b. 复制源码 `dsh/<平台>/bundle/*`（内容一致跳过），再把
 *      `dsh/<平台>/agent-presets/<preset>/` 现场渲染成 `<bundle>/presets/<preset>.patch.yml`
 *   c. 清理不属于当前平台的陈旧 `*.patch.yml`（删预设后不留悬空 patch）
 *   d. 建 `<profile>/node_modules/<bundle>` → `<bundle>` 的 junction（裸说明符解析必需）
 *   e. 在 profile `package.json` 写 `link:` 依赖 + `dsh.profile.bundles` 条目
 *   f. 调 `dsh plugin --profile <p> install`（失败只告警，链接已足以让 DSH 解析）
 *
 * 为什么是显式 CLI 而不是桥接启动时自动写：
 *   1. DSH 只在启动期读 bundles / cordis.patch.yml，写完必须重启 DSH 才生效——启动时
 *      静默改写只会让人以为「已经好了」；
 *   2. 崩溃重启 loop 会反复改写另一个应用正在读写的配置；
 *   3. 该文件里有用户/其它插件维护的内容（含历史乱码注释），写坏代价极高。
 *
 * 幂等：链接指向一致 → noop；package.json 值一致 → 不落盘；patch 与源一致 → 不写盘。
 *
 * 用法：
 *   npm run install:preset                 # 安装到 ~/.dsh 的 web profile
 *   npm run install:preset -- --dry-run    # 只打印判定与安装计划，不落盘
 *   npm run install:preset -- --profile headless
 *   npm run install:preset -- --no-plugin-install   # 建链接与 package.json，但不跑 dsh plugin install
 *   npm run install:preset -- --json
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// MCP（mcp-bus）注册块归 agent-gateway 的 setup:dsh 管；这里只装 preset bundle。
const {
  DEFAULT_PROFILE,
  resolveDshHome,
  resolveProfileDir,
  planDirLink,
  applyDirLink,
  planMaterializeDir,
  applyMaterializeDir,
  listBundleSourceFiles,
  copyFileIfChanged,
  readProfilePackage,
  patchProfilePackage,
  serializeProfilePackage,
  pluginInstallCommand,
  auditServerPrefixes,
} = await import(new URL('./lib/dsh-bundle.mjs', import.meta.url).href);

// 守卫白名单（bundle 源文件唯一权威实现）——反向覆盖对账的基准名单。
const { SAFE_PREFIXES } = await import(new URL('../dsh/qq/bundle/qq-tool-restrict.mjs', import.meta.url).href);

const { platforms: listPlatforms, PLATFORMS } = await import(new URL('./lib/platforms.mjs', import.meta.url).href);

// 生成逻辑在 runtime 层（preset-files.mjs 也要复用），CLI 薄壳只是 --check 入口。
const {
  buildPatches,
  bundleDirFor,
  presetsOutDir,
  listStalePatches,
} = await import(new URL('./lib/preset-patches.mjs', import.meta.url).href);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'json' || key === 'dry-run' || key === 'help' || key === 'no-plugin-install') {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    // 空值/纯空白一律视为「没给值」：`--home ` 这种写法会把文件写到默认 home，
    // 静默跑偏比直接报错危险得多（真实踩过：--home 变量名与 PowerShell $HOME 冲突）。
    if (value === undefined || value.startsWith('--') || value.trim() === '') {
      throw new Error(`missing value for --${key}`);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

/**
 * 物化一个平台的 bundle 并接进 profile。
 *
 * 顺序有讲究（改错顺序会把文件写进仓库或建出悬空链接）：
 *   ① 断链 + 建真实目录（**先**断链，否则后续复制会写穿到链接目标 = 写进仓库）
 *   ② 复制源文件（package.json + 运行期代码；内容一致跳过）
 *   ③ 渲染 patch 到 `<bundle>/presets/` 并清理陈旧产物
 *   ④ 建 `<profile>/node_modules/<bundle>` junction（目标此时已存在）
 *   ⑤ 登记 profile package.json（link: 依赖 + bundles）
 *
 * 源不合法（缺 persona/qq-tool-restrict、非法相对行名）时直接抛错——装坏比不装更糟。
 */
function installPlatformBundle({ platform, profile, home, dryRun, log }) {
  const bundle = PLATFORMS[platform]?.bundle;
  if (!bundle) throw new Error(`平台 "${platform}" 未在 PLATFORMS 中登记 bundle 包名`);
  const sourceDir = bundleDirFor(platform, REPO_ROOT);
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`bundle 源目录不存在：${sourceDir}（仓库缺少 dsh/${platform}/bundle）`);
  }

  const dshHome = resolveDshHome({ home });
  const bundleDir = path.join(dshHome, 'plugins', bundle);
  const outDir = presetsOutDir({ platform, home: dshHome });
  const profileDir = resolveProfileDir({ home: dshHome, profile });
  const nodeModulesLink = path.join(profileDir, 'node_modules', bundle);
  const pkgFile = path.join(profileDir, 'package.json');

  // ① 真实目录（断链不写穿）
  const dirPlan = planMaterializeDir(bundleDir);
  log(`${platform}: bundle 目录 ${dirPlan.action} → ${bundleDir}`);
  if (!dryRun) applyMaterializeDir(dirPlan, { log: (line) => log(`${platform}: ${line}`) });

  // ② 源文件
  const sources = listBundleSourceFiles(sourceDir).map((rel) => {
    const from = path.join(sourceDir, rel);
    const to = path.join(bundleDir, rel);
    if (dryRun) {
      const same = fs.existsSync(to) && fs.readFileSync(to).equals(fs.readFileSync(from));
      log(`${platform}: ${same ? '源文件一致' : '将复制'} ${rel}`);
      return { file: rel, changed: !same };
    }
    const r = copyFileIfChanged(from, to);
    log(`${platform}: ${r.changed ? '已复制' : '源文件一致'} ${rel}`);
    return { file: rel, changed: r.changed };
  });

  // ③ patch 产物（dry-run 走 check 模式：只判定、不写盘）
  const patches = buildPatches({
    platforms: [platform],
    outDir,
    check: dryRun,
    log: (line) => log(`${platform}: ${line}`),
  }).map((r) => ({ name: r.name, file: path.relative(bundleDir, r.file).replace(/\\/g, '/'), changed: r.changed }));

  // 陈旧产物：不属于本平台的 *.patch.yml（例如删掉的 qq-chat-v2 / qq-chat-lite）
  const stale = listStalePatches({ platform, outDir });
  for (const file of stale) {
    log(`${platform}: ${dryRun ? '将清理' : '已清理'}陈旧产物 ${path.basename(file)}`);
    if (!dryRun) fs.rmSync(file, { force: true });
  }

  // ④ node_modules 链接（裸说明符解析必需；目标刚建好，已存在）
  const linkPlan = planDirLink(nodeModulesLink, bundleDir, { requireTarget: false });
  if (linkPlan.action === 'conflict') {
    throw new Error(`拒绝覆盖真实目录：${nodeModulesLink}。请先移走该目录再重跑。`);
  }
  log(`${platform}: node_modules 链接 ${linkPlan.action} → ${nodeModulesLink}`);
  if (!dryRun) applyDirLink(linkPlan);

  // ⑤ profile 登记
  const pkg = readProfilePackage(pkgFile, profile);
  const patched = patchProfilePackage(pkg, { name: bundle, linkDir: bundleDir });
  log(`${platform}: package.json ${patched.changed ? `已更新（${patched.dependency}）` : '已登记且一致'}`);

  // 守卫白名单反向覆盖对账（挂载即意图）：挂了 server 却没进 SAFE_PREFIXES 时，
  // DSH 的工具调用会被 qq-tool-restrict 执行期守卫静默拒绝——安装当场提醒。
  const guardAudit = auditServerPrefixes({ profileDir, prefixes: SAFE_PREFIXES });
  if (guardAudit.skipped) {
    log(`${platform}: MCP 守卫对账跳过（cordis.patch.yml 不存在）`);
  } else if (guardAudit.ok) {
    log(`${platform}: MCP 守卫对账 ✓（挂载 server：${guardAudit.servers.join('、')}）`);
  } else {
    log(`${platform}: ⚠ MCP 守卫对账缺口——已挂载 server 未进 qq-tool-restrict SAFE_PREFIXES：${guardAudit.missing.join('、')}（守卫将拒绝其工具调用）`);
  }
  if (!dryRun && patched.changed) fs.writeFileSync(pkgFile, serializeProfilePackage(patched.pkg), 'utf8');

  return {
    platform,
    bundle,
    bundleDir,
    materialized: dirPlan.action,
    sources,
    patches,
    staleRemoved: stale.map((file) => path.basename(file)),
    nodeModulesLink: { path: nodeModulesLink, action: linkPlan.action },
    packageJson: { file: pkgFile, changed: patched.changed, dependency: patched.dependency, bundleAdded: patched.bundleAdded },
  };
}

/** 逐平台物化（当前只有一个平台，但循环保证新增 wx 时不用改安装逻辑）。 */
function installPresetBundles({ profile, home, dryRun, log }) {
  return listPlatforms().map((platform) => installPlatformBundle({ platform, profile, home, dryRun, log }));
}

/**
 * `dsh plugin --profile <p> install`：让 DSH 自己把 node_modules 物化。
 * 失败不中断安装（链接与 package.json 已就位，DSH 仍能解析），只提示手工命令。
 */
function autoInstallProfileBundles({ profile, home, dryRun, log }) {
  if (dryRun) {
    log('dry-run：跳过 dsh plugin install');
    return { ran: false, status: null, reason: 'dry-run' };
  }
  const { command, args, options } = pluginInstallCommand({ profile });
  // --home 覆盖时必须把同一个 DSH_HOME 传给子进程，否则 dsh 会去真实的 ~/.dsh 物化。
  const env = home ? { ...process.env, DSH_HOME: path.resolve(home) } : process.env;
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, env, ...options });
  if (r.error) {
    log(`dsh plugin install 无法启动（${r.error.code || r.error.message}）。`);
    log(`若 DSH 启动报 "cannot resolve profile bundle"，请手动执行：dsh plugin --profile ${profile} install`);
    return { ran: false, status: null, reason: String(r.error.code || r.error.message) };
  }
  if (r.status === 0) {
    log(`dsh plugin --profile ${profile} install: OK`);
  } else {
    // 常见失败是环境缺 pnpm（dsh plugin 内部调用它）或 dsh 不在 PATH：
    // 把子进程输出带出来，否则只看到「退出码 1」等于没说。
    const detail = `${r.stderr || ''}\n${r.stdout || ''}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('dsh: plugin command failed;'));
    log(`dsh plugin --profile ${profile} install 返回退出码 ${r.status}${detail ? `：${detail.slice(0, 200)}` : ''}`);
    log('提示：链接与 package.json 已就位，DSH 通常仍能解析；若启动报 "cannot resolve profile bundle"，'
      + '请确认 pnpm 在 PATH 中后手动重跑：dsh plugin --profile ' + profile + ' install');
  }
  return { ran: true, status: r.status };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log([
      '用法: npm run install:preset -- [--profile <name>] [--home <path>] [--dry-run] [--json] [--no-plugin-install]',
      '',
      '  --profile <name>     DSH profile（默认 web；headless 场景传 headless）',
      '  --home <path>        DSH home（默认 $DSH_HOME 或 ~/.dsh；测试/多实例用）',
      '  --dry-run            只打印判定与安装计划，不落盘',
      '  --json               机器可读输出',
      '  --no-plugin-install  建链接与 package.json，但不执行 dsh plugin install',
      '',
      'preset bundle 安装（2026-11-16 从 agent-gateway 迁入桥接；生成物只落 DSH 侧，仓库内不留 patch）：',
      '  1. 物化 <DSH_HOME>/plugins/<bundle> 为真实目录（若原本是链接则只断链，不写穿仓库）',
      '  2. 复制源码（package.json + 运行期代码）并现场渲染 <presets>/<preset>.patch.yml，清理陈旧 patch',
      '  3. 建 <profile>/node_modules/<bundle> 链接、写 profile package.json 的 link: 依赖与 bundles，最后跑 dsh plugin install',
      '',
      'MCP（mcp-bus）注册块由 agent-gateway 的 npm run setup:dsh 负责，本脚本不碰它。',
      '安装完必须重启 DSH 才生效。',
    ].join('\n'));
    return 0;
  }

  const json = args.json === true;
  const dryRun = args['dry-run'] === true;
  const profile = args.profile ?? DEFAULT_PROFILE;
  const fail = (message, extra = {}) => {
    if (json) console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
    else console.error(`[install:preset] ${message}`);
    return 1;
  };

  // --json 时进度行必须走 stderr：stdout 只能是那一个 JSON 对象，否则调用方解析失败。
  const log = (line) => {
    if (json) console.error(`[install:preset] ${line}`);
    else console.log(`[install:preset] ${line}`);
  };

  let bundles = null;
  let pluginInstall = null;
  try {
    // 顺序在 installPlatformBundle 内部固定：断链→建目录→复制→渲染 patch→链接→登记。
    // 源不合法（缺 persona/qq-tool-restrict、非法相对名）会在渲染 patch 时直接抛错，
    // 此时目录可能已建好，但不会留下「patch 与源不一致」的可用 bundle。
    bundles = installPresetBundles({ profile, home: args.home, dryRun, log });
    pluginInstall = args['no-plugin-install'] === true
      ? { ran: false, status: null, reason: '--no-plugin-install' }
      : autoInstallProfileBundles({ profile, home: args.home, dryRun, log });
  } catch (error) {
    return fail(`preset bundle 安装失败：${error?.message ?? error}`, { bundles });
  }

  if (json) {
    console.log(JSON.stringify({ ok: true, dryRun, profile, bundles, pluginInstall }, null, 2));
    return 0;
  }

  let changed = false;
  for (const item of bundles) {
    const patchChanged = item.patches.filter((p) => p.changed).length;
    const sourceChanged = item.sources.filter((s) => s.changed).length;
    console.log(`[install:preset] ${item.platform} bundle: 目录 ${item.materialized}`
      + `；源文件 ${sourceChanged}/${item.sources.length} 更新`
      + `；patch ${patchChanged}/${item.patches.length} 更新`
      + `；陈旧清理 ${item.staleRemoved.length}`
      + `；node_modules ${item.nodeModulesLink.action}`
      + `；package.json ${item.packageJson.changed ? '已更新' : '未变'}`);
    changed = changed || item.packageJson.changed || patchChanged > 0 || sourceChanged > 0;
  }
  if (changed) {
    console.log('[install:preset] 注意：DSH 只在启动时读这些配置 —— 需要重启 DSH 才会生效。');
  }
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`install:preset: ${error?.message ?? error}`);
  process.exit(1);
}
