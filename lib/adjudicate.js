/**
 * 裁决域 —— **「用户裁决一条提案」这件事的唯一实现**。
 *
 * ## 为什么这个文件必须存在
 *
 * 0.2.0 把命令面（`/memory accept`）的裁决逻辑搬进了 `lib/host/mutations.js`，
 * 因为「面板接受」和「命令接受」是两份实现，而**双实现漂移是这类项目最贵的
 * 一类 bug**。但那次搬迁**只搬了一半**：
 *
 * `lib/tools.js` 的 `memory_resolve`（工具面）保留了**自己的一份完整实现**。
 * 于是同一条提案、同一个「接受」动作，经两个入口落盘的东西不一样 ——
 * 用 `.tmp-audit/probe-adjudication-drift.mjs` 与 `probe-merge-drift.mjs`
 * 实测，三处分叉，其中一处是**真实的数据丢失**：
 *
 * | 分叉 | 命令 / 面板面 | 工具面 | 后果 |
 * |---|---|---|---|
 * | `authority` | `null` | `user-confirmed` | `authority` 进 `contentHash` → 同一个动作产出两个不同的回执哈希；`promote` 按权威过滤，于是「哪些记忆值得推广」取决于你点的哪个按钮 |
 * | `confidence` | 原样（可能 `null`） | 缺席时算一个标签 | 同上，且 `lifecycle` / `weakest` 排序不同 |
 * | **图提案（merge / edge）** | 删掉提案，**合并从未发生**，还回「已接受 merge 提议：undefined」 | 真的合并 | **提案被静默丢弃** —— 用户点了接受，系统报成功，什么都没做 |
 * | 对账补丁（`claims`） | 不识别 | 支持 | 面板上无法用「后来学到的东西」关掉一条断言 |
 *
 * 所以本文件的判据只有一条：**裁决不是「面板的能力」，是领域的能力**。
 * 工具面、命令面、面板面都是它的**适配器** —— 各自只做「参数形状转换」和
 * 「失败怎么表达」，不碰裁决本身。
 *
 * ## 三个入口的失败形状不同，这是刻意的
 *
 * | 入口 | 失败形状 | 理由 |
 * |---|---|---|
 * | 工具面 | 抛 `MemoryError` | 宿主 registry 转成 `isError: true` 的结构化结果 |
 * | 命令面 | `{ kind: 'error', text }` | 命令处理器**永不崩**（一个在按键上崩溃的命令比没有命令更糟） |
 * | 面板面 | `{ ok: false, error, code? }` | 面板要按 `code` 决定弹不弹二次确认 |
 *
 * **裁决本身只有一份**：本文件返回 `MutationResult`；两个适配器各自翻译。
 *
 * ## 返回形状
 *
 * ```
 * { ok: true,  value, text }     // text 是给人看的一句话，命令面直接回显
 * { ok: false, error, code? }    // error 同上；code 给界面判断要不要弹二次确认
 * ```
 *
 * **失败不是异常。** 真正的异常（磁盘满、权限）在这里被接住并转成
 * `{ ok: false }`，同时 `guards` 保证一次失败的写入不会推进 revision。
 *
 * ## 用户裁决权的边界
 *
 * `accept` 会**重跑硬门**。用户裁决的是「要不要记」，不是「跳过安全门」——
 * 一条含密钥的记忆不会因为点了接受就变成可写的。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { applyResolutions } from './claims.js'
import { collectOwners, nextHint, review } from './gate.js'
import { ensureSnapshot, markDirty } from './index-build.js'
import { consolidate, dream as runDream } from './lifecycle.js'
import { ID_PATTERN, confidenceLabel } from './model.js'
import { buildPromotion, renderPromotion, summarizePromotion } from './promote.js'
import {
  RECEIPT_HASH_VERSION,
  appendLedger,
  appendReceipt,
  deleteEntry,
  ensureLayout,
  findEntry,
  findProposal,
  newProposalId,
  readAll,
  readStats,
  receiptStatus,
  removeProposal,
  resealReceipts,
  retireEntry,
  withStats,
  writeEntry,
  writeProposal,
} from './store.js'
import { isoNow, stableJson, writeFileAtomic } from './util.js'

import { sharedGuards } from './host/guards.js'
import { readQuotaState } from './host/queries.js'

/**
 * 可编辑的内容字段 —— **唯一事实源**。
 *
 * **白名单必须显式**，而且**必须在裁决域再筛一次**。`edit` 是全插件唯一一条
 * 「用户给的任意对象会被 spread 进 `writeEntry`」的路径，而 `writeEntry`
 * 拿 `entry.id` 当文件名、`entry.status` 当生命周期：
 *
 *   - `edit: { id: "别人的id" }` 能**覆盖别人的记忆**；
 *   - `edit: { status: "rejected" }` 写出来的条目落盘即从召回里消失，
 *     而回执和 ledger 都记着「accepted」。
 *
 * 工具面的 schema 已经收成白名单，但命令面 / 面板 / 测试都可能直接调到这里 ——
 * 两道闸都要有。
 *
 * > 0.3.x 之前这里有两份：`lib/tools.js` 的 8 项（含 `claims`）与
 * > `lib/host/mutations.js` 的 7 项（不含）。于是**只有工具面能写 `claims`** ——
 * > 而 `claims` 恰恰不是普通内容字段，它走的是补丁语义（见 `pickClaimPatches`）。
 * > 现在合成一份：`claims` 在表里，但 `pickEditable` 会跳过它。
 */
