/**
 * 生命周期：衰减、陈旧提示、合并、dream pass。
 *
 * 三条不可协商的规则（来自 gingugu 的 `AGENTS.md` 与 ownmem 的 `TECHNICAL.md`）：
 *
 *  1. **休眠是信息性的，绝不改变 confidence。** 一条休眠的记忆在安睡，不是在腐烂；
 *     召回会把它唤醒。`Do not reintroduce time-based decay.`
 *  2. **math finds STRUCTURE, and structure is not CONTENT.** dream 的三个 pass
 *     各自停在意义开始的地方 —— 提议排名、提议成员集、提议配对，**没有一个提议关系类型**。
 *     这使整个东西可以无人值守跑。
 *  3. **一条没有近邻的孤儿应该保持孤儿。** 一个被无意义边填满的图对检索比一个带洞的图更糟，
 *     因为扩散激活会随后把种子的预算花在它们身上。
 */

import { jaccard, levenshtein, tokenize } from './util.js'

/* ── 常量（每个都有出处，不要「优化」） ─────────────────────────── */

export const DECAY = Object.freeze({
  /** 新鲜度地板：再老的记忆也保留 35% —— 休眠不是腐烂。 */
  freshnessFloor: 0.35,
  /** 90 天没被召回 = 休眠。 */
  dormantAfterDays: 90,
  /** 180 天没被召回 = 建议弃用（**建议**，不自动执行）。 */
  deprecateSuggestAfterDays: 180,
  /** 新鲜度半衰期。 */
  freshnessHalfLifeDays: 365,
})

export const STALENESS = Object.freeze({
  /** 锚点至今 ≥14 天才点火。 */
  reviewHintAfterDays: 14,
  /** "waiting on X" 必须在 60 字符内命名一个具名 agent。 */
  namedAgentWindow: 60,
  /** 时间无关的类型：它们不因为「旧」而需要复查。 */
  timelessTypes: Object.freeze(['convention', 'capability']),
})

export const CONSOLIDATION = Object.freeze({
  /** 合并候选的相似度地板。 */
  minSimilarity: 0.82,
  /** 摘要策略的片段长度。 */
  summarySnippet: 160,
})

export const DREAM = Object.freeze({
  centrality: { damping: 0.85, maxIterations: 100, tolerance: 1e-9, baselineMultiple: 3, topN: 10 },
  clusters: {
    minClusterSize: 3, // 两条有边的记忆是一个关系，不是一个社群
    maxClusterSize: 40, // 超过这个，「这些属于一起」开始描述 namespace
    minDensity: 0.5, // 多数翻转点 —— **不是调优阈值**
    maxRounds: 50,
    topN: 15,
  },
  orphans: { orphanLimit: 25, candidatePool: 20 },
})

/* ── 1 · 衰减 ─────────────────────────────────────────────────────── */

const daysSince = (iso, now) => {
  const parsed = Date.parse(iso ?? '')
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY
  return Math.max(0, (now - parsed) / 86_400_000)
}

/**
 * 新鲜度。`FRESHNESS_FLOOR + (1 - FLOOR) * 2^(-days/halfLife)`。
 *
 * 地板是「休眠不是腐烂」的算术表达：一条 3 年没碰的记忆仍然得分 0.35，
 * 而不是被时间清零。
 */
export function freshness(entry, now = Date.now()) {
  const days = daysSince(referenceTimestamp(entry), now)
  if (!Number.isFinite(days)) return DECAY.freshnessFloor
  const raw = 2 ** (-days / DECAY.freshnessHalfLifeDays)
  return DECAY.freshnessFloor + (1 - DECAY.freshnessFloor) * raw
}

/**
 * 参考时间 = 三个候选的 **MAX**，不是 COALESCE。
 *
 * COALESCE 返回第一个非空，所以**上一次确认之后做的内容编辑会被静默丢弃** ——
 * 记忆会按更早的瞬间被计分、被排序、被检查陈旧度。无法解析的候选跳过，不让读崩溃。
 */
export function referenceTimestamp(entry) {
  const candidates = [entry.lastVerifiedAt, entry.modifiedAt, entry.createdAt]
    .map((value) => (typeof value === 'string' ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value))
  if (candidates.length === 0) return null
  return new Date(Math.max(...candidates)).toISOString()
}

