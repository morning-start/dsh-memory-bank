/**
 * 存储层：目录布局、条目读写、审计日志、待决提案、捕获收件箱。
 *
 * 布局（**只有项目层**，权威副本，随仓库 review / 回滚）：
 *
 *   <root>/.dsh-memory/
 *   ├── config.json          本项目配置
 *   ├── memories/<id>.md     一条记忆一个文件
 *   ├── trust/receipts.json  信任回执（与正文分离）
 *   ├── pending/<pid>.json   DEFER 的提案
 *   ├── pending/rejected/    被拒的提案（留档，不参与召回）
 *   ├── inbox/<id>.json      捕获队列（先落盘再处理）
 *   ├── stats.json           访问遥测
 *   ├── ledger.jsonl         全部写入尝试
 *   └── index/               内容寻址快照（可删可重建）
 *
 * **本插件不做全局记忆。** 记忆是仓库级制品 —— 跨项目的那一层由别的插件负责。
 * 这里只提供 `lib/promote.js`（把项目记忆整理成**可推广的包**），
 * 由人或那个插件消费；本插件不写、不读、不索引任何全局存储。
 *
 * 纪律：
 *   - 写一律原子（tmp → rename），读者永远看不到半个文件；
 *   - 单个坏文件不拖垮扫描，报进 problems 而不是抛；
 *   - index/ 与 ledger.jsonl 是可重建/可追加的派生物，memories/ 与 trust/ 进 git。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ID_PATTERN, assertLifecycleTransition, canonicalBody, contentHash, evidenceRoot, parseEntry, serializeEntry } from './model.js'
import { collapse, isoNow, sha256, stableJson, toRepoPath, writeFileAtomic } from './util.js'

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
    inbox: join(base, 'inbox'),
    ledger: join(base, 'ledger.jsonl'),
    stats: join(base, 'stats.json'),
    index: join(base, 'index'),
    snapshots: join(base, 'index', 'snapshots'),
    head: join(base, 'index', 'HEAD'),
    previous: join(base, 'index', 'PREVIOUS'),
    exportDir: join(base, 'export'),
    gitignore: join(base, '.gitignore'),
  }
}

const GITIGNORE_BODY = `# 派生数据：索引可重建，日志可重放。记忆正文与回执进 git。
index/
ledger.jsonl
export/
# 遥测与队列：每轮召回 / 每轮捕获都会改它们。留在 git 里就是让 git status 永远脏。
stats.json
inbox/
pending/rejected/
*.tmp-*
`

/**
 * 记忆文件的绝对路径 —— **唯一的 id → 路径转换点**。
 *
 * 为什么必须集中：`id` 来自两个不可信的地方 —— 工具参数（`memory_forget` 的
 * `id`）和**记忆文件自己的 frontmatter**（`readAll` 从内容里取）。直接
 * `join(memories, `${id}.md`)` 会被 `id: "../../package"` 穿出记忆库，
 * 落在仓库任意位置 —— 而 `memories/` 按设计是进 git、随 PR review 的。
 *
 * 三道闸：`ID_PATTERN` 只允许 `[a-z0-9_]`；`resolve` 后再 `relative` 一次，
 * 确认真的还在 `memories/` 里。
 */
export function entryFile(root, id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`memory-bank: 非法的记忆 id「${id}」—— 只允许 ${ID_PATTERN}`)
  }
  const memories = layout(root).memories
  const file = resolve(memories, `${id}.md`)
  if (toRepoPath(memories, file) === null) throw new Error(`memory-bank: 记忆 id 越界「${id}」`)
  return file
}

