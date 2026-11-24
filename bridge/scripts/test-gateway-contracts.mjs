// agent-gateway 的契约测试已随 P0 抽包移到兄弟仓库：
//   ../agent-gateway/scripts/test-gateway-contracts.mjs
// 那份测试包含「网关侧鉴权 ↔ 本仓库 src/gateway/gateway-client.js 适配器侧客户端」的
// 签名互认段，所以本仓库的审计套件必须把它带上——否则任何一侧单独改签名
// 格式都不会被发现。
//
// 这里只做转发：保持 test:audit 的目录约定（scripts/ 下的单文件入口），
// 同时让测试的归属与实现的归属一致。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// 2026-11-23 monorepo：本脚本随包迁入 bridge/ 子目录，兄弟仓 agent-gateway 需多上一层。
const pkgDir = path.resolve(root, '..', '..', 'agent-gateway');

const result = spawnSync(process.execPath, ['--test', 'scripts/test-gateway-contracts.mjs', 'scripts/test-executor-contract.mjs', 'scripts/test-runtime-turn.mjs', 'scripts/test-context-assembler.mjs', 'scripts/test-adapter-conformance.mjs', 'scripts/test-layering.mjs', 'scripts/test-actions-manifest.mjs', 'scripts/test-qq-tools.mjs', 'scripts/test-web-search.mjs'], {
  cwd: pkgDir,
  stdio: 'inherit',
  timeout: 120000,
  env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
});
if (result.error) {
  console.error(`FAILED to spawn agent-gateway test suite: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`FAILED agent-gateway test suite: exit ${result.status}`);
  process.exit(result.status ?? 1);
}
