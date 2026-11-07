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

/* ── 常驻层（pinned） ────────────────────────────────────────────── */

describe('常驻层', () => {
  const pinnedEntry = (id, overrides = {}) =>
    entry(id, { pinned: true, title: `常驻 ${id}`, about: `长期约束 ${id}`, ...overrides })

  it('查询打不中时 pinned 仍然在场（这是它存在的全部理由）', () => {
    const snapshot = snapshotOf(pinnedEntry('redis_dep'))
    const envelope = recall('完全无关的查询词', snapshot, { config: CONFIG })

    assert.equal(envelope.delivery.tier, 'abstain', '查询确实没命中')
    assert.equal(envelope.pinned.length, 1, 'pinned 被查询结果连坐了')
    assert.equal(envelope.pinned[0].memoryId, 'redis_dep')

    const rendered = renderRecall(envelope)
    assert.match(rendered, /常驻（pinned）/, 'abstain 时 pinned 段被吞了')
    assert.match(rendered, /redis_dep\.md/, 'pinned 条目没给路径')
    assert.match(rendered, /没有召回/, 'abstain 的结论仍然要说')
  })

  it('pinned 是**加性**的，不占 limit 名额', () => {
    const snapshot = snapshotOf(
      pinnedEntry('redis_dep'),
      entry('pool_cap', { title: '连接池上限排查', about: 'staging 健康检查超时' }),
    )
    const envelope = recall('连接池上限排查', snapshot, { config: CONFIG, limit: 1 })

    assert.equal(envelope.delivery.tier, 'content')
    assert.equal(envelope.results.length, 1, 'limit=1 只该给一条查询结果')
    assert.equal(envelope.pinned.length, 1, 'pinned 另算，没有挤掉查询结果')
    assert.equal(envelope.pinned[0].memoryId, 'redis_dep')
  })

  it('非 active/advisory 的 pinned 不注入（白名单，不是黑名单）', () => {
    const snapshot = snapshotOf(
      pinnedEntry('a', { status: 'active' }),
      pinnedEntry('b', { status: 'stale' }),
      pinnedEntry('c', { status: 'deprecated' }),
    )
    const envelope = recall('无关', snapshot, { config: CONFIG })
    assert.deepEqual(
      envelope.pinned.map((item) => item.memoryId),
      ['a'],
      '`stale` 只该给指针，不该进常驻注入',
    )
  })

  it('过期的 pinned 不注入（「常驻」不等于「永久」）', () => {
    const snapshot = snapshotOf(
      pinnedEntry('alive', { expiresAt: '2030-01-01T00:00:00Z' }),
      pinnedEntry('dead', { expiresAt: '2020-01-01T00:00:00Z' }),
    )
    const envelope = recall('无关', snapshot, { config: CONFIG, now: () => Date.parse('2026-01-01T00:00:00Z') })
    assert.deepEqual(envelope.pinned.map((item) => item.memoryId), ['alive'])
  })

  it('`maxPinned: 0` 关掉常驻层（可配置的逃生阀）', () => {
    const snapshot = snapshotOf(pinnedEntry('redis_dep'))
    const envelope = recall('无关', snapshot, { config: { ...CONFIG, recall: { maxPinned: 0 } } })
    assert.deepEqual(envelope.pinned, [])
  })

  it('excludeIds 对 pinned 同样生效（同一条不能既被排除又被注入）', () => {
    const snapshot = snapshotOf(pinnedEntry('redis_dep'))
    const envelope = recall('无关', snapshot, { config: CONFIG, excludeIds: ['redis_dep'] })
    assert.deepEqual(envelope.pinned, [])
  })

  it('abstain 兜底提示可覆盖，且默认不编造路径', () => {
    const snapshot = snapshotOf(entry('pool_cap', { title: '连接池上限排查', about: 'staging 健康检查超时' }))

    const withHint = renderRecall(recall('完全无关的查询词', snapshot, { config: CONFIG }), {
      fallbackHint: '> 兜底：先读 `docs/README.md`。',
    })
    assert.match(withHint, /docs\/README\.md/)

    const without = renderRecall(recall('完全无关的查询词', snapshot, { config: CONFIG }))
    assert.match(without, /兜底/, 'abstain 必须给下一步，不能只说「没找到」')
    assert.match(without, /glob/, '默认兜底指向确定性动作')
  })
})

/* ── 渲染给模型看的那一行 ─────────────────────────────────────────── */

/**
 * 上一版渲染的是 `置信：verified` —— 而那个值来自 `confidenceLabel(五项加权和)`，
 * `verified` 这个词在宣称一次**从未发生**的验证。更坏的是它**不可复算**：
 * 模型看不到那五项权重，也没法重算，只能选择相信。
 *
 * 现在渲染的是 `权威` —— 「有没有人看过这条并签了字」。这是可核的：
 * 去看 `memory_pending`、看 `ledger.jsonl`、或者直接问用户。
 *
 * `confidence` 仍然留在 envelope 上（`promote` 的进包资格按它比），
 * 只是**不再注入给模型**。
 */
