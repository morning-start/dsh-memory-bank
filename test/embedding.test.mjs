/**
 * 语义通道：**默认关，开闸有标准。**
 *
 * 这一组的核心不变量不是「向量算得准」—— 那是 provider 的事 —— 而是：
 *
 *   1. 默认关。通道关着时，G1 的行为和「没有这个功能」逐字节相同。
 *   2. 永不抛。一次 embedding 服务挂掉，不能让记忆写不进去。
 *   3. 只在调用方**显式给了阈值**时才参与判决。
 *   4. 失败要降级，而且降级要**说出来**（log 一次），不能静默。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createEmbeddingChannel, vectorizeOwners } from '../lib/embedding.js'
import { gateOwnership } from '../lib/gate.js'

const owners = [
  { ref: 'README.md', normalized: '记忆会过时但正文永不改写', text: '记忆会过时，但正文永不改写。' },
  { ref: 'docs/design.md', normalized: '协议是纯算术可复现', text: '协议是纯算术，可复现。' },
]

/** 假 embedding 服务：把文本映射成确定的 4 维向量。 */
function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body })
    return handler(body, calls.length)
  }
  impl.calls = calls
  return impl
}

describe('默认关', () => {
  it('provider=none 时 enabled=false', () => {
    const channel = createEmbeddingChannel({ config: {} })
    assert.equal(channel.enabled, false)
    assert.equal(channel.provider, 'none')
    assert.match(channel.describe(), /关闭/)
  })

  it('关着时 vectorOf 返回 null，ensure 返回空数组', async () => {
    const channel = createEmbeddingChannel({ config: {} })
    assert.equal(channel.vectorOf('任何文本'), null)
    assert.deepEqual(await channel.ensure(['a', 'b']), [])
  })

  it('**关着时 G1 只走逐字包含**', () => {
    const verbatim = gateOwnership({ title: '记忆会过时，但正文永不改写', about: 'x'.repeat(20) }, { owners })
    assert.equal(verbatim.kind, 'refuse')
    assert.equal(verbatim.code, 'owned-elsewhere')

    // 改写：没有向量就过
    const paraphrase = gateOwnership({ title: '记忆随仓库走，不随会话走', about: 'y'.repeat(20) }, { owners })
    assert.equal(paraphrase.kind, 'pass')
  })
})

describe('lexical provider', () => {
  it('确定性：同样的文本同样的向量', () => {
    const channel = createEmbeddingChannel({ config: { embedding: { provider: 'lexical' } } })
    const a = channel.vectorOf('记忆是仓库级制品')
    const b = channel.vectorOf('记忆是仓库级制品')
    assert.deepEqual([...a], [...b])
  })

  it('自身余弦 = 1', () => {
    const channel = createEmbeddingChannel({ config: { embedding: { provider: 'lexical' } } })
    const vector = channel.vectorOf('记忆是仓库级制品')
    assert.ok(Math.abs(channel.cosine(vector, vector) - 1) < 1e-9)
  })

  it('describe 明说「实测不足以做 G1 判决」', () => {
    const channel = createEmbeddingChannel({ config: { embedding: { provider: 'lexical' } } })
    assert.match(channel.describe(), /实测不足以做 G1 判决/)
  })

  it('**不传阈值就不参与判决**（lexical 只做诊断）', () => {
    const channel = createEmbeddingChannel({ config: { embedding: { provider: 'lexical' } } })
    assert.equal(channel.g1Threshold, null)
  })
})

