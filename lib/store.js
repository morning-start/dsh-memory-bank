/**
 * 存储层：目录布局、条目读写、审计日志、待决提案。
 *
 * 布局（项目层，权威副本，随仓库 review / 回滚）：
 *
 *   <root>/.dsh-memory/
 *   ├── config.json          本项目配置
 *   ├── memories/<id>.md     一条记忆一个文件
 *   ├── trust/receipts.json  信任回执（与正文分离）
 *   ├── pending/<pid>.json   DEFER 的提案
 *   ├── pending/rejected/    被拒的提案（留档，不参与召回）
 *   ├── ledger.jsonl         全部写入尝试
 *   └── index/               内容寻址快照（可删可重建）
 *
 * 全局层 `<home>/.dsh-memory/` 同结构，只放已收口的跨项目结论。
 *
 * 纪律：
 *   - 写一律原子（tmp → rename），读者永远看不到半个文件；
 *   - 单个坏文件不拖垮扫描，报进 problems 而不是抛；
 *   - index/ 与 ledger.jsonl 是可重建/可追加的派生物，memories/ 与 trust/ 进 git。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { contentHash, evidenceRoot, parseEntry, serializeEntry } from './model.js'
import { collapse, isoNow, sha256, stableJson, writeFileAtomic } from './util.js'

export const MEMORY_DIR_NAME = '.dsh-memory'

/** 目录布局。 */
export function layout(root) {
  const base = join(root, MEMORY_DIR_NAME)
  return {
    root,
    base,
    config: join(base, 'config.json'),
    memories: join(base, 'memories'),
    trust: join(base, 'trust'),
    receipts: join(base, 'trust', 'receipts.json'),
    pending: join(base, 'pending'),
    rejected: join(base, 'pending', 'rejected'),
    ledger: join(base, 'ledger.jsonl'),
    stats: join(base, 'stats.json'),
    index: join(base, 'index'),
    snapshots: join(base, 'index', 'snapshots'),
    head: join(base, 'index', 'HEAD'),
    previous: join(base, 'index', 'PREVIOUS'),
    gitignore: join(base, '.gitignore'),
  }
}

/** 全局层根目录。 */
export function globalRoot() {
  return process.env.DSH_MEMORY_HOME || join(homedir(), MEMORY_DIR_NAME)
}

const GITIGNORE_BODY = `# 派生数据：索引可重建，日志可重放。记忆正文与回执进 git。
index/
ledger.jsonl
*.tmp-*
`

/** 非破坏初始化：只补缺失项，已有文件一个字节都不动。 */
export function ensureLayout(root) {
  const paths = layout(root)
  mkdirSync(paths.memories, { recursive: true })
  mkdirSync(paths.trust, { recursive: true })
  mkdirSync(paths.rejected, { recursive: true })
  mkdirSync(paths.snapshots, { recursive: true })
  if (!existsSync(paths.gitignore)) writeFileAtomic(paths.gitignore, GITIGNORE_BODY)
  if (!existsSync(paths.config)) writeFileAtomic(paths.config, `${stableJson(defaultConfig(), 2)}\n`)
  if (!existsSync(paths.receipts)) {
    writeFileAtomic(
      paths.receipts,
      `${stableJson({ schema: 'dsh-memory.trust/v1', receipts: [] }, 2)}\n`,
    )
  }
  return paths
}

/** 插件内置默认值 —— 与 config.js 的默认值同源，避免两处漂移。 */
export function defaultConfig() {
  return {
    schema: 'dsh-memory.config/v1',
    version: 1,
    autonomy: 'balanced',
    thresholds: {
      autoAcceptFloor: 0.6,
      deferFloor: 0.35,
      duplicate: 0.82,
      coverageFloor: 0.45,
      content: {
        identifier: 0.6,
        path: 0.7,
        error: 0.7,
        natural: 0.65,
        decision: 0.65,
        mixed: 0.65,
      },
      contentTier: 0.85,
      exactAnchorContent: 0.5,
    },
    quota: { repo: 200, global: 500, growthThreshold: 50 },
    template: ['功能名', '生效条件', '子功能', '执行', '验证方式', '不适用条件'],
    capture: { enabled: true, mode: 'strict', signals: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] },
    recall: { inject: true, maxBytes: 4000, maxPointers: 3 },
    embedding: { enabled: false, weight: 0 },
    conflict: { semantic: false },
  }
}

