// src 目录结构守卫（2026-11 按功能域归类后的防回退闸门）。
//
// 约束：
//   1. src 顶层只允许入口 bridge.js；其余模块必须落在功能子目录里；
//   2. 子目录只允许 core / gateway / integrations / chat / media / ops / shared；
//      （mcp 已随自带 MCP server 退役，若再出现会被这里拦下）
//   3. 每个子目录至少有可执行模块；
//   4. 所有相对 import（含动态 import）都能解析到真实文件——移动文件后最常见的
//      失败形态就是"路径改了一半"，而它只会在运行期才炸。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const ALLOWED_DIRS = ['core', 'gateway', 'integrations', 'chat', 'media', 'ops', 'shared'];
const ALLOWED_FILES = new Set(['bridge.js']);

let failed = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`✅ ${label}`);
  } else {
    console.error(`❌ ${label}`);
    failed += 1;
  }
}

const entries = fs.readdirSync(SRC, { withFileTypes: true });
const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();

for (const name of files) {
  assert(ALLOWED_FILES.has(name), `顶层文件 ${name} 在允许清单内`);
}
for (const name of dirs) {
  assert(ALLOWED_DIRS.includes(name), `顶层目录 ${name} 在允许清单内`);
}
for (const name of ALLOWED_DIRS) {
  assert(dirs.includes(name), `存在 src/${name}/`);
  if (!dirs.includes(name)) continue;
  const count = fs.readdirSync(path.join(SRC, name)).filter((n) => /\.(js|mjs)$/.test(n)).length;
  assert(count > 0, `src/${name}/ 含可执行模块（${count} 个）`);
}

// 相对 import 解析：`from './x.js'`、`import('./x.js')` 都算。
const broken = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(target);
      continue;
    }
    if (!/\.(js|mjs)$/.test(entry.name)) continue;
    const text = fs.readFileSync(target, 'utf8');
    for (const match of text.matchAll(/(?:from\s+|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const spec = match[1].split('?')[0];
      if (!fs.existsSync(path.resolve(path.dirname(target), spec))) {
        broken.push(`${path.relative(ROOT, target)} -> ${match[1]}`);
      }
    }
  }
})(SRC);
assert(broken.length === 0, `相对 import 必须可解析${broken.length ? `（${broken.join('; ')}）` : ''}`);

if (failed > 0) {
  console.error(`\n❌ src 目录结构守卫失败：${failed} 项`);
  process.exit(1);
}
console.log('\n🎉 src 目录结构守卫通过');