describe('http provider', () => {
  const config = (overrides = {}) => ({
    embedding: {
      provider: 'http',
      endpoint: 'https://example.invalid/v1/embeddings',
      model: 'test-model',
      timeoutMs: 5_000,
      ...overrides,
    },
  })

  it('调用并缓存（同样文本只请求一次）', async () => {
    const fetchImpl = fakeFetch((body) => ({
      ok: true,
      json: async () => ({ data: body.input.map(() => ({ embedding: [0.6, 0.8, 0, 0] })) }),
    }))
    const channel = createEmbeddingChannel({ config: config(), fetchImpl })

    const first = await channel.ensure(['记忆是仓库级制品'])
    assert.equal(fetchImpl.calls.length, 1)
    assert.deepEqual([...first[0]], [0.6, 0.8, 0, 0])

    await channel.ensure(['记忆是仓库级制品'])
    assert.equal(fetchImpl.calls.length, 1, '第二次必须命中缓存')

    assert.ok(Math.abs(channel.cosine(first[0], first[0]) - 1) < 1e-9)
  })

  it('批量：一次请求发全部未命中的', async () => {
    const fetchImpl = fakeFetch((body) => ({
      ok: true,
      json: async () => ({ data: body.input.map((_, index) => ({ embedding: [index + 1, 0, 0, 0] })) }),
    }))
    const channel = createEmbeddingChannel({ config: config(), fetchImpl })
    const vectors = await channel.ensure(['a'.repeat(4), 'b'.repeat(4), 'a'.repeat(4)])
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(fetchImpl.calls[0].body.input.length, 2, '重复文本只发一次')
    assert.equal(vectors.length, 2, '**去重**：返回值按去重后的列表')
  })

  it('**HTTP 失败 → 降级，不抛**', async () => {
    const logs = []
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 503 }))
    const channel = createEmbeddingChannel({ config: config(), fetchImpl, log: (message) => logs.push(message) })

    const vectors = await channel.ensure(['记忆是仓库级制品'])
    assert.deepEqual(vectors, [null])
    assert.ok(logs.some((line) => /降级为逐字包含/.test(line)), '必须说出来，不能静默')
  })

  it('**网络异常 → 降级，不抛**', async () => {
    const logs = []
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED')
    }
    const channel = createEmbeddingChannel({ config: config(), fetchImpl, log: (message) => logs.push(message) })
    const vectors = await channel.ensure(['x'.repeat(4)])
    assert.deepEqual(vectors, [null])
    assert.ok(logs.some((line) => /ECONNREFUSED/.test(line)))
  })

  it('返回条数不符 → 降级', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => ({ data: [] }) }))
    const channel = createEmbeddingChannel({ config: config(), fetchImpl })
    assert.deepEqual(await channel.ensure(['x'.repeat(4)]), [null])
  })

  it('向量为空 → 降级', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => ({ data: [{ embedding: [] }] }) }))
    const channel = createEmbeddingChannel({ config: config(), fetchImpl })
    assert.deepEqual(await channel.ensure(['x'.repeat(4)]), [null])
  })

  it('缺 endpoint → 降级，不调用', async () => {
    const logs = []
    const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => ({ data: [] }) }))
    const channel = createEmbeddingChannel({
      config: config({ endpoint: null }),
      fetchImpl,
      log: (message) => logs.push(message),
    })
    assert.deepEqual(await channel.ensure(['x'.repeat(4)]), [null])
    assert.equal(fetchImpl.calls.length, 0)
    assert.ok(logs.some((line) => /缺少 endpoint/.test(line)))
  })

  it('降级后 describe 报「降级中」', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 500 }))
    const channel = createEmbeddingChannel({ config: config(), fetchImpl, log: () => {} })
    await channel.ensure(['x'.repeat(4)])
    assert.match(channel.describe(), /降级中/)
  })

  it('**维度不一致 → 降级并说出来**（不是静默 0）', () => {
    const logs = []
    const channel = createEmbeddingChannel({
      config: config(),
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }),
      log: (message) => logs.push(message),
    })

    // 0 的意思是「正交」（确实无关）；维度不同意味着「不可比」（换过模型）。
    // 静默返回 0 会把一次配置事故当成一次干净的「不相关」判决。
    assert.equal(channel.cosine(Float64Array.from([1, 0]), Float64Array.from([1, 0, 0])), 0)
    assert.match(channel.describe(), /降级中/)
    assert.ok(logs.some((line) => /维度不一致/.test(line)), '降级必须说出来')
  })

  it('**失败不缓存**（否则这份 owner 数组直到进程重启都没有向量）', async () => {
    let fail = true
    const fetchImpl = async (url, init) => {
      if (fail) return { ok: false, status: 503 }
      return { ok: true, json: async () => ({ data: JSON.parse(init.body).input.map(() => ({ embedding: [1, 0] })) }) }
    }
    const channel = createEmbeddingChannel({ config: config(), fetchImpl, log: () => {} })
    const list = [{ ref: 'a.md', text: '甲' }]

    assert.deepEqual(await vectorizeOwners(list, channel), [{ ref: 'a.md', vector: null }])
    fail = false
    const second = await vectorizeOwners(list, channel)
    assert.ok(second[0].vector, '失败结果被缓存了 —— 服务恢复后仍然拿不到向量')
  })

  it('**缓存是 LRU 不是 FIFO**：命中即刷新序', async () => {
    const fetchImpl = fakeFetch((body) => ({
      ok: true,
      json: async () => ({ data: body.input.map(() => ({ embedding: [1, 0] })) }),
    }))
    const channel = createEmbeddingChannel({ config: config(), fetchImpl })
    const hot = 'hot-text'
    const cold = Array.from({ length: 1999 }, (_, index) => `cold-${index}`)

    await channel.ensure([hot])
    await channel.ensure(cold) // 缓存填满（2000 条，含 hot）
    assert.ok(channel.vectorOf(hot), 'hot 刚写进去')
    await channel.ensure(['cold-2000']) // 逐出一条：LRU 该逐 cold-0，FIFO 逐 hot

    assert.ok(channel.vectorOf(hot), '被反复命中的热文本被挤出去了 —— 这是 FIFO')
  })
})