/* ── 读 ───────────────────────────────────────────────────────────── */

/**
 * 语料扫描缓存：`root -> { stamp, result }`。
 *
 * 为什么需要它：`systemPrompt.context` 在**每一次 prompt 装配**上跑，
 * 而装配路径扫一遍 200 条记忆 = 200 次 `readFileSync` + 200 次 YAML 解析。
 * 一秒钟几次装配就是几十毫秒的纯浪费，而且全在用户按键的关键路径上。
 *
 * 失效靠**目录签名**（名字 + mtime + size 的摘要），不靠 TTL：
 * 写盘（`writeFileAtomic` 走 rename）会改 mtime，所以缓存自然失效；
 * 显式 `invalidateCorpus` 兜住 mtime 精度不足的文件系统。
 */
const scanCache = new Map()

function corpusStamp(memoriesDir) {
  try {
    if (!existsSync(memoriesDir)) return 'missing'
    const names = readdirSync(memoriesDir).filter((name) => name.endsWith('.md')).sort()
    let accumulator = String(names.length)
    for (const name of names) {
      try {
        const stat = statSync(join(memoriesDir, name))
        accumulator += `|${name}:${stat.mtimeMs}:${stat.size}`
      } catch {
        accumulator += `|${name}:?`
      }
    }
    return sha256(accumulator)
  } catch {
    return 'unreadable'
  }
}

/** 丢弃某个 root 的扫描缓存。写盘后调用 —— 不依赖 mtime 精度。 */
export function invalidateCorpus(root) {
  scanCache.delete(root)
}

/** 清空全部缓存（测试用）。 */
export function clearStoreCache() {
  scanCache.clear()
}

