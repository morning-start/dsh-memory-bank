/**
 * 索引与扫描缓存：确定性、失效、回收。
 *
 * 重点钉住两件容易回归的事：
 *   1. 快照 id 必须是**纯函数**（同输入同 id），否则每次装配都重建；
 *   2. 扫描缓存必须在写盘后失效 —— 一个「记得住但不更新」的缓存比没有缓存更糟。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  COMPILER_VERSION,
  TOKENIZER_PROFILE,
  compileSnapshot,
  collectUnreferenced,
  ensureSnapshot,
  publishSnapshot,
  rankingProfileHash,
  readSnapshot,
} from '../lib/index-build.js'
import { RANKING } from '../lib/index-build.js'
import { clearStoreCache, invalidateCorpus, layout, readAll, writeEntry } from '../lib/store.js'

let root

const entry = (id, overrides = {}) => ({
  id,
  title: `记忆 ${id}`,
  kind: 'pitfall',
  about: `关于 ${id} 的说明`,
  body: `# 功能名\n${id}\n\n# 生效条件\n条件\n\n# 子功能\n组件\n\n# 执行\n执行\n\n# 验证方式\n验证\n\n# 不适用条件\n不适用`,
  status: 'active',
  confidence: 'inferred',
  provenance: 'self-concluded',
  evidence: [{ kind: 'file', ref: 'src/a.ts' }],
  relations: [],
  claims: [],
  scope: ['repo:x'],
  triggers: [`${id} 触发`],
  ...overrides,
})

const seed = (...entries) => {
  for (const item of entries) writeEntry(root, item)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-memory-index-'))
  clearStoreCache()
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
  mkdirSync(join(root, '.dsh-memory', 'memories'), { recursive: true })
})

afterEach(() => {
  clearStoreCache()
  rmSync(root, { recursive: true, force: true })
})

describe('快照编译', () => {
  it('snapshotId 是纯函数（同输入同 id）', () => {
    const a = compileSnapshot([entry('a'), entry('b')], { now: '2026-01-01T00:00:00Z' })
    const b = compileSnapshot([entry('a'), entry('b')], { now: '2026-06-01T00:00:00Z' })
    assert.equal(a.snapshotId, b.snapshotId, 'now 不该参与内容寻址')
  })

  it('语料变化 → snapshotId 变化', () => {
    const a = compileSnapshot([entry('a')])
    const b = compileSnapshot([entry('a'), entry('b')])
    assert.notEqual(a.snapshotId, b.snapshotId)
  })

  it('manifest 记录编译器与分词器身份（参与寻址）', () => {
    const snapshot = compileSnapshot([entry('a')])
    assert.equal(snapshot.manifest.compilerVersion, COMPILER_VERSION)
    assert.equal(snapshot.manifest.tokenizerProfile, TOKENIZER_PROFILE)
    assert.ok(snapshot.manifest.snapshotId.length > 0)
  })

  it('rankingProfileHash 对 key 顺序不敏感', () => {
    const reordered = Object.fromEntries(Object.entries(RANKING).reverse())
    assert.equal(rankingProfileHash(reordered), rankingProfileHash(RANKING))
  })

  it('倒排表按词排序（字节级可复现）', () => {
    const snapshot = compileSnapshot([entry('a'), entry('b')])
    const terms = snapshot.postings.terms.map((item) => item.term)
    assert.deepEqual(terms, [...terms].sort())
  })

  it('exact-map 收录 name / title / trigger / 路径 / basename', () => {
    const snapshot = compileSnapshot([entry('a')])
    const kinds = new Set(snapshot.exactMap.map((item) => item.kind))
    for (const kind of ['name', 'title', 'trigger', 'path', 'basename']) assert.ok(kinds.has(kind), kind)
  })
})

describe('发布与读取', () => {
  it('发布后能读回同一份', () => {
    const snapshot = compileSnapshot([entry('a')])
    publishSnapshot(root, snapshot)
    const read = readSnapshot(root)
    assert.equal(read.snapshotId, snapshot.snapshotId)
    assert.equal(read.selected, 'current')
    assert.equal(read.documents.length, 1)
  })

  it('第二次发布把旧快照推到 PREVIOUS', () => {
    const first = compileSnapshot([entry('a')])
    publishSnapshot(root, first)
    const second = compileSnapshot([entry('a'), entry('b')])
    publishSnapshot(root, second)
    assert.equal(readSnapshot(root).snapshotId, second.snapshotId)
  })

  it('同一 snapshotId 重发时缓存失效（不能返回旧对象）', () => {
    const snapshot = compileSnapshot([entry('a')])
    publishSnapshot(root, snapshot)
    const first = readSnapshot(root)
    publishSnapshot(root, { ...snapshot, documents: [...snapshot.documents, { id: 'ghost' }] })
    const second = readSnapshot(root)
    assert.notEqual(first, second, '必须重新读盘 —— 指针内容没变但文件被重写了')
  })

  it('编译器版本不匹配的快照被拒绝（不静默降级）', () => {
    const snapshot = compileSnapshot([entry('a')])
    publishSnapshot(root, snapshot)
    // 手工把 manifest 改成旧版本
    const dir = join(layout(root).snapshots, snapshot.snapshotId)
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...snapshot.manifest, compilerVersion: '0.0.1' }), 'utf8')
    assert.equal(readSnapshot(root), null)
  })
})

describe('ensureSnapshot', () => {
  it('语料没变 → 复用（rebuilt: false）', () => {
    seed(entry('a'))
    const first = ensureSnapshot(root)
    assert.equal(first.rebuilt, true)
    const second = ensureSnapshot(root)
    assert.equal(second.rebuilt, false)
    assert.equal(second.snapshot.snapshotId, first.snapshot.snapshotId)
  })

  it('改了正文 → 重建并报 source-changed', () => {
    seed(entry('a'))
    ensureSnapshot(root)
    writeFileSync(
      join(root, '.dsh-memory', 'memories', 'a.md'),
      readFileSync(join(root, '.dsh-memory', 'memories', 'a.md'), 'utf8').replace('条件', '改过的条件'),
      'utf8',
    )
    invalidateCorpus(root)
    const rebuilt = ensureSnapshot(root)
    assert.equal(rebuilt.rebuilt, true)
    assert.equal(rebuilt.trigger, 'source-changed')
  })

  it('force 强制重建', () => {
    seed(entry('a'))
    ensureSnapshot(root)
    assert.equal(ensureSnapshot(root, { force: true }).trigger, 'forced')
  })

  it('空语料也能出版本（abstain 的前提）', () => {
    const { snapshot } = ensureSnapshot(root)
    assert.equal(snapshot.documents.length, 0)
  })
})

describe('垃圾回收', () => {
  it('只保留两个指针引用的快照', () => {
    const first = compileSnapshot([entry('a')])
    publishSnapshot(root, first)
    const second = compileSnapshot([entry('a'), entry('b')])
    publishSnapshot(root, second)
    const third = compileSnapshot([entry('a'), entry('b'), entry('c')])
    publishSnapshot(root, third)

    const removed = collectUnreferenced(root)
    assert.ok(removed >= 1)
    const remaining = readdirSync(layout(root).snapshots)
    assert.ok(remaining.includes(third.snapshotId))
  })

  it('**指针缺失时什么都不删**（GC 吃掉活快照的唯一防线）', () => {
    publishSnapshot(root, compileSnapshot([entry('a')]))
    rmSync(layout(root).head, { force: true })
    assert.equal(collectUnreferenced(root), 0)
    assert.ok(readdirSync(layout(root).snapshots).length > 0)
  })
})

describe('扫描缓存', () => {
  it('同一 root 连续两次返回同一数组（缓存命中）', () => {
    seed(entry('a'))
    assert.equal(readAll(root).entries, readAll(root).entries)
  })

  it('写盘后自动失效', () => {
    seed(entry('a'))
    const before = readAll(root).entries
    writeEntry(root, entry('b'))
    const after = readAll(root).entries
    assert.notEqual(before, after)
    assert.equal(after.length, 2)
  })

  it('返回的数组是冻结的（防止污染下一次装配）', () => {
    seed(entry('a'))
    const { entries } = readAll(root)
    assert.throws(() => entries.push({ id: 'x' }), TypeError)
  })

  it('坏文件进 problems 而不让整个扫描失败', () => {
    seed(entry('a'))
    writeFileSync(join(root, '.dsh-memory', 'memories', 'broken.md'), 'not frontmatter', 'utf8')
    invalidateCorpus(root)
    const { entries, problems } = readAll(root)
    assert.equal(entries.length, 1)
    assert.equal(problems.length, 1)
    assert.equal(problems[0].code, 'parse-error')
  })
})
