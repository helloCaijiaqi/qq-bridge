// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/chat/md-to-plain.js';
import * as sensitive from '../src/chat/sensitive.js';
import * as wait from '../src/chat/v2-wait.js';
import * as safeFetch from '../src/media/safe-fetch.js';
import * as mediaNormalize from '../src/media/media-normalize.js';
import * as forward from '../src/chat/forward.js';
import * as sticker from '../src/chat/sticker-lib.js';
import * as voiceLib from '../src/media/send-voice-lib.js';
import * as stateAcl from '../src/ops/state-acl.mjs';
import { createGatewayActionsHandler } from '../src/gateway/gateway-actions.js';
import { loadActionsManifest } from '../src/gateway/actions-manifest.js';
import { createActionHandlers, createHttpDispatch } from '../src/gateway/action-handlers.js';
import { createGatewayClient } from '../src/gateway/gateway-client.js';
import { createWaitAction, createWaitRegistry } from '../src/gateway/wait-registry.js';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function bridgeHarness({ config = {}, savedState, files = {}, globals = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', ...config,
    // 网关是唯一形态：夹具默认给一份可用配置，避免每个测试都重复写 url/secret。
    gateway: {
      url: 'http://127.0.0.1:7190', adapterId: 'qq-main', platform: 'qq',
      secret: 'fixture-gateway-secret', ...(config.gateway ?? {}),
    },
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  // 额外状态文件（用于测试"启动时读到损坏/旧版文件"这类路径）。
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(temp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], faces: [], http: [] };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  // 统一的假 HTTP 响应：`json()` 给 OneBot/DSH 风格调用方，`text()` 给
  // gateway-client（它读原始文本再 JSON.parse —— 真实 fetch 两种都有）。
  const jsonResponse = (payload) => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
  const httpState = { fails: false, inboundRouted: true };
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body });
    // 网络故障注入：测「适配器降级/重试保留」的分支（例如 wait 投递失败不消费登记）。
    if (httpState.fails) throw new Error('fixture network down');
    // agent-gateway 假端：健康探测与入站投递（桥接 actions 投递的唯一出口）。
    if (String(url).endsWith('/v1/health')) {
      return jsonResponse({ ok: true, service: 'agent-gateway', mode: 'on' });
    }
    if (String(url).endsWith('/v1/inbound')) {
      return jsonResponse({
        ok: true,
        turnId: 'fixture-turn',
        deduped: false,
        status: httpState.inboundRouted ? 'accepted' : 'unrouted',
        routed: httpState.inboundRouted,
      });
    }
    const action = String(url).split('/').pop();
    // fetch_custom_face_detail：同步收藏表情的 HTTP 兜底路径要拿到**数组**（WS 失败时用）。
    if (action === 'fetch_custom_face_detail') {
      return jsonResponse({
        status: 'ok',
        retcode: 0,
        data: [{ emoji_id: 'http-fixture-sticker', resId: 'http-fixture-sticker', url: 'https://public.invalid/http-sticker', md5: 'AABBCCDDEEFF00112233445566778899', desc: 'HTTP 兜底表情' }]
      });
    }
    if (action === 'fetch_ptt_text') {
      return jsonResponse({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } });
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return jsonResponse({
        status: 'ok',
        retcode: 0,
        data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
      });
    }
    return jsonResponse({ status: 'ok', retcode: 0, data: { message_id: 9001 } });
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    settings: {
      describe: async () => success({ namespaces: [] }),
      update: async () => success({ updated: true })
    },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async fetchFaceEntity(id) { calls.faces.push(id); return null; }
    async request(action, params = {}) {
      // 群成员列表：v2 读工具 qq_get_group_members 会用到（含 WS 不可用时的 HTTP 兜底路径）。
      if (action === 'get_group_member_list') {
        return {
          status: 'ok', retcode: 0,
          data: [
            { user_id: 111, nickname: '小明', card: '小明', role: 'member' },
            { user_id: 222, nickname: '路人', card: '' },
            { user_id: 123, nickname: '管理员', card: '群主', role: 'owner' }
          ]
        };
      }
      return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] };
    }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    deliverPrompt,
    deliverInboundViaGateway,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, cfg, promptQueues,
    getSocialV2State, appendSocialV2Message, recordSentMessagesV2,
    buildWakeSnapshotV2, sendWakePromptV2, socialV2,
    syncStickerLibrary, listStickersForV2, getStickerImageData,
    replayPendingWakeReasonsV2,
    setupSleepTimerV2,
    getInitialPrompt, setInitialPrompt, loadInitialPrompts, formatInitialPromptV2,
    initialPrompts, initialPromptMaxChars,
    extractMediaFromSegments, segmentsToText, fetchOneBotImage, fetchMediaData, resolveMediaList,
    emojiCdnCandidates, getImageDimensions, acceptImageBuffer, MAX_MEDIA_BYTES, bot,
    isConversationBusyV2,
    selfIdentityTextV2,
    setSelfIdentity(display, id) {
      selfDisplayName = String(display ?? '');
      selfUserId = String(id ?? '');
      selfNickname = selfDisplayName.toLowerCase() || 'deepseek';
    },
    voiceCfg, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator,
    voiceBudgetCheck, sendVoiceV2, sendVoiceForV2, assertOutboundAuditOk,
    // wait 事件回推：登记表本身暴露给测试断言「投递失败不消费」。
    waitRegistry,
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  const context = vm.createContext({
    fs, os, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...sticker,
    ...voiceLib, ...stateAcl,
    // P5：bridge 顶层 import 了动作回投处理器。审计在上文统一剥掉 import 语句，
    // 不注入就会在「配了 gateway 密钥」的用例里 ReferenceError（VM 里的未定义标识符）。
    // 真实实现直接注入：它不发请求，只有网关回投进来才动作。
    createGatewayActionsHandler,
    // 共享动作层同样真实注入：它把清单动作翻译成内部请求，不触网。
    createActionHandlers,
    createHttpDispatch,
    // 清单加载同样真实注入：读的是仓库内 actions-manifest.json（只读，无副作用）。
    loadActionsManifest,
    // 适配器侧网关客户端（真实实现）：不发真实网络请求——VM 里的 fetch 是
    // fakeFetch，测试可以从 calls.http 断言投出去的信封（wait 事件回推靠它）。
    createGatewayClient,
    // wait 排起登记：纯状态机，真实注入（bridge.js 的 import 被剥掉后靠这里提供绑定）。
    createWaitAction,
    createWaitRegistry,
    // 桥接的出图出口会调归一化（体积/动图抽帧）：VM 里必须能拿到这几个函数。
    normalizeImageForModel: mediaNormalize.normalizeImageForModel,
    sniffImage: mediaNormalize.sniffImage,
    planNormalization: mediaNormalize.planNormalization,
    planAnimation: mediaNormalize.planAnimation,
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'src/chat/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData, describeAge }; })());`, context);
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  return { ...bridge, calls, temp,
    // 宿主侧故障注入：VM 里的 fetch 是 fakeFetch，开关放在宿主闭包里最省事。
    setHttpFails(value) { httpState.fails = Boolean(value); },
    // 网关白名单未命中：入站回 routed:false（桥接必须如实失败，不得落回本地）。
    setInboundRouted(value) { httpState.inboundRouted = value !== false; },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      fs.rmSync(temp, { recursive: true, force: true });
    } };
}
