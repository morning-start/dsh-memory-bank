/**
 * 断言模型：抽取、限定、状态判定、对账。
 *
 * 每一条用例都对应一条被语料打出来的规则 —— 改规则前先看这里的注释。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  blankNonAssertions,
  claimStats,
  extractClaims,
  reconcileClaims,
  rederiveClaims,
  resolveClaim,
  syncClaims,
} from '../lib/claims.js'

const options = { namespaceDefaultRepo: 'acme-api' }

const refs = (text, opts = options) => extractClaims(text, opts).map((claim) => `${claim.kind}:${claim.ref}:${claim.state}`)

describe('抽取', () => {
  it('PR 带 sigil → 认；裸 `PR 3` → 不认', () => {
    assert.deepEqual(refs('see PR #10 for the fix'), ['pull-request:acme-api#10:unverified'])
    assert.deepEqual(refs('the plan has PR 3 and PR 4 in it'), [])
  })

  it('sigil 与 kind 之间只允许空格/制表符，不跨行', () => {
    // 列表项结尾的 `NO PR` 绝不能绑到下一行的 `2.`
    const text = '1. this is NO PR\n2. #12 is open'
    const found = refs(text, { namespaceDefaultRepo: 'acme-api' })
    assert.ok(!found.includes('pull-request:acme-api#12:resolved'), '不能跨行绑定')
  })

  it('URL 里的 repo 优先于 namespace 默认', () => {
    const found = refs('https://github.com/other-org/other-repo/pull/77 merged')
    assert.deepEqual(found, ['pull-request:other-repo#77:resolved'])
  })

  it('文内紧邻 repo 名（括号 / 空格两种写法）', () => {
    assert.deepEqual(refs('PR #10 (platform-infra) is open'), ['pull-request:platform-infra#10:open'])
    assert.deepEqual(refs('platform-infra PR #11 merged'), ['pull-request:platform-infra#11:resolved'])
  })

  it('repo 名永不出现在路径分隔符之后', () => {
    // 没有 lookbehind 时，`feature/serve-transport. PR #10` 会把 serve-transport 读成 repo
    const found = refs('branch feature/serve-transport. PR #10 is open')
    assert.deepEqual(found, ['pull-request:acme-api#10:open'])
  })

  it('单连字符不构成 repo（曾从散文里发明三个 repo）', () => {
    assert.deepEqual(refs('docs-only #168 is open'), ['issue:acme-api#168:open'])
    assert.deepEqual(refs('re-point #155 merged'), ['issue:acme-api#155:resolved'])
  })

  it('工单不是 repo', () => {
    // PROJ-8#65 曾被读成 repo=PROJ-8
    const found = refs('PROJ-8#65 merged')
    assert.ok(found.every((item) => !item.includes('PROJ-8#')), JSON.stringify(found))
  })

  it('`shipped` 不算 resolved（同一个词两个意思）', () => {
    assert.deepEqual(refs('doc shipped PR #168'), ['pull-request:acme-api#168:unverified'])
    assert.deepEqual(refs('PR #65 SHIPPED'), ['pull-request:acme-api#65:unverified'])
  })

  it('`fixed` 不算 resolved（在叙述修复，不是 PR 的状态）', () => {
    assert.deepEqual(refs('Fixed in PR #873'), ['pull-request:acme-api#873:unverified'])
  })

  it('merge HELD → open（HELD 是明确的「未合并」）', () => {
    assert.deepEqual(refs('PR #10 merge HELD'), ['pull-request:acme-api#10:open'])
  })

  it('无状态 ref → unverified，不是 open', () => {
    assert.deepEqual(refs('Fixed in PR #873'), ['pull-request:acme-api#873:unverified'])
  })

  it('没有 namespace 默认时，无法限定的 ref 被丢弃（dropping beats guessing）', () => {
    assert.deepEqual(extractClaims('see PR #10', { namespaceDefaultRepo: null }), [])
  })

  it('同一 (kind, ref) 只保留最强的一条', () => {
    const found = extractClaims('PR #10 is open. Later, PR #10 was merged.', options)
    assert.equal(found.length, 1)
    assert.equal(found[0].state, 'resolved')
  })

  it('依赖版本断言', () => {
    assert.deepEqual(refs('upgraded vitest@2.0.3 across packages'), ['dependency:vitest@2.0.3:resolved'])
  })
})

describe('预处理', () => {
  it('wiki-link 被抹空（11/11 条来自这里的 claim 都错）', () => {
    const text = 'See [[PR #10 open: the promotion bridge]] for context.'
    assert.equal(extractClaims(text, options).length, 0)
    const blanked = blankNonAssertions(text)
    assert.equal(blanked.length, text.length, '抹空必须保留偏移')
    assert.equal(blanked.replace(/\s+/g, ' ').trim(), 'See for context.')
  })

  it('反引号内不算断言', () => {
    assert.equal(extractClaims('the literal text `PR #10 open` is a string', options).length, 0)
  })

  it('抹空保留偏移（等长空格）', () => {
    const text = '[[PR #1]] and PR #2 merged'
    assert.equal(text.length, blankNonAssertions(text).length)
  })
})

describe('对账', () => {
  const entries = [
    { id: 'a', status: 'active', scope: ['repo:x'], claims: [{ kind: 'pull-request', ref: 'x#10', state: 'open' }] },
    { id: 'b', status: 'active', scope: ['repo:x'], claims: [{ kind: 'pull-request', ref: 'x#10', state: 'resolved' }] },
    { id: 'c', status: 'active', scope: ['repo:x'], claims: [{ kind: 'issue', ref: 'x#99', state: 'unverified' }] },
    { id: 'd', status: 'deprecated', scope: ['repo:x'], claims: [{ kind: 'issue', ref: 'x#98', state: 'open' }] },
  ]

  it('同 ref 既 open 又 resolved → 矛盾', () => {
    const result = reconcileClaims(entries)
    assert.equal(result.contradicted.length, 1)
    assert.equal(result.contradicted[0].ref, 'x#10')
    assert.deepEqual(result.contradicted[0].openBy, ['a'])
    assert.deepEqual(result.contradicted[0].resolvedBy, ['b'])
  })

  it('unverified 与 open 是不相交的集合', () => {
    const result = reconcileClaims(entries)
    assert.ok(result.unverified.some((item) => item.ref === 'x#99'))
    assert.ok(!result.open.some((item) => item.ref === 'x#99'))
  })

  it('open 与 openActionable 是两个数字（deprecated 上的不算可行动）', () => {
    const stats = claimStats(entries)
    assert.equal(stats.open, 2) // a + d
    assert.equal(stats.openActionable, 1) // 只有 a
  })

  it('矛盾**只在同 namespace 内**成立（跨 namespace 会编造）', () => {
    const crossNamespace = [
      { id: 'a', status: 'active', scope: ['repo:x'], claims: [{ kind: 'pull-request', ref: 'y#10', state: 'open' }] },
      { id: 'b', status: 'active', scope: ['repo:z'], claims: [{ kind: 'pull-request', ref: 'y#10', state: 'resolved' }] },
    ]
    assert.equal(reconcileClaims(crossNamespace).contradicted.length, 0)
  })

  it('sample 枚举每一条 open claim，矛盾优先', () => {
    const stats = claimStats(entries)
    assert.equal(stats.sample[0].contradicted, true)
    assert.ok(stats.sample.length >= 1)
  })
})

describe('同步与重推导', () => {
  it('散文变了 → 丢弃 resolution', () => {
    const entry = {
      id: 'a',
      body: 'PR #10 is merged',
      claims: [{ kind: 'pull-request', ref: 'acme-api#10', state: 'open', resolvedState: 'resolved', resolvedBy: 'x' }],
    }
    const next = syncClaims(entry, options)
    assert.equal(next[0].state, 'resolved')
    assert.equal(next[0].resolvedState, undefined)
  })

  it('抽取器变聪明了 → 保留 resolution', () => {
    const entry = {
      id: 'a',
      body: 'PR #10 is open',
      claims: [{ kind: 'pull-request', ref: 'acme-api#10', state: 'open', resolvedState: 'resolved', resolvedBy: 'x' }],
    }
    const next = rederiveClaims(entry, options)
    assert.equal(next[0].resolvedState, 'resolved')
    assert.equal(next[0].resolvedBy, 'x')
  })

  it('resolveClaim 只写 resolution 三列，不改 state', () => {
    const entry = { id: 'a', claims: [{ kind: 'pull-request', ref: 'acme-api#10', state: 'open' }] }
    const { entry: next, changed } = resolveClaim(entry, {
      kind: 'pull-request',
      ref: 'acme-api#10',
      resolvedState: 'resolved',
      resolvedBy: 'b',
      resolvedAt: '2026-11-06T00:00:00Z',
    })
    assert.equal(changed, true)
    assert.equal(next.claims[0].state, 'open')
    assert.equal(next.claims[0].resolvedState, 'resolved')
    assert.equal(next.claims[0].resolvedBy, 'b')
  })
})