/** 文件名 → id。 */
function idFromFile(name) {
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

/**
 * 扫描全部条目。坏文件进 `problems` 而不是让整个扫描失败 ——
 * 一条写坏的文件不能让用户失去整个记忆库。
 *
 * 返回的 `entries` 数组是**冻结的**：它是缓存里的同一个对象，
 * 任何就地修改都会污染下一次装配。
 */
export function readAll(root, { clock = Date.now } = {}) {
  const paths = layout(root)
  const entries = []
  const problems = []
  if (!existsSync(paths.memories)) return { entries, problems, scannedAt: isoNow(clock) }

  const stamp = corpusStamp(paths.memories)
  const cached = scanCache.get(root)
  if (cached && cached.stamp === stamp) return cached.result

  for (const name of readdirSync(paths.memories).sort()) {
    if (!name.endsWith('.md')) continue
    const file = join(paths.memories, name)
    try {
      if (!statSync(file).isFile()) continue
      const entry = parseEntry(readFileSync(file, 'utf8'), { idFromPath: idFromFile(name) })
      entry.path = `${MEMORY_DIR_NAME}/memories/${name}`
      if (entry.id !== idFromFile(name)) {
        problems.push({ file: entry.path, code: 'name-file-mismatch', detail: `${entry.id} ≠ ${idFromFile(name)}` })
      }
      entries.push(entry)
    } catch (error) {
      problems.push({ file: `${MEMORY_DIR_NAME}/memories/${name}`, code: 'parse-error', detail: String(error?.message ?? error) })
    }
  }

  const result = Object.freeze({ entries: Object.freeze(entries), problems: Object.freeze(problems), scannedAt: isoNow(clock) })
  scanCache.set(root, { stamp, result })
  return result
}

export function findEntry(root, id) {
  return readAll(root).entries.find((entry) => entry.id === id) ?? null
}

/** 活跃语料：终态之外的条目。 */
export function activeEntries(entries) {
  return entries.filter((entry) => !['deprecated', 'rejected', 'superseded'].includes(entry.status))
}

/* ── 写 ───────────────────────────────────────────────────────────── */

/**
 * 落盘一条条目。调用方必须**已经过审核协议** —— 这里不做任何判定。
 * 返回写入后的条目（补上时间戳与状态）。
 */
export function writeEntry(root, entry, { clock = Date.now, status = 'active' } = {}) {
  const paths = ensureLayout(root)
  const now = isoNow(clock)
  const next = {
    ...entry,
    status: entry.status ?? status,
    createdAt: entry.createdAt ?? now,
    modifiedAt: now,
    lastVerifiedAt: entry.lastVerifiedAt ?? now,
  }
  writeFileAtomic(join(paths.memories, `${next.id}.md`), serializeEntry(next))
  invalidateCorpus(root)
  return next
}

/** 退休（软删除）：转 deprecated，正文保留，退出召回。 */
export function retireEntry(root, id, { clock = Date.now, reason = '' } = {}) {
  const entry = findEntry(root, id)
  if (!entry) return null
  const next = { ...entry, status: 'deprecated', modifiedAt: isoNow(clock) }
  writeFileAtomic(join(layout(root).memories, `${id}.md`), serializeEntry(next))
  invalidateCorpus(root)
  return { entry: next, reason }
}

/** 硬删除：**只能由用户裁决触发**。 */
export function deleteEntry(root, id) {
  const file = join(layout(root).memories, `${id}.md`)
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  invalidateCorpus(root)
  return true
}

/* ── 访问统计 ─────────────────────────────────────────────────────── */

/**
 * 访问计数存在**独立文件**里，不写回 `.md`。
 *
 * 为什么：每次召回都改一次条目，会让 `git status` 永远脏、让 `git blame` 变成噪声、
 * 让内容哈希每次都变（回执全部失效）。访问是**遥测**，不是内容。
 */
export function readStats(root) {
  const paths = layout(root)
  if (!existsSync(paths.stats)) return { schema: 'dsh-memory.stats/v1', entries: {} }
  try {
    const parsed = JSON.parse(readFileSync(paths.stats, 'utf8'))
    return {
      schema: 'dsh-memory.stats/v1',
      entries: parsed && typeof parsed.entries === 'object' && parsed.entries ? parsed.entries : {},
    }
  } catch {
    return { schema: 'dsh-memory.stats/v1', entries: {} }
  }
}

/** 记一次召回。返回实际被更新的 id（不存在的条目静默跳过）。 */
export function touchEntries(root, ids, { clock = Date.now } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) return []
  const paths = layout(root)
  const stats = readStats(root)
  const now = isoNow(clock)
  const touched = []
  for (const id of ids) {
    if (typeof id !== 'string' || !id) continue
    const current = stats.entries[id] ?? { accessCount: 0, lastAccessed: null }
    stats.entries[id] = { accessCount: current.accessCount + 1, lastAccessed: now }
    touched.push(id)
  }
  if (touched.length === 0) return []
  try {
    writeFileAtomic(paths.stats, `${stableJson(stats, 2)}\n`)
  } catch {
    /* 遥测写不进去不能拖垮召回 */
  }
  return touched
}

/** 把统计合并回条目视图（`readAll` 不改文件，只补字段）。 */
export function withStats(entries, stats) {
  return entries.map((entry) => {
    const record = stats?.entries?.[entry.id]
    return record ? { ...entry, accessCount: record.accessCount ?? 0, lastAccessed: record.lastAccessed ?? null } : entry
  })
}

/* ── 回执 ─────────────────────────────────────────────────────────── */

export function readReceipts(root) {
  const paths = layout(root)
  if (!existsSync(paths.receipts)) return { schema: 'dsh-memory.trust/v1', receipts: [] }
  try {
    const parsed = JSON.parse(readFileSync(paths.receipts, 'utf8'))
    return { schema: 'dsh-memory.trust/v1', receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [] }
  } catch {
    return { schema: 'dsh-memory.trust/v1', receipts: [] }
  }
}

/**
 * 写回执。**链式**：新回执必须指向前一条的 contentHash，
 * 第一次必须是 `import` 且前驱为 null。
 */
