/**
 * 推广包：**只产出包，不写全局存储。**
 *
 * 这一组的核心不变量：
 *   1. 硬排除必须硬 —— 含密钥的、终态的、没证据的，永远不出现在包里；
 *   2. 输出必须可移植 —— 不含绝对路径、不含会话 id；
 *   3. 只提名，不搬运 —— 推广与否是人的判断。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { DEFAULT_FORBIDDEN, assertRulesCompile } from '../lib/gate.js'
import {
  PROMOTION_SCHEMA,
  buildPromotion,
  detectCommit,
  detectRepo,
  renderPromotion,
  summarizePromotion,
} from '../lib/promote.js'

let root

const entry = (id, overrides = {}) => ({
  id,
  title: `记忆 ${id}`,
  kind: 'pitfall',
  about: `关于 ${id} 的说明`,
  body: `# 功能名\n${id}\n\n# 生效条件\n通用做法。\n\n# 子功能\n组件。\n\n# 执行\n执行。\n\n# 验证方式\n验证。\n\n# 不适用条件\n无。`,
  status: 'active',
  confidence: 'verified',
  provenance: 'file-derived',
  actionRisk: 'R1',
  evidence: [{ kind: 'file', ref: 'src/db/pool.ts:17' }],
  scope: ['repo:acme/api'],
  triggers: ['连接池'],
  claims: [],
  createdAt: '2026-01-01T00:00:00Z',
  modifiedAt: '2026-01-01T00:00:00Z',
  lastVerifiedAt: '2026-01-01T00:00:00Z',
  ...overrides,
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-promote-'))
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@acme/api' }), 'utf8')
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`, 'utf8')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('仓库身份', () => {
  it('detectRepo 读 package.json 的 name（含 scope）', () => {
    assert.equal(detectRepo(root), '@acme/api')
  })

  it('没有 package.json 时回退 .git/config', () => {
    rmSync(join(root, 'package.json'))
    writeFileSync(join(root, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/api.git\n', 'utf8')
    assert.equal(detectRepo(root), 'api')
  })

  it('detectCommit 读分支 ref', () => {
    assert.equal(detectCommit(root), 'a'.repeat(40))
  })

  it('detached HEAD 直接读 sha', () => {
    writeFileSync(join(root, '.git', 'HEAD'), `${'b'.repeat(40)}\n`, 'utf8')
    assert.equal(detectCommit(root), 'b'.repeat(40))
  })

  it('没有 git 时返回 null', () => {
    rmSync(join(root, '.git'), { recursive: true, force: true })
    assert.equal(detectCommit(root), null)
  })
})

describe('硬排除', () => {
  it('终态永远不推广', () => {
    const { bundle, excluded } = buildPromotion([entry('a', { status: 'deprecated' })], { root })
    assert.equal(bundle.entries.length, 0)
    assert.equal(excluded[0].reason, 'terminal')
  })

  it('含密钥 → 排除，且**不泄漏命中内容**', () => {
    // 运行时拼出来：字面量会被上游的密钥扫描器改写，那样测的就不是我们的规则了
    const secret = ['api', 'key', '=', 'A'.repeat(24)].join('')
    const { bundle, excluded } = buildPromotion([entry('a', { body: `用 ${secret} 部署。` })], { root })
    assert.equal(bundle.entries.length, 0)
    assert.equal(excluded[0].reason, 'secret')
    assert.match(excluded[0].detail, /^rule #\d+$/)
    assert.doesNotMatch(JSON.stringify(excluded), /A{24}/)
    assert.doesNotMatch(JSON.stringify(bundle), /A{24}/)
  })

  it('**每一条密钥规则都必须能编译** —— 装错一条就是静默失效一条', () => {
    assert.equal(assertRulesCompile(), DEFAULT_FORBIDDEN.length)
  })

  it('内联 (?i) 规则真的会匹配（不是静默 try/catch 吞掉）', () => {
    // 这是从 Python 实现抄过来的规则表，JS 里 `(?i)` 是 SyntaxError。
    // 曾经的写法 `new RegExp(p, p.startsWith('(?i)') ? '' : 'u')` 让
    // 7 条规则全部编译失败、被 catch 吞掉 —— 从来没生效过。
    const families = [
      ['api', 'key', '=', 'a'.repeat(24)],
      ['app', 'secret', '=', 'b'.repeat(24)],
      ['pass', 'word', ':', 'c'.repeat(12)],
      ['Bearer ', 'd'.repeat(24)],
    ].map((parts) => parts.join(''))

    for (const secret of families) {
      const { bundle } = buildPromotion([entry('x', { body: `配置 ${secret}` })], { root })
      assert.equal(bundle.entries.length, 0, `规则漏掉了：${secret.slice(0, 12)}…`)
    }
  })

  it('没有证据 → 排除（在别的仓库无法复核）', () => {
    const { excluded } = buildPromotion([entry('a', { evidence: [] })], { root })
    assert.equal(excluded[0].reason, 'no-evidence')
  })

  it('置信低于地板 → 排除', () => {
    const { excluded } = buildPromotion([entry('a', { confidence: 'inferred' })], {
      root,
      config: { promote: { minConfidence: 'verified', includeProjectSpecific: true } },
    })
    assert.equal(excluded[0].reason, 'low-confidence')
  })

  it('放宽地板后可以进来', () => {
    const { bundle } = buildPromotion([entry('a', { confidence: 'inferred' })], {
      root,
      config: { promote: { minConfidence: 'inferred', includeProjectSpecific: true } },
    })
    assert.equal(bundle.entries.length, 1)
  })
})

describe('软标记', () => {
  it('证据全指向项目内路径 → project-specific-evidence', () => {
    const { bundle } = buildPromotion([entry('a')], { root })
    assert.ok(bundle.entries[0].markers.includes('project-specific-evidence'))
  })

  it('证据是通用路径（如 semver）→ 不标', () => {
    const { bundle } = buildPromotion([entry('a', { evidence: [{ kind: 'commit', ref: 'a'.repeat(40) }] })], { root })
    assert.ok(!bundle.entries[0].markers.includes('project-specific-evidence'))
  })

  it('scope 全是 repo:* → scoped-to-repo', () => {
    const { bundle } = buildPromotion([entry('a')], { root })
    assert.ok(bundle.entries[0].markers.includes('scoped-to-repo'))
  })

  it('reviewBy 到期 → needs-review', () => {
    const { bundle } = buildPromotion([entry('a', { reviewBy: '2020-01-01' })], { root })
    assert.ok(bundle.entries[0].markers.includes('needs-review'))
  })

  it('90 天没动 → dormant', () => {
    const { bundle } = buildPromotion([entry('a', { lastVerifiedAt: '2020-01-01T00:00:00Z' })], { root })
    assert.ok(bundle.entries[0].markers.includes('dormant'))
  })

  it('includeProjectSpecific=false 时项目特定条目被排除', () => {
    const { bundle, excluded } = buildPromotion([entry('a')], {
      root,
      config: { promote: { minConfidence: 'verified', includeProjectSpecific: false } },
    })
    assert.equal(bundle.entries.length, 0)
    assert.equal(excluded[0].reason, 'project-specific')
  })
})

describe('可移植性', () => {
  it('**输出不含绝对路径**', () => {
    const { bundle } = buildPromotion([entry('a')], { root })
    const json = JSON.stringify(bundle)
    assert.ok(!json.includes(root), '推广包泄漏了本机绝对路径')
    assert.ok(!json.includes(process.cwd()), '推广包泄漏了进程 cwd')
  })

  it('不含会话 id', () => {
    const { bundle } = buildPromotion([entry('a', { origin: { sessionId: 'sess_secret_123' } })], { root })
    assert.doesNotMatch(JSON.stringify(bundle), /sess_secret_123/)
  })

  it('证据路径保持仓库相对', () => {
    const { bundle } = buildPromotion([entry('a')], { root })
    assert.equal(bundle.entries[0].evidence[0].ref, 'src/db/pool.ts:17')
  })

  it('digest 是条目内容的函数（同样输入同 digest）', () => {
    const a = buildPromotion([entry('a'), entry('b')], { root }).bundle.digest
    const b = buildPromotion([entry('a'), entry('b')], { root }).bundle.digest
    assert.equal(a, b)

    const c = buildPromotion([entry('a')], { root }).bundle.digest
    assert.notEqual(a, c)
  })
})

describe('渲染', () => {
  it('Markdown 开头说明这是什么、从哪来', () => {
    const { bundle } = buildPromotion([entry('a')], { root })
    const markdown = renderPromotion(bundle)
    assert.match(markdown, /^# 记忆推广包/)
    assert.match(markdown, /@acme\/api/)
    assert.match(markdown, /只包含提名的条目，不包含任何全局存储/)
  })

  it('标注出现在条目里', () => {
    const { bundle } = buildPromotion([entry('a')], { root })
    const markdown = renderPromotion(bundle)
    assert.match(markdown, /推广前请核对/)
    assert.match(markdown, /证据全指向项目内路径/)
  })

  it('排除段列出原因与计数', () => {
    const { bundle } = buildPromotion(
      [entry('a'), entry('b', { status: 'deprecated' }), entry('c', { evidence: [] })],
      { root },
    )
    const markdown = renderPromotion(bundle)
    assert.match(markdown, /## 没有推广的条目/)
    assert.match(markdown, /终态（已退休 \/ 被拒 \/ 被取代）（1 条）/)
    assert.match(markdown, /没有证据（1 条）/)
  })

  it('空语料也能渲染', () => {
    const { bundle } = buildPromotion([], { root })
    assert.match(renderPromotion(bundle), /0 条项目记忆里，\*\*0 条\*\*被提名/)
  })

  it('summarizePromotion 是一行摘要', () => {
    const { bundle } = buildPromotion([entry('a')], { root })
    const summary = summarizePromotion(bundle)
    assert.match(summary, /推广包：1 \/ 1 条被提名/)
    assert.ok(summary.split('\n').length <= 3)
  })
})

describe('schema', () => {
  it('带版本，消费方可以据此判断能不能读', () => {
    const { bundle } = buildPromotion([], { root })
    assert.equal(bundle.schema, PROMOTION_SCHEMA)
    assert.equal(PROMOTION_SCHEMA, 'dsh-memory.promotion/v1')
  })

  it('summary 与 entries 一致', () => {
    const { bundle } = buildPromotion([entry('a'), entry('b', { kind: 'decision' })], { root })
    assert.equal(bundle.summary.promoted, bundle.entries.length)
    assert.equal(bundle.summary.byKind.pitfall, 1)
    assert.equal(bundle.summary.byKind.decision, 1)
  })
})

/**
 * 硬排除的**默认配置**回归。
 *
 * 0.2.0 写的是 `config.safety?.forbidden ?? DEFAULT_FORBIDDEN`，而
 * `defaultConfig().safety.forbidden` 是 **`[]` 不是 `undefined`** ——
 * `??` 永不短路，于是**默认配置下规则表是空的**，密钥原样进包。
 *
 * 这条和 `lib/gate.js:793` 的 G3 是同一个判据，必须同形。
 */