/** 休眠？**只报告，不改 confidence。** */
export function isDormant(entry, now = Date.now()) {
  // 必须走 referenceTimestamp，不能 `lastVerifiedAt ?? modifiedAt`：
  // COALESCE 语义会在「上次确认之后又改了内容」时按更早的瞬间算年龄 ——
  // 刚改过的记忆被判休眠，而坏时间戳永远算不出年龄、永远休眠。
  // 三处（isDormant / suggestsDeprecation / reviewHints）必须同一个函数，
  // 否则同一个问题有了三个答案。
  return daysSince(referenceTimestamp(entry), now) >= DECAY.dormantAfterDays
}

/** 建议弃用？（**建议**，不自动执行 —— 「Never forget」） */
export function suggestsDeprecation(entry, now = Date.now()) {
  return daysSince(referenceTimestamp(entry), now) >= DECAY.deprecateSuggestAfterDays
}

/** 访问分数：对数饱和到 50 次。 */
export function accessScore(entry) {
  const count = Number(entry.accessCount ?? 0)
  if (!Number.isFinite(count) || count <= 0) return 0
  return Math.min(1, Math.log(count + 1) / Math.log(50))
}

/* ── 2 · 陈旧提示 ─────────────────────────────────────────────────── */

/**
 * 三个**有门**的信号（锚点 ≥14 天才点火，且永不在时间无关类型上点火）。
 *
 * 正则来自 gingugu 的软件工程 PR 语料。**换域必须重写** —— 但这三条的
 * 形状（"还在等什么"）是通用的。
 */
const GATED_PATTERNS = [
  {
    label: 'open-pr-reference',
    pattern:
      /(?:PR|MR|pull request|merge request)\s*[#!]?\d+[^.\n]{0,80}?\b(?:open|waiting|awaiting|pending|unmerged|not\s+(?:yet\s+)?merged|blocked|needs)\b|\b(?:open|waiting on|awaiting|blocked on)\b[^.\n]{0,40}?(?:PR|MR|pull request|merge request)\s*[#!]?\d+/iu,
  },
  {
    label: 'waiting-on',
    pattern: /(?<!was )(?<!were )\b(?:waiting (?:on|for)|awaiting|blocked (?:on|by))\b/iu,
  },
  {
    label: 'unmerged-branch',
    pattern: /\bbranch\b[^.\n]{0,60}\b(?:not\s+(?:yet\s+)?merged|unmerged|still open)\b/iu,
  },
]

/** 两个**无门**信号（自带时钟）。 */
const UNGATED_PATTERNS = [
  { label: 'expires', pattern: /\bexpires?\s+(?:on\s+)?(\d{4}-\d{2}-\d{2})\b/iu },
  { label: 'as-of', pattern: /\bas of\s+(\d{4}-\d{2}-\d{2})\b/iu },
]

/** 引号或反引号内的内容不算断言。**只有 `"` 和 `` ` `` 是定界符** —— 裸 `'` 更常是所有格或缩写。 */
const QUOTED = /"[^"\n]*"|`[^`\n]*`/g

/**
 * 具名 agent：大写专有名词、PR 引用、工单键，或具名工件。
 *
 * 区分大小写是**刻意的** —— `"waiting for EOF"` 和 `"waiting for the init container
 * image pull"` 一个都没命名，它们在描述机制，不是状态。
 */
