/**
 * 推广（promotion）：把项目记忆整理成**可推广的包**。
 *
 * **本插件不做全局记忆。** 记忆是仓库级制品，跨项目的那一层由别的插件负责。
 * 这个模块只做一件事：把「哪些项目记忆换一个仓库还成立」整理成人能读、
 * 机器能消费的形态。
 *
 * 三条纪律：
 *
 *  1. **只提名，不搬运。** 推广与否是人的判断 —— 和 dream 只提议结构、
 *     G7 只列最弱候选、`memory_forget` 不自动退休是同一条纪律。
 *  2. **硬排除必须硬。** 含密钥的、回执被改过的、终态的，永远不出现在包里。
 *     一条泄漏的秘密比一百条没推广的记忆贵。
 *  3. **输出必须可移植。** 不含绝对路径、不含会话 id、不含机器名。
 *     只保留仓库相对路径 + 仓库名 + 提交 sha。
 *
 * 为什么需要它：没有出口，项目记忆是一条单行道 —— 你在一个仓库里学到的
 * 通用做法，在下一个仓库里还得重新学一遍。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_FORBIDDEN, compileRule } from './gate.js'
import { CONFIDENCE_RANK, contentHash } from './model.js'
import { collapse, isoNow, sha256, stableJson, truncate } from './util.js'

/** 推广包 schema 版本。消费方按它判断能不能读。 */
export const PROMOTION_SCHEMA = 'dsh-memory.promotion/v1'

/* 置信排序：进包的资格按它比。**序在 `model.js` 里**（`CONFIDENCE_RANK`）——
 * 这一份曾经是复制的第二份，值一样但没人保证以后一样。 */

/** 终态：无论多通用都不推广。 */
const TERMINAL = new Set(['deprecated', 'rejected', 'superseded'])

/**
 * 项目内路径判定：证据全是这种形态的条目，大概率是**项目特定**的。
 *
 * 这不是排除条件，是**标注**条件 —— 「staging 超时先查连接池上限」锚在
 * `src/db/pool.ts` 上，但它换一个仓库仍然成立。
 * 机器分不清这两者，所以只标注，让人在包里看见。
 */
const PROJECT_PATH = /^(?:\.\/)?(?:src|lib|app|packages|test|tests|docs|scripts|config)\//i

/** 仓库身份：`package.json` 的 name 去 scope，否则 `.git/config` 的末段。 */
export function detectRepo(root) {
  try {
    const packageFile = join(root, 'package.json')
    if (existsSync(packageFile)) {
      const parsed = JSON.parse(readFileSync(packageFile, 'utf8'))
      if (typeof parsed?.name === 'string' && parsed.name) return parsed.name
    }
  } catch {
    /* 读不到就看 git */
  }
  try {
    const config = readFileSync(join(root, '.git', 'config'), 'utf8')
    const match = /url\s*=\s*.*\/([^/\s]+?)(?:\.git)?\s*$/m.exec(config)
    if (match?.[1]) return match[1]
  } catch {
    /* 没有 git 就是没有仓库名 */
  }
  return null
}

