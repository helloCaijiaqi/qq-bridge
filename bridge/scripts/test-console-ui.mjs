#!/usr/bin/env node
/** Real-browser tests against an isolated fixture. Never starts qq-bridge or sends real messages. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startConsoleFixture } from './console-ui-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const artifacts = args.find(x => x.startsWith('--artifacts='))?.slice('--artifacts='.length);
const views = ['overview', 'access', 'operations', 'reference'];
const pinnedIds = JSON.parse((await readFile(join(here, 'console-ui-legacy-ids.json'), 'utf8')).replace(/^\uFEFF/, ''));
const baselinePath = join(here, 'console-ui-contracts.json');

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean)) {
    try { return require(candidate); } catch {}
  }
  throw new Error('Playwright not found. Install with npm install --no-save playwright, or set PLAYWRIGHT_MODULE to its package directory.');
}

const { chromium } = await loadPlaywright();
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
  join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
].find(x => existsSync(x));
const fixture = await startConsoleFixture({});
let browser;
const results = [];
const errors = [];
const blockedRequests = [];
async function test(name, fn) {
  const start = Date.now();
  try { await fn(); results.push({ name, ok: true, durationMs: Date.now() - start }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.message, durationMs: Date.now() - start }); console.error(`FAIL ${name}: ${error.message}`); }
}

try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  // Even if a future console accidentally references an external endpoint, tests cannot reach it.
  await context.route('**/*', async route => {
    const requested = new URL(route.request().url());
    if (requested.origin === fixture.url) return route.continue();
    blockedRequests.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(fixture.url);
  await page.waitForFunction(() => document.getElementById('wlGroups')?.value.includes('123456789') && document.getElementById('v2Enabled')?.checked === true);

  async function navigate(view) {
    if (await page.locator(`[data-page="${view}"]:visible`).count()) return;
    const nav = page.locator(`[data-view="${view}"]`).first();
    if (!await nav.isVisible()) {
      const toggle = page.locator('#navToggle, [data-nav-toggle], [aria-controls="sidebar"], button[aria-label*="导航"]').first();
      if (await toggle.count()) await toggle.click();
    }
    await nav.click();
  }
  async function reveal(selector) {
    const target = page.locator(selector).first();
    const view = await target.evaluate(el => el.closest('[data-page]')?.dataset.page);
    if (view) await navigate(view);
    for (const details of await target.locator('xpath=ancestor::details').all()) {
      if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
    }
    return target;
  }
  async function fill(id, value) { await (await reveal(`#${id}`)).fill(String(value)); }
  async function check(id, checked) { await (await reveal(`#${id}`)).setChecked(checked); }
  async function clickWrite(selector, path, method = 'POST') {
    const target = await reveal(selector);
    const [response] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === method),
      target.click(),
    ]);
    assert.equal(response.status(), 200, `${method} ${path} should succeed`);
    assert.equal((await response.json()).ok, true);
    return fixture.requests.at(-1)?.body;
  }

  await test(`All ${pinnedIds.length} pinned IDs remain present and every DOM ID is unique`, async () => {
    const ids = await page.locator('[id]').evaluateAll(nodes => nodes.map(x => x.id));
    assert.deepEqual(pinnedIds.filter(x => !ids.includes(x)), []);
    assert.equal(new Set(ids).size, ids.length, 'Duplicate DOM IDs detected');
  });

  await test('All four navigation destinations work and preserve unsaved form values across polling', async () => {
    for (const view of views) {
      await navigate(view);
      const visiblePages = await page.locator('[data-page]').evaluateAll(nodes => nodes.filter(x => x.getClientRects().length && getComputedStyle(x).visibility !== 'hidden').map(x => x.dataset.page));
      assert(visiblePages.length > 0, `${view} has no visible content`);
      assert(visiblePages.every(x => x === view), `${view} exposes another page: ${visiblePages.join(', ')}`);
    }
    const drafts = { wlGroups: '100001, 100002', tsMsg: '未发送的测试消息' };
    for (const [id, value] of Object.entries(drafts)) await fill(id, value);
    await navigate('overview');
    await page.waitForTimeout(3300); // Exercise the real 3-second status polling interval.
    for (const [id, value] of Object.entries(drafts)) assert.equal(await (await reveal(`#${id}`)).inputValue(), value, `${id} lost its draft`);
    // Restore fixture defaults so the payload baseline remains deterministic.
    await page.reload();
    await page.waitForFunction(() => document.getElementById('wlGroups')?.value.includes('123456789'));
  });

  await test('Whitelist numeric parsing and security contracts', async () => {
    for (const [id, value] of Object.entries({ wlGroups: '123456789，100003', wlPrivate: '100001 100002', dnGroups: '800001,800002', dnPrivate: '900001', ownerQQ: '100001' })) await fill(id, value);
    assert.deepEqual(await clickWrite('#wlSave', '/api/whitelist'), { allow: { private: [100001, 100002], groups: [123456789, 100003] }, deny: { private: [900001], groups: [800001, 800002] }, ownerQQ: '100001' });
    await check('secInterceptNotify', false);
    assert.deepEqual(await clickWrite('#secSave', '/api/security'), { interceptNotify: false });
  });

  // state/ 的 ACL 收紧需要管理员权限，未提权时桥接会明确报告 hardened:false。
  // 控制台必须把这件事**显式**呈现（含可复制的提权命令），而不是让用户以为已经安全；
  // 用户按提示处理后点「重新检测」应当转为成功态。
  await test('Unhardened state directory surfaces a warning with the exact command', async () => {
    await navigate('access');
    await page.waitForFunction(() => document.getElementById('stateDirWarn')?.style.display !== 'none');
    const shown = await page.evaluate(() => ({
      path: document.getElementById('stateDirPath').textContent,
      cmd: document.getElementById('stateDirCmd').textContent,
    }));
    assert.match(shown.path, /state/, '应当显示 state 目录路径');
    assert.match(shown.cmd, /icacls/, '应当给出可复制的提权命令');
    await page.waitForFunction(() => document.getElementById('stateDirReharden') !== null);
    const [request] = await Promise.all([
      page.waitForRequest(r => new URL(r.url()).pathname === '/api/security' && r.method() === 'POST'),
      page.click('#stateDirReharden'),
    ]);
    assert.deepEqual(JSON.parse(request.postData() || '{}'), { rehardenStateDir: true });
    await page.waitForFunction(() => document.getElementById('stateDirWarn')?.style.display === 'none');
  });

  await test('Second-generation complete save payload, units, zero values and tool switches', async () => {
    await fill('v2RecSleepMin', 7);
    await fill('v2SleepMinMs', 42);
    await fill('v2PreSleepWaitMin', 0);
    await fill('v2RecProb', 0);
    await fill('v2RecKeywords', '鲸鱼，DeepSeek, 测试');
    await fill('v2AutoReplyCheckSec', 17);
    await fill('v2WaitDefaultQuietMs', 0);
    await fill('v2MaxSendMin', 0);
    await check('v2ProvideRecommendations', false);
    const firstTool = page.locator('[data-v2-tool]').first();
    await reveal('[data-v2-tool]');
    await firstTool.setChecked(false);
    const body = await clickWrite('#v2ConfigSaveTop', '/api/socialV2/config');
    assert.equal(body.wake.recommendedSleepMinMs, 420000);
    assert.equal(body.wake.sleepMinMs, 42000);
    assert.equal(body.wake.preSleepWaitMs, 0);
    assert.equal(body.wake.recommendedProbability, 0);
    assert.deepEqual(body.wake.recommendedKeywords, ['鲸鱼', 'DeepSeek', '测试']);
    assert.equal(body.autoReplyCheckMs, 17000);
    assert.equal(body.wait.defaultQuietMs, 0);
    assert.equal(body.send.maxSendPerMinute, 0);
    assert.equal(body.provideRecommendations, false);
    assert.equal(body.tools[await firstTool.getAttribute('data-v2-tool')], false);
    // The lower save button must submit the same complete configuration.
    assert.deepEqual(await clickWrite('#v2ConfigSave', '/api/socialV2/config'), body);
    assert.deepEqual(await clickWrite('#v2PauseBtn', '/api/socialV2/activity'), { paused: true });
    assert.deepEqual(await clickWrite('#v2ResumeBtn', '/api/socialV2/activity'), { paused: false });
  });

  await test('Voice debug panel loads the library and dry-run validates without sending', async () => {
    await navigate('operations');
    await page.waitForFunction(() => document.getElementById('voiceList')?.textContent.includes('演示-问候'));
    await fill('voiceSendTarget', 'group:123456789');
    await check('voiceSendDryRun', true);
    const body = await clickWrite('#voiceSendBtn', '/api/voice/send');
    assert.equal(body.dryRun, true);
    assert.equal(body.file, '演示-问候.mp3');
  });

  await test('Test message reaches only the mock endpoint', async () => {
    await (await reveal('#tsKind')).selectOption('group');
    await fill('tsId', '123456789');
    await fill('tsMsg', '离线测试，不会发往 QQ。');
    assert.deepEqual(await clickWrite('#tsSend', '/api/test-send'), { kind: 'group', id: '123456789', message: '离线测试，不会发往 QQ。' });
  });

  // 基线从「逐字节载荷」改为「端点 × 次数」：载荷契约已由上面每个 clickWrite 的
  // deepEqual 钉死，这里只保证控制台不会**多出**任何未预期的写请求（数量与端点对账）。
  await test('Submitted writes exactly match the expected endpoint counts', async () => {
    const expected = JSON.parse(await readFile(baselinePath, 'utf8')).counts;
    const actual = {};
    for (const r of fixture.requests) {
      const key = `${r.method} ${r.path}`;
      actual[key] = (actual[key] || 0) + 1;
    }
    assert.deepEqual(actual, expected);
  });

  await test('Mobile and tablet layouts have no document-level horizontal overflow', async () => {
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      for (const view of views) {
        await navigate(view);
        const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
        assert(dimensions.document <= dimensions.viewport + 1, `${width}px / ${view}: ${JSON.stringify(dimensions)}`);
        if (artifacts && width === 390 && ['overview', 'operations'].includes(view)) {
          await mkdir(resolve(artifacts), { recursive: true });
          await page.screenshot({ path: resolve(artifacts, `mobile-${view}.png`), fullPage: true, animations: 'disabled' });
        }
      }
    }
  });

  await test('Dark mode toggles, persists across reload and stays overflow-free', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const snapshot = () => page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      stored: localStorage.getItem('qq-console-theme'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      text: getComputedStyle(document.body).color,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      toggle: document.getElementById('themeToggle').getAttribute('aria-pressed'),
    }));
    const light = await snapshot();
    assert.equal(light.theme, 'light', '测试环境系统偏好为浅色，默认应为浅色');
    await page.locator('#themeToggle').click();
    const dark = await snapshot();
    assert.equal(dark.theme, 'dark');
    assert.equal(dark.stored, 'dark', '主题选择需要写入 localStorage');
    assert.equal(dark.toggle, 'true', 'aria-pressed 需要反映当前主题');
    assert.equal(dark.scheme, 'dark', 'color-scheme 需同步，滚动条与表单控件才会跟随');
    assert.notEqual(dark.bodyBg, light.bodyBg, 'body 背景色必须真的改变');
    assert.notEqual(dark.text, light.text, '正文颜色必须真的改变');
    const ratio = await page.evaluate(() => {
      const parse = value => value.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number);
      const luminance = rgb => { const [r, g, b] = rgb.map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const background = luminance(parse(getComputedStyle(document.body).backgroundColor));
      const heading = luminance(parse(getComputedStyle(document.querySelector('h1')).color));
      return (Math.max(background, heading) + 0.05) / (Math.min(background, heading) + 0.05);
    });
    assert(ratio >= 7, `深色下标题与背景对比度不足：${ratio.toFixed(2)}`);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('statusText')?.textContent !== '正在连接…');
    assert.equal((await snapshot()).theme, 'dark', '刷新后应保持深色');
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
      assert(dimensions.document <= dimensions.viewport + 1, `深色 ${width}px 出现横向溢出：${JSON.stringify(dimensions)}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#themeToggle').click();
    assert.equal((await snapshot()).theme, 'light', '应能切回浅色');
  });

  await test('Console follows the system preference when no theme was chosen', async () => {
    const systemDark = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', serviceWorkers: 'block' });
    await systemDark.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort('blockedbyclient'));
    const systemPage = await systemDark.newPage();
    systemPage.on('pageerror', error => errors.push(error.message));
    await systemPage.goto(fixture.url);
    await systemPage.waitForFunction(() => document.getElementById('statusText')?.textContent !== '正在连接…');
    assert.equal(await systemPage.evaluate(() => document.documentElement.dataset.theme), 'dark', '系统偏好深色时应默认深色');
    await systemDark.close();
  });

  await test('Reduced-motion preference disables decorative motion', async () => {
    const calm = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await calm.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort('blockedbyclient'));
    const calmPage = await calm.newPage();
    calmPage.on('pageerror', error => errors.push(error.message));
    await calmPage.goto(fixture.url);
    await calmPage.waitForFunction(() => document.getElementById('statusText')?.textContent !== '正在连接…');
    const motion = await calmPage.evaluate(() => ({
      decor: getComputedStyle(document.querySelector('.bg-decor'), '::before').animationName,
      page: getComputedStyle(document.querySelector('[data-page="overview"]')).animationName,
      transition: getComputedStyle(document.querySelector('button')).transitionDuration,
    }));
    assert.equal(motion.decor, 'none', '背景动效应在 reduced-motion 下关闭');
    assert.equal(motion.page, 'none', '页面切换动画应在 reduced-motion 下关闭');
    assert.equal(motion.transition, '0s', '过渡应在 reduced-motion 下关闭');
    await calm.close();
  });

  if (artifacts) {
    await mkdir(resolve(artifacts), { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const view of views) {
      await navigate(view);
      await page.screenshot({ path: resolve(artifacts, `desktop-${view}.png`), fullPage: true, animations: 'disabled' });
    }
    await page.locator('#themeToggle').click();
    for (const view of ['overview', 'operations']) {
      await navigate(view);
      await page.screenshot({ path: resolve(artifacts, `dark-${view}.png`), fullPage: true, animations: 'disabled' });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await navigate('overview');
    await page.screenshot({ path: resolve(artifacts, 'dark-mobile-overview.png'), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#themeToggle').click();
  }
  await test('No JavaScript errors, unknown API routes or external requests', async () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(fixture.unknownRequests, []);
    assert.deepEqual(blockedRequests, []);
  });
} finally {
  if (browser) await browser.close();
  await fixture.close();
  if (artifacts) {
    await mkdir(resolve(artifacts), { recursive: true });
    await writeFile(resolve(artifacts, 'test-results.json'), JSON.stringify({ results, requests: fixture.requests, errors, blockedRequests }, null, 2) + '\n');
  }
}
const failed = results.filter(x => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; ${fixture.requests.length} isolated mock writes.`);
if (failed.length) process.exitCode = 1;
