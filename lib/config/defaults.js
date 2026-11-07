/**
 * 内置默认值 —— 四层配置的**最底层**。
 *
 * 为什么单独一个文件：这是「兜底值」的唯一事实源。`lib/store.js` 的
 * `ensureLayout` 要把它写进 `.dsh-memory/config.json` 的空模板，`layers.js`
 * 要拿它当合并基底 —— 两处各写一份就是漂移。
 *
 * **schema 里故意不填 `.default()`**（见 `schema.js` 文件头）：schema 填出的
 * 默认值与「用户显式配置」无法区分，会在解析时永久遮蔽环境变量回退。
 * 类型/范围在 schema 里校验，默认值与回退只在这里。
 */

/** 配置文件里的 schema 标识。改它等于换一种文件格式。 */
export const CONFIG_SCHEMA = 'dsh-memory.config/v1'

/** 当前配置版本。`migrate.js` 按它判定要不要迁移。 */
export const CONFIG_VERSION = 1

/** 插件内置默认值。 */
export function defaultConfig() {
  return {
    schema: CONFIG_SCHEMA,
    version: CONFIG_VERSION,
    autonomy: 'balanced',
    thresholds: {
      autoAcceptFloor: 0.6,
      deferFloor: 0.35,
      duplicate: 0.82,
      coverageFloor: 0.45,
      content: {
        identifier: 0.6,
        path: 0.7,
        error: 0.7,
        natural: 0.65,
        decision: 0.65,
        mixed: 0.65,
      },
      contentTier: 0.85,
      exactAnchorContent: 0.5,
    },
    quota: { repo: 200, growthThreshold: 50 },
    template: ['功能名', '生效条件', '子功能', '执行', '验证方式', '不适用条件'],
    capture: {
      enabled: true,
      mode: 'strict',
      // 正文起草：template（纯确定性，填不满就留占位符 → DEFER）| subagent（后台跑一次模型）
      draft: 'template',
      draftProvider: 'in-process',
      signals: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'],
    },
    recall: { inject: true, maxBytes: 4000, maxPointers: 3 },
    /**
     * 推广到全局记忆：**只产出包，不写全局存储**。
     * 全局那一层由别的插件负责；这里只负责「把项目记忆整理成可推广的形态」。
     */
    promote: { format: 'both', minConfidence: 'verified', includeProjectSpecific: true },
    /**
     * 语义通道。**默认关** —— 开闸标准写在 `lib/embedding.js` 文件头：
     * 跑自己的语料看 `bench/embedding-experiment.mjs` 的 margin，> 0.15 才值得开。
     */
    embedding: {
      provider: 'none',
      model: 'text-embedding-3-small',
      endpoint: null,
      timeoutMs: 10_000,
      g1Threshold: null,
    },
    /**
     * G3 的附加规则。**只增不减**：用户加进去的规则会与 `DEFAULT_FORBIDDEN`
     * 合并（`review` 里做），不是替换 —— 否则一个空数组就能把密钥扫描关掉。
     */
    safety: { forbidden: [] },
    conflict: { semantic: false },
  }
}

/**
 * 只属于**仓库**的字段（界面 3 的项目配置抽屉）。
 *
 * 边界要写死，否则「为什么我的配置在这个仓库不生效」会变成最常见的支持问题：
 * 这几项是仓库属性（这个仓库要不要自动捕获、这个仓库配额多少、这个仓库的
 * 六要素叫法），换仓库就该变。
 *
 * **不在**这里的：`autonomy` / `thresholds` / `embedding` / `recall` / `promote` /
 * `conflict` —— 那些是**用户偏好**，跨仓库应该一致。
 */
export const PROJECT_KEYS = Object.freeze(['capture', 'quota', 'template', 'safety'])

/**
 * 从一份完整配置里裁出「项目层该存什么」。
 *
 * 只保留 `PROJECT_KEYS`，并且**只保留与默认值不同的部分** —— 否则第一次保存
 * 就会把当时的默认值永久冻进仓库，以后改默认值对这个仓库再也不生效。
 */
export function projectPatchFrom(config) {
  const defaults = defaultConfig()
  const patch = {}
  for (const key of PROJECT_KEYS) {
    const value = config?.[key]
    if (value === undefined) continue
    const fallback = defaults[key]
    if (isPlainObject(value) && isPlainObject(fallback)) {
      const sub = {}
      for (const [k, v] of Object.entries(value)) {
        if (stableEqual(v, fallback[k])) continue
        sub[k] = v
      }
      if (Object.keys(sub).length > 0) patch[key] = sub
      continue
    }
    if (stableEqual(value, fallback)) continue
    patch[key] = value
  }
  return patch
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 数组按内容比，对象按键值比；其余用 `Object.is`。 */
export function stableEqual(a, b) {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => stableEqual(item, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) if (!stableEqual(a[key], b[key])) return false
    return true
  }
  return false
}
