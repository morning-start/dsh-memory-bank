/**
 * 生命周期：衰减、陈旧提示、合并、dream pass。
 *
 * 三条不可协商的规则各有一组用例：
 *   1. 休眠是信息性的，绝不改 confidence；
 *   2. dream 只提议结构，不写记忆也不写关系；
 *   3. 没有近邻的孤儿保持孤儿。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DECAY,
  DREAM,
  accessScore,
  bestOf,
  consolidate,
  consolidationCandidates,
  dream,
  freshness,
  isDormant,
  isExpired,
  lifecycleReport,
  referenceTimestamp,
  reviewDue,
  reviewHints,
  stripQuoted,
  suggestsDeprecation,
} from '../lib/lifecycle.js'

const NOW = Date.parse('2026-11-06T00:00:00Z')
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString()

const entry = (overrides = {}) => ({
  id: 'm',
  title: 'a memory',
  kind: 'pitfall',
  about: 'about',
  body: '# 功能名\na\n# 生效条件\nb\n# 子功能\nc\n# 执行\nd\n# 验证方式\ne\n# 不适用条件\nf',
  status: 'active',
  confidence: 'inferred',
  evidence: [{ kind: 'file', ref: 'src/a.ts' }],
  relations: [],
  scope: ['repo:x'],
  createdAt: daysAgo(400),
  modifiedAt: daysAgo(400),
  lastVerifiedAt: daysAgo(400),
  ...overrides,
})

describe('衰减', () => {
  it('新鲜度有地板：3 年没碰仍然 35%', () => {
    assert.ok(freshness(entry({ lastVerifiedAt: daysAgo(3650) }), NOW) >= DECAY.freshnessFloor)
  })

  it('新鲜度随天数单调下降', () => {
    const fresh = freshness(entry({ lastVerifiedAt: daysAgo(0) }), NOW)
    const older = freshness(entry({ lastVerifiedAt: daysAgo(365) }), NOW)
    assert.ok(fresh > older)
  })

  it('参考时间用 MAX 而不是 COALESCE（否则「上次确认之后的内容编辑」被静默丢弃）', () => {
    const value = referenceTimestamp({
      lastVerifiedAt: daysAgo(300),
      modifiedAt: daysAgo(2),
      createdAt: daysAgo(400),
    })
    assert.equal(value, new Date(NOW - 2 * 86_400_000).toISOString())
  })

  it('无法解析的候选被跳过，不让读崩溃', () => {
    assert.equal(referenceTimestamp({ lastVerifiedAt: 'not-a-date', modifiedAt: daysAgo(5) }), new Date(NOW - 5 * 86_400_000).toISOString())
    assert.equal(referenceTimestamp({}), null)
  })

  it('休眠只报告，不改 confidence', () => {
    const old = entry({ lastVerifiedAt: daysAgo(120), confidence: 'verified' })
    assert.equal(isDormant(old, NOW), true)
    assert.equal(old.confidence, 'verified') // **没有被改写**
  })

  it('90 天内不算休眠', () => {
    assert.equal(isDormant(entry({ lastVerifiedAt: daysAgo(89) }), NOW), false)
  })

  it('建议弃用是 180 天', () => {
    assert.equal(suggestsDeprecation(entry({ lastVerifiedAt: daysAgo(179) }), NOW), false)
    assert.equal(suggestsDeprecation(entry({ lastVerifiedAt: daysAgo(181) }), NOW), true)
  })

  it('访问分数对数饱和到 50', () => {
    assert.equal(accessScore({ accessCount: 0 }), 0)
    assert.equal(accessScore({ accessCount: 50 }), 1)
    assert.ok(accessScore({ accessCount: 5 }) > accessScore({ accessCount: 1 }))
  })

  /* ── 回归：三处参考时刻必须同一个函数（COALESCE vs MAX） ── */

  it('**刚改过的记忆不算休眠**（按 MAX 语义，不是 lastVerifiedAt）', () => {
    // 上一次确认是 300 天前，但 2 天前又改了内容 —— 那条编辑不能被静默丢弃
    const edited = entry({ lastVerifiedAt: daysAgo(300), modifiedAt: daysAgo(2), createdAt: daysAgo(400) })
    assert.equal(isDormant(edited, NOW), false, '旧实现按 lastVerifiedAt 算，把刚改过的记忆判成休眠')
    assert.equal(suggestsDeprecation(edited, NOW), false)
  })

  it('坏时间戳被跳过，不因为坏值永远休眠', () => {
    const broken = entry({ lastVerifiedAt: 'not-a-date', modifiedAt: daysAgo(2), createdAt: 'garbage' })
    assert.equal(isDormant(broken, NOW), false, '旧实现 daysSince(坏值) = Infinity，永远休眠')
  })

  it('reviewHints 与 isDormant 用同一个参考时刻', () => {
    const edited = entry({ body: 'PR #10 has been open for a while', lastVerifiedAt: daysAgo(300), modifiedAt: daysAgo(2) })
    assert.deepEqual(reviewHints(edited, NOW), [], '刚改过就不该点火')
  })
})