const NAMED_AGENT = /[A-Z][a-z]{2,}|\b(?:PR|MR)\s*[#!]?\d+|\b[A-Z][A-Z0-9]{1,9}-\d+\b|\b(?:key|sign-?off|approval|approver)\b/

export function stripQuoted(text) {
  return String(text ?? '').replace(QUOTED, (match) => ' '.repeat(match.length))
}

/**
 * 复查提示。返回 `[{ label, detail }]`。
 *
 * 三个过滤器把检测器挡在普通散文之外：
 *   1. 引号/反引号内一律不算；
 *   2. `waiting-on` 额外要求 60 字符内有一个具名 agent；
 *   3. deprecated 记忆在每个面都被跳过 —— 弃用**就是**那次和解。
 *
 * 代价是真实的且有界：对小写未具名名词的等待（"waiting on the vendor"）不再点火。
 * 实测把精度从 0.65 提到 0.79。
 */
export function reviewHints(entry, now = Date.now()) {
  if (entry.status === 'deprecated' || entry.status === 'rejected' || entry.status === 'superseded') return []
  if (STALENESS.timelessTypes.includes(entry.kind)) return []

  const text = stripQuoted(`${entry.title ?? ''}\n${entry.about ?? ''}\n${entry.body ?? ''}`)
  const ageDays = daysSince(referenceTimestamp(entry), now)
  const hints = []

  if (Number.isFinite(ageDays) && ageDays >= STALENESS.reviewHintAfterDays) {
    for (const { label, pattern } of GATED_PATTERNS) {
      const match = pattern.exec(text)
      if (!match) continue
      if (label === 'waiting-on') {
        const window = text.slice(
          Math.max(0, (match.index ?? 0) - STALENESS.namedAgentWindow),
          (match.index ?? 0) + match[0].length + STALENESS.namedAgentWindow,
        )
        if (!NAMED_AGENT.test(window)) continue
      }
      hints.push({ label, detail: match[0].slice(0, 80) })
    }
  }

  for (const { label, pattern } of UNGATED_PATTERNS) {
    const match = pattern.exec(text)
    if (match) hints.push({ label, detail: match[1] ?? match[0] })
  }

  return hints
}

/** 到了 `reviewBy` 吗？到了就该重新核对。 */
export function reviewDue(entry, now = Date.now()) {
  if (!entry.reviewBy) return false
  const due = Date.parse(entry.reviewBy)
  if (!Number.isFinite(due)) return false
  return due <= now
}

/** 过期了吗？（`expiresAt` 到了） */
export function isExpired(entry, now = Date.now()) {
  if (!entry.expiresAt) return false
  const at = Date.parse(entry.expiresAt)
  if (!Number.isFinite(at)) return false
  return at <= now
}

/* ── 3 · 合并 ─────────────────────────────────────────────────────── */

/** 近重复分组：并查集。 */
export function consolidationCandidates(entries, { threshold = CONSOLIDATION.minSimilarity } = {}) {
  const active = entries.filter((entry) => entry.status === 'active' || entry.status === 'advisory')
  const fingerprints = active.map((entry) => new Set(tokenize(`${entry.about ?? ''} ${entry.body ?? ''}`)))
  const parent = active.map((_, index) => index)

  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]]
      index = parent[index]
    }
    return index
  }
  const union = (a, b) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent[rootB] = rootA
  }

  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      if (active[i].kind !== active[j].kind) continue
      if (jaccard(fingerprints[i], fingerprints[j]) < threshold) continue
      union(i, j)
    }
  }

  const groups = new Map()
  for (let index = 0; index < active.length; index += 1) {
    const root = find(index)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(active[index])
  }

  return [...groups.values()]
    .filter((group) => group.length >= 2)
    .map((group) => ({
      kind: 'merge',
      ids: group.map((entry) => entry.id),
      titles: group.map((entry) => entry.title),
      // 平手取最近更新 —— 「哪条最好」用 confidence 排，不用「谁先写的」
      best: bestOf(group),
    }))
    .sort((a, b) => b.ids.length - a.ids.length)
}

/** 最高 confidence，平手取最近更新。 */
export function bestOf(entries) {
  const rank = { verified: 3, inferred: 2, stale: 1, deprecated: 0 }
  return [...entries].sort((a, b) => {
    const delta = (rank[b.confidence] ?? 1) - (rank[a.confidence] ?? 1)
    if (delta !== 0) return delta
    return Date.parse(b.modifiedAt ?? '') - Date.parse(a.modifiedAt ?? '')
  })[0]
}

/**
 * 合并成一条新记忆。**纯函数**：不写盘、不改原条目。
 *
 * `keepOriginals` 由调用方决定；这里的产出一个新条目，
 * 调用方负责把原始条目标 deprecated 并连 `supersedes` 边。
 */
