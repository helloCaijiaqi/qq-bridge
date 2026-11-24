// gateway.json 热加载监视器专项（消费端语义）：缺失/非法时**保留最后有效凭据**
// 而不是摘除——桥接不自断身份，撑到新文件出现后 rotate 自动换线。
// 全离线（临时目录 + refresh 手动驱动，不依赖真实轮询时钟）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createGatewayWatcher } = await import(new URL('../src/gateway/gateway-watch.js', import.meta.url).href);
const { gatewayConfigPath } = await import(new URL('../src/core/gateway-config.js', import.meta.url).href);

const SECRET = 'c'.repeat(32);

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-gwwatch-'));
}

function writeGateway(root, doc) {
  fs.writeFileSync(gatewayConfigPath(root), JSON.stringify(doc, null, 2) + '\n');
}

const baseDoc = (extra = {}) => ({
  v: 1, id: 'qq-main', kind: 'adapter', url: 'http://127.0.0.1:7190', transport: 'auto', ...extra,
});

test('watcher 生命周期：缺失→出现→换密钥→非法（保留旧凭据）→修复→删除（保留旧凭据）', () => {
  const root = tmpRoot();
  const logs = [];
  const rotations = [];
  const w = createGatewayWatcher({
    root,
    logger: (m) => logs.push(m),
    onChange: (config) => rotations.push(config.adapterId),
  });
  try {
    // 初始缺失：config=null（桥接启动路径自己负责「无凭据即失败」，watcher 只观测）。
    assert.equal(w.current().config, null);
    assert.equal(w.current().error, null);
    assert.equal(w.current().stale, false);

    // 出现 → 生效（初始加载不触发 onChange）。
    writeGateway(root, baseDoc({ secret: SECRET }));
    w.refresh();
    assert.equal(w.current().config.adapterId, 'qq-main');
    assert.equal(w.current().config.secret, SECRET);
    assert.deepEqual(rotations, [], '初始加载不触发 onChange');

    // 换密钥重写 → 新凭据 + onChange 触发。
    writeGateway(root, baseDoc({ id: 'svc-new', secret: 'd'.repeat(32) }));
    w.refresh();
    assert.equal(w.current().config.adapterId, 'svc-new');
    assert.equal(w.current().config.secret, 'd'.repeat(32));
    assert.deepEqual(rotations, ['svc-new'], '变更触发 onChange（rotate 的入口）');
    assert.equal(w.current().stale, false);

    // 非法（id 大写）→ 保留最后有效凭据 + stale 标记 + 告警。
    writeGateway(root, baseDoc({ id: 'Svc New', secret: 'd'.repeat(32) }));
    w.refresh();
    assert.equal(w.current().config.adapterId, 'svc-new', '非法文件不覆盖旧凭据');
    assert.match(w.current().error, /不合法/);
    assert.equal(w.current().stale, true, 'stale 标记：凭据可能已失效');
    assert.deepEqual(rotations, ['svc-new'], '非法不触发 onChange');

    // 修复 → 自动恢复生效（再次 onChange）。
    writeGateway(root, baseDoc({ id: 'svc-fixed', secret: 'e'.repeat(32) }));
    w.refresh();
    assert.equal(w.current().config.adapterId, 'svc-fixed');
    assert.equal(w.current().stale, false);
    assert.deepEqual(rotations, ['svc-new', 'svc-fixed']);

    // 删除 → 保留最后有效凭据 + stale。
    fs.unlinkSync(gatewayConfigPath(root));
    w.refresh();
    assert.equal(w.current().config.adapterId, 'svc-fixed', '删除不摘除消费端身份');
    assert.match(w.current().error, /已移除/);
    assert.equal(w.current().stale, true);

    // 关键事件全部留痕。
    assert.ok(logs.some((m) => /已加载/.test(m)), '初始加载有日志');
    assert.ok(logs.some((m) => /热轮换/.test(m) && /无需重启/.test(m)), '变更有日志');
    assert.ok(logs.some((m) => /非法，保留最后有效凭据/.test(m)), '非法保留有日志');
    assert.ok(logs.some((m) => /已移除：保留最后有效凭据/.test(m)), '删除保留有日志');
  } finally {
    w.stop();
  }
});

test('watcher 幂等：内容未变的重复 refresh 不重复触发 onChange/日志', () => {
  const root = tmpRoot();
  const logs = [];
  const rotations = [];
  const w = createGatewayWatcher({ root, logger: (m) => logs.push(m), onChange: (c) => rotations.push(c.adapterId) });
  try {
    writeGateway(root, baseDoc({ secret: SECRET }));
    w.refresh();
    assert.equal(w.current().config.adapterId, 'qq-main');
    const logged = logs.length;
    w.refresh();
    w.refresh();
    assert.equal(logs.length, logged, '内容未变不产生新日志');
    assert.deepEqual(rotations, [], '内容未变不触发 onChange');
  } finally {
    w.stop();
  }
});