describe('陈旧提示', () => {
  it('14 天内不点火（锚点太新）', () => {
    const fresh = entry({ body: 'PR #10 is open and waiting on the platform team', lastVerifiedAt: daysAgo(2) })
    assert.deepEqual(reviewHints(fresh, NOW), [])
  })

  it('open-pr-reference 在 14 天后点火', () => {
    const stale = entry({ body: 'PR #10 has been open for a while', lastVerifiedAt: daysAgo(30) })
    assert.ok(reviewHints(stale, NOW).some((hint) => hint.label === 'open-pr-reference'))
  })

  it('waiting-on 需要 60 字符内有一个具名 agent', () => {
    const unnamed = entry({ body: 'waiting for the init container image pull', lastVerifiedAt: daysAgo(30) })
    assert.ok(!reviewHints(unnamed, NOW).some((hint) => hint.label === 'waiting-on'))

    const named = entry({ body: 'waiting on Baskar for the sign-off', lastVerifiedAt: daysAgo(30) })
    assert.ok(reviewHints(named, NOW).some((hint) => hint.label === 'waiting-on'))
  })

  it('引号/反引号内不算断言', () => {
    const quoted = entry({ body: 'the phrase "expires 2026-06-29" appears in the config', lastVerifiedAt: daysAgo(30) })
    assert.ok(!reviewHints(quoted, NOW).some((hint) => hint.label === 'expires'))
    assert.equal(stripQuoted('a "b" c').replace(/\s+/g, ' ').trim(), 'a c')
  })

  it('裸单引号不是定界符（更常是所有格）', () => {
    assert.equal(stripQuoted("Boomtastic's note"), "Boomtastic's note")
  })

  it('时间无关类型不因为「旧」而点火', () => {
    const convention = entry({ kind: 'convention', body: 'PR #10 is open', lastVerifiedAt: daysAgo(30) })
    assert.deepEqual(reviewHints(convention, NOW), [])
  })

  it('deprecated 记忆在每个面都被跳过（弃用就是那次和解）', () => {
    const deprecated = entry({ status: 'deprecated', body: 'PR #10 is open', lastVerifiedAt: daysAgo(30) })
    assert.deepEqual(reviewHints(deprecated, NOW), [])
  })

  it('expires / as-of 自带时钟，不看锚点年龄', () => {
    const fresh = entry({ body: 'token expires 2026-06-29', lastVerifiedAt: daysAgo(1) })
    assert.ok(reviewHints(fresh, NOW).some((hint) => hint.label === 'expires'))
  })

  it('reviewDue / isExpired 按日期判', () => {
    assert.equal(reviewDue({ reviewBy: daysAgo(1) }, NOW), true)
    assert.equal(reviewDue({ reviewBy: daysAgo(-1) }, NOW), false)
    assert.equal(isExpired({ expiresAt: daysAgo(1) }, NOW), true)
    assert.equal(isExpired({ expiresAt: null }, NOW), false)
  })
})

