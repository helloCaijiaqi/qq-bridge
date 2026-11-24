/**
 * 平台注册表 —— 「哪个平台用哪个人设」的唯一权威。
 *
 * 为什么要有这一层：
 *   过去网关用 `GATEWAY_PRESET` 全局写死一个预设名（`qq-chat-v2`）。多平台（qq / 将来的 wx）
 *   必然要求「QQ 的人设别套到微信会话上」，于是把映射收进代码：平台 → bundle 包名 + 预设名。
 *   仓库侧目录与它一一对应：`dsh/<platform>/{agent-presets,bundle}`。
 *
 * 回退策略（刻意的）：
 *   平台没映射、或映射的预设不在 DSH 可用清单时，回退 DSH 内置 `minimal`——**不是** `standard`。
 *   `standard` 带 bash / 文件读写等本地工具，挂到群聊会话等于把本地工具暴露给群聊；
 *   `minimal` 没有这些能力，最坏情况是「QQ 里出现一个不认识 QQ 的助手」，而不是安全破口。
 *   只有连 `minimal` 都不在清单里（环境本身坏了）才 fail-closed 抛错。
 *
 * 本模块不 import 任何东西（core 层只允许 node 内置/同目录），方便单测与复用。
 */

/** 回退预设：DSH 内置、无 bash/文件工具。 */
export const FALLBACK_PRESET = 'minimal';

/**
 * 平台 → bundle 包名 + 该平台托管的预设（顺序即优先级）。
 * 新增平台只需在这里加一行，并在 `dsh/<platform>/` 放源码。
 */
export const PLATFORMS = Object.freeze({
  qq: Object.freeze({
    bundle: 'qq-agent-presets',
    presets: Object.freeze(['qq-chat']),
  }),
});

/** 全部已登记平台。 */
export function platforms() {
  return Object.keys(PLATFORMS);
}

/** 平台配置；未登记返回 null。 */
export function platformConfig(platform) {
  return PLATFORMS[String(platform ?? '')] ?? null;
}

/** 该平台的 bundle 包名（= DSH 侧 package.json 的 name / node_modules 目录名）。 */
export function bundleForPlatform(platform) {
  return platformConfig(platform)?.bundle ?? null;
}

/** 该平台的预设名列表；未登记返回 []。 */
export function presetsForPlatform(platform) {
  return [...(platformConfig(platform)?.presets ?? [])];
}

/** 该平台的首选预设；未登记或无预设返回 null。 */
export function primaryPresetFor(platform) {
  return presetsForPlatform(platform)[0] ?? null;
}

/** 预设名反查平台（控制台按预设名定位源码目录用）。 */
export function platformForPreset(name) {
  const target = String(name ?? '');
  for (const platform of platforms()) {
    if (PLATFORMS[platform].presets.includes(target)) return platform;
  }
  return null;
}

/**
 * 从会话键取平台：`qq:svc-xxx:private:398102999` → `qq`。
 * 会话键是网关自己拼的（`<platform>:<adapterId>:<kind>:<conversationId>`），首段即平台。
 */
export function platformOfSessionKey(sessionKey) {
  const head = String(sessionKey ?? '').split(':')[0]?.trim();
  return head || '';
}

/**
 * 解析某平台该用的预设。
 *
 * @param {{platform?: string, available?: string[]}} input
 *   available = DSH 当前可用预设清单（`agentPresets/list`）。
 * @returns {{preset: string, fallback: boolean, reason: 'ok'|'unmapped'|'not-installed'}}
 * @throws 当映射与回退都不可用（清单里没有 minimal）时抛出——环境坏了，静默建会话更危险。
 */
export function resolvePreset({ platform, available } = {}) {
  const ids = Array.isArray(available) ? available : [];
  const mapped = primaryPresetFor(platform);
  const reason = mapped ? 'not-installed' : 'unmapped';

  if (mapped && ids.includes(mapped)) {
    return { preset: mapped, fallback: false, reason: 'ok' };
  }
  if (ids.includes(FALLBACK_PRESET)) {
    return { preset: FALLBACK_PRESET, fallback: true, reason };
  }
  const detail = mapped ? `映射 preset "${mapped}" 未安装` : `平台 "${platform ?? ''}" 未登记`;
  throw new Error(
    `无法为平台 "${platform ?? ''}" 选择预设（fail-closed）：${detail}，`
    + `且回退 preset "${FALLBACK_PRESET}" 也不在 DSH 可用清单（${ids.join(', ') || '未知'}）。`
    + ' 请先在 DSH 侧装好该平台的 preset bundle（npm run setup:dsh）后重启 DSH。',
  );
}