/** 非破坏初始化：只补缺失项，已有文件一个字节都不动。 */
export function ensureLayout(root) {
  const paths = layout(root)
  mkdirSync(paths.memories, { recursive: true })
  mkdirSync(paths.trust, { recursive: true })
  mkdirSync(paths.rejected, { recursive: true })
  mkdirSync(paths.inbox, { recursive: true })
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

import { defaultConfig } from './config/defaults.js'

/**
 * 插件内置默认值 —— **定义在 `config/defaults.js`**，这里只是转出。
 *
 * 为什么不留在本文件：默认值是四层配置（默认 → 项目 → 环境 → 行）的最底层，
 * 属于配置域；`ensureLayout` 与 `layers.js` 都读它，两处各写一份就是漂移。
 */
export { defaultConfig }

/* ── 读 ───────────────────────────────────────────────────────────── */

/**
 * 语料扫描缓存：`root -> { cheap, stamp, result, checkedAt }`。
 *
 * 为什么需要它：`systemPrompt.context` 在**每一次 prompt 装配**上跑，
 * 而装配路径扫一遍 200 条记忆 = 200 次 `readFileSync` + 200 次 YAML 解析。
 *
 * 两级失效，因为**正确性和成本在这里冲突**：
 *
 *   - **便宜戳**（目录 mtime + size，1 次 `statSync`）：抓到增删改名，抓不到
 *     就地编辑 —— 但本插件自己的写全部走 `invalidateCorpus`，所以它只负责「别人改的」。
 *   - **全量戳**（逐个文件 mtime + size）：抓得到就地编辑，但 200 次 `statSync`
 *     在 Windows 上就是 2–3 ms，不能每条查询都付。
 *
 * 折中：便宜戳一致且距上次全量核对不到 `FULL_CHECK_INTERVAL_MS` 时直接命中；
 * 否则跑一次全量。最坏情况是**外部编辑器改了一行，2 秒后才被看见** ——
 * 而在这个系统里，2 秒的陈旧远远好过每轮多付 3 毫秒。
 */
const scanCache = new Map()
const FULL_CHECK_INTERVAL_MS = 2_000

function cheapStamp(memoriesDir) {
  try {
    const stat = statSync(memoriesDir)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

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
 * 返回的 `entries` 数组与每个条目都是**冻结的**：它们是缓存里的同一批对象，
 * 任何就地修改都会污染下一次装配。
 */
export function readAll(root, { clock = Date.now } = {}) {
  const paths = layout(root)
  if (!existsSync(paths.memories)) return { entries: [], problems: [], scannedAt: isoNow(clock) }

  const dir = paths.memories
  const cheap = cheapStamp(dir)
  const cached = scanCache.get(root)
  const now = Date.now()

  /** 缓存命中时也要重算 `scannedAt` —— 否则它报的是**上一个调用方**的时钟。 */
  const hit = (record) => ({ ...record.result, scannedAt: isoNow(clock) })

  if (cached && cached.cheap === cheap && now - cached.checkedAt < FULL_CHECK_INTERVAL_MS) {
    return hit(cached)
  }

  const stamp = corpusStamp(dir)
  if (cached && cached.stamp === stamp) {
    cached.cheap = cheap
    cached.checkedAt = now
    return hit(cached)
  }

  const entries = []
  const problems = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      // **BOM 必须在解析前剥掉。** Windows 记事本 / 部分编辑器默认带 BOM 保存，
      // 而 `parseEntry` 以 `---\n` 开头判断，带 BOM 的文件会整条消失 ——
      // 只有 `memory_audit` 里一行 `parse-error`，用户以为记忆丢了。
      const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
      const entry = parseEntry(text, { idFromPath: idFromFile(name) })
      entry.path = `${MEMORY_DIR_NAME}/memories/${name}`
      /**
       * **文件名是 id 的唯一权威**，frontmatter 里写的 `id` 只当作一次性诊断。
       *
       * 为什么不能信内容：`id` 会被拼成文件路径（`writeEntry` / `retireEntry` /
       * `deleteEntry`）。一个 `id: "../../package"` 的记忆文件（来自 PR，
       * 而 `memories/` 是进 git、随 PR review 的）就能把写入/删除引到仓库任意位置。
       */
      if (entry.id !== idFromFile(name)) {
        problems.push({ file: entry.path, code: 'name-file-mismatch', detail: `${entry.id} ≠ ${idFromFile(name)}` })
        entry.id = idFromFile(name)
      }
      // 冻结：`contentHash` 的缓存挂在对象上，就地修改会让缓存永久陈旧。
      // 装配路径上的每个消费者都是只读的，所以这不是限制。
      entries.push(Object.freeze(entry))
    } catch (error) {
      problems.push({ file: `${MEMORY_DIR_NAME}/memories/${name}`, code: 'parse-error', detail: String(error?.message ?? error) })
    }
  }

  const result = Object.freeze({ entries: Object.freeze(entries), problems: Object.freeze(problems), scannedAt: isoNow(clock) })
  scanCache.set(root, { cheap, stamp, result, checkedAt: now })
  return result
}

export function findEntry(root, id) {
  return readAll(root).entries.find((entry) => entry.id === id) ?? null
}

/**
 * 活跃语料：**白名单**，不是黑名单。
 *
 * 协议规定可注入集是 `{active, advisory}`（`lifecycleInjectable`）。上一版写成
 * 「排除 deprecated/rejected/superseded」，于是 `observed` / `candidate` /
 * `shadow` / `stale` 四个未定状态照样进召回 —— 而 `stale` 按协议只该给指针。
 */
export function activeEntries(entries) {
  return entries.filter((entry) => entry.status === 'active' || entry.status === 'advisory')
}

/* ── 写 ───────────────────────────────────────────────────────────── */

/**
 * 落盘一条条目。调用方必须**已经过审核协议** —— 这里不做任何判定。
 * 返回写入后的条目（补上时间戳与状态）。
 *
 * 三条不变量由这里兜住（协议层的门不负责）：
 *   1. **终态不可逆** —— 写盘前跑 `assertLifecycleTransition`。上一版直接
 *      `status: entry.status ?? status`，于是 `deprecated → active` 静默放行：
 *      一条已退休的记忆，只要有一条同 id 的提案被 accept 就复活了。
 *   2. **id 不能穿出 memories/** —— 走 `entryFile`。
 *   3. **不许静默覆盖另一条记忆** —— 见下。
 *
 * ## 为什么需要第 3 条
 *
 * `normalizeId` 把 `[\s-]` 统一成 `_`、丢掉其余非 ASCII 字母数字，这个映射
 * **按设计是多对一的**（`deploy-staging` / `deploy staging` / `deploy_staging`
 * 被当成同一条记忆）。但「同一条」是**猜测**：两条真正不同的记忆撞上同一个
 * slug 时，`writeFileAtomic` 会直接覆盖文件 —— 正文、回执、`supersedes` 链
 * 一起消失，而 `memory_remember` 返回「已记住」。
 *
 * G2 判据 2「id 在语料里唯一」（`docs/03:195`）在 0.2.0 里**没有任何消费者**。
 * 这里就是那个消费者：**同 id 但标题不同** = 两条不同的记忆 → 拒绝，让调用方
 * 传显式 id，或先退休旧条目。
 *
 * 同 id + **同标题**是合法的「重写这条记忆」（编辑、重签回执、accept 提案），
 * 不拦。需要跨标题改写（`memory_resolve` 的 `edit`、merge 合并）时显式传
 * `{ overwrite: true }` —— 意图写在调用点，而不是靠默认值。
 *
 * @param {{ overwrite?: boolean }} [options]
 */
export function writeEntry(root, entry, { clock = Date.now, status = 'active', overwrite = false } = {}) {
  ensureLayout(root)
  const now = isoNow(clock)
  const previous = typeof entry.id === 'string' ? findEntry(root, entry.id) : null
  const nextStatus = entry.status ?? status
  assertLifecycleTransition(previous?.status ?? null, nextStatus)

  const next = {
    ...entry,
    // 存**规范形式** —— 文件里写的就是 `serializeEntry(canonicalBody(...))`，
    // 内存里若保留原始 body，`contentHash(写回值)` 就和 `contentHash(读回值)` 不同。
    body: canonicalBody(entry.body),
    status: nextStatus,
    createdAt: entry.createdAt ?? previous?.createdAt ?? now,
    modifiedAt: now,
    /**
     * **显式 `null` 必须保留。**
     *
     * 上一版是 `entry.lastVerifiedAt ?? now` —— `??` 把 `null` 当缺省，
     * 于是「从没验证过」这个状态**不可表达**：任何写入都会被自动盖上
     * 「刚刚验证过」。`lifecycle.consolidate` 产出的合并条目正是靠
     * 显式 `null` 表达「这段文本没有任何人验证过」，被 `??` 一兜就丢了。
     *
     * 判据用 `=== undefined` 而不是 `in`：调用方 spread 一份读回来的条目时
     * （`retireEntry` / `writeEntry({...entry})`）该字段总是存在，
     * 只有**新建**条目才缺键 —— 缺键才叫「刚建立，就是现在」。
     */
    lastVerifiedAt: entry.lastVerifiedAt === undefined ? now : entry.lastVerifiedAt,
  }

  if (previous !== null && !overwrite && previous.title !== next.title) {
    const error = new Error(
      `memory-bank: id「${next.id}」已被另一条记忆占用（「${previous.title ?? previous.id}」）—— ` +
        `标题归一化后撞到了同一个 id。传一个显式 id，或先 memory_forget 退休旧条目。`,
    )
    error.code = 'id-collision'
    error.id = next.id
    error.existingTitle = previous.title ?? null
    throw error
  }

  writeFileAtomic(entryFile(root, next.id), serializeEntry(next))
  invalidateCorpus(root)
  return next
}

/** 退休（软删除）：转 deprecated，正文保留，退出召回。 */
export function retireEntry(root, id, { clock = Date.now, reason = '' } = {}) {
  const entry = findEntry(root, id)
  if (!entry) return null
  assertLifecycleTransition(entry.status ?? null, 'deprecated')
  const next = { ...entry, status: 'deprecated', modifiedAt: isoNow(clock) }
  writeFileAtomic(entryFile(root, id), serializeEntry(next))
  invalidateCorpus(root)
  return { entry: next, reason }
}

/** 硬删除：**只能由用户裁决触发**。 */
export function deleteEntry(root, id) {
  const file = entryFile(root, id)
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
    // `Array.isArray` 必须单独排除：数组也是 `typeof 'object'`，而一旦 `entries`
    // 是数组，`entries[id] = ...` 会挂成非索引属性，`stableJson` 的 `sortKeys`
    // 走 `.map` 把它们全丢掉 —— 之后**每一次**写入都静默消失。
    const usable = parsed && typeof parsed.entries === 'object' && parsed.entries && !Array.isArray(parsed.entries)
    return { schema: 'dsh-memory.stats/v1', entries: usable ? parsed.entries : {} }
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
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) continue
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
 * 内容哈希的**算法版本**。
 *
 * 0.1.1 把 `actionRisk` / `provenance` / `confidence` / `status` / `relations` /
 * `claims` 补进了 `contentHash`（漏了它们，改成 R5 的索引永远不重建）。
 * 0.3.3 又把 `authority` 补了进去（同样的理由：它落在快照 document 上、
 * 被渲染给模型看）。
 * 哈希一变，**旧回执就会全部对不上** —— 而那些记忆一个字都没被改。
 *
 * 所以回执带版本号：版本低于当前的回执报 `needs-reseed`（提示重新签一次），
 * **不报 `tampered`**。虚假的篡改指控比没有回执更糟 —— 它训练用户忽略这个警告。
 */
export const RECEIPT_HASH_VERSION = 3

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
    hashVersion: RECEIPT_HASH_VERSION,
    contentHash: content,
    evidenceRoot: root_,
    lifecycle: entry.status ?? 'active',
    actionRisk: entry.actionRisk ?? 'R1',
    // 回执**镜像**条目的权威，与 `actionRisk` 同形 —— 回执不是第二个事实源。
    authority: entry.authority ?? 'observed',
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

/**
 * 回执是否仍然有效（内容没被改过）。
 *
 * 返回 `missing` / `ok` / `tampered` / `evidence-tampered` / `needs-reseed`。
 * `needs-reseed` 是**升级路径**：哈希算法版本变了的旧回执不是篡改，
 * 只是要重签一次。`memory_audit` 单独渲染它，不混进「正文被改」。
 */
export function receiptStatus(root, entry) {
  const receipt = readReceipts(root).receipts.find((item) => item.memoryId === entry.id)
  if (!receipt) return 'missing'
  // 旧版本的哈希字段集不同 —— 这不是篡改，只是需要重签一次。
  if ((receipt.hashVersion ?? 1) < RECEIPT_HASH_VERSION) return 'needs-reseed'
  if (receipt.contentHash !== contentHash(entry)) return 'tampered'
  if (receipt.evidenceRoot !== evidenceRoot(entry)) return 'evidence-tampered'
  return 'ok'
}

/**
 * **批量重签回执** —— `needs-reseed` 的修复路径。
 *
 * ## 为什么必须有这个函数
 *
 * 哈希字段集每变一次（0.1.1 的 `actionRisk` / `provenance` / `confidence`…，
 * 0.3.3 的 `authority`），全部既有回执都会对不上。`receiptStatus` 把它们报成
 * `needs-reseed` 而不是 `tampered` —— 这是诚实的，但**光诚实不够**：
 *
 * 没有修复路径，审计里那条「ℹ 回执待重签 N 条」就**永远不会消失**，
 * 而永久存在的警告会被学会忽略（`RECEIPT_HASH_VERSION` 的注释正是这么说的：
 * 「虚假的篡改指控比没有回执更糟 —— 它训练用户忽略这个警告」）。
 * `needs-reseed` 是它的温和版，不是它的例外。
 *
 * ## 它改什么、不改什么
 *
 * **只改回执，不碰记忆正文。** 正文没被改过，被改的是「哈希怎么算」——
 * 这两件事必须能分开，否则「重签」和「篡改」就不可区分。
 *
 * 所以 `change` / `rollback` / `verifier` 链条**原样保留**，只更新
 * `hashVersion` / `contentHash` / `evidenceRoot` / 镜像字段，
 * 并留下 `resealedFrom`（从哪个版本重签）与 `resealedAt`。
 * **一次不可追溯的重签和一次篡改没有区别。**
 *
 * 整批一次写盘（`byId` 就地替换 + 一次 `writeFileAtomic`），
 * 不是「每条读一遍写一遍」—— 那样半途失败会留下一半新一半旧的回执文件。
 *
 * @returns {{ resealed: string[], receipts: object[] }}
 */
export function resealReceipts(root, entries, { clock = Date.now } = {}) {
  const store = readReceipts(root)
  const byId = new Map(store.receipts.map((receipt) => [receipt.memoryId, receipt]))
  const resealed = []

  for (const entry of entries) {
    const receipt = byId.get(entry.id)
    if (!receipt) continue
    const from = receipt.hashVersion ?? 1
    if (from >= RECEIPT_HASH_VERSION) continue

    byId.set(entry.id, {
      ...receipt,
      hashVersion: RECEIPT_HASH_VERSION,
      contentHash: contentHash(entry),
      evidenceRoot: evidenceRoot(entry),
      lifecycle: entry.status ?? 'active',
      actionRisk: entry.actionRisk ?? 'R1',
      authority: entry.authority ?? 'observed',
      scopes: entry.scope ?? [],
      resealedFrom: from,
      resealedAt: isoNow(clock),
    })
    resealed.push(entry.id)
  }

  if (resealed.length === 0) return { resealed, receipts: store.receipts }

  const next = {
    schema: 'dsh-memory.trust/v1',
    // 遍历**原数组**而不是 `byId.values()`：回执文件的顺序是签名历史的一部分。
    receipts: store.receipts.map((receipt) => byId.get(receipt.memoryId) ?? receipt),
  }
  writeFileAtomic(layout(root).receipts, `${stableJson(next, 2)}\n`)
  return { resealed, receipts: next.receipts }
}

/* ── 审计日志（append-only） ───────────────────────────────────────── */

/**
 * ledger 写失败的出口。
 *
 * `appendLedger` 不能抛（它挂在每一次写入尝试上，抛了就变成「记忆写不进去」），
 * 但**也不能静默** —— `docs/02:34` 的纪律 7 是「失败必须可见；静默失败比不记忆更糟」。
 * 上一版是 `catch { /* 空 *\/ }`，于是 ledger 写不进去时没人知道，
 * 而 `memory_audit` 的拒答率 / 延迟率**全都偏小**，看起来一切正常。
 */
let ledgerErrorHandler = null

/** 由 `index.js` 接到宿主的 `log` 上。 */
export function onLedgerError(handler) {
  ledgerErrorHandler = typeof handler === 'function' ? handler : null
}

/** 追加一行。**永不删**：这是「它到底自己记了什么」的唯一答案。 */
export function appendLedger(root, record, { clock = Date.now } = {}) {
  const paths = ensureLayout(root)
  const line = stableJson({ ts: isoNow(clock), ...record })
  try {
    appendFileSync(paths.ledger, `${line}\n`, 'utf8')
    return record
  } catch (error) {
    try {
      ledgerErrorHandler?.(`ledger 写入失败（${record?.kind ?? 'unknown'}）：${error?.message ?? error}`)
    } catch {
      /* 连日志通道都坏了，那就真的没办法了 */
    }
    return { ...record, ledgerWriteFailed: true }
  }
}

export function readLedger(root, { limit = 200 } = {}) {
  const paths = layout(root)
  if (!existsSync(paths.ledger)) return []
  if (!Number.isFinite(limit) || limit <= 0) return []
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

/**
 * 队列文件名 → id。**只接受安全字符集**。
 *
 * `inbox/<id>.json` 与 `pending/<id>.json` 的 id 会被拼成路径，而 inbox 的 id
 * 来自**文件内容**（`readInbox` 里 `JSON.parse` 出来的 `id` 字段），drain 循环
 * 又把它原样喂给 `removeInbox`。一个 `{"id":"../../../victim"}` 的队列项
 * 就能删掉记忆库外任意文件。
 */
const SAFE_QUEUE_ID = /^[A-Za-z0-9_-]+$/

function queueId(name) {
  const id = name.replace(/\.json$/, '')
  return SAFE_QUEUE_ID.test(id) ? id : null
}

/* ── 捕获收件箱（durable queue） ─────────────────────────────────── */

/**
 * 捕获收件箱：`inbox/<id>.json`，**先落盘再处理**。
 *
 * 为什么必须落盘：`agent/turn-stopping` 是宿主 **await** 的路径，
 * 而「跑十道门 + 起草正文 + 写记忆 + 重建索引」是 100 ms 量级。
 * 把整条链路塞进那条路径，就是让用户多等 100 ms 才看到回合结束。
 *
 * 所以 turn-stopping 只做「确定性判定 + 把事实快照落盘」（~1 ms），
 * 真正的处理交给后台 drain。落盘而不是纯内存队列，是为了**进程崩了也不丢**。
 */
export function writeInbox(root, item, { clock = Date.now } = {}) {
  const paths = ensureLayout(root)
  const id = item.id ?? `i_${clock().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const record = { ...item, id, enqueuedAt: item.enqueuedAt ?? isoNow(clock) }
  writeFileAtomic(join(paths.inbox, `${id}.json`), `${stableJson(record, 2)}\n`)
  return record
}

export function readInbox(root) {
  const paths = layout(root)
  if (!existsSync(paths.inbox)) return []
  return readdirSync(paths.inbox)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      try {
        const record = JSON.parse(readFileSync(join(paths.inbox, name), 'utf8'))
        // 文件内容里的 id 只是**提示**，永远以文件名为准 —— 否则一个
        // `{"id":"../../../victim"}` 的队列项就能让 drain 删掉库外文件。
        return { ...record, id: queueId(name) ?? name.replace(/\.json$/, '') }
      } catch {
        return { id: name.replace(/\.json$/, ''), corrupt: true }
      }
    })
}

/** 入队 id → 绝对路径。三道闸：字符集、去扩展名、根约束。 */
function inboxFile(root, id) {
  if (typeof id !== 'string' || !SAFE_QUEUE_ID.test(id)) {
    throw new Error(`memory-bank: 非法的队列 id「${id}」`)
  }
  return join(layout(root).inbox, `${id}.json`)
}

export function removeInbox(root, id) {
  rmSync(inboxFile(root, id), { force: true })
}

export function inboxSize(root) {
  try {
    return readdirSync(layout(root).inbox).filter((name) => name.endsWith('.json')).length
  } catch {
    return 0
  }
}

/* ── 待决提案 ─────────────────────────────────────────────────────── */

/**
 * 待审队列的**上限**与**存活期**。
 *
 * ## 为什么必须有（而不是「跑起来再看」）
 *
 * 队列深度是**设计参数**，不是运行结果。一个只进不出的队列会：
 *
 * 1. 积到几百条，人就会**盖章通过** —— 那时「我看过了」变成一个不成立的陈述，
 *    而盖过章的不审比不审更危险，因为它带来虚假的保证；
 * 2. 让「待决 N 条」变成背景噪音，于是**真的**需要裁决的那条也被淹掉。
 *
 * ## 为什么是常量不是配置
 *
 * 配额（`config.quota.repo`）可以配，因为「这个仓库能放多少条」是用户的事。
 * 但「一个人一次能审多少条」不是偏好 —— 把它做成旋钮，只会让人调高它，
 * 而调高的那一刻队列就又变回死信办公室。**设计参数不该有旋钮。**
 *
 * 50 条 ≈ 一个人一次坐下来看得完的量；14 天 ≈ 两周没碰就说明它不重要。
 */
export const PROPOSAL_QUEUE_LIMIT = 50
export const PROPOSAL_TTL_DAYS = 14

/**
 * 写一条待决提案。
 *
 * **队列满时抛 `queue-full`** —— 不静默丢，也不无限长。
 * 调用方必须处理：自动捕获降级为 DISCARD（记 ledger），工具面回「先裁决」。
 * 静默丢弃一条本该记住的记忆是这个系统最坏的失败方式，所以这里必须是异常，
 * 不是 `return null`。
 */
export function writeProposal(root, proposal, { clock = Date.now, limit = PROPOSAL_QUEUE_LIMIT } = {}) {
  const paths = ensureLayout(root)
  const existing = readProposalDir(paths.pending)
  if (existing.length >= limit) {
    const error = new Error(
      `待审队列已满（${existing.length}/${limit}）—— 这条没有进队列。` +
        `先裁决一些：\`/memory pending\` → \`/memory accept|reject <id>\`。`,
    )
    error.code = 'queue-full'
    error.count = existing.length
    error.limit = limit
    throw error
  }
  const next = { ...proposal, createdAt: proposal.createdAt ?? isoNow(clock) }
  writeFileAtomic(join(paths.pending, `${next.id}.json`), `${stableJson(next, 2)}\n`)
  return next
}

