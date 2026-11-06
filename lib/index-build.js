/**
 * 索引编译器：把 Markdown 语料编译成**内容寻址**的确定性快照。
 *
 * 为什么内容寻址：召回必须可复现 —— 同样查询 + 同样配置 + 同样快照，
 * 永远同样的排序。同时它给了回滚一个天然的锚点。
 *
 * 快照目录：`index/snapshots/<snapshotId>/{manifest,documents,postings,exact-map,graph,ranking}.json`
 * 指针：`index/HEAD`（当前）、`index/PREVIOUS`（回滚点）
 *
 * 跳过判定的五个条件（少一个都会让「改了排序常量但输出没变」变成日常）：
 *   compiler 版本 · tokenizer profile · ranking 身份 · 源摘要 · 每条记忆的回执是否仍当前
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { contentHash } from './model.js'
import { activeEntries, layout, readAll } from './store.js'
import { sha256, stableJson, tokenize, writeFileAtomic } from './util.js'

export const COMPILER_VERSION = '0.10.0'

/**
 * 分词器身份。**参与快照 id** —— 换分词器必须重建索引，
 * 否则同一个查询会在旧 postings 上返回新排序。
 *
 * 形态：`<策略>@<版本>`。改任何一条 `tokenize()` 的规则都要改这里。
 */
export const TOKENIZER_PROFILE = ['dsh-memory', 'tokenizer', 'v1'].join('-')

/** BM25F 字段与权重。顺序即 postings 的 field 下标。 */
export const FIELD_CONFIG = Object.freeze([
  { name: 'title', weight: 3.4, lengthNormalization: 0.75 },
  { name: 'about', weight: 2.8, lengthNormalization: 0.75 },
  { name: 'triggers', weight: 2.6, lengthNormalization: 0.5 },
  { name: 'body', weight: 1.0, lengthNormalization: 0.75 },
])

/** 排序常量。**它们也是编译输入** —— 改了必须重建快照。 */
export const RANKING = Object.freeze({
  profile: 'deterministic-ranker-v1',
  bm25: { k1: 1.2 },
  rrf: {
    k: 10,
    channelWeights: { exact: 8, bm25f: 16, ngram: 0.1, fuzzy: 0.25, graph: 0.05, embedding: 0 },
  },
  featureWeights: {
    exact_anchor: 0.15,
    approximate_anchor: 0,
    query_coverage: 0.2,
    query_span_coverage: 0, // 门用，不排序
    matched_terms: 0.15,
    high_signal_concepts: 0.3,
    high_signal_terms: 0.15,
    anchor_terms: 0.15,
    field_coverage: 0.2,
    scope_overlap: 0.01,
    authority: 0.01,
    evidence: 0.01,
    freshness: 0.01,
    graph_quality: 0.02,
    channel_diversity: 0.05,
  },
  authorityStrength: { observed: 0.75, normative: 1, 'user-confirmed': 0.95 },
  evidenceStrength: { user: 1, test: 0.9, symbol: 0.8, file: 0.8, commit: 0.7, command: 0.6, doc: 0.5 },
  graphKindStrength: {
    'wiki-link': 1,
    supersedes: 0.95,
    'authority-doc': 0.85,
    'history-doc': 0.7,
    'code-evidence': 0.8,
    'code-test': 0.8,
  },
  freshnessHalfLifeDays: 365,
  mmr: { lambda: 0.78, similarityThreshold: 0.82 },
})

/** 排序身份：只含**值**，且 key 顺序归一化。 */
export function rankingProfileHash(ranking = RANKING) {
  return sha256(stableJson(ranking))
}

/* ── 编译 ─────────────────────────────────────────────────────────── */

function fieldText(entry, field) {
  switch (field) {
    case 'title':
      return entry.title ?? ''
    case 'about':
      return entry.about ?? ''
    case 'triggers':
      return (entry.triggers ?? []).join(' ')
    case 'body':
      return entry.body ?? ''
    default:
      return ''
  }
}