describe('合并', () => {
  const similar = [
    entry({ id: 'a', title: 'pool cap', about: 'staging timeout because of pool cap', body: 'staging timeout because of pool cap in db' }),
    entry({ id: 'b', title: 'pool cap 2', about: 'staging timeout because of pool cap', body: 'staging timeout because of pool cap in db' }),
    entry({ id: 'c', title: 'unrelated', kind: 'decision', about: 'totally different thing about deploy', body: 'totally different thing about deploy pipeline' }),
  ]

  it('近重复被分到一组', () => {
    const groups = consolidationCandidates(similar, { threshold: 0.5 })
    assert.ok(groups.length >= 1)
    assert.deepEqual(groups[0].ids.sort(), ['a', 'b'])
  })

  it('不同 kind 不合并', () => {
    const groups = consolidationCandidates(
      [
        entry({ id: 'a', about: 'same words here now', body: 'same words here now' }),
        entry({ id: 'b', kind: 'decision', about: 'same words here now', body: 'same words here now' }),
      ],
      { threshold: 0.5 },
    )
    assert.equal(groups.length, 0)
  })

  it('bestOf 取最高 confidence，平手取最近更新', () => {
    const best = bestOf([
      entry({ id: 'a', confidence: 'inferred', modifiedAt: daysAgo(10) }),
      entry({ id: 'b', confidence: 'verified', modifiedAt: daysAgo(20) }),
      entry({ id: 'c', confidence: 'verified', modifiedAt: daysAgo(2) }),
    ])
    assert.equal(best.id, 'c')
  })

  it('合并产物是 advisory（先降级，等一次人工确认）', () => {
    const merged = consolidate([similar[0], similar[1]], 'merge')
    assert.equal(merged.status, 'advisory')
    assert.deepEqual(merged.supersedes.sort(), ['a', 'b'])
    assert.ok(merged.relations.every((relation) => relation.type === 'supersedes'))
  })

  it('summarize 产出紧凑摘要', () => {
    const merged = consolidate([similar[0], similar[1]], 'summarize')
    assert.match(merged.title, /^\[summarize\]/)
    assert.match(merged.body, /- \*\*pool cap\*\*/)
  })

  it('少于 2 条抛错', () => {
    assert.throws(() => consolidate([similar[0]]), /at least 2/)
  })

  /* ── 回归：consolidate 压平 evidence → 合并产物立刻 quarantined ── */

  it('合并产物**原样保留**每条锚点的 kind 与 hash', () => {
    const merged = consolidate(
      [
        entry({
          id: 'a',
          evidence: [
            { kind: 'symbol', ref: 'src/a.ts#createPool', hash: 'h1' },
            { kind: 'file', ref: 'src/a.ts:1-2' },
          ],
        }),
        entry({
          id: 'b',
          evidence: [
            { kind: 'commit', ref: 'abc1234' },
            { kind: 'file', ref: 'src/a.ts:1-2' },
          ],
        }),
      ],
      'merge',
    )
    assert.deepEqual(
      merged.evidence.map((item) => `${item.kind}:${item.ref}`).sort(),
      ['commit:abc1234', 'file:src/a.ts:1-2', 'symbol:src/a.ts#createPool'],
      '旧实现把 symbol / commit 伪造成文件路径，合并产物一落盘就 quarantined',
    )
    assert.equal(merged.evidence.find((item) => item.kind === 'symbol').hash, 'h1')
  })
})

