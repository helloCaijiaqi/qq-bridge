#!/usr/bin/env node
/**
 * CLI 薄壳：把 `dsh/<平台>/agent-presets/<preset>/` 渲染成 DSH 侧的
 * `<DSH_HOME>/plugins/<bundle>/presets/*.patch.yml`（生成物不落仓库）。
 *
 * 转换逻辑（行校验、守卫说明符改写、YAML 渲染、陈旧清理）都在
 * scripts/lib/preset-patches.mjs（渲染逻辑与安装脚本共用）
 * ）。
 *
 * 用法：
 *   node scripts/build-agent-preset-patches.mjs                     # 生成/刷新 DSH 侧 patch
 *   node scripts/build-agent-preset-patches.mjs --check             # 只校验产物与源一致（不一致 exit 1）
 *   node scripts/build-agent-preset-patches.mjs --out <dir>         # 指定输出目录（测试/一次性渲染）
 *   node scripts/build-agent-preset-patches.mjs --platform qq       # 只处理某个平台（默认全部）
 *   node scripts/build-agent-preset-patches.mjs --repo-root <p>     # 测试用：对临时仓执行
 *
 * 何时需要跑：
 *   - 改了 dsh/<平台>/agent-presets/<preset>/agent.cordis.yml 或 preset.yml（install:preset 也会自动跑一次）
 *   - 改完想确认 DSH 侧产物是否最新（--check）
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const mod = await import(new URL('./lib/preset-patches.mjs', import.meta.url).href);
const { REPO_ROOT, buildPatches, presetTargets, listStalePatches, presetsOutDir } = mod;

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const repoRoot = flagValue('--repo-root') ? path.resolve(flagValue('--repo-root')) : REPO_ROOT;
const outDir = flagValue('--out') ? path.resolve(flagValue('--out')) : undefined;
const platform = flagValue('--platform');

const known = presetTargets().map((t) => t.platform);
const platforms = platform ? [platform] : known;
for (const p of platforms) {
  if (!known.includes(p)) {
    console.error(`[preset-patches] ERROR: 未登记的平台 "${p}"（已知：${known.join(', ')}）`);
    process.exit(1);
  }
}

const results = buildPatches({
  check,
  repoRoot,
  outDir,
  platforms,
  log: (line) => console.log(`[preset-patches] ${line}`),
});

// 陈旧产物只在「非 --check 且非自定义 outDir」时清理：--check 是只读模式，
// 自定义 outDir 可能是测试目录，不该被顺手删文件。
const removed = [];
if (!check && !outDir) {
  for (const p of platforms) {
    const dir = presetsOutDir({ platform: p });
    for (const file of listStalePatches({ platform: p, outDir: dir })) {
      fs.rmSync(file, { force: true });
      removed.push(file);
      console.log(`[preset-patches] ✓ 已清理陈旧产物 ${path.basename(file)}`);
    }
  }
}

const drifted = results.filter((r) => r.changed);
if (check && drifted.length > 0) {
  console.error(`[preset-patches] ERROR: ${drifted.length} 个 patch 与源不一致；请运行 node scripts/build-agent-preset-patches.mjs`);
  for (const item of drifted) console.error(`  - ${item.name}（${item.platform}）${item.file}`);
  process.exit(1);
}

console.log('[preset-patches] Done');
