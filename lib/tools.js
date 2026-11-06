/**
 * 工具层：6 个 `memory_*` 工具的声明式定义与注册。
 *
 * 刻意只有 6 个 —— DSH 的工具是稀缺上下文资源。gingugu 的 30+ 工具面
 * 是给「无插件的第三方宿主」用的；DSH 里同类能力用命令、配置和面板就够了。
 *
 * | 工具 | 作用 |
 * |---|---|
 * | memory_remember | 提议一条记忆（走完整协议） |
 * | memory_recall   | 主动召回（三级交付） |
 * | memory_pending  | 列待决提案 |
 * | memory_resolve  | accept / reject / edit 一条提案 |
 * | memory_audit    | 全量审计 + 漂移复查（只读） |
 * | memory_forget   | 退休 / 删除（破坏性） |
 */

import { existsSync, readFileSync } from 'node:fs'

import { claimStats, detectRepoName, extractClaims } from './claims.js'
import { collectOwners, nextHint, review } from './gate.js'
import { DECAY as DECAY_CONST, consolidate, dream, lifecycleReport } from './lifecycle.js'
import { ensureSnapshot, markDirty, readSnapshot } from './index-build.js'
import { actionRiskOf, normalizeId } from './model.js'
import { recall as runRecall, renderRecall } from './recall.js'
import {
  activeEntries,
  appendLedger,
  appendReceipt,
  deleteEntry,
  ensureLayout,
  findEntry,
  findProposal,
  inboxSize,
  newProposalId,
  readAll,
  readLedger,
  readProposals,
  readReceipts,
  readStats,
  receiptStatus,
  removeProposal,
  retireEntry,
  touchEntries,
  withStats,
  writeEntry,
  writeProposal,
} from './store.js'
import { collapse } from './util.js'

/** 领域错误：宿主 registry 会转成 `isError: true` 的结构化结果。 */
export class MemoryError extends Error {
  constructor(kind, message, options = {}) {
    super(message, options)
    this.name = 'MemoryError'
    this.kind = kind
    this.detail = options.detail
  }
}

const inputError = (message, detail) => new MemoryError('input', message, { detail })

/* ── 参数边界 ─────────────────────────────────────────────────────── */

function requiredText(value, name) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw inputError(`参数 ${name} 必填，且不能是空白字符串`)
  return text
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArray(value) {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
  return items.length ? items : undefined
}

