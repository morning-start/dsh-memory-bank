/**
 * 召回管线：预算、五路信号、特征、双门、MMR。
 *
 * 这一组钉住的不是「排序对不对」（那是调参的事），而是**管线在哪里静默空转**：
 * 每一条都对应一个「看起来在跑、实际上一路什么都不做」的实现 ——
 * 恒空的 ngram 路、恒假的 exact 特征、恒 NaN 的阈值、形同虚设的预算。
 * 它们都不报错，只会让召回悄悄退化成「只按倒排表排个序」。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { compileSnapshot, RANKING } from '../lib/index-build.js'
import { ABSTAIN_REASONS, classify, recall, renderRecall } from '../lib/recall.js'

const BODY = [
  '# 功能名',
  '连接池上限排查',
  '',
  '# 生效条件',
  'staging 健康检查超时先看 DB_POOL_MAX。',
  '',
  '# 子功能',
  '`src/db/pool.ts` 里的连接数配置。',
  '',
  '# 执行',
  '加 worker 只会让更多请求排在同样 10 个连接后面。',
  '',
  '# 验证方式',
  '`kubectl exec` 读环境变量。',
  '',
  '# 不适用条件',
  '生产环境（连接池按实例数缩放）。',
].join('\n')

const entry = (id, overrides = {}) => ({
  id,
  path: `.dsh-memory/memories/${id}.md`,
  title: `记忆 ${id}`,
  kind: 'pitfall',
  about: `关于 ${id} 的说明`,
  body: BODY,
  status: 'active',
  confidence: 'inferred',
  provenance: 'self-concluded',
  actionRisk: 'R1',
  evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
  relations: [],
  claims: [],
  scope: ['repo:acme/api'],
  triggers: [],
  ...overrides,
})

const snapshotOf = (...entries) => ({ ...compileSnapshot(entries), selected: 'current' })

/** 与 `defaultConfig()` 的内容档同值；显式传，免得测试依赖配置默认值。 */
const CONFIG = {
  thresholds: {
    content: { identifier: 0.6, path: 0.7, error: 0.7, natural: 0.65, decision: 0.65, mixed: 0.65 },
    contentTier: 0.85,
    exactAnchorContent: 0.5,
    coverageFloor: 0.45,
  },
}

/* ── 预算 ─────────────────────────────────────────────────────────── */

describe('token 预算', () => {
  it('注入的是节选不是全文，estimatedTokens 按实际注入量算', () => {
    const body = `# 功能名\nstaging 连接池上限排查顺序\n\n${'正文细节。'.repeat(400)}`
    const snapshot = snapshotOf(
      entry('pool_cap', {
        title: 'staging 连接池上限排查顺序',
        about: 'staging 健康检查超时的排查顺序',
        body,
      }),
    )

    const envelope = recall('staging 连接池上限排查顺序', snapshot, { config: CONFIG })
    assert.equal(envelope.delivery.tier, 'content', JSON.stringify(envelope.abstain))

    const [result] = envelope.results
    assert.ok(result.excerpt.length <= 240, `excerpt 是全文（${result.excerpt.length} 字）—— 预算形同虚设`)
    assert.ok(result.excerpt.length < body.length)
    assert.equal(envelope.budget.estimatedTokens, Math.ceil(result.excerpt.length / 4))
    assert.equal(envelope.budget.truncated, true, '被截断过就必须标出来')
  })

  it('预算不足时 abstain 是「预算」措辞，且 eligible=false', () => {
    const snapshot = snapshotOf(
      entry('pool_cap', { title: '连接池上限排查', about: 'staging 健康检查超时', body: BODY }),
    )

    const envelope = recall('连接池上限排查', snapshot, { config: CONFIG, maxTokens: 1 })
    assert.equal(envelope.delivery.tier, 'abstain')
    assert.equal(envelope.delivery.eligible, false, 'abstain 却还标着可交付')
    assert.equal(envelope.abstain.reason, ABSTAIN_REASONS.BUDGET_EMPTY)
    assert.equal(envelope.abstain.gate, 'budget')

    const rendered = renderRecall(envelope)
    assert.match(rendered, /预算/)
    assert.doesNotMatch(rendered, /没有越过相关性门/, '预算问题被渲染成相关性结论')
  })
})

/* ── 五路信号 ─────────────────────────────────────────────────────── */

