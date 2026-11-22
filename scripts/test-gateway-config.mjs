// gateway.json 读取器/迁移的专项测试。
//
// 覆盖的是「配置来源换了」这件事最容易出错的几处：相对路径解析、密钥优先级、
// 迁移只做一次、迁移后 config.json 的其它键原样保留、以及每个失败分支的报错
// 能不能直接指向可操作的动作（否则运维只能猜）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {
  GATEWAY_CONFIG_FILE, gatewayConfigPath, loadGatewayConfig, migrateLegacyGatewaySection,
} = await import(new URL('../src/core/gateway-config.js', import.meta.url).href);

const SECRET = 'a'.repeat(32);

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-gwcfg-'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeGateway(root, doc) {
  writeJson(gatewayConfigPath(root), doc);
}

function baseDoc(extra = {}) {
  return { v: 1, id: 'qq-main', kind: 'adapter', url: 'http://127.0.0.1:7190', transport: 'auto', ...extra };
}

test('读取：secretFile 相对路径按 gateway.json 所在目录解析', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'secrets', 'qq-main.secret'), `${SECRET}\n`);
  writeGateway(root, baseDoc({ secretFile: 'secrets/qq-main.secret' }));

  const cfg = loadGatewayConfig({ root });
  assert.equal(cfg.url, 'http://127.0.0.1:7190');
  assert.equal(cfg.adapterId, 'qq-main');
  assert.equal(cfg.platform, 'qq');
  assert.equal(cfg.transport, 'auto');
  assert.equal(cfg.secret, SECRET, '文件里的换行要 trim 掉');
  assert.equal(cfg.auth, 'secretFile');
  assert.equal(cfg.secretFile, path.join(root, 'secrets', 'qq-main.secret'));
  assert.equal(cfg.file, gatewayConfigPath(root));
});

test('读取：内联 secret 可用；与 secretFile 并存时以文件为准并告警', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'secrets', 'k.secret'), `${SECRET}\n`);
  writeGateway(root, baseDoc({ secret: 'b'.repeat(32) }));
  const inline = loadGatewayConfig({ root });
  assert.equal(inline.auth, 'inline');
  assert.equal(inline.secret, 'b'.repeat(32));

  writeGateway(root, baseDoc({ secret: 'b'.repeat(32), secretFile: 'secrets/k.secret' }));
  const warnings = [];
  const both = loadGatewayConfig({ root, logger: (msg) => warnings.push(msg) });
  assert.equal(both.auth, 'secretFile');
  assert.equal(both.secret, SECRET);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /以 secretFile 为准/);
});

test('读取：失败分支都给出可操作原因', () => {
  const root = tmpRoot();
  assert.throws(() => loadGatewayConfig({ root }), /缺少 .*gateway\.json[\s\S]*secrets:gen/);

  writeGateway(root, baseDoc({ v: 2 }));
  assert.throws(() => loadGatewayConfig({ root }), /v=2 不受支持/);

  writeGateway(root, baseDoc({ id: 'QQ Main' }));
  assert.throws(() => loadGatewayConfig({ root }), /id="QQ Main" 不合法/);

  writeGateway(root, baseDoc({ url: 'ftp://127.0.0.1' }));
  assert.throws(() => loadGatewayConfig({ root }), /url 只支持 http\/https/);

  writeGateway(root, baseDoc({ transport: 'carrier-pigeon' }));
  assert.throws(() => loadGatewayConfig({ root }), /transport="carrier-pigeon" 不合法/);

  writeGateway(root, baseDoc({ secretFile: 'secrets/missing.secret' }));
  assert.throws(() => loadGatewayConfig({ root }), /secretFile 无法读取[\s\S]*missing\.secret/);

  writeGateway(root, baseDoc({ secret: 'short' }));
  assert.throws(() => loadGatewayConfig({ root }), /secret 太短/);

  writeGateway(root, baseDoc());
  assert.throws(() => loadGatewayConfig({ root }), /没有密钥/);

  // BOM：Windows 编辑器常带，不能因此判非法 JSON。
  fs.writeFileSync(gatewayConfigPath(root), `\uFEFF${JSON.stringify(baseDoc({ secret: SECRET }))}`);
  assert.equal(loadGatewayConfig({ root }).secret, SECRET);
});