function clampInt(value, { min, max, fallback }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/* ── 渲染 ─────────────────────────────────────────────────────────── */

function renderAccepted(entry, review, root) {
  return [
    `已记住：${entry.title}`,
    `  id=${entry.id} · kind=${entry.kind} · 置信=${review.confidence ?? '-'} · 风险=${entry.actionRisk}`,
    `  文件：${entry.path ?? `.dsh-memory/memories/${entry.id}.md`}`,
    review.gates?.some((gate) => gate.kind === 'downgrade')
      ? `  注意：${review.gates.filter((gate) => gate.kind === 'downgrade').map((gate) => gate.code).join(', ')}`
      : null,
    '',
    '这条记忆会在后续会话里被召回。它现在进了 git —— 像代码一样 review 它。',
  ]
    .filter(Boolean)
    .join('\n')
}

function renderDeferred(proposal, review) {
  return [
    `已提交待决：${proposal.candidate.title}`,
    `  proposalId=${proposal.id}`,
    `  协议判不了：${(review.gates ?? []).filter((gate) => gate.kind === 'refuse').map((gate) => `${gate.gate}:${gate.code}`).join(' / ')}`,
    '',
    '这条**没有**写入记忆。它进了 `.dsh-memory/pending/`，由你裁决：',
    `  memory_resolve {"proposalId":"${proposal.id}","action":"accept" | "reject" | "edit"}`,
    '',
    '不要原样重试 —— 同样的候选会得到同样的裁决。',
  ].join('\n')
}

/* ── 工具实现 ─────────────────────────────────────────────────────── */

export function createToolDefinitions({ resolveRoot, cfg, log }) {
  /** 一次写入的公共后半段：审核 → 三值裁决 → 副作用。 */
  function submit(candidate, { sessionId = null } = {}) {
    const root = resolveRoot()
    ensureLayout(root)

    // **先补 origin 再审核**：置信公式读的是 origin.signal，
    // 显式工具调用 = S7。少了这一步，六要素齐的记忆会卡在 0.585。
    const normalized = {
      ...candidate,
      origin: {
        ...(candidate.origin ?? {}),
        signal: candidate.origin?.signal ?? 'S7',
        sessionId: candidate.origin?.sessionId ?? sessionId,
      },
    }

    const { entries } = readAll(root)
    const owners = collectOwners(root)
    const quotaState = readQuotaState(root)
    const verdict = review(normalized, {
      root,
      config: cfg,
      corpus: entries,
      owners,
      quotaState,
    })

    // 断言抽取：正文里「PR #10 还开着」这类句子是**断言**，写时冻结。
    // 抽取失败是 best-effort —— 一条抽不出 claim 的记忆仍然是好记忆，
    // 而一次写不进去的记忆没有价值。
    let claims = normalized.claims ?? []
    if (claims.length === 0) {
      try {
        claims = extractClaims(normalized.body ?? '', {
          namespaceDefaultRepo: detectRepoName(root),
        })
      } catch (error) {
        log(`claim extraction failed for ${normalized.id}: ${error?.message ?? error}`)
      }
    }

    const base = {
      id: normalized.id,
      title: collapse(normalized.title),
      kind: normalized.kind,
      about: collapse(normalized.about),
      body: normalized.body,
      evidence: verdict.resolvedEvidence ?? normalized.evidence ?? [],
      scope: normalized.scope ?? [],
      triggers: normalized.triggers ?? [],
      supersedes: normalized.supersedes ?? [],
      relations: normalized.relations ?? [],
      claims,
      confidence:
        normalized.confidence ?? (verdict.confidence !== undefined ? confidenceLabel(verdict.confidence) : 'inferred'),
      provenance: normalized.provenance ?? 'self-concluded',
      actionRisk: verdict.actionRisk ?? actionRiskOf(normalized),
      origin: normalized.origin,
    }

    if (verdict.decision === 'ACCEPT') {
      const entry = writeEntry(root, base)
      appendReceipt(root, entry)
      appendLedger(root, {
        kind: 'attempt',
        id: entry.id,
        decision: 'accepted',
        confidence: verdict.confidence ?? null,
        gates: verdict.gates?.map((gate) => `${gate.gate}:${gate.kind}`) ?? [],
      })
      ensureSnapshot(root, { force: true })
      return { decision: 'ACCEPT', entry, verdict, text: renderAccepted(entry, verdict, root) }
    }

    if (verdict.decision === 'REJECT') {
      appendLedger(root, {
        kind: 'attempt',
        id: base.id,
        decision: 'rejected',
        code: verdict.code,
        gate: verdict.gate,
        // 安全门命中时**不记录任何正文**，只记录规则序号
        detail: verdict.code === 'secret' ? { rule: verdict.detail?.rule } : safeDetail(verdict.detail),
      })
      const next = nextHint(verdict.code, verdict.detail)
      throw new MemoryError('rejected', `拒绝写入（${verdict.gate}:${verdict.code}）\n${next}`, {
        detail: { ...verdict.detail, decision: 'REJECT', gate: verdict.gate, code: verdict.code, next },
      })
    }

    // DEFER
    const proposal = writeProposal(root, {
      id: newProposalId(),
      candidate: base,
      gates: verdict.gates ?? [],
      deferredBy: (verdict.gates ?? []).filter((gate) => gate.kind === 'refuse').map((gate) => gate.gate),
      why: (verdict.gates ?? []).filter((gate) => gate.kind === 'refuse').map((gate) => `${gate.gate}:${gate.code}`),
      status: 'pending',
    })
    appendLedger(root, {
      kind: 'attempt',
      proposalId: proposal.id,
      id: base.id,
      decision: 'deferred',
      deferredBy: proposal.deferredBy,
    })
    return { decision: 'DEFER', proposal, verdict, text: renderDeferred(proposal, verdict) }
  }

  return [
    /* ── memory_remember ─────────────────────────────────────────── */
    {
      name: 'memory_remember',
      description:
        '提议一条长期记忆。**走完整审核协议**：八道门串行，返回 ACCEPT（已写入）/ REJECT（硬拒，带 next 说明怎么改）/ DEFER（协议判不了，进待决队列等你裁决）。' +
        '只在「这条信息换一个新会话还有用」时调用；任务状态、临时结果、代码里已有的东西、由规则文件/测试拥有的东西都会被 G1 拒掉。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'snake_case 全局唯一键，也是文件名。不填则由 title 推导。' },
          title: { type: 'string', description: '一行标题，≤120 字' },
          kind: {
            type: 'string',
            enum: ['decision', 'pitfall', 'convention', 'correction', 'fact', 'capability'],
            description: '记忆类型：决策 / 坑 / 约定 / 纠错 / 事实 / 能力',
          },
          about: { type: 'string', description: '这条记忆是**干什么用的**（进索引与去重指纹）' },
          body: {
            type: 'string',
            description:
              'Markdown 正文，必须含六要素标题：功能名 / 生效条件 / 子功能 / 执行 / 验证方式 / 不适用条件。80–8000 字。',
          },
          evidence: {
            type: 'array',
            description: '证据锚点，至少一条**可解析的文件/文档锚点**（`path` 或 `path:line`）',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: {
                  type: 'string',
                  enum: ['file', 'symbol', 'test', 'commit', 'command', 'doc', 'user'],
                },
                ref: { type: 'string', description: '仓库相对路径 / 符号 / 测试 id / 提交 sha / 命令' },
                excerpt: { type: 'string' },
              },
              required: ['kind', 'ref'],
            },
          },
          scope: { type: 'array', items: { type: 'string' }, description: '适用面，如 ["repo:acme/api"]' },
          triggers: { type: 'array', items: { type: 'string' }, description: '什么查询词应唤起它' },
          supersedes: { type: 'array', items: { type: 'string' }, description: '被本条目取代的 id' },
          provenance: {
            type: 'string',
            enum: ['user-asserted', 'measured', 'file-derived', 'self-concluded'],
            description: '怎么信上的。与置信度正交；不确定就写 self-concluded。',
          },
        },
        required: ['title', 'kind', 'about', 'body', 'evidence'],
      },
      run: (args, exec) => {
        const title = requiredText(args.title, 'title')
        const candidate = {
          id: normalizeId(optionalText(args.id) ?? title) || 'memory',
          title,
          kind: args.kind,
          about: requiredText(args.about, 'about'),
          body: requiredText(args.body, 'body'),
          evidence: Array.isArray(args.evidence) ? args.evidence : [],
          scope: stringArray(args.scope) ?? [],
          triggers: stringArray(args.triggers) ?? [],
          supersedes: stringArray(args.supersedes) ?? [],
          provenance: args.provenance ?? 'self-concluded',
        }
        return submit(candidate, { sessionId: exec?.agent?.session?.id ?? null }).text
      },
    },

    /* ── memory_recall ───────────────────────────────────────────── */
    {
      name: 'memory_recall',
      description:
        '从项目记忆里召回历史证据。三级交付：content（给原文）/ pointers（只给线索，**不是答案**）/ abstain（没有，并说明是哪道门拒的）。' +
        '开工前、遇到报错、或「这个口径定过吗」时用它。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '症状原话 / 标识符 / 错误码 / 路径' },
          limit: { type: 'integer', description: '最多几条，默认 3，范围 1-10' },
          max_tokens: { type: 'integer', description: '注入预算，默认 400，范围 100-4000' },
        },
        required: ['query'],
      },
      run: (args) => {
        const root = resolveRoot()
        const { snapshot } = ensureSnapshot(root)
        const envelope = runRecall(requiredText(args.query, 'query'), snapshot, {
          limit: clampInt(args.limit, { min: 1, max: 10, fallback: 3 }),
          maxTokens: clampInt(args.max_tokens, { min: 100, max: 4000, fallback: 400 }),
          config: cfg,
        })
        // 记一次访问。**只写遥测文件，不写回 .md** —— 否则每次召回都让 git 变脏、
        // 让内容哈希变、让回执全部失效。
        try {
          touchEntries(root, [...envelope.results.map((result) => result.memoryId), ...envelope.pointers.map((pointer) => pointer.memoryId)])
        } catch (error) {
          log(`touch failed: ${error?.message ?? error}`)
        }
        return renderRecall(envelope)
      },
    },

    /* ── memory_pending ──────────────────────────────────────────── */
    {
      name: 'memory_pending',
      description: '列待决提案：协议判不了、等你裁决的记忆。默认最新 10 条。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', description: '最多几条，默认 10，范围 1-50' },
          include_rejected: { type: 'boolean', description: '同时列出已拒绝的（留档）' },
        },
      },
      run: (args) => {
        const root = resolveRoot()
        const proposals = readProposals(root)
        const limit = clampInt(args.limit, { min: 1, max: 50, fallback: 10 })
        if (proposals.length === 0) return '没有待决提案。'
        const lines = [`待决提案 ${proposals.length} 条：`, '']
        for (const proposal of proposals.slice(0, limit)) {
          lines.push(renderProposal(proposal))
        }
        return lines.join('\n')
      },
    },

    /* ── memory_resolve ──────────────────────────────────────────── */
    {
      name: 'memory_resolve',
      description:
        '裁决一条待决提案。accept / reject / edit。**用户的裁决权是「要不要记」，不是「跳过安全门」** —— accept 仍会重跑 G1–G5、G7。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          proposalId: { type: 'string', description: '提案 id（p_…）' },
          action: { type: 'string', enum: ['accept', 'reject', 'edit'], description: '裁决动作' },
          edit: {
            type: 'object',
            additionalProperties: true,
            description: 'action=edit 时要合并进去的字段（title / about / body / scope / triggers / evidence）',
          },
          reason: { type: 'string', description: '为什么这样裁，写进审计日志' },
        },
        required: ['proposalId', 'action'],
      },
      run: (args) => {
        const root = resolveRoot()
        const proposalId = requiredText(args.proposalId, 'proposalId')
        const proposal = findProposal(root, proposalId)
        if (!proposal) throw inputError(`没有这条提案：${proposalId}`)

        if (args.action === 'reject') {
          removeProposal(root, proposalId, { reject: true })
          appendLedger(root, { kind: 'resolve', proposalId, action: 'reject', reason: args.reason ?? null })
          return `已拒绝：${proposal.candidate?.title ?? proposalId}\n留档在 .dsh-memory/pending/rejected/，不参与召回。`
        }

        // 图提案（merge / edge / core / cluster）没有 candidate —— 它们改的是**结构**，
        // 而结构不是内容。一条拒绝是永久的：同样的计算明天在同一张图上跑会得出同样的结论。
        if (!proposal.candidate) {
          return resolveGraphProposal(root, proposalId, proposal, args, { log })
        }

        const merged = args.action === 'edit' ? { ...proposal.candidate, ...(args.edit ?? {}) } : proposal.candidate
        // 用户已裁决「要记」，但硬门必须重跑 —— 裁决权不是豁免权
        const { entries } = readAll(root)
        const verdict = review(merged, {
          root,
          config: cfg,
          corpus: entries,
          owners: collectOwners(root),
          quotaState: readQuotaState(root),
        })

        if (verdict.decision === 'REJECT') {
          appendLedger(root, {
            kind: 'resolve',
            proposalId,
            action: args.action,
            decision: 'rejected',
            code: verdict.code,
            gate: verdict.gate,
          })
          throw new MemoryError(
            'rejected',
            `用户裁决了「要记」，但硬门仍然拒绝（${verdict.gate}:${verdict.code}）\n${nextHint(verdict.code, verdict.detail)}\n
用户的裁决权是「要不要记」，不是「跳过安全门」。改好后再 accept。`,
            { detail: verdict.detail },
          )
        }

        const entry = writeEntry(root, {
          ...merged,
          evidence: verdict.resolvedEvidence ?? merged.evidence,
          confidence: merged.confidence ?? confidenceLabel(verdict.confidence ?? 0.7),
          actionRisk: verdict.actionRisk,
        })
        appendReceipt(root, entry, { verifier: { kind: 'user', id: 'memory_resolve' } })
        removeProposal(root, proposalId)
        appendLedger(root, { kind: 'resolve', proposalId, action: args.action, decision: 'accepted', reason: args.reason ?? null })
        markDirty(root)
        return `已接受：${entry.title}\n  id=${entry.id} · 文件 .dsh-memory/memories/${entry.id}.md`
      },
    },

    /* ── memory_audit ────────────────────────────────────────────── */
    {
      name: 'memory_audit',
      description:
        '只读审计：语料规模、回执健康、证据漂移（目标消失 = quarantined，切片变了 = advisory）、' +
        '断言对账（open / contradicted / unverified）、生命周期（休眠 / 到期复查 / 过期 / 建议弃用 / 合并候选）、' +
        '最弱候选、拒答与延迟统计。传 `dream: true` 会额外跑三个图 pass 并把发现写进待决队列（**不改记忆**）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          check_evidence: { type: 'boolean', description: '是否复查证据锚点（默认 true）' },
          dream: { type: 'boolean', description: '跑 dream pass（centrality / clusters / orphans）并暂存提案（默认 false）' },
        },
      },
      run: (args) => {
        const root = resolveRoot()
        const { entries, problems } = readAll(root)
        const stats = readStats(root)
        const active = withStats(activeEntries(entries), stats)
        const receipts = readReceipts(root).receipts
        const ledger = readLedger(root, { limit: 500 })

        const drift = []
        if (args.check_evidence !== false) {
          for (const entry of active) {
            const status = receiptStatus(root, entry)
            if (status === 'ok') continue
            drift.push({ id: entry.id, status })
          }
        }

        const accepted = ledger.filter((record) => record.decision === 'accepted').length
        const rejected = ledger.filter((record) => record.decision === 'rejected').length
        const deferred = ledger.filter((record) => record.decision === 'deferred').length
        const total = Math.max(1, accepted + rejected + deferred)

        const pending = readProposals(root)
        const queued = inboxSize(root)
        const lines = [
          `记忆库：${root}`,
          `  活跃 ${active.length} 条 · 全部文件 ${entries.length} 个 · 回执 ${receipts.length} 条`,
          `  待决提案 ${pending.length} 条 · 后台队列 ${queued} 条`,
          '',
          `写入尝试（最近 ${ledger.length} 条日志）：`,
          `  ACCEPT ${accepted} · REJECT ${rejected} · DEFER ${deferred}`,
          `  拒绝率 ${((rejected / total) * 100).toFixed(1)}% · 延迟率 ${((deferred / total) * 100).toFixed(1)}%`,
        ]
        if (queued > 0) {
          lines.push(
            '',
            `⚠ 后台队列还有 ${queued} 条未处理（下次 turn 结束会自动 drain；卡住说明进程被杀了）。`,
            '  它们已经**落盘**，重启后仍在 `.dsh-memory/inbox/`。',
          )
        }

        if (problems.length > 0) {
          lines.push('', `⚠ 坏文件 ${problems.length} 个（不影响其余记忆）：`)
          for (const problem of problems.slice(0, 5)) lines.push(`  - ${problem.file} · ${problem.code} · ${problem.detail}`)
        }

        if (drift.length > 0) {
          lines.push('', `⚠ 回执异常 ${drift.length} 条：`)
          for (const item of drift.slice(0, 10)) {
            lines.push(
              `  - ${item.id} · ${item.status === 'missing' ? 'quarantined（缺回执）' : item.status === 'tampered' ? 'quarantined（正文被改）' : 'advisory（证据根变了）'}`,
            )
          }
        } else {
          lines.push('', '回执全部健康。')
        }

        /* ── 断言对账 ── */
        const claims = claimStats(entries)
        lines.push(
          '',
          '断言对账：',
          `  open ${claims.open}（可行动 ${claims.openActionable}）· resolved ${claims.resolved} · ` +
            `unverified ${claims.unverified} · **contradicted ${claims.contradicted}**`,
        )
        if (claims.contradictions.length > 0) {
          lines.push('  ⚠ 矛盾（同一个 ref 既 open 又 resolved）：')
          for (const contradiction of claims.contradictions) {
            lines.push(
              `    - ${contradiction.kind} ${contradiction.ref}：open 于 ${contradiction.openBy.join(', ')}；resolved 于 ${contradiction.resolvedBy.join(', ')}`,
            )
          }
        } else if (claims.open > 0) {
          lines.push('  没有矛盾。open claim 是**积压**不是错误 —— 逐条处理并关闭它。')
        }

        /* ── 生命周期 ── */
        const life = lifecycleReport(active)
        lines.push(
          '',
          '生命周期：',
          `  休眠 ${life.dormant.length} 条（≥${DECAY_CONST.dormantAfterDays} 天未被召回；**休眠不是腐烂**，不改 confidence）`,
          `  到期复查 ${life.reviewDue.length} 条 · 已过期 ${life.expired.length} 条 · 建议弃用 ${life.suggestsDeprecation.length} 条`,
        )
        if (life.reviewDue.length > 0) {
          for (const item of life.reviewDue.slice(0, 5)) lines.push(`    - ${item.id} · reviewBy=${item.reviewBy}`)
        }
        if (life.expired.length > 0) {
          for (const item of life.expired.slice(0, 5)) lines.push(`    - ${item.id} · expiresAt=${item.expiresAt}`)
        }
        if (life.reviewHints.length > 0) {
          lines.push('  复查提示（**只是提示，不改状态**）：')
          for (const hint of life.reviewHints.slice(0, 10)) lines.push(`    - ${hint.id} · ${hint.label} · ${hint.detail}`)
        }
        if (life.consolidation.length > 0) {
          lines.push('  合并候选：')
          for (const group of life.consolidation.slice(0, 5)) {
            lines.push(`    - ${group.ids.join(' + ')}（${group.ids.length} 条）`)
          }
        }

        /* ── dream ── */
        if (args.dream) {
          const report = dream(entries)
          lines.push(
            '',
            `dream pass：${report.graph.nodes} 节点 · ${report.graph.edges} 条边 · ${report.graph.orphans} 个孤儿`,
          )
          let staged = 0
          for (const [passName, findings] of Object.entries(report.passes)) {
            if (!findings?.length) {
              lines.push(`  ${passName}: 无发现`)
              continue
            }
            for (const finding of findings) {
              const id = newProposalId()
              writeProposal(root, {
                id,
                kind: finding.kind,
                pass: passName,
                subjectId: finding.subjectId,
                objectId: finding.objectId,
                score: finding.score,
                evidence: finding.evidence,
                why: [`dream:${passName}`],
                status: 'pending',
              })
              staged += 1
            }
            lines.push(`  ${passName}: ${findings.length} 条提案`)
          }
          lines.push(`  已暂存 ${staged} 条 → memory_pending 看，memory_resolve 裁决`)
          lines.push('  **dream 不写记忆、不写关系** —— 它只提议结构，意义判断留给人。')
        }

        const snapshotInfo = readSnapshot(root)
        lines.push('', `索引快照：${snapshotInfo ? snapshotInfo.snapshotId : '尚未编译（下次召回会建）'}`)
        return lines.join('\n')
      },
    },

    /* ── memory_forget ───────────────────────────────────────────── */
    {
      name: 'memory_forget',
      description:
        '退休（软删除）或永久删除一条记忆。**破坏性**：hard_delete 需要显式传 `confirm: true`，且只该由用户在明确要求时提供。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '记忆 id' },
          hard_delete: { type: 'boolean', description: 'true = 永久删除（不可恢复）' },
          confirm: { type: 'boolean', description: 'hard_delete 时必填 true；这是用户确认，不是模型能自己给的' },
          reason: { type: 'string', description: '为什么退休，写进审计日志' },
        },
        required: ['id'],
      },
      run: (args) => {
        const root = resolveRoot()
        const id = requiredText(args.id, 'id')
        const entry = findEntry(root, id)
        if (!entry) throw inputError(`没有这条记忆：${id}`)

        if (args.hard_delete) {
          if (args.confirm !== true) {
            throw inputError(
              'hard_delete 需要 confirm: true。\n这是**用户的确认**，不是模型能自己给的 —— 先向用户确认「永久删除 <id>？不可恢复」，得到明确同意后再传。',
            )
          }
          deleteEntry(root, id)
          appendLedger(root, { kind: 'forget', id, hardDelete: true, reason: args.reason ?? null })
          markDirty(root)
          return `已永久删除：${id}`
        }

        retireEntry(root, id, { reason: args.reason ?? '' })
        appendLedger(root, { kind: 'forget', id, hardDelete: false, reason: args.reason ?? null })
        markDirty(root)
        return `已退休：${id}\n正文保留在 .dsh-memory/memories/，退出召回。要永久删除传 hard_delete: true + confirm: true。`
      },
    },
  ]
}