/**
 * 让过期的提案**自动退场**（进 `pending/rejected/` 留档，不删除）。
 *
 * 这是队列的**出口**。没有它，`PROPOSAL_QUEUE_LIMIT` 迟早会被撞上，
 * 而「撞上」的表现是自动捕获开始失败 —— 那是最糟的发现方式。
 *
 * 过期 ≠ 拒绝：拒绝是「我看过了，不要」，过期是「两周没人看，它不重要」。
 * 两者都留档，但 `expiredAt` 与 `rejectedAt` 分开记 —— 前者是一次
 * **没有发生的**裁决，把它混进拒绝里会让「拒答率」这个数字失真。
 *
 * @returns {string[]} 被移出队列的提案 id
 */
export function expireProposals(root, { clock = Date.now, ttlDays = PROPOSAL_TTL_DAYS } = {}) {
  const paths = layout(root)
  if (!existsSync(paths.pending)) return []
  const cutoff = clock() - ttlDays * 86_400_000
  const expired = []

  for (const proposal of readProposalDir(paths.pending)) {
    if (proposal?.corrupt) continue
    const created = Date.parse(proposal.createdAt ?? '')
    if (!Number.isFinite(created) || created > cutoff) continue
    mkdirSync(paths.rejected, { recursive: true })
    writeFileAtomic(
      proposalFile(paths.rejected, proposal.id),
      `${stableJson({ ...proposal, expiredAt: isoNow(clock), ttlDays }, 2)}\n`,
    )
    rmSync(proposalFile(paths.pending, proposal.id), { force: true })
    expired.push(proposal.id)
  }

  return expired
}

