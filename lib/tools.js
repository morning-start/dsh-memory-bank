/**
 * 工具层：6 个 `memory_*` 工具的声明式定义与注册。
 *
 * 刻意只有 7 个 —— DSH 的工具是稀缺上下文资源。gingugu 的 30+ 工具面
 * 是给「无插件的第三方宿主」用的；DSH 里同类能力用命令、配置和面板就够了。
 *
 * | 工具 | 作用 |
 * |---|---|
 * | memory_remember | 提议一条记忆（走完整协议） |
 * | memory_recall   | 主动召回（三级交付） |
 * | memory_pending  | 列待决提案 |
 * | memory_resolve  | accept / reject / edit 一条提案 |
 * | memory_audit    | 全量审计 + 漂移复查（只读） |
 * | memory_promote  | 整理成可推广到全局记忆的包（只读、只提名） |
 * | memory_forget   | 退休 / 删除（破坏性） |
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { claimStats, detectRepoName, extractClaims } from './claims.js'
import { driftReport } from './drift.js'
import { createEmbeddingChannel, vectorizeOwners } from './embedding.js'
import { collectOwners, nextHint, review } from './gate.js'
import { DECAY as DECAY_CONST, consolidate, dream, lifecycleReport } from './lifecycle.js'
import { ensureSnapshot, markDirty, readSnapshot } from './index-build.js'
import { actionRiskOf, ID_PATTERN, normalizeId } from './model.js'
import { PROMOTION_SCHEMA, buildPromotion, renderPromotion, summarizePromotion } from './promote.js'
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
  layout,
  newProposalId,
  readAll,
  readLedger,
  readProposals,
  readRejectedProposals,
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
import { collapse, stableJson, writeFileAtomic } from './util.js'

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

/**
 * 从 `edit` 参数里挑出**可编辑的内容字段**。
 *
 * `memory_resolve` 的 `edit` 是唯一一条「用户给的任意对象会被 spread 进
 * `writeEntry`」的路径，而 `writeEntry` 拿 `entry.id` 当文件名、`entry.status`
 * 当生命周期。schema 已经收成白名单，但这条路径也可能被命令面 / 测试直接调用，
 * 所以在 `run` 里**再筛一次** —— 两道闸都要有。
 */
const EDITABLE_FIELDS = ['title', 'about', 'body', 'kind', 'scope', 'triggers', 'evidence']