export const EDITABLE_FIELDS = Object.freeze([
  'title',
  'about',
  'body',
  'kind',
  'scope',
  'triggers',
  'evidence',
  'claims',
])

/**
 * 从 `edit` 参数里挑出**可编辑的内容字段**。
 *
 * `claims` 被**刻意跳过** —— 它需要 `applyResolutions` 的合并语义（补丁列表），
 * 不是覆盖。见 `pickClaimPatches`。
 */
export function pickEditable(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null
  const picked = {}
  for (const field of EDITABLE_FIELDS) {
    if (field === 'claims') continue
    if (Object.hasOwn(patch, field) && patch[field] !== undefined) picked[field] = patch[field]
  }
  return Object.keys(picked).length > 0 ? picked : null
}

/**
 * `claims` 的**唯一**可写形态：resolution 三列的补丁列表。
 *
 * 不是「整体替换 claims」。`state` 是写时冻结的历史，让它可写等于
 * 把「改写历史」的权力交出去 —— 而这一层的全部价值是
 * 「散文是诚实的历史」（`docs/01:99`）。
 *
 * 白名单在这里**再筛一次**：schema 是给宿主的，`run` 也可能被直接调用。
 */
export function pickClaimPatches(claims) {
  if (!Array.isArray(claims)) return null
  const patches = claims
    .filter((claim) => claim && typeof claim === 'object' && !Array.isArray(claim))
    .map((claim) => ({
      kind: typeof claim.kind === 'string' ? claim.kind : null,
      ref: typeof claim.ref === 'string' ? claim.ref : null,
      // 只有这三列。`state` / `evidence` 一律丢弃 —— 它们由抽取器拥有。
      ...(claim.resolvedState === undefined ? {} : { resolvedState: String(claim.resolvedState) }),
      ...(claim.resolvedBy === undefined ? {} : { resolvedBy: claim.resolvedBy === null ? null : String(claim.resolvedBy) }),
      ...(claim.resolvedAt === undefined ? {} : { resolvedAt: claim.resolvedAt === null ? null : String(claim.resolvedAt) }),
    }))
    .filter((patch) => patch.kind && patch.ref)
  return patches.length > 0 ? patches : null
}

const ok = (value, text) => ({ ok: true, value, text })

