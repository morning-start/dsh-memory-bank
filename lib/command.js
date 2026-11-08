/**
 * `/memory` 斜杠命令 —— 用户**直接**掌握记忆库的控制面。
 *
 * 为什么命令比 Web 面板更值得先做：
 *   - 它不需要客户端 bundle，一次注册即在所有交互式 surface 生效；
 *   - 它**不经过模型** —— 用户输入 `/memory accept p_xxx` 就是用户的裁决，
 *     不需要先让模型转述一遍「我要接受这条」再让模型调工具。
 *
 * 这正是「拿不准时用户有足够强的掌握能力」的落点：
 * 工具面是给 Agent 的，命令面是给人看的。
 *
 * ## 本文件现在是**薄壳**
 *
 * `docs/07` §3 阶段 B 的硬约束：**面板的 `accept` 和 `/memory accept` 必须
 * 是同一个函数**。裁决逻辑（重跑硬门、写回执、移出待决、写 ledger）全部
 * 搬到了 `lib/host/mutations.js`，命令面只剩两件事：
 *
 *   1. **解析**：`rawInput` → 子命令 + 参数；
 *   2. **渲染**：`MutationResult` → `{ kind, text }`（宿主命令面的返回形状）。
 *
 * 上一版这里是完整的一份实现，于是「面板接受」和「命令接受」是两条独立
 * 代码路径 —— 双实现漂移正是 0.1.1 修过的那一类 bug。
 *
 * 只读子命令（`status` / `pending` / `recall` / `audit`）仍留在本文件：
 * 它们渲染的是**给人看的文本**，而 `queries.js` 返回的是**给界面用的结构**。
 * 两者刻意不同形（一个是段落，一个是对象），硬要共用会把两边都弄脏。
 */

import { existsSync } from 'node:fs'

import { claimStats } from './claims.js'
import { ensureSnapshot, readSnapshot } from './index-build.js'
import { lifecycleReport } from './lifecycle.js'
import { recall as runRecall, renderRecall } from './recall.js'
import {
  activeEntries,
  ensureLayout,
  inboxSize,
  isInitialized,
  layout,
  readAll,
  readProposals,
  touchEntries,
} from './store.js'
import { collapse } from './util.js'

import { sharedGuards } from './host/guards.js'
import { createMutations } from './host/mutations.js'

const USAGE = [
  '用法：',
  '  /memory                   状态总览',
  '  /memory init [--dry-run]  初始化记忆库（幂等，只建骨架）',
  '  /memory pending           待决提案',
  '  /memory accept <id>       接受一条提案',
  '  /memory reject <id>       拒绝一条提案',
  '  /memory recall <查询>      直接召回',
  '  /memory audit             全量审计',
  '  /memory dream             跑 dream pass 并暂存提案',
  '  /memory promote [--json]  生成可推广到全局记忆的包',
  '  /memory retire <id>       退休一条记忆（软删除）',
  '  /memory reseed [--dry-run] 重签旧版本哈希的回执（只改回执，不碰正文）',
].join('\n')

/**
 * `MutationResult` → 命令面返回形状。
 *
 * 命令处理器**永不抛**（见 handler 的 catch），所以这里只做形状映射：
 * `ok: false` 的 `error` 是一句给人看的话，直接回显。
 *
 * @param {{ ok: boolean, text?: string, error?: string }} result
 */
function toCommand(result) {
  return result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.error }
}

/**
 * 创建命令处理器。`resolveRoot(agent)` 与工具面 / 面板面共用同一个解析器 ——
 * 三条路径必须落在**同一个记忆库**上，否则用户和 Agent 会看到两份世界。
 *
 * @param {{
 *   resolveRoot: (agent?: unknown) => string,
 *   configSource: { get(root: string): object },
 *   log: (message: string) => void,
 *   mutations?: object,
 * }} deps
 */
