/**
 * 断言模型（`memory_claims`）—— 从 gingugu 抄来的最值钱的一件事。
 *
 * 一条说「PR #10 还开着」的记忆是在做**断言**。它写的时候为真，散文是诚实的历史，
 * **永不为跟踪世界而改写**。世界往前走了，我们把「后来学到了什么」另存一列。
 *
 * 没有这个原语时，唯一能记录「PR #10 已合并」的办法是改写记忆，或者粘一条
 * `=== STATUS ===` 横幅 —— 而 dogfooding 语料因此长出了 37 条记忆上的 160 种横幅风格。
 *
 * 三个被语料打出来的规则（全部有实测，不要「优化」掉）：
 *
 *  1. **无状态 ref ≠ open。** 1,161 条记忆里 225 条 ref 没断言状态，对 223 条真 claim，
 *     而它们绝大多数在叙述**已完成**的工作（"Fixed in PR #873"）。默认成 open 会把
 *     积压翻倍，全是历史。→ 独立状态 `unverified`：**是索引，不是队列**。
 *  2. **引用不是断言。** wiki-link 里的 `[[PR #10 open: …]]` 是指向同名记忆的**链接**。
 *     785 条语料上 11 条 claim 来自 wiki-link 内部，**每一条都错**。→ 抽取前抹空。
 *  3. **`shipped` 不算 resolved。** "merge HELD" 同时含两边的词；"doc shipped PR #168"
 *     指 PR 被**创建**，"PR #65 SHIPPED" 指合并。漏一条 claim 静默无害，
 *     猜错一条会教读者彻底忽略 claims。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { collapse } from './util.js'

/** 断言种类。 */
export const CLAIM_KINDS = Object.freeze(['pull-request', 'issue', 'ticket', 'dependency', 'status', 'branch'])

/** 断言状态。**永不改写** `state`；解析另存。 */
export const CLAIM_STATES = Object.freeze(['open', 'resolved', 'unverified'])

const STATE_PRECEDENCE = { unverified: 0, open: 1, resolved: 2 }

/* ── 正则（每条限制都是被语料打出来的） ─────────────────────────── */

/** 显式 URL 命名了 repo 与编号。 */
const URL_REF =
  /https?:\/\/(?:www\.)?(?:github|gitlab)\.com\/([\w.-]+(?:\/[\w.-]+)*?)\/(?:pull|-\/merge_requests|merge_requests)\/(\d+)/giu

/**
 * 文内 ref。**sigil 是强制的** —— 且 sigil 与 kind 之间只允许空格/制表符。
 *
 * - 裸 `PR 3` 在散文里指**计划序列中的一个位置**，不是身份。存在性检查救不了这个，
 *   因为 PR #1–#5 在相关 repo 里确实存在。
 * - `[ \t]*` 而非 `\s*`：空白跨了换行，会让列表项结尾的 `NO PR` 绑到**下一个**列表项的
 *   `2.` 上，产出一条断言**恰好相反**的 claim。**A ref never crosses a line.**
 */
const REF = new RegExp(
  String.raw`(?:(?<![\w./-])(?<repo>[A-Za-z][\w.-]{2,30})[ \t]+)?` +
    String.raw`\b(?<kind>PR|MR|pull request|merge request)[ \t]*[#!](?<num>\d+)` +
    String.raw`(?:[ \t]*\((?<repoAfter>[A-Za-z][\w.-]{2,30})\)|[ \t]+(?<repoWord>[A-Za-z][\w.-]{2,30})\b)?`,
  'giu',
)