function readProposalDir(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(dir, name), 'utf8'))
      } catch {
        // 坏文件必须**降级**成一条记录，不能让它抛 —— 这个 catch 里的
        // `basename` 曾经没导入，于是一个被截断的提案文件让待决面板、
        // 审计、裁决三条路一起 ReferenceError。纪律是「单个坏文件不拖垮扫描」。
        return { id: name.replace(/\.json$/, ''), corrupt: true }
      }
    })
}

export function readProposals(root) {
  return readProposalDir(layout(root).pending)
}

/** 被拒的提案（留档，不参与召回）。`memory_pending(include_rejected)` 的读侧。 */
export function readRejectedProposals(root) {
  return readProposalDir(layout(root).rejected)
}

export function findProposal(root, id) {
  return readProposals(root).find((item) => item.id === id) ?? null
}

function proposalFile(dir, id) {
  if (typeof id !== 'string' || !SAFE_QUEUE_ID.test(id)) {
    throw new Error(`memory-bank: 非法的提案 id「${id}」`)
  }
  return join(dir, `${id}.json`)
}

export function removeProposal(root, id, { reject = false, clock = Date.now } = {}) {
  const paths = layout(root)
  const file = proposalFile(paths.pending, id)
  if (!existsSync(file)) return false
  if (reject) {
    mkdirSync(paths.rejected, { recursive: true })
    const proposal = findProposal(root, id) ?? { id }
    writeFileAtomic(
      proposalFile(paths.rejected, id),
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