describe('ngram 路', () => {
  it('真的参与融合（查询覆盖率，而不是恒空的 Jaccard）', () => {
    const snapshot = snapshotOf(entry('pool_cap', { title: '连接池上限', about: 'staging 健康检查超时' }))
    const envelope = recall('连接池上限', snapshot, { config: CONFIG })
    assert.equal(envelope.delivery.tier, 'content', JSON.stringify(envelope.abstain))
    assert.ok(
      envelope.results[0].lanes.includes('ngram'),
      `lanes=${JSON.stringify(envelope.results[0].lanes)} —— ngram 路恒空（Jaccard 门槛数学上不可达）`,
    )
  })
})

describe('exact 路', () => {
  it('**符号命中不要求整串相等**：「看 createPool 的实现」要能命中', () => {
    const snapshot = snapshotOf(
      entry('pool_cap', {
        title: 'z',
        about: 'zz',
        // 正文与查询零 token 重叠：内容档要求的覆盖率拿不到，只能落到 pointers。
        body: '# 功能名\nzzz\n\n# 生效条件\nqqq\n',
        evidence: [{ kind: 'symbol', ref: 'createPool' }],
      }),
    )

    const envelope = recall('看 createPool 的实现', snapshot, { config: CONFIG })
    assert.equal(envelope.delivery.tier, 'pointers', JSON.stringify(envelope.abstain))
    assert.equal(envelope.pointers[0].memoryId, 'pool_cap')
  })

  it('短标识符不做包含匹配（长度门槛）', () => {
    const snapshot = snapshotOf(
      entry('pool_cap', {
        title: 'z',
        about: 'zz',
        body: '# 功能名\nzzz\n\n# 生效条件\nqqq\n',
        evidence: [{ kind: 'symbol', ref: 'id' }],
      }),
    )
    assert.equal(recall('看 xid 的实现', snapshot, { config: CONFIG }).delivery.tier, 'abstain')
  })

  it('**exact 命中的 anchor 特征真的进特征集**（曾经恒为 undefined）', () => {
    const snapshot = snapshotOf(
      entry('pool_cap', {
        title: '连接池上限',
        about: 'x',
        body: '与查询毫无重叠的正文。'.repeat(20),
        evidence: [{ kind: 'symbol', ref: 'createPool' }],
      }),
    )

    // 阈值抬到 0.99：除了 anchor 之外没有任何候选能过门，detail 报的就是它。
    const envelope = recall('createPool', snapshot, {
      config: { thresholds: { content: { identifier: 0.99 } } },
    })
    assert.equal(envelope.delivery.tier, 'abstain')
    const reported = Number(envelope.abstain.detail.match(/最高 gate 分数 ([\d.]+)/)[1])
    assert.equal(reported, 0.9, `exact 命中没有 anchor 分（报 ${reported}）—— 特征集读错了字段`)
  })
})

/* ── 双门 ─────────────────────────────────────────────────────────── */

describe('阈值', () => {
  it('配置只给了部分标签时落到 0.65 兜底（不是 NaN）', () => {
    const snapshot = snapshotOf(
      entry('pool_cap', {
        title: '连接池上限排查',
        about: 'staging 健康检查超时',
        body: `# 功能名\n连接池上限排查的顺序\n\n${BODY}`,
        triggers: ['连接池上限'],
      }),
    )

    const envelope = recall('连接池上限排查的顺序是什么', snapshot, {
      config: { thresholds: { content: { identifier: 0.6 } } },
    })
    assert.ok(Number.isFinite(envelope.threshold), `阈值是 ${envelope.threshold} —— Math.max(...[undefined])`)
    assert.equal(envelope.threshold, 0.65)
    assert.equal(envelope.delivery.tier, 'content', JSON.stringify(envelope.abstain))
  })

  it('abstain 的 detail 报的是**最高** gate 分数（不是融合顺序第一条）', () => {
    // noise 只在 exact 路（触发词）命中，分数很低；worker_count 靠文本特征拿到高分。
    // 融合顺序是 exact 先行 —— 取 `scored[0]` 会报成 noise 的那个低分。
    const snapshot = snapshotOf(
      entry('noise', { title: 'z', about: 'zz', body: 'zzz', triggers: ['error 报错'] }),
      entry('worker_count', {
        title: 'worker 数量与 staging 超时',
        about: 'worker 数量 排查 连接池上限',
        triggers: ['worker 数量'],
      }),
    )
    const query = 'error 报错 createPool staging worker 数量 连接池上限 超时'

    // 先跑一遍宽松阈值：拿 results 里的 gateScore 当作「最高分」的真值。
    const loose = recall(query, snapshot, { config: CONFIG })
    assert.equal(loose.delivery.tier, 'content', JSON.stringify(loose.abstain))
    const expected = Math.max(...loose.results.map((result) => result.gateScore))

    const strict = recall(query, snapshot, {
      config: {
        ...CONFIG,
        thresholds: {
          ...CONFIG.thresholds,
          content: {
            ...CONFIG.thresholds.content,
            natural: 0.99,
            identifier: 0.99,
            mixed: 0.99,
            error: 0.99,
          },
        },
      },
    })
    assert.equal(strict.delivery.tier, 'abstain')
    const reported = Number(strict.abstain.detail.match(/最高 gate 分数 ([\d.]+)/)[1])
    assert.equal(reported, expected, `detail 报 ${reported}，实际最高 ${expected}`)
  })
})