test('读取：mode/state 原样透传（P4 镜像开关不能被吞）', () => {
  const root = tmpRoot();
  writeGateway(root, baseDoc({ secret: SECRET, mode: 'on', state: 'on' }));
  const cfg = loadGatewayConfig({ root });
  assert.equal(cfg.mode, 'on');
  assert.equal(cfg.state, 'on');
});

test('迁移：config.json 的 gateway 段搬到 gateway.json，其余键一字不动', () => {
  const root = tmpRoot();
  const configFile = path.join(root, 'config.json');
  writeJson(configFile, {
    ownerQQ: 123,
    allow: { private: ['123'] },
    socialV2: { enabled: true },
    gateway: {
      url: 'http://127.0.0.1:7190',
      adapterId: 'qq-main',
      platform: 'qq',
      secret: SECRET,
      mode: 'on',
      state: 'on',
      // 已废弃的回滚开关：不迁移，但要有告警。
      delivery: 'gateway',
      conversations: ['qq:group:1'],
    },
  });

  const logs = [];
  const result = migrateLegacyGatewaySection({ root, writeJson: writeJson, logger: (m) => logs.push(m) });
  assert.equal(result.migrated, true);
  assert.equal(result.file, gatewayConfigPath(root));

  const doc = readJson(gatewayConfigPath(root));
  assert.equal(doc.v, 1);
  assert.equal(doc.id, 'qq-main');
  assert.equal(doc.url, 'http://127.0.0.1:7190');
  assert.equal(doc.secret, SECRET);
  assert.equal('adapterId' in doc, false, 'v1 用 id，不再有 adapterId');
  assert.equal(doc.mode, 'on');
  assert.equal(doc.state, 'on');
  assert.equal('delivery' in doc, false);
  assert.equal('conversations' in doc, false);
  assert.ok(logs.some((m) => /已把 config.json 的 gateway 段迁移/.test(m)));
  assert.ok(logs.some((m) => /delivery \/ conversations/.test(m)), '废弃键要告警');

  const rest = readJson(configFile);
  assert.equal('gateway' in rest, false);
  assert.equal(rest.ownerQQ, 123);
  assert.deepEqual(rest.allow, { private: ['123'] });
  assert.equal(rest.socialV2.enabled, true);

  // 二次启动：迁移是幂等的（config.json 已无该段 → 直接走读取）。
  assert.deepEqual(migrateLegacyGatewaySection({ root, writeJson }), { migrated: false, file: null });
  assert.equal(loadGatewayConfig({ root }).secret, SECRET);
});

test('迁移：两处同时存在时拒绝启动，并说明删哪一段', () => {
  const root = tmpRoot();
  writeJson(path.join(root, 'config.json'), { ownerQQ: 1, gateway: { adapterId: 'qq-main', secret: SECRET } });
  writeJson(gatewayConfigPath(root), baseDoc({ secret: SECRET }));
  assert.throws(
    () => migrateLegacyGatewaySection({ root, writeJson }),
    /仍有 gateway 段[\s\S]*删除 config\.json 中的 "gateway" 段/,
  );
});

test('迁移：无 config.json / 无 gateway 段时不做任何事', () => {
  const root = tmpRoot();
  assert.deepEqual(migrateLegacyGatewaySection({ root, writeJson }), { migrated: false, file: null });
  writeJson(path.join(root, 'config.json'), { ownerQQ: 1 });
  assert.deepEqual(migrateLegacyGatewaySection({ root, writeJson }), { migrated: false, file: null });
  assert.equal(fs.existsSync(gatewayConfigPath(root)), false);
});

test('文件名常量：消费方与文档必须一致', () => {
  assert.equal(GATEWAY_CONFIG_FILE, 'gateway.json');
  assert.equal(path.basename(gatewayConfigPath('/x/y')), 'gateway.json');
  // 自检：本文件的路径拼接不依赖 cwd（用 import.meta 解析依赖）。
  assert.ok(fileURLToPath(import.meta.url).endsWith('test-gateway-config.mjs'));
});