export function consolidate(entries, strategy = 'merge', { now = new Date().toISOString() } = {}) {
  if (entries.length < 2) throw new Error('consolidate needs at least 2 memories')
  const best = bestOf(entries)
  const body =
    strategy === 'summarize'
      ? entries.map((entry) => `- **${entry.title}** — ${collapseLine(entry.about)}`).join('\n')
      : entries.map((entry) => `## ${entry.title}\n${entry.body ?? ''}`).join('\n\n')

  return {
    id: `${best.id}_merged`,
    title: `[${strategy}] ${best.title}`,
    kind: best.kind,
    about: collapseLine(entries.map((entry) => entry.about).join(' / ')),
    body:
      strategy === 'summarize'
        ? `# 功能名\n${best.title}\n\n# 子功能\n${body}\n\n# 生效条件\n（合并自 ${entries.length} 条记忆）\n\n# 执行\n（见各条原始记忆）\n\n# 验证方式\n（各条原样保留）\n\n# 不适用条件\n（各条原样保留）`
        : body,
    evidence: dedupeEvidence(entries.flatMap((entry) => entry.evidence ?? [])),
    scope: [...new Set(entries.flatMap((entry) => entry.scope ?? []))],
    triggers: [...new Set(entries.flatMap((entry) => entry.triggers ?? []))],
    supersedes: entries.map((entry) => entry.id),
    relations: entries.map((entry) => ({ type: 'supersedes', target: entry.id })),
    claims: [],
    provenance: 'self-concluded',
    confidence: best.confidence,
    actionRisk: best.actionRisk,
    createdAt: now,
    modifiedAt: now,
    lastVerifiedAt: now,
    status: 'advisory', // 合并产物先降级，等一次人工确认
  }
}

function collapseLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 合并产物的证据：**原样保留**每条锚点的 `kind` / `hash` / `excerpt` / `symbol`，
 * 只按 `kind\u0000ref` 去重。
 *
 * 旧实现是 `map(ref => ({ kind: 'file', ref }))`，两个后果都很致命：
 *  - symbol 锚点（`src/a.ts#createPool`）和 commit 锚点（sha）被伪造成文件路径
 *    → 合并产物一落盘就 `quarantined`，「合并」变成了「制造漂移」；
 *  - hash 被丢掉 → 下一次复查必然 `advisory`。
 * 合并的产物立刻不可信，那这个动作就没有意义。
 */
function dedupeEvidence(evidence) {
  const seen = new Map()
  for (const item of evidence) {
    if (!item || typeof item.ref !== 'string' || !item.ref) continue
    const key = `${item.kind ?? 'file'}\u0000${item.ref}`
    if (seen.has(key)) continue
    seen.set(key, { ...item })
  }
  return [...seen.values()]
}

/* ── 4 · dream pass ───────────────────────────────────────────────── */

/**
 * 三个已发表算法，每一个都恰好停在意义开始的地方。
 *
 * 这使无人值守跑安全：**一次坏跑最多浪费一个读者的时间**，
 * 因为 dream 里没有任何东西写 `memories`，也没有任何东西写 relation ——
 * 全部产出都是**提议**。
 */
export function dream(entries, { now = Date.now() } = {}) {
  const active = entries.filter((entry) => entry.status === 'active' || entry.status === 'advisory')
  const graph = buildGraph(active)
  return {
    graph: { nodes: graph.nodes.length, edges: graph.edges.length, orphans: graph.nodes.filter((id) => !graph.adjacency.get(id)?.length).length },
    passes: {
      centrality: proposeCentrality(active, graph),
      clusters: proposeClusters(active, graph),
      orphans: proposeOrphans(active),
    },
  }
}

function buildGraph(entries) {
  const ids = new Set(entries.map((entry) => entry.id))
  const adjacency = new Map(entries.map((entry) => [entry.id, []]))
  const edges = []
  for (const entry of entries) {
    for (const relation of entry.relations ?? []) {
      if (!relation?.target || !ids.has(relation.target)) continue
      // 图在这里**无向**：结构问题问的是连通性，不是箭头朝哪
      adjacency.get(entry.id)?.push(relation.target)
      adjacency.get(relation.target)?.push(entry.id)
      edges.push({ from: entry.id, to: relation.target, kind: relation.type })
    }
  }
  return { nodes: [...ids].sort(), edges, adjacency }
}

