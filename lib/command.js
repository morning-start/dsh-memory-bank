/**
 * `/memory` 斜杠命令 —— 用户**直接**掌握记忆库的控制面。
 *
 * 为什么命令比 Web 面板更值得先做：
 *   - 它不需要客户端 bundle，一次注册即在所有交互式 surface 生效；
 *   - 它**不经过模型** —— 用户输入 `/memory accept p_xxx` 就是用户的裁决，
 *     不需要先让模型转述一遍「我要接受这条」再让模型调工具。
 *
 * 这正是「拿不准时用户有足够强的掌握能力」的落点：
 * 工具面是给 Agent 的，命令面是给人的。
 */

import { collectOwners, nextHint, review } from './gate.js'
import { ensureSnapshot, markDirty, readSnapshot } from './index-build.js'
import { dream, lifecycleReport } from './lifecycle.js'
import { recall as runRecall, renderRecall } from './recall.js'
import {
  activeEntries,
  appendLedger,
  appendReceipt,
  ensureLayout,
  findProposal,
  inboxSize,
  newProposalId,
  readAll,
  readProposals,
  removeProposal,
  retireEntry,
  touchEntries,
  writeEntry,
  writeProposal,
} from './store.js'
import { claimStats } from './claims.js'
import { collapse } from './util.js'

const USAGE = [
  '用法：',
  '  /memory                   状态总览',
  '  /memory pending           待决提案',
  '  /memory accept <id>       接受一条提案',
  '  /memory reject <id>       拒绝一条提案',
  '  /memory recall <查询>      直接召回',
  '  /memory audit             全量审计',
  '  /memory dream             跑 dream pass 并暂存提案',
  '  /memory retire <id>       退休一条记忆（软删除）',
].join('\n')

/**
 * 创建命令处理器。`resolveRoot(agent)` 与工具面共用同一个解析器 ——
 * 两条路径必须落在**同一个记忆库**上，否则用户和 Agent 会看到两份世界。
 */
