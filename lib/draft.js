/**
 * 正文起草：把「值得记的那件事」变成一条**能过门**的记忆。
 *
 * 两种实现，默认 `template`：
 *
 *   template  纯确定性，从这一轮的真实内容里能填的就填，填不了的留占位符。
 *             占位符会被 G2b 拦住变成 DEFER —— 自动捕获产出的是**草稿**。
 *
 *   subagent  在**后台**（drain 里，不在 turn-stopping 上）跑一个子 Agent 把
 *             六要素填实。产出仍然要过十道门，只是从「草稿」变成「成稿」。
 *
 * 为什么子 Agent 只能在 drain 里跑，不能在 hook 里：
 *   `agent/turn-stopping` 是宿主 **await** 的路径。在它里面 spawn 一个子 Agent
 *   等于让用户多等一次完整的模型往返（秒级），比同步重建索引（105 ms）还糟。
 *   放后台就没有这个问题 —— 用户看不到这段延迟。
 *
 * 为什么默认关：
 *   每条记忆一次模型调用是真实的钱和真实的时间。绝大多数捕获（S1 显式指令、
 *   S2 纠错）用确定性模板就够了，剩下的本来就该人来裁。
 *   打开它意味着「我愿意为自动成稿付钱」，这是一个**用户决定**，不是默认值。
 */

import { buildCandidate, placeholder, placeholderSections } from './capture.js'
import { collapse } from './util.js'

/** 六要素的输出契约。子 Agent 必须返回这六个字段。 */
const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    when: { type: 'string' },
    components: { type: 'string' },
    how: { type: 'string' },
    verify: { type: 'string' },
    unless: { type: 'string' },
  },
  required: ['name', 'when', 'components', 'how', 'verify', 'unless'],
}

/** 缺字段时补的占位符文案（与 `capture.buildCandidate` 同源）。 */
const SECTION_PLACEHOLDER = {
  name: '功能名',
  when: '什么情况下适用',
  components: '改了哪些东西',
  how: '怎么做',
  verify: '怎么确认它还是对的',
  unless: '什么时候它不管用',
}

function renderPrompt(facts, hit, template) {
  const userText = collapse(facts.userTexts.join('\n'))
  const assistantText = collapse(facts.assistantTexts.join('\n'))
  return [
    '你在为项目的长期记忆起草一条条目。只输出六要素的正文段，不要解释、不要客套。',
    '',
    '## 这一轮发生了什么',
    `触发信号：${hit.id}（${hit.kind}）`,
    '',
    '### 用户说',
    userText || '（无）',
    '',
    '### 助手最后回答',
    assistantText || '（无）',
    '',
    '### 改过的文件',
    facts.editedFiles.length > 0 ? facts.editedFiles.map((file) => `- ${file}`).join('\n') : '（无）',
    '',
    '### 跑过的命令',
    facts.successedCommands?.length > 0
      ? facts.succeededCommands.map((item) => `- ${item.name}`).join('\n')
      : '（无）',
    '',
    '## 要求',
    '- 只写这一轮**真实发生过**的事，不要推断、不要编造路径或命令。',
    '- `unless`（不适用条件）写这一轮**确实观察到**的边界；没观察到就写「未发现例外」。',
    '- 每一段一句话到三句话，具体到能被人验证。',
    '',
    '## 当前草稿（可参考，不要照抄占位符）',
    template.body,
  ].join('\n')
}

/**
 * 创建起草器。返回 `draft({ facts, hit, id, signal })` →
 * `{ candidate, draftedBy: 'template' | 'subagent' }`。
 *
 * **永不抛**：任何失败都回退到模板草稿 —— 一条填不满的记忆仍然值得进待决队列，
 * 而一次起草失败绝不能吞掉捕获。
 */
export function createDrafter({ ctx, getConfig, log }) {
  let warned = false

  return async function draft({ facts, hit, id, signal }) {
    const template = buildCandidate(facts, hit, { id })
    // `capture.draft` 是**仓库属性** —— 同一个 profile 下不同仓库可以不同，
    // 所以每次按 live Agent 现取，不用 apply() 时的快照。
    const agent = facts.agent
    const cfg = getConfig?.(agent) ?? {}
    if (cfg?.capture?.draft !== 'subagent') return { candidate: template, draftedBy: 'template' }

    const subagent = ctx?.subagent
    if (!subagent?.startActivation || !agent) {
      if (!warned) {
        warned = true
        log?.('capture.draft=subagent 但子 Agent 服务不可用，回退模板草稿')
      }
      return { candidate: template, draftedBy: 'template' }
    }

    let activation
    try {
      activation = await subagent.startActivation({
        provider: cfg.capture.draftProvider ?? 'in-process',
        label: `memory-draft-${hit.id}`,
        parent: agent,
        prompt: [{ type: 'text', text: renderPrompt(facts, hit, template) }],
        outputSchema: DRAFT_SCHEMA,
        delivery: 'caller',
        signal: signal ?? new AbortController().signal,
      })
    } catch (error) {
      log?.(`起草子 Agent 启动失败，回退模板：${error?.message ?? error}`)
      return { candidate: template, draftedBy: 'template' }
    }

    try {
      const result = await activation.result
      const structured = result?.structured
      if (!structured || typeof structured !== 'object') {
        log?.(`起草子 Agent 未返回结构化结果（stopReason=${result?.stopReason}），回退模板`)
        return { candidate: template, draftedBy: 'template' }
      }

      const sections = Object.fromEntries(
        Object.entries(structured).map(([key, value]) => [key, collapse(String(value ?? ''))]),
      )
      // 子 Agent 也可能只填一部分。**缺哪段补哪段的占位符** ——
      // 用模板里的通用文本去填，等于把「我不知道」写成一句看起来像事实的话，
      // 而 G2b 存在的全部意义就是不让那件事发生。
      for (const key of DRAFT_SCHEMA.required) {
        if (!sections[key]) sections[key] = placeholder(SECTION_PLACEHOLDER[key] ?? key)
      }

      const body = [
        '# 功能名',
        sections.name,
        '',
        '# 生效条件',
        sections.when,
        '',
        '# 子功能',
        sections.components,
        '',
        '# 执行',
        sections.how,
        '',
        '# 验证方式',
        sections.verify,
        '',
        '# 不适用条件',
        sections.unless,
      ].join('\n')

      const remaining = placeholderSections(body)
      if (remaining.length > 0) {
        log?.(`起草子 Agent 留下了 ${remaining.length} 处占位符，按草稿处理`)
      }

      return { candidate: { ...template, body }, draftedBy: 'subagent' }
    } catch (error) {
      log?.(`起草子 Agent 失败，回退模板：${error?.message ?? error}`)
      return { candidate: template, draftedBy: 'template' }
    } finally {
      try {
        await activation.dispose()
      } catch {
        /* 释放失败不影响已拿到的结果 */
      }
    }
  }
}

export { DRAFT_SCHEMA }