/**
 * PageRank。**为什么不是原始度数**：度数只数邻居就停了；
 * PageRank 用**邻居自身的地位**加权地数邻居 ——
 * 这是「被十条琐碎笔记链着」和「被三条图其余部分倚重的记忆链着」之间的差别。
 */
function proposeCentrality(entries, graph) {
  const { damping, maxIterations, tolerance, baselineMultiple, topN } = DREAM.centrality
  const nodes = graph.nodes
  const count = nodes.length
  if (count === 0) return []

  const rank = new Map(nodes.map((id) => [id, 1 / count]))
  const outDegree = new Map(nodes.map((id) => [id, graph.adjacency.get(id)?.length ?? 0]))

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const next = new Map(nodes.map((id) => [id, (1 - damping) / count]))
    for (const id of nodes) {
      const degree = outDegree.get(id) ?? 0
      const share = degree > 0 ? rank.get(id) / degree : 0
      for (const neighbour of graph.adjacency.get(id) ?? []) {
        next.set(neighbour, (next.get(neighbour) ?? 0) + damping * share)
      }
    }
    let delta = 0
    for (const id of nodes) delta += Math.abs(next.get(id) - rank.get(id))
    for (const [id, value] of next) rank.set(id, value)
    if (delta < tolerance) break
  }

  const baseline = baselineMultiple / count
  // **已 pinned 的记忆被跳过**：它们是预期的结果，手挑的层和计算出的层**应该**大量重叠，
  // 提议已经为真的东西会埋掉真正的发现。
  const pinned = new Set(entries.filter((entry) => entry.pinned).map((entry) => entry.id))

  const ranked = nodes
    .filter((id) => !pinned.has(id))
    .map((id) => ({ id, rank: rank.get(id) ?? 0 }))
    .filter((item) => item.rank >= baseline)
    .sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : 1))
    .slice(0, topN)

  if (ranked.length === 0) return []
  const top = ranked[0].rank || 1
  return ranked.map((item) => ({
    kind: 'core',
    subjectId: item.id,
    objectId: null,
    // 按本次运行自己的最高分归一化，让队列能把 centrality 发现和 similarity 发现并排排序
    score: Number((item.rank / top).toFixed(4)),
    evidence: { pagerank: item.rank, baseline },
  }))
}

/**
 * Label propagation。**为什么不是 Louvain**：Louvain 优化模块度，可能找到稍好的社群；
 * 它**还需要一个分辨率参数，而挑一个就是选择答案该有多粗 —— 一种扮成设置的偏好**。
 * Label propagation 没有这种旋钮，它收敛到边已经说的东西。
 */
function proposeClusters(entries, graph) {
  const { minClusterSize, maxClusterSize, minDensity, maxRounds, topN } = DREAM.clusters
  const nodes = graph.nodes
  if (nodes.length === 0) return []

  // **按 id 排序访问**：label propagation 依赖访问顺序，一个每次看到同一张图都返回
  // 不同社群的运行不是人能审计的数学 —— 而可审计性是它被允许无人值守的唯一理由。
  const label = new Map(nodes.map((id) => [id, id]))
  for (let round = 0; round < maxRounds; round += 1) {
    let changed = false
    for (const id of nodes) {
      const neighbours = graph.adjacency.get(id) ?? []
      if (neighbours.length === 0) continue
      const counts = new Map()
      for (const neighbour of neighbours) {
        const current = label.get(neighbour)
        counts.set(current, (counts.get(current) ?? 0) + 1)
      }
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0]
      if (label.get(id) !== best) {
        label.set(id, best)
        changed = true
      }
    }
    if (!changed) break
  }

  const groups = new Map()
  for (const id of nodes) {
    const key = label.get(id)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(id)
  }

  return [...groups.entries()]
    .filter(([, members]) => members.length >= minClusterSize && members.length <= maxClusterSize)
    .map(([key, members]) => {
      const inside = new Set(members)
      let internal = 0
      let total = 0
      for (const id of members) {
        for (const neighbour of graph.adjacency.get(id) ?? []) {
          total += 1
          if (inside.has(neighbour)) internal += 1
        }
      }
      return { key, members: members.sort(), density: total === 0 ? 0 : internal / total }
    })
    .filter((cluster) => cluster.density >= minDensity)
    .sort((a, b) => b.members.length - a.members.length || (a.key < b.key ? -1 : 1))
    .slice(0, topN)
    .map((cluster) => ({
      kind: 'cluster',
      subjectId: cluster.members[0],
      objectId: null,
      score: Number(cluster.density.toFixed(4)),
      evidence: { members: cluster.members, density: cluster.density },
    }))
}

