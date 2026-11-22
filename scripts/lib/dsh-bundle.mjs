/**
 * dsh-bundle —— 把仓库里的 DSH bundle 包接进 profile。
 *
 * 形态（2026-11 调整后的单一形态：**物化** + 一级链接）：
 *   - 仓库只存源码：`dsh/<平台>/bundle`（package.json + 运行期代码）与
 *     `dsh/<平台>/agent-presets/<preset>/`；仓库内**不留**生成的 patch。
 *   - `<DSH_HOME>/plugins/<bundle>` 是**真实目录**，由 setup-dsh 把源码复制进去，
 *     并把 patch 现场渲染到它的 `presets/` 子目录。删掉整个目录后重跑 setup 即可完整重建。
 *   - `<profile>/node_modules/<bundle>` 仍是 junction → `<DSH_HOME>/plugins/<bundle>`：
 *     preset 行里的裸说明符（`qq-agent-presets/qq-tool-restrict.mjs`）按 profile 目录解析，
 *     必须有这条链接。
 *   - profile `package.json` 仍然是 `link:` 依赖 + `dsh.profile.bundles` 条目。
 *
 * 这个模块只放**可单测的纯函数**与极薄的 IO 包装（风格对齐 dsh-patch.mjs）：
 * 计划（plan）与执行（apply）分离，CLI 侧负责打印与备份。
 *
 * 安全性：
 *   - 物化目标若是**真实目录**→ 复用（只覆盖同名源文件，绝不删目录内容）。
 *   - 物化目标若是**链接**→ 只断链再建真实目录，绝不写穿到链接目标（否则会改写仓库）。
 *   - node_modules 同名真实目录 → conflict，绝不覆盖。
 *   - 幂等：源文件内容一致 → 跳过；package.json 值一致 → changed:false 不落盘。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PROFILE = 'web';

/** profile 名会拼进 shell 命令与路径，先做白名单校验。 */
export const PROFILE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** DSH home：显式参数 > DSH_HOME 环境变量 > ~/.dsh。 */
export function resolveDshHome({ home, env = process.env } = {}) {
  if (home) return path.resolve(home);
  if (env.DSH_HOME) return path.resolve(env.DSH_HOME);
  return path.join(os.homedir(), '.dsh');
}

/** `<DSH_HOME>/profiles/<profile>`。 */
export function resolveProfileDir({ home, env, profile = DEFAULT_PROFILE } = {}) {
  assertProfile(profile);
  return path.join(resolveDshHome({ home, env }), 'profiles', profile);
}

/**
 * 计划一次「物化目录」：把 `<DSH_HOME>/plugins/<bundle>` 变成真实目录。
 *
 * - 不存在 → create
 * - 存在且是链接 → relink（**只断链**，绝不顺着链接删目标；否则会删掉仓库内容）
 * - 存在且是真实目录 → reuse（不删内容，后续只覆盖同名源文件）
 */
export function planMaterializeDir(dirPath) {
  const dir = path.resolve(dirPath);
  let stat = null;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return { action: 'create', dirPath: dir };
  }
  if (stat.isSymbolicLink()) return { action: 'relink', dirPath: dir };
  if (stat.isDirectory()) return { action: 'reuse', dirPath: dir };
  throw new Error(`目标已存在但不是目录：${dir}。请先移走该文件再重跑。`);
}

/** 执行 `planMaterializeDir` 的结果（幂等）。 */
export function applyMaterializeDir(planned, { log = () => {} } = {}) {
  if (planned.action === 'reuse') return planned;
  if (planned.action === 'relink') {
    // junction/符号链接：rmSync 只删链接本身，不递归进目标。
    fs.rmSync(planned.dirPath, { recursive: true, force: true });
    log(`已断开旧链接 ${planned.dirPath}`);
  }
  fs.mkdirSync(planned.dirPath, { recursive: true });
  return planned;
}

