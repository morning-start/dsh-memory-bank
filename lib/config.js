/**
 * 配置解析：行 config > 环境变量 > 内置默认值。
 *
 * **唯一事实源**。`Config` schema 故意不填默认值 —— schema 填出的默认值
 * 与「用户显式配置」无法区分，会在解析时永久遮蔽环境变量回退。
 * 类型/范围在 schema 里校验，默认值与回退只在这里。
 *
 * 曾经这里的实现是「先 `deepMerge(defaults, rowConfig)` 把默认值填满，再
 * `merged.x ?? env[x]`」—— 默认值一填满，`??` 就永不短路，**四个环境变量里
 * 死了三个**（只有 `root` 有效，因为 `defaultConfig()` 里没有这个键）。
 * 而且 `autonomy` 的 fail-fast 只校验 `merged.autonomy`，于是
 * `DSH_MEMORY_AUTONOMY=yolo` 静默回退到 `balanced`。
 *
 * 修法是换掉合并顺序：**先算环境变量层，再让它和默认值、行配置按
 * 默认值 → 环境变量 → 行配置 的顺序逐层合并**。这样「没设」与「设成默认值」
 * 才真正可区分。
 */

import { isAbsolute } from 'node:path'

import { defaultConfig } from './store.js'

/** 环境变量回退表。**没有 HOME 变量** —— 本插件不写全局存储。 */
const ENV = Object.freeze({
  autonomy: 'DSH_MEMORY_AUTONOMY',
  root: 'DSH_MEMORY_ROOT',
  autoAcceptFloor: 'DSH_MEMORY_AUTO_ACCEPT_FLOOR',
  deferFloor: 'DSH_MEMORY_DEFER_FLOOR',
})

const AUTONOMY = ['manual', 'balanced', 'autonomous']

/**
 * 从环境变量读一个数字。**非法值直接抛** —— 静默回退到默认值比没有这个
 * 环境变量更糟：用户以为自己改了口径，实际跑的是别的闸门。
 */
function envNumber(env, name, fallback) {
  const raw = env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const parsed = Number.parseFloat(String(raw))
  if (!Number.isFinite(parsed)) {
    throw new Error(`memory-bank: 环境变量 ${name} 必须是数字，收到「${raw}」`)
  }
  return parsed
}

function numberOr(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function deepMerge(base, override) {
  if (override === undefined || override === null) return base
  if (Array.isArray(override)) return override
  if (typeof override !== 'object') return override
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    out[key] = key in base && typeof base[key] === 'object' && base[key] !== null && !Array.isArray(base[key])
      ? deepMerge(base[key], value)
      : value
  }
  return out
}

/** 环境变量层。只有**真的设了**的键才进层 —— 否则让默认值顶上。 */
function envLayer(env) {
  const layer = {}
  if (env[ENV.autonomy] !== undefined && String(env[ENV.autonomy]).trim() !== '') layer.autonomy = String(env[ENV.autonomy]).trim()
  if (env[ENV.root] !== undefined && String(env[ENV.root]).trim() !== '') layer.root = String(env[ENV.root]).trim()

  const thresholds = {}
  const autoAcceptFloor = envNumber(env, ENV.autoAcceptFloor, undefined)
  const deferFloor = envNumber(env, ENV.deferFloor, undefined)
  if (autoAcceptFloor !== undefined) thresholds.autoAcceptFloor = autoAcceptFloor
  if (deferFloor !== undefined) thresholds.deferFloor = deferFloor
  if (Object.keys(thresholds).length > 0) layer.thresholds = thresholds

  return layer
}

/**
 * 解析配置。`rowConfig` 是 cordis.patch.yml 那一行的 `config`。
 * 非法值**不静默降级**：autonomy 不在枚举里直接抛 —— 一个拼写错误
 * 绝不能悄悄回退到更激进的档位。
 */
export function resolveConfig(rowConfig = {}, env = process.env) {
  const defaults = defaultConfig()
  // 默认值 → 环境变量 → 行配置。顺序即优先级，反过来就回到「环境变量全死」。
  const merged = deepMerge(deepMerge(defaults, envLayer(env)), rowConfig)

  const autonomy = merged.autonomy
  if (!AUTONOMY.includes(autonomy)) {
    throw new Error(`memory-bank: autonomy 只能是 ${AUTONOMY.join(' / ')}，收到「${autonomy}」`)
  }

  const autoAcceptFloor = numberOr(merged.thresholds?.autoAcceptFloor, defaults.thresholds.autoAcceptFloor)
  const deferFloor = numberOr(merged.thresholds?.deferFloor, defaults.thresholds.deferFloor)

  if (autoAcceptFloor <= 0 || autoAcceptFloor > 1) {
    throw new Error(`memory-bank: autoAcceptFloor 必须在 (0, 1]，收到 ${autoAcceptFloor}`)
  }
  if (deferFloor < 0 || deferFloor > 1) {
    throw new Error(`memory-bank: deferFloor 必须在 [0, 1]，收到 ${deferFloor}`)
  }
  if (deferFloor > autoAcceptFloor) {
    throw new Error('memory-bank: deferFloor 不能大于 autoAcceptFloor')
  }

  const root = merged.root ?? null
  // **mount 时就 fail-fast**：上一版只在每次工具调用时校验，插件照常挂载，
  // 配置错误被藏进 7 条工具路径里。环境变量那条分支还完全不校验。
  if (root !== null && (typeof root !== 'string' || !isAbsolute(root))) {
    throw new Error(`memory-bank: root 必须是绝对路径，收到「${root}」`)
  }

  // autonomy 调制 autoAcceptFloor（manual 永不自动，全靠确认）
  const effectiveAutoAccept =
    autonomy === 'manual' ? 1.01 : autonomy === 'autonomous' ? Math.min(autoAcceptFloor, 0.45) : autoAcceptFloor

  return {
    ...merged,
    autonomy,
    root,
    thresholds: {
      ...defaults.thresholds,
      ...merged.thresholds,
      autoAcceptFloor: effectiveAutoAccept,
      deferFloor,
      content: { ...defaults.thresholds.content, ...(merged.thresholds?.content ?? {}) },
    },
    quota: { ...defaults.quota, ...(merged.quota ?? {}) },
    capture: { ...defaults.capture, ...(merged.capture ?? {}) },
    recall: { ...defaults.recall, ...(merged.recall ?? {}) },
    promote: { ...defaults.promote, ...(merged.promote ?? {}) },
    safety: { ...defaults.safety, ...(merged.safety ?? {}) },
    conflict: { ...defaults.conflict, ...(merged.conflict ?? {}) },
  }
}

export { AUTONOMY, ENV }