describe('硬排除 · 默认配置（回归）', () => {
  it('**没传 safety.forbidden 也必须扫默认规则**', () => {
    const leaking = entry('leak', { body: 'api_key = sk-abcdefghijklmnopqrstuvwxyz012345' })
    const { bundle, excluded } = buildPromotion([leaking], { root, config: {} })

    assert.equal(bundle.entries.length, 0, '默认配置下含密钥的条目绝不能进包')
    assert.equal(excluded.length, 1)
    assert.equal(excluded[0].reason, 'secret')
  })

  it('**`evidence[].excerpt` 也要扫**（贴进摘录等于绕过整道门）', () => {
    const leaking = entry('leak-excerpt', {
      evidence: [
        {
          kind: 'file',
          ref: 'src/db/pool.ts:17',
          excerpt: 'password: hunter2hunter2hunter2',
        },
      ],
    })
    const { bundle, excluded } = buildPromotion([leaking], { root, config: {} })
    assert.equal(bundle.entries.length, 0)
    assert.equal(excluded[0]?.reason, 'secret')
  })

  it('用户加的规则是**追加**，不是替换', () => {
    // 自定义规则 + 默认规则都要生效。
    const custom = entry('custom', { body: 'ACME_INTERNAL_TOKEN_9527' })
    const { excluded } = buildPromotion([custom], {
      root,
      config: { safety: { forbidden: ['ACME_INTERNAL_TOKEN_\\d+'] } },
    })
    assert.equal(excluded[0]?.reason, 'secret')

    const defaultRule = entry('default-rule', { body: 'api_key = sk-abcdefghijklmnopqrstuvwxyz012345' })
    const second = buildPromotion([defaultRule], {
      root,
      config: { safety: { forbidden: ['ACME_INTERNAL_TOKEN_\\d+'] } },
    })
    assert.equal(second.excluded[0]?.reason, 'secret', '默认规则不能因为用户加了规则而消失')
  })
})

