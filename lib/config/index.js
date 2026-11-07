/**
 * 配置域门面 —— 四层配置、项目层读写、热重载的唯一入口。
 *
 * ## 为什么要有「源」而不是一个 `cfg` 对象
 *
 * 0.1.0 的 `cfg` 是 `apply()` 的闭包，只算一次。改任何持久化层都不会重新
 * `resolveConfig`，**必须重启宿主**。这是「配置改了不生效」的根因。
 *
 * 把 `cfg` 改成函数式（`() => cfg`）会让 7 个工具 + 2 个钩子 + 1 个命令全部
 * 改签名；`createConfigSource` 用**按 root 缓存**换掉了闭包：每次取配置多一次
 * Map 查找（< 1 µs），但换来「保存即生效」。
 *
 * ## 为什么按 root 缓存
 *
 * 项目层是**仓库级**的。同一个 profile 下可能同时开着仓库 A 和仓库 B 的会话，
 * 它们的 `.dsh-memory/config.json` 不同。用「上一次的 root」这种全局状态会
 * 串味 —— 而在多仓库同时工作时，串味意味着**写进别人的仓库**。
 *
 * 缓存按 `mtime:size` 失效，所以外部编辑器改了 `config.json` 也能看见。
 */

import { PROJECT_KEYS, defaultConfig } from './defaults.js'
import { LAYERS, mergeLayers, normalize, projectLayer, pruneMaterialized, resolveConfig, sourceOf } from './layers.js'
import { projectConfigPath, projectStamp, readProjectConfig, resetProjectConfig, writeProjectConfig } from './project.js'
import { GROUPS, Config, describeFields } from './schema.js'

/** cosmokit 的 volatile 协议符号（`Symbol.for`，跨 ESM/CJS 副本一致）。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * 判断一个值是不是 cosmokit 的 `Volatile` 引用。
 *
 * 不 `import { isVolatile } from '@deepseek-ai/cosmokit'`：那是宿主包，
 * 第三方插件依赖它就是在赌版本。`Symbol.for` 是**协议**，不是实现 ——
 * 两个 ESM 副本拿到的也是同一个符号。
 */
export function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/**
 * 递归去掉 `Volatile` 包装，得到普通值。
 *
 * **`apply(ctx, config)` 的第一件事必须是这个。** `Config` 的顶层分组都标了
 * `.volatile()`（见 `schema.js` 文件头），schema 解析出的值里它们是**引用对象**。
 * 直接 `deepMerge` 会把引用当成普通对象遍历 —— 结果是空对象，全部字段静默
 * 丢成默认值。
 */
export function plainConfig(value) {
  if (isVolatileRef(value)) return plainConfig(/** @type {{get:() => unknown}} */ (value).get())
  if (Array.isArray(value)) return value.map(plainConfig)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]))
  }
  return value
}

/**
 * 把一份配置摊成「每个字段现在的值 + 从哪来 + 能不能改」。
 *
 * 这是界面 1 的唯一数据源。`source` / `writable` 不是锦上添花：
 * 0.1.1 修的三个配置缺陷（环境变量全死、默认值遮蔽、`config.json` 不读）
 * 本质都是**作用域不可见**。
 *
 * @param {object} config 归一化后的配置
 * @param {{default:object,project:object,env:object,row:object}} layers 四层原始值
 */
export function describeConfig(config, layers) {
  const { fields } = describeFields()
  const defaults = defaultConfig()

  const read = (source, path) => {
    let current = source
    for (const part of path.split('.')) {
      if (current === null || typeof current !== 'object') return undefined
      current = current[part]
    }
    return current
  }

  return {
    groups: GROUPS,
    fields: fields.map((field) => {
      const source = sourceOf(layers, field.path)
      const top = field.path.split('.')[0]
      return {
        ...field,
        value: read(config, field.path),
        defaultValue: read(defaults, field.path),
        source,
        /**
         * **能不能在这个界面里改。**
         *
         * 判据只有一个：**界面唯一的写入口是 `memoryBank/setProjectConfig`
         * （写项目层），而项目层只认 `PROJECT_KEYS`**。所以
         * `writable === (top ∈ PROJECT_KEYS && source ∉ {env, row})`。
         *
         * 0.2.0 写的是 `source !== 'env' && source !== 'row'` —— 少了
         * `PROJECT_KEYS` 这一半。于是「自主度 / 审核阈值 / 召回预算 / 推广 /
         * 语义通道 / 冲突 / root」这 **33 个叶子字段**在界面上是可编辑的，
         * 保存却返回 `ok: true` 且 `written: {}` —— 值静默回弹、零提示。
         * 那正是 0.1.1 花一整版修的「作用域不可见」，在 UI 层又造了一个。
         *
         * `env` 层任何文件都盖不住；`row` 层（`cordis.patch.yml` 的 `config:`）
         * 是**部署者**的显式选择，设置界面写的是项目层 / profile 层，同样盖不住。
         */
        writable: PROJECT_KEYS.includes(top) && source !== 'env' && source !== 'row',
        // 项目配置抽屉只装仓库属性；用户偏好不在这一层。
        projectScoped: PROJECT_KEYS.includes(top),
        projectWritable: PROJECT_KEYS.includes(top) && source !== 'env' && source !== 'row',
      }
    }),
  }
}