describe('渲染 · 权威而不是置信', () => {
  const renderOne = (overrides = {}) => {
    const snapshot = snapshotOf(
      entry('pool_cap', { title: '连接池上限排查', about: 'staging 健康检查超时', ...overrides }),
    )
    return renderRecall(recall('连接池上限排查', snapshot, { config: CONFIG }))
  }

  it('**不再渲染 `置信`** —— 那个数不可复算', () => {
    assert.doesNotMatch(renderOne({ confidence: 'verified' }), /置信/)
  })

  it('未背书 → 明说「仅模型观察」', () => {
    assert.match(renderOne({ authority: 'observed' }), /权威：未背书（仅模型观察）/)
  })

  it('人签过字 → 说「用户确认」', () => {
    assert.match(renderOne({ authority: 'user-confirmed' }), /权威：用户确认/)
  })

  it('缺 `authority` 按 observed 算 —— 没写不等于有人背书', () => {
    assert.match(renderOne(), /未背书/)
  })

  it('envelope 上仍然带着 `confidence`（推广门要用）', () => {
    const snapshot = snapshotOf(
      entry('pool_cap', { title: '连接池上限排查', about: 'staging 健康检查超时', confidence: 'verified' }),
    )
    const envelope = recall('连接池上限排查', snapshot, { config: CONFIG })
    assert.equal(envelope.results[0].confidence, 'verified')
  })

  /**
   * 另外两个裸数字（指针层 `gate=0.975`、内容层页脚 `gate=0.95`）同样是
   * **相关性**分，却渲染在满是认知字段的上下文里。模型没法独立检验它，
   * 只能选择相信 —— 而「相信」正是要消掉的东西。
   */
  it('**内容层不再渲染裸数字 `gate=`**', () => {
    assert.doesNotMatch(renderOne(), /gate=/)
  })

  it('**指针层也不再渲染裸数字 `gate=`**', () => {
    const snapshot = snapshotOf(
      entry('pool_cap', { title: '连接池上限排查', about: 'staging 健康检查超时' }),
    )
    const envelope = recall('连接池上限排查', snapshot, {
      config: { ...CONFIG, thresholds: { ...CONFIG.thresholds, contentTier: 0.9999 } },
    })
    assert.equal(envelope.delivery.tier, 'pointers', JSON.stringify(envelope.delivery))
    const rendered = renderRecall(envelope)
    assert.doesNotMatch(rendered, /gate=/)
    assert.match(rendered, /\.dsh-memory\/memories\/pool_cap\.md/, '路径必须还在 —— 指针层的全部价值是「打开它」')
  })
})

/* ── 交付层级 · `stale` 只给指针 ──────────────────────────────────── */

/**
 * `docs/03` §8 轴一的承诺：`stale` → 只给 `pointers`（降级）。
 *
 * 0.3.4 之前它**只写在文档里** —— `recall` 把 `doc.confidence` 原样透传到
 * 渲染，从不拿它决定交付层级。一条被明确标成陈旧的记忆照样以正文注入，
 * 和它自己的标签矛盾。
 *
 * 与 0.3.1 退回的「`R4`/`R5` 只给指针」不同：`actionRisk` 是**关键词推断**
 * （正文有「部署」就算不可逆），过宽会永久屏蔽合法记忆；`confidence: stale`
 * 是**显式声明**。判据的性质决定它能不能当门用。
 */
describe('交付层级 · `stale` 只给指针', () => {
  it('全是 `stale` → 落到指针层，正文一条都不给', () => {
    const snapshot = snapshotOf(
      entry('stale_pool', { title: '连接池上限排查', about: 'staging 健康检查超时', confidence: 'stale' }),
    )
    const envelope = recall('连接池上限排查', snapshot, { config: CONFIG })
    assert.equal(envelope.delivery.tier, 'pointers', JSON.stringify(envelope.delivery))
    assert.equal(envelope.results.length, 0, 'stale 不能进正文')
    assert.deepEqual(
      envelope.pointers.map((pointer) => pointer.memoryId),
      ['stale_pool'],
      '**不能静默丢弃** —— 指针层的全部意义是「给路径」',
    )
  })

  it('新鲜 + 陈旧混排：正文只给新鲜的，陈旧的那条**以指针列出**', () => {
    const snapshot = snapshotOf(
      entry('fresh_pool', { title: '连接池上限排查', about: 'staging 健康检查超时' }),
      entry('stale_pool', {
        title: '连接池上限排查 · 旧版（已过时）',
        about: 'staging 健康检查超时 · 旧版（已过时）',
        confidence: 'stale',
      }),
    )
    const envelope = recall('连接池上限排查', snapshot, { config: CONFIG })
    assert.ok(envelope.results.length >= 1, '新鲜的那条必须能进正文')
    assert.ok(
      envelope.results.every((item) => item.confidence !== 'stale'),
      '正文里不能有 stale',
    )
    assert.ok(
      envelope.pointers.some((pointer) => pointer.memoryId === 'stale_pool'),
      `stale 那条必须出现在指针里（不静默丢），实际 pointers=${JSON.stringify(envelope.pointers.map((p) => p.memoryId))}`,
    )
    assert.match(renderRecall(envelope), /只给指针（已标陈旧/)
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
