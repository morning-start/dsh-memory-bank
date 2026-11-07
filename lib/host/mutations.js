/**
 * 写操作（面板的「写一半」）—— **命令面与面板面共用同一份实现**。
 *
 * ## 为什么必须共用
 *
 * `docs/07` §3 阶段 B 把这条写成硬约束：**面板的 `accept` 和 `/memory accept`
 * 必须是同一个函数**。上一版 `lib/command.js` 把裁决逻辑写在命令处理器里，
 * 于是「面板接受」和「命令接受」是两条独立代码路径 —— 双实现漂移是这类
 * 项目最贵的一类 bug（0.1.1 的 `gateQuota` 黑名单 / `activeEntries` 白名单
 * 就是同一个错误的第一次）。
 *
 * 所以：`lib/command.js` 现在只做**解析 + 渲染**，裁决逻辑全部落在本文件。
 *
 * ## 返回形状
 *
 * 每一个写操作都返回 `MutationResult`（`shared/types.d.ts`）：
 *
 * ```
 * { ok: true,  value, text }     // text 是给人看的一句话，命令面直接回显
 * { ok: false, error, code? }    // error 同上；code 给界面判断要不要弹二次确认
 * ```
 *
 * **失败不是异常。** 命令处理器「永不崩」（一个在按键上崩溃的命令比没有命令
 * 更糟），面板也不该因为「这条提案已经被别人处理了」整片白。真正的异常
 * （磁盘满、权限）在这里被接住并转成 `{ ok: false }`，同时 `guards` 保证
 * 一次失败的写入不会推进 revision。
 *
 * ## 用户裁决权的边界
 *
 * `accept` 会**重跑硬门**。用户裁决的是「要不要记」，不是「跳过安全门」——
 * 一条含密钥的记忆不会因为点了接受就变成可写的。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { markDirty } from '../index-build.js'
import { dream as runDream } from '../lifecycle.js'
import { collectOwners, nextHint, review } from '../gate.js'
import { ID_PATTERN } from '../model.js'
import { buildPromotion, renderPromotion, summarizePromotion } from '../promote.js'
import {
  appendLedger,
  appendReceipt,
  deleteEntry,
  ensureLayout,
  findEntry,
  findProposal,
  newProposalId,
  readAll,
  readStats,
  removeProposal,
  retireEntry,
  withStats,
  writeEntry,
  writeProposal,
} from '../store.js'
import { stableJson, writeFileAtomic } from '../util.js'

import { readQuotaState } from './queries.js'

/**
 * 可编辑的内容字段。
 *
 * **白名单必须显式**，而且**必须在这里再筛一次**。`edit` 是全插件唯一一条
 * 「用户给的任意对象会被 spread 进 `writeEntry`」的路径，而 `writeEntry`
 * 拿 `entry.id` 当文件名、`entry.status` 当生命周期：
 *
 *   - `edit: { id: "别人的id" }` 能**覆盖别人的记忆**；
 *   - `edit: { status: "rejected" }` 写出来的条目落盘即从召回里消失，
 *     而回执和 ledger 都记着「accepted」。
 *
 * 工具面的 schema 已经收成白名单，但命令面 / 面板 / 测试都可能直接调到这里 ——
 * 两道闸都要有。
 */
export const EDITABLE_FIELDS = Object.freeze(['title', 'about', 'body', 'kind', 'scope', 'triggers', 'evidence'])

function pickEditable(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null
  const picked = {}
  for (const field of EDITABLE_FIELDS) {
    if (Object.hasOwn(patch, field) && patch[field] !== undefined) picked[field] = patch[field]
  }
  return Object.keys(picked).length > 0 ? picked : null
}

const ok = (value, text) => ({ ok: true, value, text })

const fail = (error, code) => ({
  ok: false,
  error: typeof error === 'string' ? error : String(error?.message ?? error),
  ...(typeof code === 'string' && code ? { code } : {}),
})

/** 置信分数 → 标签。与 `lib/tools.js` 的同名私有函数一致（阈值不可各自发明）。 */
function confidenceLabel(score) {
  if (score >= 0.85) return 'verified'
  if (score >= 0.55) return 'inferred'
  return 'stale'
}

/**
 * 创建写操作集合。
 *
 * @param {{
 *   configSource: { get(root: string): object, setProject(root: string, patch: object): object, resetProject(root: string): object },
 *   guards: { withWriteLock(root: string, fn: () => unknown): unknown, assertRevision(root: string, expected: unknown): void, requireConfirm(confirm: unknown, what?: string): void },
 *   log?: (message: string) => void,
 *   by?: string,
 * }} deps
 */
export function createMutations({ configSource, guards, log = () => {}, by = 'command' }) {
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

  return {
    /* ── accept ─────────────────────────────────────────────────── */
    /**
     * 接受一条待决提案。
     *
     * 两条分支：
     *   - **记忆提案**：重跑硬门 → 写条目 → 写回执 → 移出 pending → ledger。
     *   - **图提案**（merge / edge / core / cluster）：`accept` 是「评审同意」，
     *     **不写记忆**。把排名写回正文就是把判断伪装成事实。
     */
    accept(root, proposalId, options = {}) {
      return run(root, 'accept', options, () => {
        if (typeof proposalId !== 'string' || !proposalId) return fail('accept 需要提案 id', 'invalid-id')
        const proposal = findProposal(root, proposalId)
        if (!proposal) return fail(`没有这条提案：${proposalId}`, 'not-found')

        if (!proposal.candidate) {
          removeProposal(root, proposalId)
          appendLedger(root, { kind: 'dream-accept', proposalId, proposalKind: proposal.kind, by })
          return ok(
            { proposalId, kind: proposal.kind },
            `已接受 ${proposal.kind} 提议：${proposal.subjectId}\n这一条不产生写入 —— 接受一次「核心/社群」的产物是评审同意，不是新的判断。`,
          )
        }

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

        const entry = writeEntry(root, {
          ...proposal.candidate,
          evidence: verdict.resolvedEvidence ?? proposal.candidate.evidence,
          actionRisk: verdict.actionRisk,
        })
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
     * 编辑后接受。`patch` **只认内容字段**（见 `EDITABLE_FIELDS`）。
     *
     * 编辑**不是**绕过协议的后门：改完仍然重跑硬门。想「改到能过扫描」的
     * 那条密钥，会在 G3 再被拒一次。
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
        if (!picked) {
          return fail(`edit 需要至少一个内容字段（${EDITABLE_FIELDS.join(' / ')}）；id / status / 时间戳由系统管，不可编辑`, 'invalid-patch')
        }

        const merged = { ...proposal.candidate, ...picked }
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

        const entry = writeEntry(root, {
          ...merged,
          evidence: verdict.resolvedEvidence ?? merged.evidence,
          confidence: merged.confidence ?? confidenceLabel(verdict.confidence ?? 0.7),
          actionRisk: verdict.actionRisk,
        })
        appendReceipt(root, entry, { verifier: { kind: 'user', id: by } })
        removeProposal(root, proposalId)
        appendLedger(root, { kind: 'resolve', proposalId, action: 'edit', decision: 'accepted', by })
        markDirty(root)
        return ok(
          entry,
          `已编辑并接受：${entry.title}\n  id=${entry.id} · 改动了 ${Object.keys(picked).join(' / ')}\n  文件 .dsh-memory/memories/${entry.id}.md`,
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