describe('dream pass', () => {
  const chain = [
    entry({ id: 'a', relations: [{ type: 'related_to', target: 'b' }] }),
    entry({ id: 'b', relations: [{ type: 'related_to', target: 'c' }] }),
    entry({ id: 'c', relations: [{ type: 'related_to', target: 'a' }] }),
    entry({ id: 'lonely', relations: [] }),
  ]

  it('dream 只产出提议，不写任何东西', () => {
    const report = dream(chain, { now: NOW })
    assert.ok(Array.isArray(report.passes.centrality))
    assert.ok(Array.isArray(report.passes.clusters))
    assert.ok(Array.isArray(report.passes.orphans))
    // **每个发现都是纯数据结构，没有 entry 对象被改写**
    for (const finding of report.passes.centrality) {
      assert.equal(typeof finding.subjectId, 'string')
      assert.equal(typeof finding.score, 'number')
    }
  })

  it('PageRank 归一化到本次运行自己的最高分', () => {
    const report = dream(chain, { now: NOW })
    if (report.passes.centrality.length === 0) return
    assert.equal(report.passes.centrality[0].score, 1)
    for (const finding of report.passes.centrality) {
      assert.ok(finding.score > 0 && finding.score <= 1)
    }
  })

  it('排序确定性：同一张图跑两次逐字节相同', () => {
    assert.equal(JSON.stringify(dream(chain, { now: NOW })), JSON.stringify(dream(chain, { now: NOW })))
  })

  it('pinned 记忆被跳过（手挑的层和计算出的层应该大量重叠）', () => {
    const pinned = chain.map((item) => ({ ...item, pinned: true }))
    const report = dream(pinned, { now: NOW })
    assert.equal(report.passes.centrality.length, 0)
  })

  it('孤儿没有近邻就保持孤儿（不能连到排名最高的任何东西）', () => {
    const report = dream([entry({ id: 'solo', about: 'zzz qqq xxx', body: 'zzz qqq xxx' })], { now: NOW })
    assert.deepEqual(report.passes.orphans, [])
  })

  it('孤儿有近邻才提议连边', () => {
    const report = dream(
      [
        entry({ id: 'a', about: 'staging pool cap timeout', body: 'staging pool cap timeout' }),
        entry({ id: 'b', about: 'staging pool cap timeout', body: 'staging pool cap timeout' }),
      ],
      { now: NOW },
    )
    assert.ok(report.passes.orphans.length >= 1)
    assert.equal(report.passes.orphans[0].kind, 'edge')
  })

  it('簇大小有上下界（两条是关系，不是社群）', () => {
    const two = [
      entry({ id: 'a', relations: [{ type: 'related_to', target: 'b' }] }),
      entry({ id: 'b', relations: [{ type: 'related_to', target: 'a' }] }),
    ]
    const report = dream(two, { now: NOW })
    assert.equal(report.passes.clusters.length, 0) // 2 < minClusterSize 3
  })

  it('常量来自已发表默认值', () => {
    assert.equal(DREAM.centrality.damping, 0.85)
    assert.equal(DREAM.clusters.minDensity, 0.5)
    assert.equal(DREAM.clusters.minClusterSize, 3)
  })

  /* ── 回归：模板字符串把 undefined 变成字面量 token ── */

  it('没有 about / title 的孤儿不因为 "undefined" 字面量被连边', () => {
    const report = dream(
      [
        entry({ id: 'a', about: undefined, title: undefined, relations: [] }),
        entry({ id: 'b', about: undefined, title: undefined, relations: [] }),
      ],
      { now: NOW },
    )
    assert.deepEqual(report.passes.orphans, [], '两条空记忆共享的 token 只能是 "undefined" —— 那是凭空造边')
  })
})

describe('整体报告', () => {
  it('lifecycleReport 汇总所有信号', () => {
    const report = lifecycleReport(
      [
        entry({ id: 'a', lastVerifiedAt: daysAgo(200), reviewBy: daysAgo(1) }),
        entry({ id: 'b', lastVerifiedAt: daysAgo(1), expiresAt: daysAgo(1) }),
      ],
      { now: NOW },
    )
    assert.equal(report.active, 2)
    assert.ok(report.dormant.includes('a'))
    assert.ok(report.reviewDue.some((item) => item.id === 'a'))
    assert.ok(report.expired.some((item) => item.id === 'b'))
  })
})
