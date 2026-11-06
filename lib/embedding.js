/**
 * 语义通道（embedding）。
 *
 * ## 它现在为什么是**关着**的
 *
 * G1 归属门只做「归一化后完全包含」—— 逐字 10/10，改写 0/5。
 * 直觉上向量能救改写，所以先做了实验（`bench/embedding-experiment.mjs`），
 * 用 TF-IDF over 词 + 字符 bigram 的**加权包含度**测三组：
 *
 *     A 逐字（该拒）  最低 0.264
 *     B 无关（该过）  最高 0.200
 *     C 改写（该拒）  最低 0.204
 *
 * 分离度 **+0.004**。那不是在 15 个手挑样本上「刚好可分」，那是噪音：
 * 相对差 2%，换一批样本就翻。**拿它开闸就是拿误伤换漏报，而且用户会以为
 * 自己买到了召回。**
 *
 * 所以这个模块提供的不是「一个能用的语义通道」，而是**一个诚实的接口**：
 *
 *   provider: 'none'     默认。通道关着，G1 走逐字包含。
 *   provider: 'lexical'  本地确定性向量。**实测不足以做 G1 判决**，
 *                        只用于诊断（`memory_audit --semantic` 看近似候选）。
 *   provider: 'http'     真正的 embedding 服务（OpenAI 兼容 /embeddings）。
 *                        这是唯一可能真的有效的实现。
 *
 * ## 开闸的验收标准
 *
 * 不是「配置里写了 enabled 就开」。跑 `node bench/embedding-experiment.mjs`
 * 换**你自己的语料**，看 `分离（C 最低 - B 最高）`：
 *
 *   < 0.05   不要开。任何阈值都是噪音。
 *   ≥ 0.15   可以考虑。阈值取两组的中间值，并把数字写进 commit message。
 *   中间     开成「只提示不判决」：进 `memory_audit` 的近似候选列表，
 *            不改 G1 的裁决。
 *
 * ## 架构约束
 *
 * `recall` 和 `gate` 都是**同步**的（每轮 prompt 装配），而 HTTP 是异步的。
 * 所以 embedding 不在门里调用 —— 它是**可预先计算的数据**：
 *
 *   - 语料向量在 `ensureSnapshot` 之后算一次，挂在 `owners` 数组上（WeakMap）；
 *   - 候选向量在 `memory_remember` / 后台 drain（本来就是 async）里算；
 *   - 门只做同步的余弦比较，拿不到向量就退回逐字包含。
 *
 * 这样「开闸」不会把任何延迟带进每轮装配路径。
 */

import { createHash } from 'node:crypto'

/** 向量维度上限（hash 兜底时用）。 */
const LEXICAL_DIMENSIONS = 512

/** 内存缓存上限。超出按 LRU 丢弃 —— 向量是可重算的派生物。 */
const MAX_CACHE = 2000

const DEFAULTS = Object.freeze({
  provider: 'none',
  model: 'text-embedding-3-small',
  endpoint: null,
  timeoutMs: 10_000,
  /** G1 用它做判决的余弦阈值。null = 不参与判决（只做诊断）。 */
  g1Threshold: null,
})

/* ── 分词（与 bench/embedding-experiment.mjs 同源） ───────────────── */

const STOP = new Set([
  '的', '了', '是', '在', '和', '与', '也', '就', '都', '而', '及', '或', '个', '这', '那', '有', '不', '要', '会', '把', '被', '从', '到', '为', '以', '一个', '我们', '你', '它',
  'to', 'a', 'the', 'of', 'is', 'in', 'and', 'or',
])

export function tokenize(text) {
  const out = []
  const lowered = String(text ?? '').toLowerCase()
  for (const match of lowered.matchAll(/[a-z][a-z0-9_+#.-]{1,}/g)) out.push(match[0])
  for (const match of lowered.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0]
    if (run.length === 1) {
      if (!STOP.has(run)) out.push(run)
      continue
    }
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const gram = run.slice(index, index + 2)
      if (!STOP.has(gram)) out.push(gram)
    }
  }
  return out
}

/** 词袋哈希向量：确定性、无状态、不需要语料。**只用于 lexical 诊断。** */
function lexicalVector(text) {
  const vector = new Float64Array(LEXICAL_DIMENSIONS)
  for (const token of tokenize(text)) {
    const digest = createHash('sha256').update(token, 'utf8').digest()
    const index = ((digest[0] << 8) | digest[1]) % LEXICAL_DIMENSIONS
    vector[index] += 1
  }
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm) || 1
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
  return vector
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  for (let index = 0; index < a.length; index += 1) dot += a[index] * b[index]
  return dot
}