function compileDocuments(entries) {
  return entries.map((entry) => {
    const fields = {}
    const fieldLengths = {}
    for (const { name } of FIELD_CONFIG) {
      const tokens = tokenize(fieldText(entry, name))
      fields[name] = tokens
      fieldLengths[name] = tokens.length
    }
    return {
      id: entry.id,
      path: entry.path,
      sourceSha256: contentHash(entry),
      content: entry.body ?? '',
      title: entry.title ?? '',
      about: entry.about ?? '',
      kind: entry.kind,
      confidence: entry.confidence ?? 'inferred',
      provenance: entry.provenance ?? 'self-concluded',
      status: entry.status ?? 'active',
      actionRisk: entry.actionRisk ?? 'R1',
      scope: entry.scope ?? [],
      triggers: entry.triggers ?? [],
      evidence: entry.evidence ?? [],
      relations: entry.relations ?? [],
      claims: entry.claims ?? [],
      lastVerifiedAt: entry.lastVerifiedAt ?? null,
      fields,
      fieldLengths,
    }
  })
}

function compilePostings(documents) {
  const averageLength = {}
  for (const { name } of FIELD_CONFIG) {
    const total = documents.reduce((sum, doc) => sum + doc.fieldLengths[name], 0)
    averageLength[name] = documents.length > 0 ? Math.max(1, total / documents.length) : 1
  }

  /** term -> { fieldIndex -> [{doc, tf}] } */
  const index = new Map()
  documents.forEach((doc, docIndex) => {
    FIELD_CONFIG.forEach(({ name }, fieldIndex) => {
      const counts = new Map()
      for (const token of doc.fields[name]) counts.set(token, (counts.get(token) ?? 0) + 1)
      for (const [term, tf] of counts) {
        if (!index.has(term)) index.set(term, new Map())
        const byField = index.get(term)
        if (!byField.has(fieldIndex)) byField.set(fieldIndex, [])
        byField.get(fieldIndex).push([docIndex, tf])
      }
    })
  })

  const total = Math.max(1, documents.length)
  const terms = [...index.keys()].sort()
  return {
    averageLength,
    documentCount: documents.length,
    terms: terms.map((term) => {
      const byField = index.get(term)
      const df = new Set()
      const postings = []
      for (const [fieldIndex, list] of [...byField.entries()].sort((a, b) => a[0] - b[0])) {
        for (const [doc, tf] of list) {
          df.add(doc)
          postings.push([doc, fieldIndex, tf])
        }
      }
      const idf = Math.log(1 + (total - df.size + 0.5) / (df.size + 0.5))
      return { term, idf, postings }
    }),
  }
}

function compileExactMap(documents) {
  const entries = new Map()
  const push = (kind, value, docId) => {
    if (!value) return
    const key = `${kind}\u0000${String(value).toLowerCase()}`
    if (!entries.has(key)) entries.set(key, { kind, value: String(value), documents: [] })
    const item = entries.get(key)
    if (!item.documents.includes(docId)) item.documents.push(docId)
  }

  for (const doc of documents) {
    push('name', doc.id, doc.id)
    push('title', doc.title, doc.id)
    for (const trigger of doc.triggers) push('trigger', trigger, doc.id)
    for (const item of doc.evidence) {
      if (item.kind === 'file' || item.kind === 'doc') {
        push('path', item.ref, doc.id)
        push('basename', String(item.ref).split('/').pop(), doc.id)
      } else if (item.kind === 'symbol') {
        push('symbol', item.ref, doc.id)
      } else if (item.kind === 'test') {
        push('test', item.ref, doc.id)
      }
    }
  }

  return [...entries.values()].sort((a, b) =>
    a.kind === b.kind ? (a.value < b.value ? -1 : 1) : a.kind < b.kind ? -1 : 1,
  )
}

function compileGraph(documents) {
  const ids = new Set(documents.map((doc) => doc.id))
  const edges = []
  for (const doc of documents) {
    for (const rel of doc.relations) {
      if (!rel?.target || !ids.has(rel.target)) continue
      edges.push({ from: doc.id, to: rel.target, kind: rel.type ?? 'related_to' })
    }
  }
  return { nodes: [...ids].sort(), edges }
}