/** 源目录下需要物化的文件（相对路径）；`presets/` 是生成物，不在复制范围。 */
export function listBundleSourceFiles(sourceDir) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (rel === 'presets') continue; // 生成物由生成器写入，不复制
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  };
  walk(sourceDir, '');
  return files.sort();
}

/**
 * 按内容比较后复制单个文件（幂等：内容一致不写盘、不刷 mtime）。
 * @returns {{file:string, changed:boolean}}
 */
export function copyFileIfChanged(sourceFile, destFile) {
  const next = fs.readFileSync(sourceFile);
  let current = null;
  try {
    current = fs.readFileSync(destFile);
  } catch {
    current = null;
  }
  const changed = !current || !current.equals(next);
  if (changed) {
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.writeFileSync(destFile, next);
  }
  return { file: destFile, changed };
}

export function assertProfile(profile) {
  if (!PROFILE_PATTERN.test(String(profile ?? ''))) {
    throw new Error(`profile 名非法：${JSON.stringify(profile)}（只允许字母/数字/下划线/连字符，≤64）`);
  }
}

function samePath(a, b) {
  const left = String(a);
  const right = String(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * 计划一条目录链接（不落盘）。
 *
 * `requireTarget` 默认为 true：目标缺失是配置错误，早失败好过建出悬空链接。
 * 例外是「链接指向另一个刚计划出来的链接」（node_modules → .dsh/plugins），
 * 那一刻目标还不存在，调用方传 false。
 *
 * @returns {{action:'create'|'relink'|'noop'|'conflict', reason:string, linkPath:string, targetPath:string}}
 */
export function planDirLink(linkPath, targetPath, { requireTarget = true } = {}) {
  const target = path.resolve(targetPath);
  const link = path.resolve(linkPath);
  if (requireTarget && !fs.existsSync(target)) {
    throw new Error(`链接目标不存在：${target}`);
  }
  let st = null;
  try {
    st = fs.lstatSync(link);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!st) {
    return { action: 'create', reason: '链接不存在', linkPath: link, targetPath: target };
  }
  if (!st.isSymbolicLink()) {
    // 真实目录/文件：不覆盖。调用方必须提示用户手工移走。
    return { action: 'conflict', reason: '同名路径已存在且不是链接（拒绝覆盖）', linkPath: link, targetPath: target };
  }
  let resolved = null;
  try {
    resolved = fs.realpathSync(link);
  } catch {
    // 悬空链接：目标曾存在过但已消失，按重建处理。
    return { action: 'relink', reason: '链接已悬空', linkPath: link, targetPath: target };
  }
  // 目标可能还不存在（requireTarget:false 的场景），此时只需确认链接指向它。
  if (!fs.existsSync(target)) {
    const raw = (() => { try { return fs.readlinkSync(link); } catch { return null; } })();
    if (raw && samePath(path.resolve(path.dirname(link), raw), target)) {
      return { action: 'noop', reason: '已指向待创建的目标', linkPath: link, targetPath: target };
    }
    return { action: 'relink', reason: '目标未就绪', linkPath: link, targetPath: target };
  }
  if (samePath(resolved, fs.realpathSync(target))) {
    return { action: 'noop', reason: '已指向同一目标', linkPath: link, targetPath: target };
  }
  return { action: 'relink', reason: `指向别处：${resolved}`, linkPath: link, targetPath: target };
}

/**
 * 执行链接计划。win32 用 junction（无需管理员权限），其它平台用目录 symlink。
 * 只删「链接本身」，不触碰目标内容（fs.rmSync 不跟随符号链接）。
 * @returns {{written:boolean, action:string}}
 */
export function applyDirLink(planned) {
  const { action, linkPath, targetPath } = planned;
  if (action === 'noop') return { written: false, action };
  if (action === 'conflict') throw new Error(`拒绝覆盖真实目录：${linkPath}`);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  if (action === 'relink') {
    try { fs.rmSync(linkPath, { recursive: true, force: true }); } catch { /* 已不存在 */ }
  }
  if (process.platform === 'win32') fs.symlinkSync(targetPath, linkPath, 'junction');
  else fs.symlinkSync(targetPath, linkPath, 'dir');
  return { written: true, action };
}

/** profile package.json 的最小骨架（DSH 自己也会补，这里保证字段齐全）。 */
export function emptyProfilePackage(profile = DEFAULT_PROFILE) {
  return { name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
}

/** 读 profile package.json；不存在返回骨架，解析失败抛错（不猜测、不覆盖）。 */
export function readProfilePackage(pkgFile, profile = DEFAULT_PROFILE) {
  if (!fs.existsSync(pkgFile)) return emptyProfilePackage(profile);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  } catch (error) {
    throw new Error(`无法解析 ${pkgFile}：${error?.message ?? error}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${pkgFile} 顶层不是对象`);
  }
  return parsed;
}

/**
 * 在 package.json 上登记一个 `link:` bundle（纯函数，不落盘）。
 *
 * 与迁移前的桥接写入格式逐字一致：
 *   dependencies[name] = `link:<绝对路径>`（反斜杠统一转正斜杠）
 *   dsh.profile.bundles 去重追加（顺序保持既有，追加在末尾）
 *
 * @returns {{pkg:object, changed:boolean, dependency:string, bundleAdded:boolean}}
 */
export function patchProfilePackage(pkg, { name, linkDir }) {
  const base = pkg && typeof pkg === 'object' && !Array.isArray(pkg) ? pkg : {};
  const next = { ...base };
  next.dependencies = { ...(base.dependencies && typeof base.dependencies === 'object' && !Array.isArray(base.dependencies) ? base.dependencies : {}) };
  const dsh = base.dsh && typeof base.dsh === 'object' && !Array.isArray(base.dsh) ? { ...base.dsh } : {};
  const profileSection = dsh.profile && typeof dsh.profile === 'object' && !Array.isArray(dsh.profile) ? { ...dsh.profile } : {};
  const bundles = Array.isArray(profileSection.bundles) ? [...profileSection.bundles] : [];

  const dependency = `link:${String(linkDir).replace(/\\/g, '/')}`;
  const depChanged = next.dependencies[name] !== dependency;
  if (depChanged) next.dependencies[name] = dependency;

  let bundleAdded = false;
  if (!bundles.includes(name)) {
    bundles.push(name);
    bundleAdded = true;
  }
  profileSection.bundles = bundles;
  dsh.profile = profileSection;
  next.dsh = dsh;

  return { pkg: next, changed: depChanged || bundleAdded, dependency, bundleAdded };
}

/** 序列化回磁盘的文本形态（2 空格缩进 + 末尾换行，与 DSH 自身写出的格式一致）。 */
export function serializeProfilePackage(pkg) {
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * `dsh plugin --profile <p> install` 的 spawn 参数。
 *
 * Windows 上 Node 不能直接 spawn `dsh.cmd`，必须经 cmd.exe；profile 已过白名单校验，
 * 可以直接插值（迁移前的桥接用环境变量传递，这里用正则校验达到同等安全性）。
 */
export function pluginInstallCommand({ profile = DEFAULT_PROFILE, platform = process.platform, comspec, dshBin } = {}) {
  assertProfile(profile);
  // dsh 不一定在 PATH 上（本机就是这种情况：只有 C:\DeepSeekHarness\bin\dsh.cmd）。
  const bin = String(dshBin || process.env.DSH_BIN || 'dsh').trim();
  if (platform === 'win32') {
    const quoted = /\s/.test(bin) ? `"${bin}"` : bin;
    return {
      command: comspec || process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', `${quoted} plugin --profile "${profile}" install`],
      options: { windowsVerbatimArguments: true, windowsHide: true },
    };
  }
  return { command: bin, args: ['plugin', '--profile', profile, 'install'], options: { windowsHide: true } };
}