function pickEditable(edit) {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return null
  const out = {}
  for (const field of EDITABLE_FIELDS) {
    if (Object.hasOwn(edit, field) && edit[field] !== undefined) out[field] = edit[field]
  }
  return Object.keys(out).length > 0 ? out : null
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
  /**
   * 语义通道。**整个插件只建一个** —— 向量缓存要跨调用复用，
   * 否则每次 `memory_remember` 都重新算一遍 owner 文档向量。
   */
  const channel = createEmbeddingChannel({ config: cfg, log })

  /**
   * 一次写入的公共后半段：审核 → 三值裁决 → 副作用。
   *
   * **默认路径是同步的。** 只有语义通道真的开着、而且配了 G1 阈值时才返回
   * Promise —— 因为那是唯一需要 `await` 的地方（HTTP embedding）。
   *
   * 这样做的理由不是性能，是**诚实**：默认配置下 `memory_remember` 的行为
   * 和以前逐字节相同，任何一个老测试的通过或失败都还是它自己说的那件事。
   * 把默认路径改成 async，只会让「默认」和「开了语义」两种行为共享一条
   * 没人真正测过的代码路径。
   */
  function submit(candidate, { sessionId = null, agent = null } = {}) {
    // **必须把 agent 传下去。** `createResolver` 的优先级是「行 config > 环境变量
    // > 会话工作目录 > 进程 cwd」，而上一版这里写的是 `resolveRoot()`（不带参数），
    // 于是会话工作目录那一段是死代码：用户在 DSH 里对仓库 A 说「记住 X」，
    // 记忆写进的是 **DSH 进程 cwd**（应用安装目录），而 `/memory status` 读的是仓库 A。
    // 两份世界 —— 正是 `lib/command.js` 自己警告过的那件事。
    const root = resolveRoot(agent)
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

      const finishSubmit = ({ ownerVectors, semanticThreshold }) => {
        const verdict = review(normalized, {
          root,
          config: cfg,
          // **必须带遥测**：G7 的 `weakness` 读 `accessCount`，而 `readAll`
          // 返回的是磁盘原样（没有这个字段）。不合并的话「最弱候选」排序
          // 永远把 usage 当 0，遥测白写。
          corpus: withStats(entries, readStats(root)),
          owners,
          quotaState,
          ownerVectors,
          semanticThreshold,
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
          markDirty(root)
          maybeTransitionQuota(root, quotaState, cfg, log)
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

        /**
         * **DISCARD：连提案都不建。**
         *
         * `gateConfidence` 有三条分支，第三条是「置信低于 `deferFloor` → 丢弃，
         * 不建提案（噪音，不打扰用户）」。上一版没有任何消费者，`discard` 只被
         * 透传到返回值里没人看 —— 于是这条分支要么不可达（默认地板下），
         * 要么可达但照样 `writeProposal`。协议里写了，代码里没有。
         */
        if (verdict.discard === true) {
          appendLedger(root, {
            kind: 'attempt',
            id: base.id,
            decision: 'discarded',
            code: verdict.code,
            gate: verdict.gate,
            confidence: verdict.confidence ?? null,
          })
          return {
            decision: 'DISCARD',
            verdict,
            text: [
              `未记录：${base.title}`,
              `  置信 ${Number(verdict.confidence ?? 0).toFixed(3)} 低于丢弃地板 ${cfg.thresholds?.deferFloor ?? 0.35}。`,
              '  这是噪音，不建提案、不打扰你。如果它确实重要，补强证据后重写。',
            ].join('\n'),
          }
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

      // ── 分派：默认同步，只有语义通道开了才走异步 ──
      if (!channel.enabled || channel.g1Threshold === null) {
        return finishSubmit({ ownerVectors: null, semanticThreshold: null })
      }
      return (async () => {
        const ownerVectors = await vectorizeOwners(owners, channel)
        const [vector] = await channel.ensure([`${normalized.title ?? ''}\n${normalized.about ?? ''}`])
        normalized.vector = vector ?? null
        return finishSubmit({ ownerVectors, semanticThreshold: channel.g1Threshold })
      })()
  }

  return [
    /* ── memory_remember ─────────────────────────────────────────── */
    {
      name: 'memory_remember',
      description:
        '提议一条长期记忆。**走完整审核协议**：十道门串行，返回 ACCEPT（已写入）/ REJECT（硬拒，带 next 说明怎么改）/ DEFER（协议判不了，进待决队列等你裁决）。' +
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
        // 默认同步返回 string；只有语义通道开着时才是 Promise（execute 会 await）
        const result = submit(candidate, { sessionId: exec?.agent?.session?.id ?? null, agent: exec?.agent ?? null })
        return result && typeof result.then === 'function' ? result.then((value) => value.text) : result.text
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
      run: (args, exec) => {
        const root = resolveRoot(exec?.agent)
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
      run: (args, exec) => {
        const root = resolveRoot(exec?.agent)
        const limit = clampInt(args.limit, { min: 1, max: 50, fallback: 10 })
        // **最新的在前**：`readProposals` 按文件名升序（= 最旧在前），
        // 而「默认最新 10 条」是这个工具唯一的卖点。少一次 reverse 就是
        // 让你看到三个月前的积压、看不到昨天刚 defer 的那条。
        const proposals = [...readProposals(root)].reverse()
        const rejected = args.include_rejected === true ? [...readRejectedProposals(root)].reverse() : []

        if (proposals.length === 0 && rejected.length === 0) return '没有待决提案。'

        const lines = []
        if (proposals.length > 0) {
          lines.push(`待决提案 ${proposals.length} 条：`, '')
          for (const proposal of proposals.slice(0, limit)) lines.push(renderProposal(proposal))
        } else {
          lines.push('没有待决提案。')
        }
        if (rejected.length > 0) {
          lines.push('', `已拒绝（留档，不参与召回）${rejected.length} 条：`, '')
          for (const proposal of rejected.slice(0, limit)) {
            lines.push(`  ${proposal.id} · ${proposal.candidate?.title ?? proposal.kind ?? '（无标题）'} · ${proposal.rejectedAt ?? ''}`)
          }
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
            additionalProperties: false,
            // **白名单必须显式**。`additionalProperties: true` 时 `edit` 会被原样
            // spread 进 `writeEntry`，而后者拿 `entry.id` 当文件名、`entry.status`
            // 当生命周期：于是 `edit:{id:"别的id"}` 能**覆盖别人的记忆**，
            // `edit:{status:"rejected"}` 写出来的条目落盘即从召回里消失，
            // 而回执和 ledger 都记着「accepted」。
            properties: {
              title: { type: 'string' },
              about: { type: 'string' },
              body: { type: 'string' },
              kind: { type: 'string', enum: ['decision', 'pitfall', 'convention', 'correction', 'fact', 'capability'] },
              scope: { type: 'array', items: { type: 'string' } },
              triggers: { type: 'array', items: { type: 'string' } },
              evidence: { type: 'array', items: { type: 'object' } },
            },
            description: 'action=edit 时要合并进去的字段。**只有内容字段** —— id / status / 时间戳由系统管，不可编辑。',
          },
          reason: { type: 'string', description: '为什么这样裁，写进审计日志' },
        },
        required: ['proposalId', 'action'],
      },
      run: (args, exec) => {
        const root = resolveRoot(exec?.agent)
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

        // **再筛一次**：schema 是给宿主的，`run` 也可能被直接调用（测试 / 命令面）。
        // 身份与生命周期字段一律忽略，编辑只改内容。
        const patch = args.action === 'edit' ? pickEditable(args.edit) : null
        const merged = patch ? { ...proposal.candidate, ...patch } : proposal.candidate
        // 用户已裁决「要记」，但硬门必须重跑 —— 裁决权不是豁免权
        const { entries } = readAll(root)
        const verdict = review(merged, {
          root,
          config: cfg,
          corpus: withStats(entries, readStats(root)),
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
      run: (args, exec) => {
        const root = resolveRoot(exec?.agent)
        const { entries, problems } = readAll(root)
        const stats = readStats(root)
        const active = withStats(activeEntries(entries), stats)
        const receipts = readReceipts(root).receipts
        const ledger = readLedger(root, { limit: 500 })

        // 回执健康 = 正文 / 证据根有没有被改（内容寻址）
        const receiptIssues = []
        if (args.check_evidence !== false) {
          for (const entry of active) {
            const status = receiptStatus(root, entry)
            if (status === 'ok') continue
            receiptIssues.push({ id: entry.id, status })
          }
        }

        // 锚点漂移 = 它引用的东西**还在不在**
        const drift = args.check_evidence === false ? null : driftReport(root, active)

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

        if (receiptIssues.length > 0) {
          const reseed = receiptIssues.filter((item) => item.status === 'needs-reseed')
          const real = receiptIssues.filter((item) => item.status !== 'needs-reseed')
          if (real.length > 0) {
            lines.push('', `⚠ 回执异常 ${real.length} 条（正文或证据根被改）：`)
            for (const item of real.slice(0, 10)) {
              lines.push(
                `  - ${item.id} · ${item.status === 'missing' ? '缺回执' : item.status === 'tampered' ? '正文被改' : '证据根被改'}`,
              )
            }
          }
          if (reseed.length > 0) {
            // 0.1.1 把 actionRisk / relations 等补进了内容哈希 —— 旧回执的哈希
            // 算法不同，这不是篡改。报成 tampered 就是一次**虚假的篡改指控**。
            lines.push('', `ℹ 回执待重签 ${reseed.length} 条（0.1.1 的内容哈希字段集变宽了，不是篡改）：`)
            lines.push('    重写这条记忆（`memory_remember` 同 id）即可重签。')
          }
        } else {
          lines.push('', '回执全部健康。')
        }

        /* ── 锚点漂移：它引用的东西还在不在 ── */
        if (drift) {
          const renderAnchor = (item, label) => {
            lines.push(`  ${label}`)
            for (const anchor of item.drifted.slice(0, 5)) {
              lines.push(`    - \`${item.id}\` · ${anchor.kind} \`${anchor.ref}\` —— ${anchor.detail}`)
            }
          }

          if (drift.quarantined.length > 0) {
            lines.push('', `⚠ 锚点消失 ${drift.quarantined.length} 条（**它引用的东西已经不在，可能整条失效**）：`)
            for (const item of drift.quarantined.slice(0, 5)) {
              for (const anchor of item.anchors.filter((entry) => entry.verdict === 'quarantined').slice(0, 3)) {
                lines.push(`  - \`${item.id}\` · ${anchor.kind} \`${anchor.ref}\` —— ${anchor.detail}`)
              }
            }
            lines.push('    处理：`memory_forget` 退休，或补新锚点后重写正文。')
          }
          if (drift.advisory.length > 0) {
            lines.push('', `ℹ 锚点切片变了 ${drift.advisory.length} 条（**重构不是攻击**，不需要退休）：`)
            for (const item of drift.advisory.slice(0, 5)) {
              for (const anchor of item.anchors.filter((entry) => entry.verdict === 'advisory').slice(0, 3)) {
                lines.push(`  - \`${item.id}\` · ${anchor.kind} \`${anchor.ref}\` —— ${anchor.detail}`)
              }
            }
          }
          if (drift.notADefinition.length > 0) {
            lines.push('', `ℹ 锚点指错 ${drift.notADefinition.length} 条（落在注释 / 字符串 / 调用处，**不重新签名**）：`)
            for (const item of drift.notADefinition.slice(0, 5)) {
              for (const anchor of item.anchors.filter((entry) => entry.verdict === 'symbol-not-a-definition').slice(0, 3)) {
                lines.push(`  - \`${item.id}\` · ${anchor.kind} \`${anchor.ref}\` —— ${anchor.detail}`)
              }
            }
          }
          /**
           * **越界锚点单独成桶。**
           *
           * `unsafe-path` 是「ref 逃出了仓库」—— 既不是「目标消失」（quarantined），
           * 也不是「切片变了」（advisory）。混进任何一桶都是错误的归因，
           * 而漏掉它更糟：它会被下面的「全部健康」兜底判成健康。
           */
          if (drift.unsafePath?.length > 0) {
            lines.push('', `⚠ 锚点路径越界 ${drift.unsafePath.length} 条（**拒绝读取仓库外的文件**）：`)
            for (const item of drift.unsafePath.slice(0, 5)) {
              for (const anchor of item.anchors.filter((entry) => entry.verdict === 'unsafe-path').slice(0, 3)) {
                lines.push(`  - \`${item.id}\` · ${anchor.kind} \`${anchor.ref}\` —— ${anchor.detail}`)
              }
            }
            lines.push('    处理：把 ref 改成 repo-relative 路径后重写这条记忆。')
          }
          if (drift.unverifiable > 0) {
            lines.push('', `  ${drift.unverifiable} 条锚点无法机器复查（commit / command / user）—— 不撒谎：既不是健康也不是漂移。`)
          }
          if (
            drift.quarantined.length === 0 &&
            drift.advisory.length === 0 &&
            drift.notADefinition.length === 0 &&
            (drift.unsafePath?.length ?? 0) === 0
          ) {
            lines.push('', `锚点全部健康（${drift.checked} 条）。`)
          }
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

    /* ── memory_promote ─────────────────────────────────────────── */
    {
      name: 'memory_promote',
      description:
        '把项目记忆整理成**可推广到全局记忆的包**。只读、只提名、不搬运 —— 本插件不做全局记忆，' +
        '全局那一层由别的插件负责，这里只回答「哪些项目记忆换一个仓库还成立」。' +
        '硬排除（终态 / 含密钥 / 无证据 / 置信不足）永远不出现在包里。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          format: {
            type: 'string',
            enum: ['summary', 'markdown', 'json', 'both'],
            description: 'summary（默认，概览 + 标题）/ markdown（完整包）/ json（机器可读）/ both',
          },
          min_confidence: {
            type: 'string',
            enum: ['verified', 'inferred', 'stale'],
            description: '进入推广包的置信地板；默认 verified',
          },
          write: {
            type: 'boolean',
            description: '写到 .dsh-memory/export/ 并返回路径；默认 false（只返回内容）',
          },
        },
      },
      run: (args, exec) => {
        const root = resolveRoot(exec?.agent)
        const { entries } = readAll(root)
        // 读写同一份配置。上一版硬编码 `'summary'`，而 `cfg.promote.format`
        // 在整个 `lib/` 里**没有任何读取点** —— 用户在行配置里写
        // `promote: {format:'json'}` 一个字节都不生效。
        const format = args.format ?? cfg.promote?.format ?? 'summary'
        const { bundle } = buildPromotion(entries, {
          root,
          config: {
            ...cfg,
            promote: { ...cfg.promote, minConfidence: args.min_confidence ?? cfg.promote?.minConfidence },
          },
        })

        if (args.write) {
          const paths = ensureLayout(root)
          mkdirSync(paths.exportDir, { recursive: true })
          const base = join(paths.exportDir, `promotion-${bundle.digest}`)
          writeFileAtomic(`${base}.json`, `${stableJson(bundle, 2)}\n`)
          writeFileAtomic(`${base}.md`, `${renderPromotion(bundle)}\n`)
          return [
            summarizePromotion(bundle),
            '',
            '已写入：',
            `  ${base}.md    （人读 / 可粘贴）`,
            `  ${base}.json  （机器读，schema ${PROMOTION_SCHEMA}）`,
            '',
            '**这两个文件不含绝对路径、不含会话 id、不含机器名** —— 只有仓库名、提交 sha 与仓库相对路径。',
          ].join('\n')
        }

        if (format === 'json') return `${stableJson(bundle, 2)}\n`
        if (format === 'markdown') return renderPromotion(bundle)
        if (format === 'both') return `${summarizePromotion(bundle)}\n\n---\n\n${renderPromotion(bundle)}`

        // summary：概览 + 标题 + 排除统计，不展开正文
        const lines = [summarizePromotion(bundle), '']
        if (bundle.entries.length === 0) {
          lines.push('没有条目被提名。')
        } else {
          for (const entry of bundle.entries) {
            lines.push(
              `  · [${entry.kind}] ${entry.title}${entry.markers.length ? `  ⚠ ${entry.markers.join(' / ')}` : ''}`,
            )
          }
        }
        if (bundle.excluded.length > 0) {
          const byReason = new Map()
          for (const item of bundle.excluded) byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1)
          lines.push('', '排除：' + [...byReason.entries()].map(([reason, count]) => `${reason} ${count}`).join(' · '))
        }
        lines.push('', '要完整包：memory_promote {"format":"markdown"} 或 {"write":true}', '要裁决：/memory promote')
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
      run: (args, exec) => {
        const root = resolveRoot(exec?.agent)
        // **先过 id 形状**：`findEntry` 已经是只读的，但后面 `deleteEntry` /
        // `retireEntry` 会把它拼成文件路径。`entryFile` 也会拦，不过在这里
        // 报「没有这条记忆」会掩盖真正的原因（id 非法），所以先明确拒绝。
        const id = requiredText(args.id, 'id')
        if (!ID_PATTERN.test(id)) throw inputError(`id 必须匹配 ${ID_PATTERN}，收到「${id}」`)
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

/**
 * 配额棘轮状态。
 *
 * 两个不变量：
 *   1. **路径走 `layout`**。上一版手拼 `${root}/.dsh-memory/quota.lock.json`，
 *      与目录布局各自为政，改布局就静默失联。
 *   2. **手写坏掉的锁文件不能把全库变成只读**。上一版原样返回，于是
 *      `{"mode":"ratchet"}`（没有 `maxActive`）让 `limit = used`，
 *      `used < limit` 恒假 —— **每一次写入都被拒，包括空库**。
 *      校验不过就降级回 `growth`。
 */
function readQuotaState(root) {
  const file = join(layout(root).base, 'quota.lock.json')
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const maxActive = Number(parsed.maxActive)
    const usable = Number.isInteger(maxActive) && maxActive > 0
    if (parsed.mode === 'ratchet' && !usable) return null
    return { ...parsed, maxActive: usable ? maxActive : null }
  } catch {
    return null
  }
}

function writeQuotaState(root, state) {
  writeFileAtomic(join(layout(root).base, 'quota.lock.json'), `${stableJson(state, 2)}\n`)
}

/**
 * 增长到阈值后一次性切 `ratchet` 并**写回**。
 *
 * 上一版 `quota.lock.json` 只有读没有写（全仓唯一一处 `readFileSync`），
 * 于是 `state.mode` 恒为 `growth`，协议 §G7 的「切换 / 写回 / 报
 * `info quota-transition`」三步一步都没发生。
 */
function maybeTransitionQuota(root, quotaState, cfg, log = () => {}) {
  if (quotaState?.mode === 'ratchet') return
  const threshold = cfg.quota?.growthThreshold ?? 50
  const ceiling = cfg.quota?.repo ?? 200
  const active = activeEntries(readAll(root).entries).length
  if (active < threshold) return
  const maxActive = Math.min(ceiling, Math.max(threshold, active))
  writeQuotaState(root, { mode: 'ratchet', maxActive, transitionedAt: new Date().toISOString() })
  appendLedger(root, { kind: 'quota-transition', from: 'growth', to: 'ratchet', maxActive })
  log(`quota 棘轮已切换：maxActive=${maxActive}（growth 阈值 ${threshold}，硬上限 ${ceiling}）`)
}