/** 当前提交 sha（detached HEAD 读 HEAD 本身，普通分支读 refs）。 */
export function detectCommit(root) {
  try {
    const gitDir = join(root, '.git')
    if (!existsSync(gitDir)) return null
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref:')) return /^[0-9a-f]{40}$/i.test(head) ? head : null
    const ref = head.slice(4).trim()
    const refFile = join(gitDir, ...ref.split('/'))
    if (existsSync(refFile)) {
      const sha = readFileSync(refFile, 'utf8').trim()
      return /^[0-9a-f]{40}$/i.test(sha) ? sha : null
    }
    // packed-refs
    const packed = join(gitDir, 'packed-refs')
    if (existsSync(packed)) {
      const match = new RegExp(`^([0-9a-f]{40}) ${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').exec(
        readFileSync(packed, 'utf8'),
      )
      if (match) return match[1]
    }
  } catch {
    /* 读不到就是没有提交 */
  }
  return null
}

/* ── 硬排除 ───────────────────────────────────────────────────────── */

function containsSecret(entry, forbidden) {
  /**
   * 扫的是**会被写进包里的全部自由文本**。
   *
   * `evidence[].excerpt` 必须算进来：它是用户贴的原文，而 G3 是唯一
   * 不可协商的门（`lib/gate.js:350-352` 的 `gateSafety` 也扫它）。
   * 0.2.0 这里只拼了 title/about/body —— 把密钥贴进摘录就绕过了整道门。
   */
  const excerpts = (Array.isArray(entry.evidence) ? entry.evidence : [])
    .map((item) => (item && typeof item.excerpt === 'string' ? item.excerpt : ''))
    .join('\n')
  const haystack = `${entry.title ?? ''}\n${entry.about ?? ''}\n${entry.body ?? ''}\n${excerpts}`
  for (const [index, pattern] of forbidden.entries()) {
    let regex
    try {
      regex = compileRule(pattern)
    } catch {
      // 规则本身写错不能变成「没扫到」—— 记进排除理由，让用户看见
      continue
    }
    if (regex.test(haystack)) return index + 1
  }
  return null
}

function daysSince(iso, now) {
  const parsed = Date.parse(iso ?? '')
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY
  return Math.max(0, (now - parsed) / 86_400_000)
}

/* ── 打包 ─────────────────────────────────────────────────────────── */

/**
 * 生成推广包。
 *
 * 返回 `{ bundle, excluded }`。`excluded` 记的是**为什么没推广** ——
 * 没有它，用户只会看到「20 条里挑了 3 条」，然后开始怀疑判据。
 */
export function buildPromotion(entries, { root = process.cwd(), config = {}, now = Date.now() } = {}) {
  const promote = { ...{ minConfidence: 'verified', includeProjectSpecific: true }, ...(config.promote ?? {}) }
  /**
   * **用户规则只增不减**，与 G3 同形（`lib/gate.js:793`）。
   *
   * 0.2.0 写的是 `config.safety?.forbidden ?? DEFAULT_FORBIDDEN` —— 而
   * `defaultConfig().safety.forbidden` 是 **`[]` 不是 `undefined`**，所以
   * `??` 永不短路，**默认配置下规则表是空的**。后果：密钥原样进推广包
   * （`memory_promote` 的 schema 描述写着「含密钥…永远不出现在包里」，
   * `write: true` 还会把它写成一份**明确用来分享**的 md）。
   *
   * 替换语义的后果，和 G3 注释里说的是同一件事：一个空数组就能把整道扫描关掉。
   */
  const extraForbidden = Array.isArray(config.safety?.forbidden) ? config.safety.forbidden : []
  const forbidden = [...DEFAULT_FORBIDDEN, ...extraForbidden]
  const floor = CONFIDENCE_RANK[promote.minConfidence] ?? CONFIDENCE_RANK.verified

  const candidates = []
  const excluded = []

  for (const entry of entries) {
    if (TERMINAL.has(entry.status)) {
      excluded.push({ id: entry.id, reason: 'terminal', detail: `status=${entry.status}` })
      continue
    }

    const secretRule = containsSecret(entry, forbidden)
    if (secretRule !== null) {
      // **只记规则序号，不记命中内容** —— 把命中片段写进包是二次泄露
      excluded.push({ id: entry.id, reason: 'secret', detail: `rule #${secretRule}` })
      continue
    }

    const rank = CONFIDENCE_RANK[entry.confidence] ?? 0
    if (rank < floor) {
      excluded.push({ id: entry.id, reason: 'low-confidence', detail: `confidence=${entry.confidence ?? 'unknown'}` })
      continue
    }

    const evidence = entry.evidence ?? []
    if (evidence.length === 0) {
      excluded.push({ id: entry.id, reason: 'no-evidence', detail: '证据为空 —— 无法在别的仓库里复核' })
      continue
    }

    /* ── 软标记：进包，但让人看见风险 ── */
    const markers = []
    const projectPaths = evidence.filter(
      (item) => (item.kind === 'file' || item.kind === 'doc') && PROJECT_PATH.test(String(item.ref ?? '')),
    )
    if (projectPaths.length === evidence.length) markers.push('project-specific-evidence')
    if ((entry.scope ?? []).every((scope) => String(scope).startsWith('repo:'))) markers.push('scoped-to-repo')
    if (entry.reviewBy && Date.parse(entry.reviewBy) <= now) markers.push('needs-review')
    if (daysSince(entry.lastVerifiedAt ?? entry.modifiedAt, now) >= 90) markers.push('dormant')
    /**
     * **权威：没人签过字。**
     *
     * 推广包是唯一**离开这个仓库**的产物 —— 它会进别的项目、被别的 Agent 召回。
     * 这种产物最该关心的问题不是「写得好不好」，是「有没有人为它负过责」。
     *
     * ## 为什么是标记不是硬排除
     *
     * 硬排除 `observed` 会让「一条都没被裁决过」的仓库**永远产不出包** ——
     * 而那是正常状态（绝大多数记忆是模型观察到的，没人逐条审）。过宽的检查
     * 会永久屏蔽合法内容，而屏蔽是静默的（`gate.js` 的 G3b 注释有先例）。
     *
     * 所以：**进包，但让它看得见。** 下游（或用户）看到这个标记就知道
     * 这条记忆的权威是「模型观察」，不是「有人背书」。
     */
    if ((entry.authority ?? 'observed') !== 'user-confirmed') markers.push('unconfirmed-authority')
    if (markers.includes('project-specific-evidence') && !promote.includeProjectSpecific) {
      excluded.push({ id: entry.id, reason: 'project-specific', detail: '证据全指向项目内路径' })
      continue
    }

    candidates.push({
      id: entry.id,
      title: entry.title,
      kind: entry.kind,
      about: entry.about,
      body: entry.body,
      confidence: entry.confidence,
      provenance: entry.provenance,
      authority: entry.authority ?? 'observed',
      actionRisk: entry.actionRisk ?? 'R1',
      scope: entry.scope ?? [],
      triggers: entry.triggers ?? [],
      // **只保留仓库相对路径** —— 绝对路径出了仓库就没有意义，而且会泄漏本机布局
      evidence: evidence.map((item) => ({ kind: item.kind, ref: String(item.ref ?? ''), excerpt: item.excerpt ?? null })),
      claims: entry.claims ?? [],
      contentHash: contentHash(entry),
      markers,
    })
  }

  const byKind = {}
  for (const candidate of candidates) byKind[candidate.kind] = (byKind[candidate.kind] ?? 0) + 1

  const bundle = {
    schema: PROMOTION_SCHEMA,
    generatedAt: isoNow(() => now),
    source: {
      repo: detectRepo(root),
      commit: detectCommit(root),
      // 只记条数，不记路径
      activeMemories: entries.length,
    },
    summary: {
      total: entries.length,
      promoted: candidates.length,
      excluded: excluded.length,
      /** 进包但没人签过字的条数 —— 一行摘要里必须看得见。 */
      unconfirmedAuthority: candidates.filter((candidate) => candidate.authority !== 'user-confirmed').length,
      byKind,
    },
    entries: candidates,
    excluded,
  }

  // 内容摘要：消费方可以据此判断「同一个包我是不是已经导过了」
  bundle.digest = sha256(stableJson({ entries: candidates.map((item) => item.contentHash) })).slice(0, 32)

  return { bundle, excluded }
}

/* ── 渲染 ─────────────────────────────────────────────────────────── */

const MARKER_LABEL = {
  'project-specific-evidence': '证据全指向项目内路径 —— 换仓库前先确认它是不是通用做法',
  'scoped-to-repo': '适用面限定在当前仓库',
  'needs-review': '已过复查期 —— 推广前先核对',
  dormant: '90 天未被召回 —— 可能已经不再成立',
  'no-evidence': '没有证据',
  'unconfirmed-authority': '没有人确认过 —— 它是「模型观察」，不是「有人背书」',
}

const EXCLUDE_LABEL = {
  terminal: '终态（已退休 / 被拒 / 被取代）',
  secret: '含密钥',
  'low-confidence': '置信不足',
  'no-evidence': '没有证据',
  'project-specific': '证据全指向项目内路径',
}

/**
 * 推广包的 Markdown 渲染。
 *
 * 开头必须是**给人看的**：这个包是什么、从哪来、为什么这些条目在里面。
 * 一头扎进正文的包，读者会在第三条放弃。
 */
export function renderPromotion(bundle) {
  const lines = [
    '# 记忆推广包',
    '',
    `来源：${bundle.source.repo ?? '（未识别仓库）'}${bundle.source.commit ? ` @ ${bundle.source.commit.slice(0, 12)}` : ''}`,
    `生成：${bundle.generatedAt} · 摘要 \`${bundle.digest}\``,
    '',
    `${bundle.summary.total} 条项目记忆里，**${bundle.summary.promoted} 条**被提名为可推广。`,
  ]

  if (Object.keys(bundle.summary.byKind).length > 0) {
    lines.push('', '按类型：' + Object.entries(bundle.summary.byKind).map(([kind, count]) => `${kind} ${count}`).join(' · '))
  }

  lines.push(
    '',
    '---',
    '',
    '> 这份包**只包含提名的条目，不包含任何全局存储**。',
    '> 推广与否由你决定 —— 把它交给负责全局记忆的插件，或手工整理。',
    '',
  )

  for (const entry of bundle.entries) {
    lines.push(`## ${entry.title}`)
    lines.push(
      `\`${entry.id}\` · ${entry.kind} · 置信 ${entry.confidence} · 来源 ${entry.provenance} · 权威 ${entry.authority ?? 'observed'} · 行动风险 ${entry.actionRisk}`,
    )
    if (entry.scope.length > 0) lines.push(`适用面：${entry.scope.join(', ')}`)
    if (entry.triggers.length > 0) lines.push(`唤醒词：${entry.triggers.join(' / ')}`)
    if (entry.markers.length > 0) {
      lines.push('')
      lines.push('⚠ **推广前请核对**：')
      for (const marker of entry.markers) lines.push(`- ${MARKER_LABEL[marker] ?? marker}`)
    }
    lines.push('', entry.body.trim(), '')
    if (entry.evidence.length > 0) {
      lines.push('证据：' + entry.evidence.map((item) => `\`${item.ref}\``).join(', '))
    }
    lines.push('', '---', '')
  }

  if (bundle.excluded.length > 0) {
    lines.push('## 没有推广的条目', '')
    const grouped = new Map()
    for (const item of bundle.excluded) {
      if (!grouped.has(item.reason)) grouped.set(item.reason, [])
      grouped.get(item.reason).push(item)
    }
    for (const [reason, items] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`### ${EXCLUDE_LABEL[reason] ?? reason}（${items.length} 条）`)
      for (const item of items.slice(0, 10)) lines.push(`- \`${item.id}\` — ${truncate(collapse(item.detail ?? ''), 80)}`)
      if (items.length > 10) lines.push(`- …还有 ${items.length - 10} 条`)
      lines.push('')
    }
  }

  return lines.join('\n').trimEnd()
}

/** 一行摘要，给 `/memory promote` 的默认面用。 */
export function summarizePromotion(bundle) {
  return [
    `推广包：${bundle.summary.promoted} / ${bundle.summary.total} 条被提名`,
    `  摘要 ${bundle.digest} · 来源 ${bundle.source.repo ?? '（未识别）'}${bundle.source.commit ? ` @ ${bundle.source.commit.slice(0, 12)}` : ''}`,
    bundle.summary.excluded > 0 ? `  排除 ${bundle.summary.excluded} 条（见下）` : '',
    bundle.summary.unconfirmedAuthority > 0
      ? `  ⚠ ${bundle.summary.unconfirmedAuthority} 条没有人确认过（权威 = observed）—— 推广包里请当作「未背书」`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}