export function createMemoryCommand({ resolveRoot, configSource, log, mutations }) {
  /**
   * 命令面与工具面必须看到**同一份**配置。
   *
   * 0.1.0 这里是 `apply()` 的闭包快照，于是「改配置 → 重启宿主」是唯一
   * 生效方式；`configSource` 按 root 缓存，改完立刻生效。两条路径共用
   * 同一个解析器，用户和 Agent 才不会看到两份世界。
   */
  const configFor = (agent) => configSource.get(resolveRoot(agent))

  /**
   * 写操作。**默认与面板共用同一个实例**（`sharedGuards` 是模块级单例）——
   * 两份锁谁都不认识谁，于是「两个入口同时写」就真的能发生。
   *
   * 测试 / 别处要隔离时再注入自己的 `mutations`。
   */
  const writes = mutations ?? createMutations({ configSource, guards: sharedGuards, log, by: 'command' })

  /**
   * 未初始化时回一句**可操作**的话，而不是「0 条」。
   *
   * 「0 条」和「没装过」是两件不同的事 —— 前者是结论，后者是**还没开始**。
   * 混在一起用户会以为记忆坏了（0.3.7 修过「0 到底是没记忆还是读错了
   * 地方」，这是同一个坑的第二面）。
   */
  function uninitialized(root) {
    return [
      `记忆库：${root}`,
      '',
      '这个仓库还没初始化记忆库（`.dsh-memory/` 不存在）。',
      '',
      '  /memory init          初始化（幂等，只建骨架，不写记忆）',
      '',
      '**自动捕获与召回注入在初始化之前不会执行** —— 一个从没用过记忆的仓库，',
      '不该因为跑过几轮对话就多出 .dsh-memory/。',
    ].join('\n')
  }

  /**
   * 初始化记忆库。**幂等**：只补缺失项，已有文件一个字节都不动。
   *
   * 与 `memory_init` 工具**同一份判据**（都数 `ensureLayout` 会建的那 8 项），
   * 只是返回形状不同 —— 命令面给人看段落，工具面给模型看。
   */
  function init(agent, argument) {
    const root = resolveRoot(agent)
    const paths = layout(root)

    const items = [
      ['目录', paths.memories],
      ['目录', paths.trust],
      ['目录', paths.rejected],
      ['目录', paths.inbox],
      ['目录', paths.snapshots],
      ['文件', paths.gitignore],
      ['文件', paths.config],
      ['文件', paths.receipts],
    ]
    const missing = items.filter(([, target]) => !existsSync(target))
    /** 报告里只写仓库相对路径 —— 绝对路径进不了记忆，也不该进命令输出。 */
    const show = (target) => target.slice(paths.base.length + 1)

    if (missing.length === 0) {
      return {
        kind: 'success',
        text: [`记忆库已存在且完整：${paths.base}`, '（幂等：这次调用没有改动任何文件）'].join('\n'),
      }
    }

    if (/--dry-run/u.test(argument)) {
      return {
        kind: 'success',
        text: [
          `会创建 ${missing.length} 项（--dry-run，**未落盘**）：`,
          ...missing.map(([kind, target]) => `  · ${kind}  ${show(target)}`),
          '',
          `位置：${paths.base}`,
          '去掉 --dry-run 即落盘。',
        ].join('\n'),
      }
    }

    ensureLayout(root)

    return {
      kind: 'success',
      text: [
        `已初始化记忆库：${paths.base}`,
        '',
        `创建了 ${missing.length} 项：`,
        ...missing.map(([kind, target]) => `  · ${kind}  ${show(target)}`),
        '',
        '**`.gitignore` 已经排除派生数据**（`index/` / `ledger.jsonl` / `export/` / 遥测），',
        '记忆正文与回执会进 git —— 它们是仓库制品，不是缓存。',
        '',
        '下一步：memory_remember 写第一条 · /memory 看状态',
      ].join('\n'),
    }
  }

  function status(agent) {
    const root = resolveRoot(agent)
    if (!isInitialized(root)) return uninitialized(root)
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
    const root = resolveRoot(agent)
    if (!isInitialized(root)) return uninitialized(root)
    const proposals = readProposals(root)
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

  function recall(agent, query) {
    if (!query.trim()) return { kind: 'error', text: '用法：/memory recall <查询>' }
    const root = resolveRoot(agent)
    // **只读不建目录。** 上一版这里调 `ensureLayout` —— 一个纯查询会在仓库里
    // 写出 `.dsh-memory/` 骨架，和「`status` 不建」不对称。
    if (!isInitialized(root)) return { kind: 'error', text: uninitialized(root) }
    const { snapshot } = ensureSnapshot(root)
    const envelope = runRecall(query, snapshot, { limit: 3, config: configFor(agent) })
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
    if (!isInitialized(root)) return { kind: 'success', text: uninitialized(root) }
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

  /* ── 写：全部委托给 lib/host/mutations.js ─────────────────────── */

  const accept = (agent, proposalId) => toCommand(writes.accept(resolveRoot(agent), proposalId))

  const reject = (agent, proposalId) => toCommand(writes.reject(resolveRoot(agent), proposalId))

  const runDream = (agent) => toCommand(writes.dream(resolveRoot(agent)))

  /**
   * `/memory promote [--json] [--write] [--min <confidence>]`
   *
   * **只产出包，不写全局存储。** 全局那一层由别的插件负责 —— 这个命令
   * 只回答「哪些项目记忆换一个仓库还成立」，把决定权留给人。
   *
   * 旗标解析留在命令面（`--json` 是 shell 语法，不是领域概念）；
   * 生成逻辑在 `mutations.promote`。
   */
  function promote(agent, argument) {
    const root = resolveRoot(agent)
    if (!isInitialized(root)) return { kind: 'error', text: uninitialized(root) }
    const flags = new Set(argument.split(/\s+/u).filter((token) => token.startsWith('--')))
    const minMatch = /--min[=\s]+(\w+)/u.exec(argument)
    return toCommand(
      writes.promote(root, {
        json: flags.has('--json'),
        write: flags.has('--write'),
        ...(minMatch?.[1] ? { minConfidence: minMatch[1] } : {}),
      }),
    )
  }

  const retire = (agent, id) => toCommand(writes.retire(resolveRoot(agent), id))

  /**
   * `/memory reseed [--dry-run]`
   *
   * 哈希字段集变宽（0.1.1 的 `actionRisk`、0.3.3 的 `authority`）会让全部
   * 既有回执对不上。`receiptStatus` 把它们报成 `needs-reseed` 而不是
   * `tampered`，但**光诚实不够** —— 没有出口，那条警告就永不消失。
   *
   * 旗标解析留在命令面（`--dry-run` 是 shell 语法，不是领域概念）。
   */
  const reseed = (agent, argument) =>
    toCommand(writes.reseed(resolveRoot(agent), { dryRun: /--dry-run\b/u.test(argument) }))

  return {
    name: 'memory',
    description: '查看与裁决项目记忆库：状态、待决提案、直接召回、审计、生成推广包。',
    input: {
      hint: 'status | pending | accept <id> | reject <id> | recall <查询> | audit | dream | promote | retire <id> | reseed [--dry-run]',
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
          case 'init':
            return init(invocation?.agent, argument)
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
          case 'promote':
            return promote(invocation?.agent, argument)
          case 'retire':
            if (!argument) return { kind: 'error', text: '用法：/memory retire <id>' }
            return retire(invocation?.agent, argument)
          case 'reseed':
            return reseed(invocation?.agent, argument)
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