/**
 * 配置源。一个插件实例一个。
 *
 * @param {{ rowConfig?: object, env?: object }} [options]
 */
export function createConfigSource({ rowConfig = {}, env = process.env } = {}) {
  /** @type {Map<string, { stamp: string | null, config: object, layers: object, problems: string[] }>} */
  const cache = new Map()
  /** @type {Set<(root: string, config: object) => void>} */
  const watchers = new Set()

  const load = (root) => {
    const project = readProjectConfig(root)
    const { layers, merged } = mergeLayers({ row: rowConfig, env, project: project.value })
    const config = normalize(merged)
    return { stamp: project.stamp, config, layers, problems: project.problems }
  }

  const get = (root) => {
    if (typeof root !== 'string' || root === '') {
      // 没有 root 就没有项目层：只算默认值 + 环境变量 + 行配置。
      const { merged } = mergeLayers({ row: rowConfig, env, project: {} })
      return normalize(merged)
    }
    const stamp = projectStampOf(root)
    const cached = cache.get(root)
    if (cached && cached.stamp === stamp) return cached.config
    const fresh = load(root)
    cache.set(root, fresh)
    return fresh.config
  }

  const entry = (root) => {
    get(root)
    return cache.get(root)
  }

  return {
    /** 可移植层（默认值 + 环境变量 + 行配置）—— 用来解析 root 本身。 */
    portable() {
      const { merged } = mergeLayers({ row: rowConfig, env, project: {} })
      return normalize(merged)
    },
    get,
    /** 四层原始值，给来源计算用。 */
    layers(root) {
      return entry(root)?.layers ?? mergeLayers({ row: rowConfig, env, project: {} }).layers
    },
    /** 项目层的读取问题（坏 JSON、写错的键名）。**界面必须显示它。** */
    problems(root) {
      return entry(root)?.problems ?? []
    },
    describe(root) {
      return describeConfig(this.get(root), this.layers(root))
    },
    /** 写项目层。**只认仓库属性**，其余字段会被静默裁掉（并如实返回）。 */
    setProject(root, patch) {
      const result = writeProjectConfig(root, patch)
      this.invalidate(root)
      const config = this.get(root)
      for (const watcher of watchers) {
        try {
          watcher(root, config)
        } catch {
          /* 观察者自己崩了不能影响保存 */
        }
      }
      return { ...result, config }
    },
    resetProject(root) {
      const result = resetProjectConfig(root)
      this.invalidate(root)
      return { ...result, config: this.get(root) }
    },
    /** 让缓存失效（外部改了文件、或刚写完）。 */
    invalidate(root) {
      if (root === undefined) cache.clear()
      else cache.delete(root)
    },
    /** 配置变更订阅。返回清理函数。 */
    subscribe(watcher) {
      watchers.add(watcher)
      return () => watchers.delete(watcher)
    },
    /** 当前 root 的项目配置文件路径。 */
    projectPath: projectConfigPath,
    /** 行配置（patch 里的那一行）。来源徽标要显示它。 */
    rowConfig,
  }
}

function projectStampOf(root) {
  // 一次 stat 的代价；缓存命中时只付这一下。
  return projectStamp(root)
}

/**
 * 固定配置源 —— 没有项目层的场景（测试、探针、以及「拿不到 root」的调用）。
 *
 * 存在的理由不是图省事：`createToolDefinitions` 这类工厂需要一个**配置来源**，
 * 而它的单元测试没有仓库、也不该造一个。给它一个「只有一层、不可写」的实现，
 * 比让工厂同时接受 `cfg` 和 `configSource` 两种参数（= 两条代码路径）干净。
 *
 * 注意：**不要**拿已经归一化过的配置再喂 `resolveConfig` —— `autonomy=manual`
 * 的 `autoAcceptFloor` 会被调制到 `1.01`，再归一化一次就会抛「必须在 (0,1]」。
 * 所以这里直接原样返回。
 */
export function fixedConfigSource(config) {
  const layers = { default: defaultConfig(), project: {}, env: {}, row: config ?? {} }
  const writable = () => {
    throw new Error('memory-bank: 固定配置源不可写（没有项目配置层）')
  }
  return {
    portable: () => config ?? {},
    get: () => config ?? {},
    layers: () => layers,
    problems: () => [],
    describe: () => describeConfig(config ?? {}, layers),
    setProject: writable,
    resetProject: writable,
    invalidate() {},
    subscribe() {
      return () => {}
    },
    projectPath: projectConfigPath,
    rowConfig: config ?? {},
  }
}

export {
  Config,
  GROUPS,
  PROJECT_KEYS,
  LAYERS,
  resolveConfig,
  sourceOf,
  mergeLayers,
  normalize,
  projectLayer,
  pruneMaterialized,
}
export { defaultConfig } from './defaults.js'
export { CONFIG_SCHEMA, CONFIG_VERSION, projectPatchFrom, stableEqual } from './defaults.js'
export { readProjectConfig, writeProjectConfig, resetProjectConfig, projectConfigPath } from './project.js'
export { migrateConfig, MIGRATIONS } from './migrate.js'
export { describeFields } from './schema.js'
export { AUTONOMY, ENV } from './layers.js'
