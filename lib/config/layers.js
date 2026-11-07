/**
 * 四层合并 —— 配置的**唯一**优先级实现。
 *
 * ```
 * 行 config（cordis.patch.yml）      ← 最高：部署者显式指定
 *     > 环境变量 DSH_MEMORY_*        ← 次高：本机临时覆盖（CI / 调试）
 *     > 项目 .dsh-memory/config.json ← 团队共识：进 git、随 PR review
 *     > 内置默认值                    ← 兜底
 * ```
 *
 * **临时状态应该能盖过共识，但不能盖过部署者在 patch 里的显式配置。**
 *
 * ## 曾经的实现错在哪
 *
 * 0.1.0 的写法是「先 `deepMerge(defaults, rowConfig)` 把默认值填满，再
 * `merged.x ?? env[x]`」—— 默认值一填满，`??` 就永不短路，**四个环境变量里
 * 死了三个**（只有 `root` 有效，因为 `defaultConfig()` 里没有这个键）。
 * 而且 `autonomy` 的 fail-fast 只校验 `merged.autonomy`，于是
 * `DSH_MEMORY_AUTONOMY=yolo` 静默回退到 `balanced`。
 *
 * 修法是换掉合并顺序：**逐层合并**，而不是「填满默认值再短路」。这样
 * 「没设」与「设成默认值」才真正可区分 —— 而「这个值来自哪一层」正是
 * UI 要画出来的东西（`sourceOf`）。
 */

import { isAbsolute } from 'node:path'

import { CONFIG_VERSION, PROJECT_KEYS, defaultConfig } from './defaults.js'

/** 环境变量回退表。**没有 HOME 变量** —— 本插件不写全局存储。 */
export const ENV = Object.freeze({
  autonomy: 'DSH_MEMORY_AUTONOMY',
  root: 'DSH_MEMORY_ROOT',
  autoAcceptFloor: 'DSH_MEMORY_AUTO_ACCEPT_FLOOR',
  deferFloor: 'DSH_MEMORY_DEFER_FLOOR',
})

export const AUTONOMY = Object.freeze(['manual', 'balanced', 'autonomous'])

/** 四层的名字，也是 `source` 的取值。 */
export const LAYERS = Object.freeze(['default', 'project', 'env', 'row'])

/**
 * 从环境变量读一个数字。**非法值直接抛** —— 静默回退到默认值比没有这个
 * 环境变量更糟：用户以为自己改了口径，实际跑的是别的闸门。
 */
function envNumber(env, name) {
  const raw = env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined
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

/** 对象递归合并，数组整体替换（`over` 说了算）。 */
export function deepMerge(base, override) {
  if (override === undefined || override === null) return base
  if (Array.isArray(override)) return override
  if (typeof override !== 'object') return override
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    out[key] =
      key in base && typeof base[key] === 'object' && base[key] !== null && !Array.isArray(base[key])
        ? deepMerge(base[key], value)
        : value
  }
  return out
}

/** 环境变量层。只有**真的设了**的键才进层 —— 否则让默认值顶上。 */
export function envLayer(env = process.env) {  const layer = {}
  if (env[ENV.autonomy] !== undefined && String(env[ENV.autonomy]).trim() !== '') {
    layer.autonomy = String(env[ENV.autonomy]).trim()
  }
  if (env[ENV.root] !== undefined && String(env[ENV.root]).trim() !== '') {
    layer.root = String(env[ENV.root]).trim()
  }

  const thresholds = {}
  const autoAcceptFloor = envNumber(env, ENV.autoAcceptFloor)
  const deferFloor = envNumber(env, ENV.deferFloor)
  if (autoAcceptFloor !== undefined) thresholds.autoAcceptFloor = autoAcceptFloor
  if (deferFloor !== undefined) thresholds.deferFloor = deferFloor
  if (Object.keys(thresholds).length > 0) layer.thresholds = thresholds

  return layer
}

/** 项目层只认这几个顶层键；其余字段写进去会被静默忽略，所以这里直接裁掉。 */
const PROJECT_TOP_KEYS = new Set(PROJECT_KEYS)

/**
 * 裁剪项目层：只保留仓库属性，并去掉 `schema` / `version` 这类文件头。
 *
 * 为什么必须裁：`config.json` 是手写进 git 的文件，里面可能有 `autonomy`。
 * 一个「看起来生效、实际被更高的层盖住」的字段，比一个报错的字段更糟。
 */
export function projectLayer(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const layer = {}
  for (const key of PROJECT_TOP_KEYS) {
    if (raw[key] !== undefined) layer[key] = raw[key]
  }
  return layer
}