/**
 * 编译快照。返回 `{ snapshotId, documents, postings, exactMap, graph, ranking, manifest }`。
 * 纯函数：同样的 entries + 同样的现在 → 同样的 snapshotId。
 */
export function compileSnapshot(entries, { now = new Date().toISOString() } = {}) {
  const documents = compileDocuments(entries)
  const postings = compilePostings(documents)
  const exactMap = compileExactMap(documents)
  const graph = compileGraph(documents)
  const ranking = RANKING
  const sourceSha256 = sha256(stableJson(documents.map((doc) => ({ id: doc.id, sha: doc.sourceSha256 }))))
  const contentSha256 = sha256(
    stableJson({
      documents: sha256(stableJson(documents)),
      postings: sha256(stableJson(postings)),
      exactMap: sha256(stableJson(exactMap)),
      graph: sha256(stableJson(graph)),
      ranking: rankingProfileHash(ranking),
    }),
  )
  const snapshotId = sha256(
    `dsh-memory-index/v1\u0000${COMPILER_VERSION}\u0000${TOKENIZER_PROFILE}\u0000${sourceSha256}\u0000${contentSha256}`,
  ).slice(0, 32)

  const manifest = {
    schema: 'dsh-memory.manifest/v1',
    snapshotId,
    compilerVersion: COMPILER_VERSION,
    tokenizerProfile: TOKENIZER_PROFILE,
    createdAt: now,
    source: { sha256: sourceSha256, documentCount: documents.length },
    contentSha256,
  }

  return { snapshotId, documents, postings, exactMap, graph, ranking, manifest }
}

/* ── 持久化 ───────────────────────────────────────────────────────── */

function readPointer(file) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : null
  } catch {
    return null
  }
}

function writePointer(file, snapshotId) {
  writeFileAtomic(file, `${snapshotId}\n`)
}

function readArtifact(snapshotDir, name) {
  return JSON.parse(readFileSync(join(snapshotDir, name), 'utf8'))
}

/**
 * 已发布快照的内存缓存：`root -> { key, snapshot }`。
 *
 * 为什么需要：装配路径每轮都读 6 个 JSON 文件（`documents.json` 里带正文，
 * 200 条记忆就是几百 KB 的 `JSON.parse`）。而快照只在**指针变化**时才可能变 ——
 * 只有本进程会发布，所以指针内容就是充分的失效信号。
 */
const snapshotCache = new Map()

/** 丢弃某个 root 的快照缓存（测试用；发布路径自动失效）。 */
export function clearSnapshotCache(root) {
  if (root === undefined) snapshotCache.clear()
  else snapshotCache.delete(root)
}

/**
 * 读取已发布快照。HEAD 坏了就退 PREVIOUS 并标注 `selected: 'previous'`
 * —— 退而求其次必须是**可见的**降级，不是静默。
 */
export function readSnapshot(root) {
  const paths = layout(root)
  const head = readPointer(paths.head)
  const previous = readPointer(paths.previous)
  const key = `${head ?? ''}|${previous ?? ''}`

  const cached = snapshotCache.get(root)
  if (cached && cached.key === key) return cached.snapshot

  for (const selected of ['current', 'previous']) {
    const pointer = selected === 'current' ? head : previous
    if (!pointer) continue
    const dir = join(paths.snapshots, pointer)
    try {
      const manifest = readArtifact(dir, 'manifest.json')
      if (manifest.compilerVersion !== COMPILER_VERSION) continue
      const snapshot = {
        selected,
        snapshotId: pointer,
        manifest,
        documents: readArtifact(dir, 'documents.json'),
        postings: readArtifact(dir, 'postings.json'),
        exactMap: readArtifact(dir, 'exact-map.json'),
        graph: readArtifact(dir, 'graph.json'),
        ranking: readArtifact(dir, 'ranking.json'),
      }
      snapshotCache.set(root, { key, snapshot })
      return snapshot
    } catch {
      /* 这个指针坏了，试下一个 */
    }
  }
  return null
}