/**
 * 权威：**推广包是唯一离开这个仓库的产物**。
 *
 * 它会进别的项目、被别的 Agent 召回 —— 这种产物最该关心的问题不是
 * 「写得好不好」，是「有没有人为它负过责」。而 0.3.3 之前 `authority`
 * 根本不产生，所以这条判断在推广包里连痕迹都没有。
 *
 * **是标记不是硬排除**：硬排除 `observed` 会让「一条都没被裁决过」的仓库
 * 永远产不出包 —— 而那是正常状态（绝大多数记忆是模型观察到的，没人逐条审）。
 * 过宽的检查会永久屏蔽合法内容，而屏蔽是静默的。
 */
describe('权威 · 没人签过字的进包要看得见', () => {
  it('`observed` → 打 `unconfirmed-authority` 标记，但**仍然进包**', () => {
    const { bundle } = buildPromotion([entry('a', { authority: 'observed' })], { root, config: {} })
    assert.equal(bundle.entries.length, 1, '标记不是排除')
    assert.ok(bundle.entries[0].markers.includes('unconfirmed-authority'))
  })

  it('`user-confirmed` → 不打标记（有人背过书）', () => {
    const { bundle } = buildPromotion([entry('a', { authority: 'user-confirmed' })], { root, config: {} })
    assert.ok(!bundle.entries[0].markers.includes('unconfirmed-authority'))
  })

  it('缺 `authority` 按 observed 算 —— 没写不等于有人背书', () => {
    const { bundle } = buildPromotion([entry('a')], { root, config: {} })
    assert.ok(bundle.entries[0].markers.includes('unconfirmed-authority'))
  })

  it('摘要里数得出来', () => {
    const { bundle } = buildPromotion(
      [entry('a', { authority: 'observed' }), entry('b', { authority: 'user-confirmed' })],
      { root, config: {} },
    )
    assert.equal(bundle.summary.unconfirmedAuthority, 1)
    assert.match(summarizePromotion(bundle), /1 条没有人确认过/)
  })

  it('渲染出的条目行带着权威', () => {
    const { bundle } = buildPromotion([entry('a', { authority: 'user-confirmed' })], { root, config: {} })
    assert.match(renderPromotion(bundle), /权威 user-confirmed/)
  })
})