const fail = (error, code) => ({
  ok: false,
  error: typeof error === 'string' ? error : String(error?.message ?? error),
  ...(typeof code === 'string' && code ? { code } : {}),
})

/**
 * 创建裁决域。
 *
 * @param {{
 *   configSource: { get(root: string): object, setProject(root: string, patch: object): object, resetProject(root: string): object },
 *   guards?: { withWriteLock(root: string, fn: () => unknown): unknown, assertRevision(root: string, expected: unknown): void, requireConfirm(confirm: unknown, what?: string): void, bump(root: string): void },
 *   log?: (message: string) => void,
 *   by?: string,
 * }} deps
 */
export function createAdjudicator({ configSource, guards = sharedGuards, log = () => {}, by = 'command' }) {
  const cfgFor = (root) => configSource.get(root)

  /**
   * 进临界区并归一化失败。
   *
   * 顺序是**先 revision 再锁**：revision 对不上说明这次提交本来就过时了，
   * 没必要抢锁（抢了也会被拒）。
   */
  const run = (root, operation, options, fn) => {
    try {
      guards.assertRevision(root, options?.expectedRevision)
      const result = guards.withWriteLock(root, fn)
      // 只有**真的写成功**才推进 revision：拒绝一条不存在的提案没有改变任何东西，
      // 不该让面板的 staged form 变脏（否则用户重试会一直撞 stale-revision）。
      if (result?.ok === true) guards.bump(root)
      return result
    } catch (error) {
      log(`mutation ${operation} failed on ${root}: ${error?.message ?? error}`)
      return fail(error, error?.code)
    }
  }

  /**
   * 重跑审核协议。
   *
   * `corpus` 必须带遥测（`withStats`）：G7 的 `weakness` 读 `accessCount`，
   * 而 `readAll` 返回的是磁盘原样（没有这个字段）。不合并的话「最弱候选」
   * 永远把 usage 当 0 —— 遥测白写，而且**只在这个入口错**。
   *
   * `quotaState` 一并带上：棘轮切换之后，面板接受和工具接受必须是同一个上限。
   */
  const reviewCandidate = (root, candidate) => {
    const { entries } = readAll(root)
    return review(candidate, {
      root,
      config: cfgFor(root),
      corpus: withStats(entries, readStats(root)),
      owners: collectOwners(root),
      quotaState: readQuotaState(root),
    })
  }

  /**
   * 条目落盘的**唯一**收尾：补证据 / 置信 / 权威 / 风险，然后写。
   *
   * 为什么把这几行提出来：它们**曾经在两个入口各写一遍**，而 `authority`
   * 只在一处被赋值 —— 于是「同一次用户裁决」产出的记忆，权威取决于点的是
   * 工具还是面板。这不是格式差异，是**同一个事实有两个答案**。
   */
  const writeAdjudicated = (root, merged, verdict, { overwrite = false } = {}) =>
    writeEntry(
      root,
      {
        ...merged,
        evidence: verdict.resolvedEvidence ?? merged.evidence,
        // 候选没给置信时用门算出来的那个 —— 否则落盘是 `null`，
        // 而 `weakness` / `promote` 读它做排序。
        confidence: merged.confidence ?? confidenceLabel(verdict.confidence ?? 0.7),
        /**
         * **这是全系统唯一能产生 `user-confirmed` 的地方。**
         *
         * 人在这里看过正文、按下 accept —— 那是一次真实的背书。
         * 其余所有写入路径（工具面 `memory_remember` / 自动捕获 / 合并）
         * 都只能写 `observed`。见 `test/protocol.test.mjs` 的
         * 「accept 把权威从 `observed` 抬到 `user-confirmed`」。
         */
        authority: 'user-confirmed',
        actionRisk: verdict.actionRisk,
      },
      { overwrite },
    )

  /**
   * 裁决一条**图提案**。
   *
   * 三种结构变更，各自只做一件事：
   *   merge       → 产出一条合并记忆，原始条目标 deprecated 并连 `supersedes` 边
   *   edge        → 给主体条目加一条 `related_to` 关系
   *   core/cluster → **不改任何文件**：接受一次「核心/社群」提议的产物是评审同意，
   *                 不是新的写；把排名写回正文就是把判断伪装成事实
   *
   * **先把 union 标签折进去，再退役任何东西** —— 反序会在循环中途失败时直接丢掉它们。
   *
   * > 0.3.x 之前这条分支在 `lib/tools.js` 里，而 `lib/host/mutations.js` 的
   * > 对应分支是「删掉提案 + 回一句 `已接受 merge 提议：undefined`」。
   * > 于是**在面板上接受一条 merge 提案 = 提案永久消失，合并从未发生**。
   * > 现在两个入口都调这里。
   */
  const resolveGraphProposal = (root, proposalId, proposal) => {
    const kind = proposal.kind

    if (kind === 'merge') {
      const entries = (proposal.ids ?? []).map((id) => findEntry(root, id)).filter(Boolean)
      if (entries.length < 2) return fail(`提案 ${proposalId} 指向的记忆已不足 2 条，无法合并`, 'not-found')

      const consolidated = consolidate(entries, 'merge')
      // 结构性合并：合并后的条目本来就取代被合并的那几条，跨标题改写是意图。
      const written = writeEntry(root, consolidated, { overwrite: true })

      for (const entry of entries) {
        const relations = [...(entry.relations ?? []), { type: 'supersedes', target: written.id }]
        writeEntry(root, { ...entry, status: 'deprecated', relations })
        appendLedger(root, { kind: 'consolidate', from: entry.id, into: written.id, by })
      }

      appendReceipt(root, written, { verifier: { kind: 'user', id: by } })
      removeProposal(root, proposalId)
      ensureSnapshot(root, { force: true })
      markDirty(root)
      appendLedger(root, { kind: 'resolve', proposalId, action: 'accept', decision: 'merged', into: written.id, by })
      return ok(
        { proposalId, kind, into: written.id },
        [
          `已合并 ${entries.length} 条 → ${written.id}`,
          '  原始条目已退休（deprecated），保留正文与 supersedes 边',
          `  文件 .dsh-memory/memories/${written.id}.md`,
        ].join('\n'),
      )
    }

    if (kind === 'edge') {
      const subject = findEntry(root, proposal.subjectId)
      if (!subject) return fail(`提案 ${proposalId} 的主体记忆不存在：${proposal.subjectId}`, 'not-found')
      const relations = [...(subject.relations ?? [])]
      const exists = relations.some(
        (relation) => relation.type === 'related_to' && relation.target === proposal.objectId,
      )
      if (!exists) relations.push({ type: 'related_to', target: proposal.objectId })
      writeEntry(root, { ...subject, relations })
      removeProposal(root, proposalId)
      ensureSnapshot(root, { force: true })
      appendLedger(root, { kind: 'resolve', proposalId, action: 'accept', decision: 'edge', by })
      return ok(
        { proposalId, kind },
        `已连边：${proposal.subjectId} --related_to--> ${proposal.objectId}\n  **关系类型由人给**：pass 提议配对，不提议类型 —— 在 supersedes 和 caused_by 之间选一个是关于意义的断言。`,
      )
    }

    // core / cluster：接受就是评审同意，不写文件
    removeProposal(root, proposalId)
    appendLedger(root, { kind: 'dream-accept', proposalId, proposalKind: kind, subjectId: proposal.subjectId, by })
    log?.(`dream proposal ${proposalId} (${kind}) accepted by user`)
    return ok(
      { proposalId, kind, subjectId: proposal.subjectId ?? null },
      `已接受 ${kind} 提议：${proposal.subjectId ?? proposal.kind}\n  这一条**不产生写入** —— 接受一次「核心/社群」的产物是评审同意，不是新的判断。`,
    )
  }

  return {
    /* ── accept ─────────────────────────────────────────────────── */
    /**
     * 接受一条待决提案。
     *
     * 两条分支：
     *   - **记忆提案**：重跑硬门 → 写条目 → 写回执 → 移出 pending → ledger。
     *   - **图提案**（merge / edge / core / cluster）：`accept` 是「评审同意」，
     *     **不写记忆正文**。merge / edge 真的改结构；core / cluster 只记评审。
     */
    accept(root, proposalId, options = {}) {
      return run(root, 'accept', options, () => {
        if (typeof proposalId !== 'string' || !proposalId) return fail('accept 需要提案 id', 'invalid-id')
        const proposal = findProposal(root, proposalId)
        if (!proposal) return fail(`没有这条提案：${proposalId}`, 'not-found')

        if (!proposal.candidate) return resolveGraphProposal(root, proposalId, proposal)

        // 用户已裁决「要记」，但硬门必须重跑 —— 裁决权不是豁免权
        const verdict = reviewCandidate(root, proposal.candidate)

        if (verdict.decision === 'REJECT') {
          appendLedger(root, {
            kind: 'resolve',
            proposalId,
            action: 'accept',
            decision: 'rejected',
            code: verdict.code,
            gate: verdict.gate,
            by,
          })
          return fail(
            `用户裁决了「要记」，但硬门仍然拒绝（${verdict.gate}:${verdict.code}）\n${nextHint(verdict.code, verdict.detail)}`,
            'rejected',
          )
        }

        const entry = writeAdjudicated(root, proposal.candidate, verdict)
        appendReceipt(root, entry, { verifier: { kind: 'user', id: by } })
        removeProposal(root, proposalId)
        appendLedger(root, { kind: 'resolve', proposalId, action: 'accept', decision: 'accepted', by })
        markDirty(root)
        return ok(entry, `已接受：${entry.title}\n  id=${entry.id} · .dsh-memory/memories/${entry.id}.md`)
      })
    },

    /* ── reject ─────────────────────────────────────────────────── */
    /**
     * 拒绝一条待决提案。**留档**（`pending/rejected/`），不是删除。
     *
     * 一次拒绝是永久的：同样的计算明天会得出同样的结论。留档是为了让
     * 「为什么这条没进来」有答案。
     */
    reject(root, proposalId, reason, options = {}) {
      return run(root, 'reject', options, () => {
        if (typeof proposalId !== 'string' || !proposalId) return fail('reject 需要提案 id', 'invalid-id')
        const proposal = findProposal(root, proposalId)
        if (!proposal) return fail(`没有这条提案：${proposalId}`, 'not-found')
        removeProposal(root, proposalId, { reject: true })
        appendLedger(root, { kind: 'resolve', proposalId, action: 'reject', reason: reason ?? null, by })
        return ok(
          { proposalId },
          `已拒绝：${proposal.candidate?.title ?? proposalId}\n留档在 .dsh-memory/pending/rejected/ —— 一次拒绝是永久的：同样的计算明天会得出同样的结论。`,
        )
      })
    },

    /* ── edit ───────────────────────────────────────────────────── */
    /**
     * 编辑后接受。`patch` **只认内容字段**（见 `EDITABLE_FIELDS`）；
     * `options.claimPatches` 是**对账补丁**（resolution 三列）。
     *
     * 编辑**不是**绕过协议的后门：改完仍然重跑硬门。想「改到能过扫描」的
     * 那条密钥，会在 G3 再被拒一次。
     *
     * 对账补丁**在任何写入之前**应用，没命中就整次失败：
     * 「部分应用 + 静默丢弃」是最糟的组合 —— 用户会以为「PR #10 已经关掉了」，
     * 而实际上那条补丁掉在了地上。
     */
    edit(root, proposalId, patch, options = {}) {
      return run(root, 'edit', options, () => {
        if (typeof proposalId !== 'string' || !proposalId) return fail('edit 需要提案 id', 'invalid-id')
        const proposal = findProposal(root, proposalId)
        if (!proposal) return fail(`没有这条提案：${proposalId}`, 'not-found')
        if (!proposal.candidate) {
          return fail(
            `提案 ${proposalId} 是图提案（${proposal.kind}）—— 它改的是结构，没有可编辑的正文。请接受或拒绝。`,
            'not-editable',
          )
        }

        const picked = pickEditable(patch)
        const claimPatches = pickClaimPatches(options.claimPatches)
        if (!picked && !claimPatches) {
          return fail(
            `edit 需要至少一个内容字段（${EDITABLE_FIELDS.filter((field) => field !== 'claims').join(' / ')}）或一条 claims 补丁；id / status / 时间戳由系统管，不可编辑`,
            'invalid-patch',
          )
        }

        let merged = picked ? { ...proposal.candidate, ...picked } : proposal.candidate

        if (claimPatches) {
          const resolution = applyResolutions(merged, claimPatches, {
            resolvedBy: by,
            resolvedAt: isoNow(),
          })
          if (resolution.missing.length > 0) {
            const list = resolution.missing.map((item) => `${item.kind} ${item.ref}`).join('、')
            const known =
              (merged.claims ?? []).map((claim) => `${claim.kind} ${claim.ref}`).join('、') ||
              '（这条记忆没有 claim）'
            return fail(
              `对账补丁里有 ${resolution.missing.length} 个 ref 在记忆 ${merged.id} 里不存在：${list}\n` +
                `  已有的 claim：${known}\n` +
                '**没有写入任何东西** —— 对账是「后来学到的东西」，写错 ref 等于给别的断言盖章。',
              'claim-miss',
            )
          }
          merged = resolution.entry
        }

        const verdict = reviewCandidate(root, merged)
        if (verdict.decision === 'REJECT') {
          appendLedger(root, {
            kind: 'resolve',
            proposalId,
            action: 'edit',
            decision: 'rejected',
            code: verdict.code,
            gate: verdict.gate,
            by,
          })
          return fail(
            `编辑后仍被硬门拒绝（${verdict.gate}:${verdict.code}）\n${nextHint(verdict.code, verdict.detail)}`,
            'rejected',
          )
        }

        // `edit` **可以改标题** —— 那是用户的明确意图，不是 slug 碰撞。
        const entry = writeAdjudicated(root, merged, verdict, { overwrite: true })
        appendReceipt(root, entry, { verifier: { kind: 'user', id: by } })
        removeProposal(root, proposalId)
        appendLedger(root, { kind: 'resolve', proposalId, action: 'edit', decision: 'accepted', by })
        markDirty(root)
        return ok(
          entry,
          [
            `已编辑并接受：${entry.title}`,
            `  id=${entry.id} · 改动了 ${[Object.keys(picked ?? {}), claimPatches ? 'claims' : null].filter(Boolean).flat().join(' / ')}`,
            `  文件 .dsh-memory/memories/${entry.id}.md`,
          ].join('\n'),
        )
      })
    },

    /* ── retire ─────────────────────────────────────────────────── */
    /** 退休（软删除）：转 deprecated，正文保留，退出召回。 */
    retire(root, id, reason, options = {}) {
      return run(root, 'retire', options, () => {
        if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
          return fail(`id 必须匹配 ${ID_PATTERN}，收到「${id}」`, 'invalid-id')
        }
        const retired = retireEntry(root, id, { reason: reason ?? by })
        if (!retired) return fail(`没有这条记忆：${id}`, 'not-found')
        appendLedger(root, { kind: 'forget', id, hardDelete: false, reason: reason ?? null, by })
        markDirty(root)
        return ok(retired.entry, `已退休：${id}\n正文保留在 .dsh-memory/memories/，退出召回。`)
      })
    },

    /* ── forget ─────────────────────────────────────────────────── */
    /**
     * 永久删除。**`confirm !== true` 一律拒绝。**
     *
     * 确认检查放在「条目是否存在」之前：否则 `forget('nope', false)` 会
     * 用「没有这条记忆」泄露存在性，而真正的错误（没确认）被掩盖。
     */
    forget(root, id, confirm, options = {}) {
      return run(root, 'forget', options, () => {
        if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
          return fail(`id 必须匹配 ${ID_PATTERN}，收到「${id}」`, 'invalid-id')
        }
        guards.requireConfirm(confirm, 'hard_delete')
        if (!findEntry(root, id)) return fail(`没有这条记忆：${id}`, 'not-found')
        deleteEntry(root, id)
        appendLedger(root, { kind: 'forget', id, hardDelete: true, reason: null, by })
        markDirty(root)
        return ok({ id, hardDelete: true }, `已永久删除：${id}`)
      })
    },

    /* ── reseed ─────────────────────────────────────────────────── */
    /**
     * 批量重签旧回执。**只改回执，不碰正文。**
     *
     * 这是升级路径的**出口**：`receiptStatus` 对旧哈希版本报 `needs-reseed`
     * （不是 `tampered`），但没有修复路径的话，审计里那条「ℹ 回执待重签 N 条」
     * 永远不消失 —— 而永久存在的警告会被学会忽略。
     *
     * `dryRun` 走同一条路径但**不落盘**：先看清要改哪些，再决定改不改。
     * 一次「我以为是重签，其实是重写」的误操作不可回退，所以先给人看。
     */
    reseed(root, options = {}) {
      return run(root, 'reseed', options, () => {
        const { entries } = readAll(root)
        const stale = entries.filter((entry) => receiptStatus(root, entry) === 'needs-reseed')

        if (stale.length === 0) return ok({ dryRun: Boolean(options?.dryRun), resealed: [] }, '没有需要重签的回执。')

        if (options?.dryRun === true) {
          return ok(
            { dryRun: true, candidates: stale.map((entry) => entry.id) },
            [
              `将重签 ${stale.length} 条回执（干跑，**未写入**）：`,
              ...stale.slice(0, 20).map((entry) => `  - ${entry.id}`),
              stale.length > 20 ? `  …… 还有 ${stale.length - 20} 条` : null,
              '',
              '**只改回执，不碰正文。** 去掉 `--dry-run` 才真的写。',
            ]
              .filter(Boolean)
              .join('\n'),
          )
        }

        const { resealed } = resealReceipts(root, entries)
        appendLedger(root, {
          kind: 'reseed',
          count: resealed.length,
          hashVersion: RECEIPT_HASH_VERSION,
          by,
        })
        return ok(
          { dryRun: false, resealed },
          `已重签 ${resealed.length} 条回执（哈希版本 → ${RECEIPT_HASH_VERSION}）\n  正文未改动。`,
        )
      })
    },

    /* ── dream ──────────────────────────────────────────────────── */
    /**
     * 跑一次 dream pass 并**暂存**提案。
     *
     * **不写记忆、不写关系。** 三个 pass 各自停在意义开始的地方：提议排名、
     * 提议成员集、提议配对，没有一个提议关系类型 —— 这使它可以无人值守跑。
     */
    dream(root, options = {}) {
      return run(root, 'dream', options, () => {
        const { entries } = readAll(root)
        const report = runDream(entries)
        const lines = [`dream：${report.graph.nodes} 节点 · ${report.graph.edges} 条边 · ${report.graph.orphans} 个孤儿`]
        let staged = 0
        for (const [passName, findings] of Object.entries(report.passes)) {
          if (!findings?.length) {
            lines.push(`  ${passName}: 无发现`)
            continue
          }
          for (const finding of findings) {
            writeProposal(root, {
              id: newProposalId(),
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
          lines.push(`  ${passName}: ${findings.length} 条`)
        }
        lines.push('', `已暂存 ${staged} 条 —— /memory pending 看。`, '**dream 不写记忆、不写关系** —— 它只提议结构。')
        return ok({ staged, graph: report.graph }, lines.join('\n'))
      })
    },

    /* ── promote ───────────────────────────────────────────────── */
    /**
     * 生成可推广到全局记忆的包（**只产出，不写全局存储**）。
     *
     * 全局那一层由别的插件负责 —— 这个插件只回答「哪些项目记忆换一个仓库
     * 还成立」，把决定权留给人。
     *
     * @param {{ format?: 'summary'|'markdown'|'json'|'both', json?: boolean, write?: boolean, minConfidence?: string }} [options]
     */
    promote(root, options = {}) {
      return run(root, 'promote', options, () => {
        const { json = false, write = false, minConfidence } = options
        const { entries } = readAll(root)
        const cfg = cfgFor(root)
        const { bundle } = buildPromotion(entries, {
          root,
          config: {
            ...cfg,
            promote: { ...cfg.promote, ...(minConfidence ? { minConfidence } : {}) },
          },
        })

        if (write) {
          const paths = ensureLayout(root)
          mkdirSync(paths.exportDir, { recursive: true })
          const base = join(paths.exportDir, `promotion-${bundle.digest}`)
          writeFileAtomic(`${base}.json`, `${stableJson(bundle, 2)}\n`)
          writeFileAtomic(`${base}.md`, `${renderPromotion(bundle)}\n`)
          return ok(
            bundle,
            [
              summarizePromotion(bundle),
              '',
              `已写入 ${paths.exportDir}/promotion-${bundle.digest}{.md,.json}`,
              '**不含绝对路径 / 会话 id / 机器名** —— 只有仓库名、提交 sha、仓库相对路径。',
            ].join('\n'),
          )
        }

        if (json) return ok(bundle, `${stableJson(bundle, 2)}\n`)

        const format = options.format
        if (format === 'markdown') return ok(bundle, renderPromotion(bundle))
        if (format === 'both') return ok(bundle, `${summarizePromotion(bundle)}\n\n---\n\n${renderPromotion(bundle)}`)
        return ok(bundle, renderPromotion(bundle))
      })
    },

    /* ── 项目层配置 ─────────────────────────────────────────────── */
    /**
     * 写项目层（`<repo>/.dsh-memory/config.json`）。**只认仓库属性**
     * （`capture` / `quota` / `template` / `safety`），其余字段会被
     * `writeProjectConfig` 静默裁掉并如实返回 —— 界面必须显示「哪些没写进去」。
     */
    setProjectConfig(root, patch, options = {}) {
      return run(root, 'setProjectConfig', options, () => {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          return fail('patch 必须是一个对象（只认 capture / quota / template / safety）', 'invalid-patch')
        }
        const result = configSource.setProject(root, patch)
        const written = Object.keys(result.written ?? {})
        return ok(
          { path: result.path, written: result.written, value: result.value, problems: result.problems ?? [] },
          [
            `已写项目层：${result.path}`,
            `  落盘字段：${written.length > 0 ? written.join(' / ') : '（与默认值相同，未写任何字段）'}`,
            '  与默认值相同的字段不会落盘 —— 否则改默认值对这个仓库再也不生效。',
          ].join('\n'),
        )
      })
    },

    /**
     * 重置项目层（清空仓库级覆盖）。
     *
     * **写回一个只有文件头的文件，不是删文件。** 删文件会让 `git status`
     * 显示一个 deletion，而用户以为「只是重置」。
     */
    resetProjectConfig(root, options = {}) {
      return run(root, 'resetProjectConfig', options, () => {
        const result = configSource.resetProject(root)
        return ok(
          { path: result.path, value: result.value },
          `已重置项目层：${result.path}\n  文件保留（只有文件头）—— 删文件会让 git status 显示一个 deletion，而用户以为「只是重置」。`,
        )
      })
    },
  }
}