/* ── 辅助 ─────────────────────────────────────────────────────────── */

/** 一条提案的渲染。两种形态：记忆提案（有 candidate）与图提案（改结构）。 */
function renderProposal(proposal) {
  if (proposal.candidate) {
    return [
      `- ${proposal.id} · [${proposal.candidate.kind}] ${proposal.candidate.title}`,
      `  协议判不了：${(proposal.why ?? []).join(' / ')}`,
      `  置信：${proposal.candidate.confidence ?? '-'} · 风险：${proposal.candidate.actionRisk ?? '-'}`,
      `  裁决：memory_resolve {"proposalId":"${proposal.id}","action":"accept"|"reject"|"edit"}`,
    ].join('\n')
  }

  const label = {
    merge: `合并 ${proposal.ids?.length ?? 0} 条记忆`,
    edge: `连一条边 ${proposal.subjectId} ↔ ${proposal.objectId}`,
    cluster: `一个记忆社群（${proposal.evidence?.members?.length ?? 0} 条）`,
    core: `一条记忆是图中心 ${proposal.subjectId}`,
  }[proposal.kind] ?? proposal.kind

  return [
    `- ${proposal.id} · [${proposal.kind}] ${label}`,
    `  分数：${proposal.score ?? '-'} · 证据：${JSON.stringify(proposal.evidence ?? {}).slice(0, 120)}`,
    `  裁决：memory_resolve {"proposalId":"${proposal.id}","action":"accept"|"reject"}`,
  ].join('\n')
}