export function appendReceipt(root, entry, { verifier = { kind: 'gate', id: 'mrp-v1' }, clock = Date.now } = {}) {
  const store = readReceipts(root)
  const previous = store.receipts.find((item) => item.memoryId === entry.id)
  const content = contentHash(entry)
  const root_ = evidenceRoot(entry)
  const receipt = {
    memoryId: entry.id,
    contentHash: content,
    evidenceRoot: root_,
    lifecycle: entry.status ?? 'active',
    actionRisk: entry.actionRisk ?? 'R1',
    scopes: entry.scope ?? [],
    change: previous
      ? { mode: 'delta', baseContentHash: previous.contentHash }
      : { mode: 'import', baseContentHash: null },
    verifier,
    issuedAt: isoNow(clock),
    rollback: {
      previousContentHash: previous?.contentHash ?? null,
      previousEvidenceRoot: previous?.evidenceRoot ?? null,
    },
  }
  const next = {
    schema: 'dsh-memory.trust/v1',
    receipts: [...store.receipts.filter((item) => item.memoryId !== entry.id), receipt],
  }
  writeFileAtomic(layout(root).receipts, `${stableJson(next, 2)}\n`)
  return receipt
}

/** 回执是否仍然有效（内容没被改过）。 */
export function receiptStatus(root, entry) {
  const receipt = readReceipts(root).receipts.find((item) => item.memoryId === entry.id)
  if (!receipt) return 'missing'
  if (receipt.contentHash !== contentHash(entry)) return 'tampered'
  if (receipt.evidenceRoot !== evidenceRoot(entry)) return 'evidence-tampered'
  return 'ok'
}

/* ── 审计日志（append-only） ───────────────────────────────────────── */

/** 追加一行。**永不删**：这是「它到底自己记了什么」的唯一答案。 */
export function appendLedger(root, record, { clock = Date.now } = {}) {
  const paths = ensureLayout(root)
  const line = stableJson({ ts: isoNow(clock), ...record })
  try {
    appendFileSync(paths.ledger, `${line}\n`, 'utf8')
  } catch {
    /* 日志写不进去不能拖垮工具调用 */
  }
  return record
}

export function readLedger(root, { limit = 200 } = {}) {
  const paths = layout(root)
  if (!existsSync(paths.ledger)) return []
  try {
    return readFileSync(paths.ledger, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return { ts: null, kind: 'corrupt', raw: line }
        }
      })
  } catch {
    return []
  }
}

/* ── 待决提案 ─────────────────────────────────────────────────────── */

export function writeProposal(root, proposal, { clock = Date.now } = {}) {
  const paths = ensureLayout(root)
  const next = { ...proposal, createdAt: proposal.createdAt ?? isoNow(clock) }
  writeFileAtomic(join(paths.pending, `${next.id}.json`), `${stableJson(next, 2)}\n`)
  return next
}

export function readProposals(root) {
  const paths = layout(root)
  if (!existsSync(paths.pending)) return []
  return readdirSync(paths.pending)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(paths.pending, name), 'utf8'))
      } catch {
        return { id: basename(name, '.json'), corrupt: true }
      }
    })
}

export function findProposal(root, id) {
  return readProposals(root).find((item) => item.id === id) ?? null
}

export function removeProposal(root, id, { reject = false, clock = Date.now } = {}) {
  const paths = layout(root)
  const file = join(paths.pending, `${id}.json`)
  if (!existsSync(file)) return false
  if (reject) {
    mkdirSync(paths.rejected, { recursive: true })
    const proposal = findProposal(root, id) ?? { id }
    writeFileAtomic(
      join(paths.rejected, `${id}.json`),
      `${stableJson({ ...proposal, rejectedAt: isoNow(clock) }, 2)}\n`,
    )
  }
  rmSync(file, { force: true })
  return true
}

/** 提案 id：时间 + 随机短后缀，可排序可读。 */
export function newProposalId(clock = Date.now) {
  const stamp = new Date(clock()).toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 6)
  return `p_${stamp}_${rand}`
}

export { collapse }
