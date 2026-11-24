// setup-driver（monorepo 整合 2026-11-23）：校验 driver/runtime 完整性与版本记录一致性。
// EULA §5.4：本脚本只做**只读校验**，不复制、不下载、不部署——vendor 落位始终是人工一次性移动。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const driverRoot = path.join(repoRoot, 'driver');
const runtimeRoot = path.join(driverRoot, 'runtime');

const REQUIRED_RUNTIME = [
  'index.mjs',
  'package.json',
  'config-DL6USbGZ.js',
  'logger-BAozzyTt.js',
  'server-CQbxumin.js',
  'utils-tSVKpzEf.js',
];
const REQUIRED_DRIVER = ['EULA.md', 'PRIVACY.md', 'check-node-version.cjs', 'README.md'];
// 2026-11-23 实测：SnowLuma 按「bundle 同级」定位运行态——config/data/logs 在 runtime/ 内
const REQUIRED_DIRS = ['native', 'client', 'runtime/config', 'runtime/data', 'runtime/logs'];

let fail = 0;
const ok = (name) => console.log('  OK ' + name);
const ng = (name) => { fail++; console.log('  NG ' + name); };

console.log('driver 校验：' + driverRoot);
for (const rel of REQUIRED_RUNTIME) {
  (fs.existsSync(path.join(runtimeRoot, rel)) ? ok : ng)('runtime/' + rel);
}
for (const rel of REQUIRED_DRIVER) {
  (fs.existsSync(path.join(driverRoot, rel)) ? ok : ng)(rel);
}
for (const dir of REQUIRED_DIRS) {
  (fs.existsSync(path.join(runtimeRoot, dir)) || fs.existsSync(path.join(driverRoot, dir)) ? ok : ng)(dir + '/');
}

// 版本记录一致性：runtime/package.json 的 name+version 必须出现在 driver/README.md
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(driverRoot, 'README.md'), 'utf8');
  const ver = String(pkg.version ?? '');
  const name = String(pkg.name ?? '');
  if (name && readme.includes(name) && ver && readme.includes(ver)) ok('README 版本记录含 ' + name + '@' + ver);
  else ng('README 版本记录与 runtime/package.json 不一致（期望 ' + name + '@' + ver + '）');
} catch (e) {
  ng('版本核对失败：' + (e?.message ?? e));
}

// EULA 在位（合规要求：vendor 迁移必须随 EULA）
(fs.existsSync(path.join(driverRoot, 'EULA.md')) ? ok : ng)('EULA.md 在位（§5.4 合规）');

console.log(fail === 0 ? 'driver 校验通过' : 'driver 校验失败：' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