/**
 * 裁决一条**图提案**。
 *
 * 三种结构变更，各自只做一件事：
 *   merge   → 产出一条合并记忆，原始条目标 deprecated 并连 `supersedes` 边
 *   edge    → 给主体条目加一条 `related_to` 关系
 *   core/cluster → **不改任何文件**：接受一次「核心/社群」提议的产物是评审同意，
 *                  不是新的写；把排名写回正文就是把判断伪装成事实
 *
 * **先把 union 标签折进去，再退役任何东西** —— 反序会在循环中途失败时直接丢掉它们。
 */
function resolveGraphProposal(root, proposalId, proposal, args, { log }) {
  const kind = proposal.kind

  if (kind === 'merge') {
    const entries = (proposal.ids ?? []).map((id) => findEntry(root, id)).filter(Boolean)
    if (entries.length < 2) throw inputError(`提案 ${proposalId} 指向的记忆已不足 2 条，无法合并`)

    const consolidated = consolidate(entries, 'merge')
    const written = writeEntry(root, consolidated)

    for (const entry of entries) {
      const relations = [...(entry.relations ?? []), { type: 'supersedes', target: written.id }]
      writeEntry(root, { ...entry, status: 'deprecated', relations })
      appendLedger(root, { kind: 'consolidate', from: entry.id, into: written.id })
    }

    appendReceipt(root, written, { verifier: { kind: 'user', id: 'memory_resolve' } })
    removeProposal(root, proposalId)
    ensureSnapshot(root, { force: true })
    return [
      `已合并 ${entries.length} 条 → ${written.id}`,
      `  原始条目已退休（deprecated），保留正文与 supersedes 边`,
      `  文件 .dsh-memory/memories/${written.id}.md`,
    ].join('\n')
  }

  if (kind === 'edge') {
    const subject = findEntry(root, proposal.subjectId)
    if (!subject) throw inputError(`提案 ${proposalId} 的主体记忆不存在：${proposal.subjectId}`)
    const relations = [...(subject.relations ?? [])]
    const exists = relations.some((relation) => relation.type === 'related_to' && relation.target === proposal.objectId)
    if (!exists) relations.push({ type: 'related_to', target: proposal.objectId })
    writeEntry(root, { ...subject, relations })
    removeProposal(root, proposalId)
    ensureSnapshot(root, { force: true })
    return `已连边：${proposal.subjectId} --related_to--> ${proposal.objectId}\n  **关系类型由人给**：pass 提议配对，不提议类型 —— 在 supersedes 和 caused_by 之间选一个是关于意义的断言。`
  }

  // core / cluster：接受就是评审同意，不写文件
  removeProposal(root, proposalId)
  appendLedger(root, { kind: 'dream-accept', proposalId, proposalKind: kind, subjectId: proposal.subjectId })
  log?.(`dream proposal ${proposalId} (${kind}) accepted by user`)
  return `已接受 ${kind} 提议：${proposal.subjectId}\n  这一条**不产生写入** —— 接受一次「核心/社群」的产物是评审同意，不是新的判断。`
}

function confidenceLabel(score) {
  if (score >= 0.85) return 'verified'
  if (score >= 0.55) return 'inferred'
  return 'stale'
}

function safeDetail(detail) {
  if (!detail || typeof detail !== 'object') return detail ?? null
  // 只保留可审计的键，正文与摘录一律不进日志
  const { errors, missing, owner, why, hint, existing, similarity, used, limit, weakest, confidence, rule, ref } = detail
  return { errors, missing, owner, why, hint, existing, similarity, used, limit, weakest, confidence, rule, ref }
}

/** 配额棘轮状态。增长到阈值后一次性切 ratchet，此后只降不升。 */
function readQuotaState(root) {
  try {
    const file = `${root}/.dsh-memory/quota.lock.json`
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