/**
 * 去掉 **schema 物化出来的空容器**。
 *
 * ## 这不是洁癖，是一个静默的数据丢失
 *
 * schemastery 会把「没提供的数组」解析成 `[]`、把「没提供的对象」解析成 `{}`。
 * 宿主在 `apply(ctx, config)` 里交给我们的是**解析后的值**，于是：
 *
 * ```js
 * plainConfig(Config({ autonomy: 'balanced' }))
 * // => { autonomy: 'balanced', template: [], capture: { signals: [] }, safety: { forbidden: [] }, ... }
 * ```
 *
 * 而 `deepMerge` 对数组是**整体替换**。结果：
 *
 * - `template: []` → 六要素模板被清空 → G2 对**每一条**记忆 refuse；
 * - `capture.signals: []` → 自动捕获永不触发；
 * - `safety.forbidden: []` → 与默认值相同，无害。
 *
 * 三个字段里有两个会静默关掉功能，而**没有任何报错**。这正是 0.1.1 修过的那类
 * 「文档承诺、代码空壳」的债。
 *
 * ## 为什么裁掉 `[]` 是安全的
 *
 * 「空数组」在 patch 里与「没写」不可区分 —— 既然不可区分，就必须选一个。
 * 选「等于没写」的理由：真要关掉某个功能有专门的开关（`capture.enabled`、
 * `conflict.semantic`），而 `template: []` 这种「关掉六要素门」的写法在文档里
 * 从来没有承诺过。反过来（把 `[]` 当显式配置）会让**每一个**用 Loader 挂载的
 * 用户静默失去捕获能力。
 *
 * 项目层（手写 JSON）不裁 —— 那是人写的，`[]` 就是 `[]`。
 *
 * @template T
 * @param {T} layer
 * @returns {T}
 */
export function pruneMaterialized(layer) {
  if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) return layer
  const out = {}
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      if (value.length > 0) out[key] = value
      continue
    }
    if (typeof value === 'object') {
      const child = pruneMaterialized(value)
      if (Object.keys(child).length > 0) out[key] = child
      continue
    }
    out[key] = value
  }
  return /** @type {T} */ (out)
}

/**
 * 按 `defaults → project → env → row` 合并出**未校验**的原始值。
 *
 * 单独导出是因为 UI 要显示「这个值来自哪一层」，而来源必须在归一化
 * （`normalize` 会调制 `autoAcceptFloor`）之前算 —— 调制后的值不能反推层。
 */
export function mergeLayers({ row = {}, env = process.env, project = {} } = {}) {
  const defaults = defaultConfig()
  const rowLayer = pruneMaterialized(row)
  const projectValue = project ?? {}
  const envValue = envLayer(env)
  const resolved = deepMerge(deepMerge(deepMerge(defaults, projectValue), envValue), rowLayer)
  return { layers: { default: defaults, project: projectValue, env: envValue, row: rowLayer }, merged: resolved }
}

function hasPath(node, parts) {
  let current = node
  for (let index = 0; index < parts.length; index += 1) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return false
    if (!Object.hasOwn(current, parts[index])) return false
    current = current[parts[index]]
  }
  return true
}

/**
 * 一条字段路径的值**实际来自哪一层**。
 *
 * 从高到低找第一个「真的有这个键」的层。0.1.1 修的三个配置缺陷
 * （环境变量全死、默认值遮蔽、`config.json` 不读）本质都是同一件事：
 * **作用域不可见**。这个函数就是让作用域可见的唯一入口。
 *
 * @param {{default:object,project:object,env:object,row:object}} layers
 * @param {string} path 点分路径
 * @returns {'default'|'project'|'env'|'row'}
 */
export function sourceOf(layers, path) {
  const parts = path.split('.')
  if (hasPath(layers.row, parts)) return 'row'
  if (hasPath(layers.env, parts)) return 'env'
  if (hasPath(layers.project, parts)) return 'project'
  return 'default'
}

/**
 * 归一化 + fail-fast 校验。
 *
 * 非法值**不静默降级**：autonomy 不在枚举里直接抛 —— 一个拼写错误
 * 绝不能悄悄回退到更激进的档位。
 */
export function normalize(merged) {
  const defaults = defaultConfig()
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
    version: merged.version ?? CONFIG_VERSION,
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
    embedding: { ...defaults.embedding, ...(merged.embedding ?? {}) },
  }
}

/**
 * 解析配置。`rowConfig` 是 cordis.patch.yml 那一行的 `config`。
 *
 * @param {object} [rowConfig]
 * @param {object} [env] `process.env` 的替身（测试用）
 * @param {object} [project] 项目层原始值（已通过 `project.js` 读盘 + 校验）
 */
export function resolveConfig(rowConfig = {}, env = process.env, project = {}) {
  const { merged } = mergeLayers({ row: rowConfig, env, project: projectLayer(project) })
  return normalize(merged)
}