/** `#123` 单独出现（无 kind 词）。 */
const HASH_REF = /(?<![\w/#])#(?<num>\d{1,6})(?![\w-])/gu

/** Jira 风格工单。 */
const TICKET = /(?<![\w-])(?<key>[A-Z][A-Z0-9]{1,9}-(?<num>\d{1,6}))(?![\w-])/gu

/** 依赖版本断言。 */
const DEPENDENCY =
  /(?<![\w-])(?<name>@?[a-z0-9][\w./-]{1,60})@(?<version>\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)(?![\w.])/giu

/**
 * repo 名形状。
 *
 * 单连字符是第一次尝试，在活语料上重放时从普通散文里**发明了三个 repo** ——
 * 从 Jira 工单来的 `PROJ-8#65`，从连字符英语来的 `docs-only#168` 和 `re-point#155`。
 * 连字符在单词和工单 id 里都很常见；**两个**连字符、内部大写、或域名后缀则不然。
 *
 * **过不了这个测试是廉价的**：ref 回退到 namespace 默认，正如它以前一样。
 * **过错了就是发明一个 repo。**
 */
const REPO_SHAPED = /[a-z][A-Z]|-[\w.]*-|\.(?:com|io|dev|org|net|ai)$/u

const KNOWN_REPO_ALIASES = Object.freeze({
  pinf: 'platform-infra',
  'platform-infra': 'platform-infra',
})

/* ── 状态词汇 ─────────────────────────────────────────────────────── */

/**
 * resolved 词汇。**三个词被刻意排除**：
 *
 *  - `shipped`：`"doc shipped PR #168"` 指 PR 被**创建**，`"PR #65 SHIPPED"` 指合并。
 *    同一个词两个意思，猜错一条会教读者彻底忽略 claims。
 *  - `fixed`：`"Fixed in PR #873"` 在叙述**修复**，不是 PR 的状态 —— 那个 PR 可能还开着。
 *  - `complete` 同理，它常修饰的是任务不是引用。
 *
 * 漏掉一条 claim 是**静默无害**的；猜错一条是**响亮有害**的。所以词汇表只留无歧义的。
 */
const RESOLVED_WORDS =
  /\b(?:merged|closed|resolved|landed|released|approved)\b|已合并|已关闭|已解决|已上线/iu

/**
 * open 词汇。`held` 是「merge HELD」—— 明确的**未合并**。
 */
const OPEN_WORDS =
  /\b(?:open|opened|waiting|awaiting|pending|unmerged|blocked|draft|held|in review|up for review)\b|待合|待审|未合并|进行中|还没|尚未/iu

/** 状态窗口：match 前后各取多少字符。 */
const STATE_WINDOW = 96

/* ── 预处理 ───────────────────────────────────────────────────────── */

/**
 * 抹空 wiki-link 与非断言的引用形态。
 *
 * `[[PR #10 open: the promotion bridge]]` 是指向**名为该标题的记忆**的链接，
 * 不是本记忆关于 PR #10 的断言。抹成等长空格以保留偏移。
 */
export function blankNonAssertions(text) {
  return String(text ?? '')
    .replace(/\[\[[^\]]*\]\]/g, (match) => ' '.repeat(match.length))
    .replace(/`[^`\n]*`/g, (match) => ' '.repeat(match.length))
}

/**
 * 仓库默认名：`package.json` 的 `name` 去掉 scope，否则 git remote 的末段。
 *
 * 这个默认是**承重的**：实测 764 条记忆上，仅在文内限定得到 26 条 claim 和**零**条
 * 可用矛盾；加上它变成 145 条 claim / 10 条矛盾。
 */
export function detectRepoName(root) {
  try {
    const packageFile = join(root, 'package.json')
    if (existsSync(packageFile)) {
      const parsed = JSON.parse(readFileSync(packageFile, 'utf8'))
      if (typeof parsed?.name === 'string' && parsed.name) {
        return parsed.name.includes('/') ? parsed.name.split('/').pop() : parsed.name
      }
    }
    const configFile = join(root, '.git', 'config')
    if (existsSync(configFile)) {
      const match = /url\s*=\s*.*\/([^/\s]+?)(?:\.git)?\s*$/m.exec(readFileSync(configFile, 'utf8'))
      if (match?.[1]) return match[1]
    }
  } catch {
    /* 探测失败就是没有默认 repo，ref 回退为 unqualified */
  }
  return null
}

/* ── 抽取 ─────────────────────────────────────────────────────────── */

function normalizeKind(raw) {
  const lowered = String(raw ?? '').toLowerCase()
  if (lowered === 'pr' || lowered === 'pull request') return 'pull-request'
  if (lowered === 'mr' || lowered === 'merge request') return 'pull-request'
  if (lowered === 'issue') return 'issue'
  if (lowered === 'branch') return 'branch'
  return 'pull-request'
}

function stateOf(window) {
  if (RESOLVED_WORDS.test(window)) return 'resolved'
  if (OPEN_WORDS.test(window)) return 'open'
  return 'unverified'
}

/**
 * 限定 repo。返回 `null` 表示**无法安全限定** → 丢弃这条 ref。
 *
 * 优先级：显式 URL → 文内紧邻 repo 名 → namespace 默认 repo。
 * **dropping beats guessing.**
 */
function qualify(token, { namespaceDefaultRepo = null, knownRepos = [] } = {}) {
  const raw = collapse(token ?? '').replace(/^[:\s,.]+|[:\s,.]+$/g, '')
  if (!raw) return null

  const lowered = raw.toLowerCase()
  if (namespaceDefaultRepo && lowered === namespaceDefaultRepo.toLowerCase()) return namespaceDefaultRepo
  if (KNOWN_REPO_ALIASES[lowered]) return KNOWN_REPO_ALIASES[lowered]
  for (const repo of knownRepos) {
    if (repo.toLowerCase() === lowered) return repo
  }
  if (/^[A-Z][A-Z0-9]*-\d+$/.test(raw)) return null // PROJ-8 是工单不是 repo
  return REPO_SHAPED.test(raw) ? raw : null
}

/**
 * 从正文抽取断言。
 *
 * 返回 `[{ kind, ref, state, evidence }]`，同一 `(kind, ref)` 只保留**最强**的一条
 * （resolved > open > unverified）—— 因为读者只信一条，出现两条互相矛盾的会教他忽略全部。
 */
export function extractClaims(text, options = {}) {
  const { namespaceDefaultRepo = null, knownRepos = [] } = options
  const source = blankNonAssertions(text)
  if (!source.trim()) return []

  /** key = `${kind}\u0000${ref}` */
  const best = new Map()
  /**
   * 已经被「带 kind 词的 ref」认领的编号。
   *
   * 没有它，`PR #10` 会同时被 REF 和 HASH_REF 各记一条 —— 一条记忆里出现两条
   * 关于同一个编号的断言，读者只会学会忽略整个 claims 面。
   */
  const claimedNumbers = new Set()

  const record = (kind, ref, state, window) => {
    const key = `${kind}\u0000${ref}`
    const existing = best.get(key)
    if (existing && STATE_PRECEDENCE[state] <= STATE_PRECEDENCE[existing.state]) return
    best.set(key, {
      kind,
      ref,
      state,
      evidence: collapse(window).slice(0, 200),
    })
  }

  // 1) 显式 URL
  for (const match of source.matchAll(URL_REF)) {
    const repo = match[1].split('/').pop()
    const ref = `${repo}#${match[2]}`
    claimedNumbers.add(match[2])
    const start = Math.max(0, (match.index ?? 0) - 40)
    record('pull-request', ref, stateOf(source.slice(start, (match.index ?? 0) + match[0].length + STATE_WINDOW)), match[0])
  }

  // 2) 文内 ref
  for (const match of source.matchAll(REF)) {
    const groups = match.groups ?? {}
    const repo =
      qualify(groups.repo, options) ??
      qualify(groups.repoAfter, options) ??
      qualify(groups.repoWord, options) ??
      namespaceDefaultRepo
    if (!repo) continue // 无法限定 → 丢弃，不猜
    const kind = normalizeKind(groups.kind)
    const ref = `${repo}#${groups.num}`
    claimedNumbers.add(groups.num)
    const start = Math.max(0, (match.index ?? 0) - 40)
    const window = source.slice(start, (match.index ?? 0) + match[0].length + STATE_WINDOW)
    record(kind, ref, stateOf(window), window)
  }

  // 3) 裸 #123（只在有 namespace 默认 repo、且没被上面的带 kind 词 ref 认领时）
  if (namespaceDefaultRepo) {
    for (const match of source.matchAll(HASH_REF)) {
      if (claimedNumbers.has(match.groups.num)) continue
      const ref = `${namespaceDefaultRepo}#${match.groups.num}`
      const start = Math.max(0, (match.index ?? 0) - 40)
      const window = source.slice(start, (match.index ?? 0) + match[0].length + STATE_WINDOW)
      record('issue', ref, stateOf(window), window)
    }
  }

  // 4) Jira 工单
  for (const match of source.matchAll(TICKET)) {
    const start = Math.max(0, (match.index ?? 0) - 40)
    const window = source.slice(start, (match.index ?? 0) + match[0].length + STATE_WINDOW)
    record('ticket', match.groups.key, stateOf(window), window)
  }

  // 5) 依赖版本
  for (const match of source.matchAll(DEPENDENCY)) {
    const name = match.groups.name
    if (!name || /^\d/.test(name) || name.length < 2) continue
    record('dependency', `${name}@${match.groups.version}`, 'resolved', match[0])
  }

  return [...best.values()].sort((a, b) =>
    a.kind === b.kind ? (a.ref < b.ref ? -1 : 1) : a.kind < b.kind ? -1 : 1,
  )
}

/* ── 对账 ─────────────────────────────────────────────────────────── */

/**
 * 对账：把全库的断言收成一张表，标出哪些**互相矛盾**。
 *
 * 矛盾**只在同一 namespace 内**成立（`claims.py` 把裸 `#12` 键到 namespace 的默认 repo，
 * 所以跨 namespace 匹配会把两个不同 repo 的 PR #12 配对，报出一个不存在的矛盾）。
 * **一个跨 namespace 的矛盾在这里因此是不可见的，而且刻意如此**：
 * 漏掉一个是静默的，编造一个会教读者忽略这个指标。
 */
export function reconcileClaims(entries, { scopeOf = (entry) => entry.scope?.[0] ?? '*', includeDeprecated = false } = {}) {
  const active = entries.filter(
    (entry) => includeDeprecated || !['deprecated', 'rejected', 'superseded'].includes(entry.status),
  )

  /** `${scope}\u0000${kind}\u0000${ref}` -> [{ id, state, evidence }] */
  const byRef = new Map()
  for (const entry of active) {
    const scope = scopeOf(entry)
    for (const claim of entry.claims ?? []) {
      const key = `${scope}\u0000${claim.kind}\u0000${claim.ref}`
      if (!byRef.has(key)) byRef.set(key, [])
      byRef.get(key).push({ id: entry.id, state: claim.state, evidence: claim.evidence ?? '' })
    }
  }

  const open = []
  const unverified = []
  const contradicted = []

  for (const [key, rows] of [...byRef.entries()].sort()) {
    const [, kind, ref] = key.split('\u0000')
    const states = new Set(rows.map((row) => row.state))
    const isContradicted = states.has('open') && states.has('resolved')

    for (const row of rows) {
      if (row.state === 'unverified') {
        unverified.push({ id: row.id, kind, ref })
        continue
      }
      if (row.state !== 'open') continue
      open.push({ id: row.id, kind, ref, contradicted: isContradicted })
      if (isContradicted) {
        contradicted.push({
          ref,
          kind,
          openBy: rows.filter((item) => item.state === 'open').map((item) => item.id),
          resolvedBy: rows.filter((item) => item.state === 'resolved').map((item) => item.id),
        })
      }
    }
  }

  return { open, unverified, contradicted }
}

/**
 * 断言统计（`memory_audit` 用）。
 *
 * `open` 与 `openActionable` **必须两个都报**：前者是每一条未解决的 open claim，
 * 后者排除了 deprecated 记忆上的 —— 没有第二个数字，一个比较 `open` 与 `sample.length`
 * 的调用者会发现一个缺口，却得不到解释。
 */
export function claimStats(entries) {
  const { open, unverified, contradicted } = reconcileClaims(entries, { includeDeprecated: true })
  const { open: openActionable } = reconcileClaims(entries)
  const resolved = entries.reduce(
    (sum, entry) => sum + (entry.claims ?? []).filter((claim) => claim.state === 'resolved').length,
    0,
  )

  return {
    open: open.length,
    openActionable: openActionable.length,
    resolved,
    unverified: unverified.length,
    contradicted: contradicted.length,
    // 样本枚举**每一条** open claim，矛盾优先 —— 抽取 claim 的全部理由就是被逐条处理并关闭
    sample: open
      .sort((a, b) => Number(b.contradicted) - Number(a.contradicted))
      .slice(0, 5)
      .map(({ id, kind, ref, contradicted: isContradicted }) => ({ id, kind, ref, contradicted: isContradicted })),
    contradictions: contradicted.slice(0, 5),
  }
}

/* ── 同步与重推导 ─────────────────────────────────────────────────── */

/**
 * 散文**变了** → 丢弃 resolution。
 *
 * 散文动了，它断言的东西可能也动了，陈旧的 `resolvedBy` 指针比没有更糟。
 */
export function syncClaims(entry, options) {
  const extracted = extractClaims(entry.body ?? '', options)
  const previous = new Map((entry.claims ?? []).map((claim) => [`${claim.kind}\u0000${claim.ref}`, claim]))

  return extracted.map((claim) => {
    const old = previous.get(`${claim.kind}\u0000${claim.ref}`)
    // 散文没动的那条，保留已学到的解析
    if (old && old.state === claim.state && old.evidence === claim.evidence) return old
    return claim
  })
}

/**
 * **抽取器变聪明了**，文本未变 → 保留 resolution。
 *
 * 这是让 `default_repo` 变更生效的机制：claims 是存储行，默认值只在抽取时被查询，
 * 所以没有 re-derive，声明对已存在的任何东西都不产生影响。
 */
export function rederiveClaims(entry, options) {
  const extracted = extractClaims(entry.body ?? '', options)
  const previous = new Map((entry.claims ?? []).map((claim) => [`${claim.kind}\u0000${claim.ref}`, claim]))

  return extracted.map((claim) => {
    const old = previous.get(`${claim.kind}\u0000${claim.ref}`)
    if (!old) return claim
    // 只刷新 state 与 evidence；resolution 三列原样保留
    return {
      ...claim,
      state: claim.state,
      evidence: claim.evidence,
      resolvedState: old.resolvedState,
      resolvedBy: old.resolvedBy,
      resolvedAt: old.resolvedAt,
    }
  })
}

/** 显式关闭一条 claim（用户手动对账）。 */
export function resolveClaim(entry, { kind, ref, resolvedState = 'resolved', resolvedBy = null, resolvedAt = null }) {
  const claims = entry.claims ?? []
  const index = claims.findIndex((claim) => claim.kind === kind && claim.ref === ref)
  if (index < 0) return { entry, changed: false }
  const next = [...claims]
  // `state` **永不改写** —— 只写 resolution 三列
  next[index] = { ...next[index], resolvedState, resolvedBy, resolvedAt }
  return { entry: { ...entry, claims: next }, changed: true }
}
