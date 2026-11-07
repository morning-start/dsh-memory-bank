/**
 * 语义通道（embedding）。
 *
 * ## 它现在为什么是**关着**的
 *
 * G1 归属门只做「归一化后完全包含」—— 实测逐字 **4/10**、改写 **0/5**
 * （见 `bench/g1-eval.mjs`；剩下 6 条放行是因为判据 3/4/5 还没实现）。
 * 直觉上向量能救改写，所以先做了实验（`bench/embedding-experiment.mjs`），
 * 用 TF-IDF over 词 + 字符 bigram 的**加权包含度**测三组。
 *
 * 三次测量的对照（同一份 15 个候选，只改语料）：
 *
 *     2026-11-07 上午   A 0.244 · B 0.203 · C 0.267   分离 +0.063
 *     2026-11-07 下午   A 0.244 · B 0.286 · C 0.266   分离 −0.020
 *     0.1.0 文档记录     A 0.264 · B 0.200 · C 0.204   分离 +0.004
 *
 * **指标会翻号。** 而这三次跑的是同一份 15 个手挑样本 —— 唯一的变量是
 * 「语料 = 本仓库那 6 份 .md」的正文，改几个字就足以让它从「可分离」变成
 * 「不可分离」。那不是在 15 个样本上「刚好可分」，那是噪音：
 * 相对差个位数百分比，换一批样本就翻。**拿它开闸就是拿误伤换漏报，
 * 而且用户会以为自己买到了召回。**
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
 *   < 0.05   不要开。任何阈值都是噪音。（**当前状态**：三次测量里两次落在这里或更低）
 *   0.05–0.15  开成「只提示不判决」：进 `memory_audit` 的近似候选列表，
 *            不改 G1 的裁决。
 *   ≥ 0.15   可以考虑。阈值取两组的中间值，并把数字写进 commit message。
 *
 * 上一版这里只有 `< 0.05` 和 `≥ 0.15` 两条，中间是**真空** ——
 * 而实测值恰好落在真空里（+0.063），两边都能被引用来支持相反结论。
 * 补上中间档，判据才闭合。
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

  /**
   * 写入并**刷新 LRU 序**。
   *
   * `Map` 的插入序只有「重新 set」才会更新，所以命中时必须先 delete —— 不刷新就是
   * FIFO：一条被反复命中的热文本会被最早插进来的冷文本挤出去，缓存退化成
   * 「每个文本只活一次」。
   */
  function remember(key, vector) {
    if (cache.has(key)) cache.delete(key)
    else if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value)
    cache.set(key, vector)
    return vector
  }

  /** 取缓存（未命中返回 undefined），命中即刷新 LRU 序。 */
  function recallCached(key) {
    const vector = cache.get(key)
    return vector === undefined ? undefined : remember(key, vector)
  }

  /** 同步取：命中缓存或 lexical。**http 未命中返回 null**（绝不阻塞）。 */
  function vectorOf(text) {
    const source = String(text ?? '')
    if (!enabled || !source) return null
    const key = keyOf(source)
    const cached = recallCached(key)
    if (cached) return cached
    if (provider === 'lexical') return remember(key, lexicalVector(source))
    return null
  }

  /** 异步取：未命中就调 provider。失败返回 null 并降级。 */
  async function ensure(texts) {
    if (!enabled) return []
    const list = [...new Set(texts.map((text) => String(text ?? '')).filter(Boolean))]
    const missing = list.filter((text) => recallCached(keyOf(text)) === undefined)
    if (missing.length === 0) return list.map((text) => recallCached(keyOf(text)) ?? null)

    if (provider === 'lexical') {
      for (const text of missing) remember(keyOf(text), lexicalVector(text))
      return list.map((text) => recallCached(keyOf(text)) ?? null)
    }

    if (provider !== 'http' || !settings.endpoint) {
      if (!warned) {
        warned = true
        log(`embedding provider=${provider} 缺少 endpoint，降级为「无向量」`)
      }
      return list.map((text) => recallCached(keyOf(text)) ?? null)
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
      return list.map((text) => recallCached(keyOf(text)) ?? null)
    } catch (error) {
      // **一次失败不改变任何判决** —— 降级成「这条没有向量」
      if (!degraded) {
        degraded = true
        log(`embedding 服务不可用（${error?.message ?? error}），本次降级为逐字包含`)
      }
      return list.map((text) => recallCached(keyOf(text)) ?? null)
    }
  }

  /**
   * 通道版余弦：维度不一致时**降级**，不是静默返回 0。
   *
   * 0 的意思是「这两个向量正交」（确实无关），而维度不同意味着
   * 「这两个向量不可比」（换过模型，或缓存里混进了别的 provider）。
   * 静默返回 0 会让 G1 把一次配置事故当成一次干净的「不相关」判决。
   * 模块级 `cosine` 保持纯函数 —— `gate.js` 拿它做同步判决，不该有副作用。
   */
  function channelCosine(a, b) {
    if (a && b && a.length !== b.length && !degraded) {
      degraded = true
      log(`向量维度不一致（${a.length} vs ${b.length}），降级为逐字包含`)
    }
    return cosine(a, b)
  }

  return {
    enabled,
    provider,
    model: settings.model,
    /** G1 的余弦阈值；null = 不参与判决。 */
    g1Threshold: typeof settings.g1Threshold === 'number' ? settings.g1Threshold : null,
    vectorOf,
    ensure,
    cosine: channelCosine,
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
  // **只有全部拿到向量才缓存**。一次失败（服务挂掉、降级）也写进 WeakMap 的话，
  // 这份数组就永远没有向量 —— 之后每轮装配都拿不到语义通道，直到进程重启。
  // 少一条也不缓存：部分缓存会让「谁有向量」取决于上一次失败发生在哪一条。
  if (result.every((item) => item.vector)) ownerVectors.set(owners, result)
  return result
}