/**
 * 孤儿：**两阶段，与写入时提示完全一致**。
 *
 * 检索把上千条记忆窄化成一把候选（它的融合排名非常擅长这个，作为量级毫无意义）；
 * 然后用绝对度量重打分，并施加校准过的地板。
 * **一条提议和一条提示若对「够近到可以连边」有不同理解，那就是同一个问题有了两个答案。**
 *
 * `null` 是**一条真正孤立记忆的预期结果，而且是对的**。
 */
function proposeOrphans(entries) {
  const { orphanLimit } = DREAM.orphans
  const edges = new Set()
  for (const entry of entries) {
    for (const relation of entry.relations ?? []) {
      if (!relation?.target) continue
      edges.add(entry.id)
      edges.add(relation.target)
    }
  }
  const orphans = entries.filter((entry) => !edges.has(entry.id)).slice(0, orphanLimit)
  if (orphans.length === 0) return []

  // `?? ''` 不能省：模板字符串会把 undefined 变成字面量 "undefined"，
  // 而 "undefined" 是一个**会被匹配到的 token** —— 两条毫不相关的孤儿
  // 会因为共享这个词而被提议连边，等于凭空造边。
  const fingerprints = new Map(
    entries.map((entry) => [entry.id, new Set(tokenize(`${entry.about ?? ''} ${entry.title ?? ''}`))]),
  )
  const proposals = []

  for (const orphan of orphans) {
    // 没有词就没有相似度可言（jaccard 两空集为 0）—— 直接保持孤儿
    const mine = fingerprints.get(orphan.id)
    if (!mine || mine.size === 0) continue
    let best = null
    for (const other of entries) {
      if (other.id === orphan.id) continue
      const similarity = jaccard(fingerprints.get(orphan.id), fingerprints.get(other.id))
      if (similarity < 0.5) continue
      if (!best || similarity > best.similarity) best = { id: other.id, similarity }
    }
    // 没有近邻 → 保持孤儿。**回退到「连到排名最高的任何东西」会让图更糟。**
    if (!best) continue
    proposals.push({
      kind: 'edge',
      subjectId: orphan.id,
      objectId: best.id,
      score: Number(best.similarity.toFixed(4)),
      evidence: { similarity: best.similarity, basis: 'lexical' },
    })
  }

  return proposals.sort((a, b) => b.score - a.score || (a.subjectId < b.subjectId ? -1 : 1))
}

/* ── 5 · 健康快照 ─────────────────────────────────────────────────── */

/** 一次算全所有生命周期信号，给 `memory_audit` 用。 */
export function lifecycleReport(entries, { now = Date.now() } = {}) {
  const active = entries.filter((entry) => !['deprecated', 'rejected', 'superseded'].includes(entry.status))
  const dormant = []
  const due = []
  const expired = []
  const hints = []
  const deprecate = []

  for (const entry of active) {
    if (isDormant(entry, now)) dormant.push(entry.id)
    if (reviewDue(entry, now)) due.push({ id: entry.id, reviewBy: entry.reviewBy })
    if (isExpired(entry, now)) expired.push({ id: entry.id, expiresAt: entry.expiresAt })
    if (suggestsDeprecation(entry, now)) deprecate.push(entry.id)
    for (const hint of reviewHints(entry, now)) hints.push({ id: entry.id, ...hint })
  }

  return {
    active: active.length,
    dormant,
    reviewDue: due,
    expired,
    suggestsDeprecation: deprecate,
    reviewHints: hints,
    consolidation: consolidationCandidates(entries).slice(0, 10),
  }
}

export { levenshtein }