/* ── 通道 ─────────────────────────────────────────────────────────── */

/**
 * 创建语义通道。
 *
 * **永不抛**：任何失败都降级成「这条没有向量」，门走逐字包含。
 * 一次 embedding 服务挂掉，不能让记忆写不进去。
 */
export function createEmbeddingChannel({ config = {}, log = () => {}, fetchImpl = globalThis.fetch } = {}) {
  const settings = { ...DEFAULTS, ...(config.embedding ?? {}) }
  const provider = String(settings.provider ?? 'none').toLowerCase()
  const enabled = provider !== 'none'

  /** sha256(model\0text) -> Float64Array */
  const cache = new Map()
  let warned = false
  let degraded = false

  const keyOf = (text) => createHash('sha256').update(`${settings.model}\u0000${text}`, 'utf8').digest('hex')

  function remember(key, vector) {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value)
    cache.set(key, vector)
    return vector
  }

  /** 同步取：命中缓存或 lexical。**http 未命中返回 null**（绝不阻塞）。 */
  function vectorOf(text) {
    const source = String(text ?? '')
    if (!enabled || !source) return null
    const key = keyOf(source)
    const cached = cache.get(key)
    if (cached) return cached
    if (provider === 'lexical') return remember(key, lexicalVector(source))
    return null
  }

  /** 异步取：未命中就调 provider。失败返回 null 并降级。 */
  async function ensure(texts) {
    if (!enabled) return []
    const list = [...new Set(texts.map((text) => String(text ?? '')).filter(Boolean))]
    const missing = list.filter((text) => !cache.has(keyOf(text)))
    if (missing.length === 0) return list.map((text) => cache.get(keyOf(text)))

    if (provider === 'lexical') {
      for (const text of missing) remember(keyOf(text), lexicalVector(text))
      return list.map((text) => cache.get(keyOf(text)))
    }

    if (provider !== 'http' || !settings.endpoint) {
      if (!warned) {
        warned = true
        log(`embedding provider=${provider} 缺少 endpoint，降级为「无向量」`)
      }
      return list.map((text) => cache.get(keyOf(text)) ?? null)
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
      let payload
      try {
        const response = await fetchImpl(settings.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: settings.model, input: missing }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        payload = await response.json()
      } finally {
        clearTimeout(timer)
      }

      const rows = payload?.data
      if (!Array.isArray(rows) || rows.length !== missing.length) {
        throw new Error(`返回 ${rows?.length ?? 0} 条向量，期望 ${missing.length} 条`)
      }
      for (const [index, row] of rows.entries()) {
        const values = row?.embedding
        if (!Array.isArray(values) || values.length === 0) throw new Error(`第 ${index} 条向量为空`)
        remember(keyOf(missing[index]), Float64Array.from(values))
      }
      degraded = false
      return list.map((text) => cache.get(keyOf(text)) ?? null)
    } catch (error) {
      // **一次失败不改变任何判决** —— 降级成「这条没有向量」
      if (!degraded) {
        degraded = true
        log(`embedding 服务不可用（${error?.message ?? error}），本次降级为逐字包含`)
      }
      return list.map((text) => cache.get(keyOf(text)) ?? null)
    }
  }

  return {
    enabled,
    provider,
    model: settings.model,
    /** G1 的余弦阈值；null = 不参与判决。 */
    g1Threshold: typeof settings.g1Threshold === 'number' ? settings.g1Threshold : null,
    vectorOf,
    ensure,
    cosine,
    describe() {
      if (!enabled) return '关闭（G1 走逐字包含）'
      if (provider === 'lexical') return 'lexical（本地确定性；**实测不足以做 G1 判决**，只做诊断）'
      if (!settings.endpoint) return `${provider}（缺 endpoint，降级为关闭）`
      return `${provider} · ${settings.model} · ${degraded ? '**降级中**' : '正常'} · 缓存 ${cache.size}`
    },
  }
}

/**
 * 给 owner 文档算向量。**挂在数组上**（WeakMap）——
 * 文档不变就不重算，`collectOwners` 的缓存也复用同一个数组。
 */
const ownerVectors = new WeakMap()

export async function vectorizeOwners(owners, channel) {
  if (!channel?.enabled || !owners?.length) return null
  const cached = ownerVectors.get(owners)
  if (cached) return cached

  const vectors = await channel.ensure(owners.map((owner) => owner.text ?? owner.normalized ?? ''))
  const result = owners.map((owner, index) => ({ ref: owner.ref, vector: vectors[index] ?? null }))
  ownerVectors.set(owners, result)
  return result
}