/* ── MMR ──────────────────────────────────────────────────────────── */

describe('MMR', () => {
  it('mmrSuppressed 里不出现重复 id（suppress 要从 remaining 移除）', () => {
    // pool_cap 与 pool_cap_dup 指纹完全相同 —— 第二条必须被抑制一次。
    // 抑制后不从 remaining 移除的话，下一轮还会再抑制它一次。
    const snapshot = snapshotOf(
      entry('pool_cap', {
        title: 'staging 连接池上限排查',
        about: 'staging 健康检查超时 连接池上限',
        triggers: ['连接池上限'],
      }),
      entry('pool_cap_dup', {
        title: 'staging 连接池上限排查',
        about: 'staging 健康检查超时 连接池上限',
        triggers: ['连接池上限'],
      }),
      entry('worker_count', {
        title: 'worker 数量与 staging 超时的关系',
        about: 'worker 数量 排查',
        triggers: ['worker 数量排查'],
      }),
    )

    const envelope = recall('staging 连接池上限 排查 worker 数量 超时', snapshot, { config: CONFIG, limit: 3 })
    assert.equal(envelope.delivery.tier, 'content', JSON.stringify(envelope.abstain))
    const suppressed = envelope.mmrSuppressed ?? []
    assert.deepEqual(suppressed, [...new Set(suppressed)], `mmrSuppressed 有重复 id：${JSON.stringify(suppressed)}`)
    assert.equal(envelope.results.length, 2)
  })
})

/* ── 分类 ─────────────────────────────────────────────────────────── */

describe('查询分类', () => {
  it('`[error]` 不是路径（剥光之后不是 path）', () => {
    assert.deepEqual(classify('[error]'), ['error'])
  })

  it('真路径仍然是路径', () => {
    assert.ok(classify('src/db/pool.ts').includes('path'))
    assert.ok(classify('src/db/pool').includes('path'), '裸目录路径没有扩展名，但确实是路径')
  })
})

/* ── 时钟 ─────────────────────────────────────────────────────────── */

describe('now 透传', () => {
  it('新鲜度用调用方注入的时钟（否则同一个查询永远同一个分数）', () => {
    const snapshot = snapshotOf(
      entry('pool_cap', {
        title: '连接池上限排查',
        about: 'staging 健康检查超时',
        lastVerifiedAt: '2026-01-01T00:00:00Z',
      }),
    )
    const query = '连接池上限排查'

    const fresh = recall(query, snapshot, { config: CONFIG, now: () => Date.parse('2026-01-02T00:00:00Z') })
    const stale = recall(query, snapshot, { config: CONFIG, now: () => Date.parse('2036-01-01T00:00:00Z') })
    assert.equal(fresh.delivery.tier, 'content')
    assert.equal(stale.delivery.tier, 'content')
    assert.ok(
      fresh.results[0].score > stale.results[0].score,
      `刚验证过的记忆没有更高分：${fresh.results[0].score} vs ${stale.results[0].score}`,
    )
  })
})

/* ── 排序常量 ─────────────────────────────────────────────────────── */

describe('排序常量', () => {
  it('graphKindStrength 只列 compileGraph 真正会产生的关系', () => {
    assert.deepEqual(Object.keys(RANKING.graphKindStrength).sort(), ['contradicts', 'related_to', 'supersedes'])
    assert.equal(RANKING.graphKindStrength.contradicts, 1)
    assert.equal(RANKING.graphKindStrength.supersedes, 0.95)
    assert.equal(RANKING.graphKindStrength.related_to, 0, '「碰巧同仓库」不构成证据')
  })
})
