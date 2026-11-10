/**
 * actions-manifest 加载与校验（清单驱动的 /v1/actions 分发基座）。
 *
 * 为什么手写校验器而不是引 ajv：
 *   1. 桥接零运行时依赖原则——清单 schema 刻意只用一个受限 JSON Schema 子集，
 *      全量枚举在这里（type/const/enum/required/properties/additionalProperties/
 *      items/minimum/maximum/minLength/maxLength/minItems/maxItems，type 支持
 *      ["string","number"] 形态的数组）；
 *   2. 子集越小，"schema 表达力 = 校验器能力" 的等式越容易被测试钉住——
 *      agent-gateway/scripts/test-actions-manifest.mjs 用同一份校验器跑符合性。
 *
 * 三层校验：
 *   - validateAgainstSchema(schema, value)：通用受限 JSON Schema 子集；
 *   - validateActionsManifest(manifest, schema)：结构 + 语义（type 唯一等）；
 *   - validatePayload(entry.payloadSchema, payload)：/v1/actions 分发的 E_SCHEMA 步。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_SRC = path.dirname(fileURLToPath(import.meta.url));

export const MANIFEST_PATH = path.join(PKG_SRC, 'actions-manifest.json');
export const MANIFEST_SCHEMA_PATH = path.join(PKG_SRC, 'actions-manifest.schema.json');

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isSafeInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** 校验 value 是否匹配 type 声明（支持 "integer"｜["string","number"] 形态）。 */
function matchesType(declared, value) {
  const accepted = Array.isArray(declared) ? declared : [declared];
  const actual = typeOf(value);
  if (accepted.includes(actual)) return true;
  // JSON 里整数字面量的实际类型是 integer：声明 number 时要接受 integer 值，
  // 声明 integer 时也要接受无小数的 number 值。
  if (accepted.includes('number') && actual === 'integer') return true;
  if (accepted.includes('integer') && actual === 'number' && Number.isSafeInteger(value)) return true;
  return false;
}

/**
 * 受限 JSON Schema 校验。返回错误消息（带字段路径）或 null。
 * 错误消息风格与旧 execute() 保持一致（"payload.x must be ..."），E_SCHEMA 文案不漂移。
 */
export function validateAgainstSchema(schema, value, root = 'payload') {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    const expected = Array.isArray(schema.type) ? schema.type.join('|') : schema.type;
    return `${root} must be ${expected}`;
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    return `${root} must equal ${JSON.stringify(schema.const)}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    return `${root} must be one of ${schema.enum.map((item) => String(item)).join(', ')}`;
  }
  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      return `${root} does not match pattern ${schema.pattern}`;
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return `${root} must be a string of at least ${schema.minLength} characters`;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return `${root} exceeds ${schema.maxLength} characters`;
    }
  }
  if (typeof value === 'number') {
    const declaredInt = Array.isArray(schema.type) ? schema.type.includes('integer') : schema.type === 'integer';
    if (schema.minimum !== undefined && value < schema.minimum) {
      // 整数 + minimum:0 是最常见形态，文案与旧内置分发保持一致（契约稳定性）。
      if (declaredInt && schema.minimum === 0) return `${root} must be a non-negative integer`;
      return `${root} must be >= ${schema.minimum}`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `${root} must be <= ${schema.maximum}`;
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return `${root} must contain at least ${schema.minItems} items`;
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return `${root} exceeds ${schema.maxItems} items`;
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i += 1) {
        const error = validateAgainstSchema(schema.items, value[i], `${root}[${i}]`);
        if (error) return error;
      }
    }
    return null;
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (value[key] === undefined) return `${root}.${key} is required`;
      }
    }
    const props = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) return `${root}.${key} is not an allowed property`;
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (value[key] === undefined) continue;
      const error = validateAgainstSchema(sub, value[key], `${root}.${key}`);
      if (error) return error;
    }
  }
  return null;
}

/**
 * 清单结构 + 语义校验。
 * @returns {{ ok: boolean, errors: string[], types: string[] }}
 */
export function validateActionsManifest(manifest, schema = null) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['manifest must be a JSON object'], types: [] };
  }
  if (schema) {
    const structural = validateAgainstSchema(schema, manifest, 'manifest');
    if (structural) errors.push(structural);
  }
  const actions = Array.isArray(manifest.actions) ? manifest.actions : [];
  const seen = new Set();
  const types = [];
  for (const entry of actions) {
    if (!entry || typeof entry !== 'object') { errors.push('actions[] entry must be an object'); continue; }
    const { type } = entry;
    if (typeof type !== 'string' || !type) { errors.push('actions[].type is required'); continue; }
    if (seen.has(type)) errors.push(`duplicate action type: ${type}`);
    seen.add(type);
    types.push(type);
    if (entry.payloadSchema !== undefined && (typeof entry.payloadSchema !== 'object' || Array.isArray(entry.payloadSchema))) {
      errors.push(`${type}: payloadSchema must be an object`);
    }
  }
  return { ok: errors.length === 0, errors, types };
}

/** /v1/actions 分发的 payload 校验步：返回错误消息或 null。 */
export function validatePayload(payloadSchema, payload) {
  if (!payloadSchema || typeof payloadSchema !== 'object') return null;
  return validateAgainstSchema(payloadSchema, payload ?? {}, 'payload');
}

/**
 * 从磁盘加载并校验清单。文件缺失/不合法返回 { error }，调用方决定降级策略
 * （gateway-actions 在无清单时退回内置三分发，启动日志明示）。
 *
 * @returns {{ manifest: object|null, error: string|null }}
 */
export function loadActionsManifest({
  manifestPath = MANIFEST_PATH,
  schemaPath = MANIFEST_SCHEMA_PATH,
  logger = () => {},
} = {}) {
  let manifest;
  let schema = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { manifest: null, error: `manifest unreadable: ${error?.message ?? error}` };
  }
  try {
    schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  } catch (error) {
    logger(`[actions-manifest] schema unreadable（跳过结构校验）: ${error?.message ?? error}`);
  }
  const verdict = validateActionsManifest(manifest, schema);
  if (!verdict.ok) {
    return { manifest: null, error: `manifest invalid: ${verdict.errors.join('; ')}` };
  }
  return { manifest, error: null };
}
