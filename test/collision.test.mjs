/**
 * id 碰撞（**静默覆盖另一条记忆**）—— 回归。
 *
 * ## 它钉住的行为
 *
 * `normalizeId` 把 `[\s-]` 统一成 `_`、丢掉其余非 ASCII 字母数字，这个映射
 * **按设计是多对一的**：`deploy-staging` / `deploy staging` / `deploy_staging`
 * 被当成同一条记忆（这是想要的 —— 同一个标题重复记不该产生副本）。
 *
 * 但「同一条」是**猜测**。两条真正不同的记忆撞上同一个 slug 时，0.2.0 的
 * `writeEntry` 直接 `writeFileAtomic` 覆盖文件 —— 正文、回执、`supersedes`
 * 链一起消失，而 `memory_remember` 返回「已记住」。G2 判据 2
 * 「id 在语料里唯一」（`docs/03:195`）当时**没有任何消费者**。
 *
 * 现在 `writeEntry` 就是那个消费者：**同 id 但标题不同** → 抛 `id-collision`，
 * 让调用方传显式 id 或先退休旧条目。同 id + 同标题仍然是合法的「重写」。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { normalizeId } from '../lib/model.js'
import { clearStoreCache, readAll, writeEntry } from '../lib/store.js'

let root

const entry = (overrides = {}) => ({
  id: 'deploy_staging_connection_pool_cap',
  title: 'deploy staging connection pool cap',
  kind: 'fact',
  about: '连接池上限',
  body: `# 功能名\n连接池上限\n\n# 生效条件\nstaging。\n\n# 子功能\npool.ts。\n\n# 执行\n调 DB_POOL_MAX。\n\n# 验证方式\nenv | grep DB_POOL_MAX。\n\n# 不适用条件\n生产。`,
  evidence: [{ kind: 'file', ref: 'package.json' }],
  provenance: 'measured',
  ...overrides,
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-memory-collision-'))
  clearStoreCache()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  clearStoreCache()
})

describe('id 碰撞 · normalizeId 是多对一的（设计如此）', () => {
  it('分隔符不同的两个标题落到同一个 id', () => {
    const a = normalizeId('deploy-staging connection pool cap')
    const b = normalizeId('deploy_staging connection pool cap')
    const c = normalizeId('deploy staging  connection pool cap')
    assert.equal(a, b)
    assert.equal(b, c)
  })
})

describe('id 碰撞 · writeEntry 不许静默覆盖', () => {
  it('**同 id 但标题不同 → 抛 id-collision，库里的旧记忆原样保留**', () => {
    const first = writeEntry(root, entry())
    assert.equal(first.id, entry().id)

    assert.throws(
      () => writeEntry(root, entry({ title: 'deploy-staging connection pool cap' })),
      (error) => {
        assert.equal(error.code, 'id-collision')
        assert.equal(error.id, entry().id)
        assert.match(error.message, /已被另一条记忆占用/)
        assert.match(error.message, /memory_forget/)
        return true
      },
    )

    const entries = readAll(root).entries
    assert.equal(entries.length, 1, '不能多出一条，也不能被覆盖')
    assert.equal(entries[0].title, 'deploy staging connection pool cap', '旧记忆必须原样保留')
  })

  it('同 id + 同标题 = 合法的「重写这条记忆」', () => {
    writeEntry(root, entry())
    const rewritten = writeEntry(root, entry({ about: '改了说明' }))
    assert.equal(rewritten.about, '改了说明')
    assert.equal(readAll(root).entries.length, 1)
  })

  it('显式 `overwrite: true` 才允许跨标题改写（edit / merge 用）', () => {
    writeEntry(root, entry())
    const renamed = writeEntry(root, entry({ title: '换了个标题' }), { overwrite: true })
    assert.equal(renamed.title, '换了个标题')
    const entries = readAll(root).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].title, '换了个标题')
  })

  it('不同 id 之间互不影响', () => {
    writeEntry(root, entry())
    writeEntry(root, entry({ id: 'another_memory', title: '另一条完全不同的记忆' }))
    assert.equal(readAll(root).entries.length, 2)
  })
})

/**
 * `lastVerifiedAt` 的三种输入必须区分开。
 *
 * 上一版是 `entry.lastVerifiedAt ?? now` —— `??` 把 `null` 当缺省，
 * 于是「**从未验证过**」这个状态**不可表达**：任何写入都被自动盖上「刚刚验证过」。
 * `lifecycle.consolidate` 的合并产物正是靠显式 `null` 表达这一点的
 * （人批准的是「该合并」，不是「合并后这段话准确」）。
 */
describe('writeEntry · lastVerifiedAt 三态', () => {
  it('缺键 → 就是现在（新条目刚建立）', () => {
    const written = writeEntry(root, entry())
    assert.ok(Number.isFinite(Date.parse(written.lastVerifiedAt)))
  })

  it('**显式 null → 原样保留**（从没验证过）', () => {
    const written = writeEntry(root, entry({ lastVerifiedAt: null }))
    assert.equal(written.lastVerifiedAt, null)
    assert.equal(readAll(root).entries[0].lastVerifiedAt, null, '读回来也必须还是 null —— 否则只是内存里对')
  })

  it('显式时间戳 → 原样保留（重新验证一次不该被改掉）', () => {
    const stamp = '2026-01-01T00:00:00.000Z'
    const written = writeEntry(root, entry({ lastVerifiedAt: stamp }))
    assert.equal(written.lastVerifiedAt, stamp)
  })
})