describe('G1 语义判决（开闸后）', () => {
  /** 手工构造向量：让「改写」和 owner 的余弦到 0.9，让「无关」到 0.1。 */
  const channel = createEmbeddingChannel({ config: { embedding: { provider: 'lexical' } } })
  const ownerVectors = [
    { ref: 'README.md', vector: Float64Array.from([1, 0, 0, 0]) },
    { ref: 'docs/design.md', vector: Float64Array.from([0, 1, 0, 0]) },
  ]

  it('余弦过阈值 → refuse(semantic-owned-elsewhere)', () => {
    const candidate = { title: '记忆随仓库走，不随会话走', about: 'y'.repeat(20), vector: Float64Array.from([0.95, 0.05, 0, 0]) }
    const verdict = gateOwnership(candidate, { owners, vectors: ownerVectors, semanticThreshold: 0.8 })
    assert.equal(verdict.kind, 'refuse')
    assert.equal(verdict.code, 'semantic-owned-elsewhere')
    assert.equal(verdict.detail.owner.ref, 'README.md')
    assert.equal(verdict.detail.threshold, 0.8)
  })

  it('余弦不过阈值 → pass', () => {
    const candidate = { title: '记忆随仓库走，不随会话走', about: 'y'.repeat(20), vector: Float64Array.from([0.1, 0.1, 0.9, 0]) }
    const verdict = gateOwnership(candidate, { owners, vectors: ownerVectors, semanticThreshold: 0.8 })
    assert.equal(verdict.kind, 'pass')
  })

  it('**没有阈值就不判决**（向量给了也没用）', () => {
    const candidate = { title: '记忆随仓库走，不随会话走', about: 'y'.repeat(20), vector: Float64Array.from([1, 0, 0, 0]) }
    assert.equal(gateOwnership(candidate, { owners, vectors: ownerVectors, semanticThreshold: null }).kind, 'pass')
  })

  it('**没有向量就不判决**（阈值给了也没用）', () => {
    const candidate = { title: '记忆随仓库走，不随会话走', about: 'y'.repeat(20) }
    assert.equal(gateOwnership(candidate, { owners, vectors: ownerVectors, semanticThreshold: 0.1 }).kind, 'pass')
  })

  it('逐字包含优先于语义（code 不同，审计能区分）', () => {
    const verbatim = gateOwnership(
      { title: '记忆会过时，但正文永不改写', about: 'x'.repeat(20), vector: Float64Array.from([1, 0, 0, 0]) },
      { owners, vectors: ownerVectors, semanticThreshold: 0.8 },
    )
    assert.equal(verbatim.code, 'owned-elsewhere')
  })

  it('channel.cosine 用得上（G1 与通道同一个实现）', () => {
    assert.ok(Math.abs(channel.cosine(Float64Array.from([1, 0]), Float64Array.from([1, 0])) - 1) < 1e-9)
    assert.equal(channel.cosine(Float64Array.from([1, 0]), Float64Array.from([0, 1])), 0)
    assert.equal(channel.cosine(null, Float64Array.from([1, 0])), 0)
  })
})

describe('owner 向量缓存', () => {
  it('挂在数组上：同一个数组只算一次', async () => {
    const fetchImpl = fakeFetch((body) => ({
      ok: true,
      json: async () => ({ data: body.input.map(() => ({ embedding: [1, 0, 0, 0] })) }),
    }))
    const channel = createEmbeddingChannel({
      config: { embedding: { provider: 'http', endpoint: 'https://example.invalid/e', model: 'm' } },
      fetchImpl,
    })

    const list = [{ ref: 'a.md', text: '甲' }, { ref: 'b.md', text: '乙' }]
    await vectorizeOwners(list, channel)
    await vectorizeOwners(list, channel)
    assert.equal(fetchImpl.calls.length, 1, '第二次必须命中数组缓存')
  })

  it('通道关着时返回 null', async () => {
    const channel = createEmbeddingChannel({ config: {} })
    assert.equal(await vectorizeOwners([{ ref: 'a', text: 'x' }], channel), null)
  })
})