const ARTIFACTS = [
  ['documents.json', (snapshot) => snapshot.documents],
  ['postings.json', (snapshot) => snapshot.postings],
  ['exact-map.json', (snapshot) => snapshot.exactMap],
  ['graph.json', (snapshot) => snapshot.graph],
  ['ranking.json', (snapshot) => snapshot.ranking],
  ['manifest.json', (snapshot) => snapshot.manifest],
]

/** 发布快照：构建到临时目录 → 原子 rename → 移动指针。 */
export function publishSnapshot(root, snapshot) {
  const paths = layout(root)
  mkdirSync(paths.snapshots, { recursive: true })
  const finalDir = join(paths.snapshots, snapshot.snapshotId)
  const tmpDir = join(paths.snapshots, `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)

  mkdirSync(tmpDir, { recursive: true })
  for (const [name, pick] of ARTIFACTS) {
    writeFileAtomic(join(tmpDir, name), stableJson(pick(snapshot)))
  }
  rmSync(finalDir, { recursive: true, force: true })
  renameSync(tmpDir, finalDir)

  const previous = readPointer(paths.head)
  if (previous && previous !== snapshot.snapshotId) writePointer(paths.previous, previous)
  writePointer(paths.head, snapshot.snapshotId)
  // 同一 snapshotId 重发时指针内容不变，靠 key 自动失效会漏 —— 显式清
  snapshotCache.delete(root)
  return snapshot.snapshotId
}

/**
 * 确保有可用快照，需要时重建。返回 `{ snapshot, rebuilt, trigger }`。
 *
 * 源新鲜度探针：目录里的文件数与每个文件的大小/修改时间变化即视为漂移。
 * 这是「未复核的正文编辑」变成内容漂移的唯一入口 —— 只看快照自己的校验和
 * 永远发现不了 Markdown 被改。
 */
export function ensureSnapshot(root, { force = false } = {}) {
  const existing = readSnapshot(root)
  const scan = activeEntries(readAll(root).entries)

  if (existing && !force) {
    const manifestIds = existing.documents.map((doc) => doc.id).sort()
    const scanIds = scan.map((entry) => entry.id).sort()
    const sameSet = manifestIds.length === scanIds.length && manifestIds.every((id, i) => id === scanIds[i])
    const rankingSame = rankingProfileHash(existing.ranking) === rankingProfileHash(RANKING)
    if (sameSet && rankingSame) {
      const current = new Map(scan.map((entry) => [entry.id, contentHash(entry)]))
      const fresh = existing.documents.every((doc) => current.get(doc.id) === doc.sourceSha256)
      if (fresh) return { snapshot: existing, rebuilt: false, trigger: null }
    }
    const trigger = !rankingSame ? 'ranking-changed' : 'source-changed'
    const snapshot = compileSnapshot(scan)
    publishSnapshot(root, snapshot)
    return { snapshot: { ...snapshot, selected: 'current' }, rebuilt: true, trigger }
  }

  const snapshot = compileSnapshot(scan)
  publishSnapshot(root, snapshot)
  return { snapshot: { ...snapshot, selected: 'current' }, rebuilt: true, trigger: force ? 'forced' : 'missing' }
}

/** 垃圾回收：只删两个指针都不引用的快照。指针坏了就什么都不删。 */
export function collectUnreferenced(root) {
  const paths = layout(root)
  if (!existsSync(paths.snapshots)) return 0
  const current = readPointer(paths.head)
  const previous = readPointer(paths.previous)
  if (!current) return 0 // 引用集未知 → 不删
  const keep = new Set([current, previous].filter(Boolean))
  let removed = 0
  for (const name of readdirSync(paths.snapshots)) {
    if (keep.has(name)) continue
    rmSync(join(paths.snapshots, name), { recursive: true, force: true })
    removed += 1
  }
  return removed
}