export function createMemoryCommand({ resolveRoot, cfg, log }) {
  function status(agent) {
    const root = resolveRoot(agent)
    const { entries, problems } = readAll(root)
    const active = activeEntries(entries)
    const pending = readProposals(root)
    const claims = claimStats(entries)
    const life = lifecycleReport(active)
    const snapshot = readSnapshot(root)

    return [
      `记忆库：${root}`,
      `  活跃 ${active.length} 条 · 待决 ${pending.length} 条 · 后台队列 ${inboxSize(root)} 条 · 坏文件 ${problems.length} 个`,
      `  断言：open ${claims.open}（可行动 ${claims.openActionable}）· contradicted ${claims.contradicted} · unverified ${claims.unverified}`,
      `  生命周期：休眠 ${life.dormant.length} · 到期复查 ${life.reviewDue.length} · 已过期 ${life.expired.length}`,
      `  索引：${snapshot ? snapshot.snapshotId.slice(0, 12) : '尚未编译'}`,
      '',
      pending.length > 0 ? `有 ${pending.length} 条待决 —— /memory pending 看。` : '没有待决提案。',
      USAGE,
    ].join('\n')
  }

  function pending(agent) {
    const proposals = readProposals(resolveRoot(agent))
    if (proposals.length === 0) return '没有待决提案。'
    return [
      `待决提案 ${proposals.length} 条：`,
      '',
      ...proposals.map((proposal) => {
        if (proposal.candidate) {
          return `  ${proposal.id} · [${proposal.candidate.kind}] ${proposal.candidate.title}\n    判不了：${(proposal.why ?? []).join(' / ')}`
        }
        return `  ${proposal.id} · [${proposal.kind}] ${proposal.subjectId ?? ''} → ${proposal.objectId ?? '(结构)'}\n    分数：${proposal.score ?? '-'}`
      }),
      '',
      '裁决：/memory accept <id> · /memory reject <id>',
    ].join('\n')
  }

  function accept(agent, proposalId) {
    const root = resolveRoot(agent)
    const proposal = findProposal(root, proposalId)
    if (!proposal) return { kind: 'error', text: `没有这条提案：${proposalId}` }

    if (!proposal.candidate) {
      // 图提案：接受就是评审同意，不写记忆
      removeProposal(root, proposalId)
      appendLedger(root, { kind: 'dream-accept', proposalId, proposalKind: proposal.kind, by: 'command' })
      return {
        kind: 'success',
        text: `已接受 ${proposal.kind} 提议：${proposal.subjectId}\n这一条不产生写入 —— 接受一次「核心/社群」的产物是评审同意，不是新的判断。`,
      }
    }

    // 用户已裁决「要记」，但硬门必须重跑 —— 裁决权不是豁免权
    const { entries } = readAll(root)
    const verdict = review(proposal.candidate, {
      root,
      config: cfg,
      corpus: entries,
      owners: collectOwners(root),
    })

    if (verdict.decision === 'REJECT') {
      appendLedger(root, {
        kind: 'resolve',
        proposalId,
        action: 'accept',
        decision: 'rejected',
        code: verdict.code,
        gate: verdict.gate,
        by: 'command',
      })
      return {
        kind: 'error',
        text: `用户裁决了「要记」，但硬门仍然拒绝（${verdict.gate}:${verdict.code}）\n${nextHint(verdict.code, verdict.detail)}`,
      }
    }

    const entry = writeEntry(root, {
      ...proposal.candidate,
      evidence: verdict.resolvedEvidence ?? proposal.candidate.evidence,
      actionRisk: verdict.actionRisk,
    })
    appendReceipt(root, entry, { verifier: { kind: 'user', id: 'command' } })
    removeProposal(root, proposalId)
    appendLedger(root, { kind: 'resolve', proposalId, action: 'accept', decision: 'accepted', by: 'command' })
    markDirty(root)
    return { kind: 'success', text: `已接受：${entry.title}\n  id=${entry.id} · .dsh-memory/memories/${entry.id}.md` }
  }

  function reject(agent, proposalId) {
    const root = resolveRoot(agent)
    const proposal = findProposal(root, proposalId)
    if (!proposal) return { kind: 'error', text: `没有这条提案：${proposalId}` }
    removeProposal(root, proposalId, { reject: true })
    appendLedger(root, { kind: 'resolve', proposalId, action: 'reject', by: 'command' })
    return {
      kind: 'success',
      text: `已拒绝：${proposal.candidate?.title ?? proposalId}\n留档在 .dsh-memory/pending/rejected/ —— 一次拒绝是永久的：同样的计算明天会得出同样的结论。`,
    }
  }

  function recall(agent, query) {
    if (!query.trim()) return { kind: 'error', text: '用法：/memory recall <查询>' }
    const root = resolveRoot(agent)
    ensureLayout(root)
    const { snapshot } = ensureSnapshot(root)
    const envelope = runRecall(query, snapshot, { limit: 3, config: cfg })
    try {
      touchEntries(root, [
        ...envelope.results.map((result) => result.memoryId),
        ...envelope.pointers.map((pointer) => pointer.memoryId),
      ])
    } catch (error) {
      log(`touch failed: ${error?.message ?? error}`)
    }
    return { kind: 'success', text: renderRecall(envelope) }
  }

  function audit(agent) {
    const root = resolveRoot(agent)
    const { entries } = readAll(root)
    const active = activeEntries(entries)
    const claims = claimStats(entries)
    const life = lifecycleReport(active)
    const lines = [
      `审计：${root}`,
      `  活跃 ${active.length} 条`,
      '',
      `断言：open ${claims.open}（可行动 ${claims.openActionable}）· resolved ${claims.resolved} · unverified ${claims.unverified} · contradicted ${claims.contradicted}`,
    ]
    for (const item of claims.sample.slice(0, 5)) {
      lines.push(`  ${item.contradicted ? '⚠' : '·'} ${item.kind} ${item.ref} ← ${item.id}`)
    }
    lines.push(
      '',
      `生命周期：休眠 ${life.dormant.length} · 到期复查 ${life.reviewDue.length} · 已过期 ${life.expired.length} · 建议弃用 ${life.suggestsDeprecation.length}`,
    )
    for (const hint of life.reviewHints.slice(0, 8)) lines.push(`  提示：${hint.id} · ${hint.label} · ${hint.detail}`)
    if (life.consolidation.length > 0) {
      lines.push('', '合并候选：')
      for (const group of life.consolidation.slice(0, 5)) lines.push(`  ${group.ids.join(' + ')}`)
    }
    return { kind: 'success', text: lines.join('\n') }
  }

  function runDream(agent) {
    const root = resolveRoot(agent)
    const { entries } = readAll(root)
    const report = dream(entries)
    const lines = [
      `dream：${report.graph.nodes} 节点 · ${report.graph.edges} 条边 · ${report.graph.orphans} 个孤儿`,
    ]
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
    return { kind: 'success', text: lines.join('\n') }
  }

  function retire(agent, id) {
    const root = resolveRoot(agent)
    const entry = retireEntry(root, id, { reason: 'command' })
    if (!entry) return { kind: 'error', text: `没有这条记忆：${id}` }
    appendLedger(root, { kind: 'forget', id, hardDelete: false, by: 'command' })
    markDirty(root)
    return { kind: 'success', text: `已退休：${id}\n正文保留在 .dsh-memory/memories/，退出召回。` }
  }

  return {
    name: 'memory',
    description: '查看与裁决项目记忆库：状态、待决提案、直接召回、审计。',
    input: {
      hint: 'status | pending | accept <id> | reject <id> | recall <查询> | audit | dream | retire <id>',
    },
    handler: (invocation) => {
      try {
        const raw = String(invocation?.rawInput ?? '').trim()
        const [subcommand = 'status', ...rest] = raw.split(/\s+/u)
        const argument = collapse(rest.join(' '))

        switch (subcommand) {
          case '':
          case 'status':
            return { kind: 'success', text: status(invocation?.agent) }
          case 'pending':
            return { kind: 'success', text: pending(invocation?.agent) }
          case 'accept':
            if (!argument) return { kind: 'error', text: '用法：/memory accept <id>' }
            return accept(invocation?.agent, argument)
          case 'reject':
            if (!argument) return { kind: 'error', text: '用法：/memory reject <id>' }
            return reject(invocation?.agent, argument)
          case 'recall':
            return recall(invocation?.agent, argument)
          case 'audit':
            return audit(invocation?.agent)
          case 'dream':
            return runDream(invocation?.agent)
          case 'retire':
            if (!argument) return { kind: 'error', text: '用法：/memory retire <id>' }
            return retire(invocation?.agent, argument)
          default:
            return { kind: 'error', text: `未知子命令「${subcommand}」\n\n${USAGE}` }
        }
      } catch (error) {
        // 命令处理器**永不崩**：一个在按键上崩溃的命令比没有命令更糟
        log(`command failed: ${error?.message ?? error}`)
        return { kind: 'error', text: `命令失败：${error?.message ?? error}` }
      }
    },
  }
}
