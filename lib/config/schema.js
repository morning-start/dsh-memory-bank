/**
 * `Config` schema —— 配置面的**单一事实源**。
 *
 * host 平面（校验、默认值回退、UI 表单）与设计文档都从这里取字段，
 * 不许在别处再写一份。
 *
 * ## 为什么每个顶层分组都标 `.volatile()`
 *
 * **不标 = 整张表单只读，而且宿主不会告诉你为什么。**
 *
 * 宿主的 `volatileForm(schema)`（`@deepseek-ai/dsh-settings`）只把
 * `meta.volatile` 的字段放进可编辑表单；一个都没标时它返回 `undefined`，
 * 设置页直接拒绝打开（`'Plugin entry "<ns>" has no volatile fields'`）。
 *
 * 标在**顶层分组对象**上就会递归生效（`volatileForm` 遇到 volatile 节点直接
 * `plainSchema` 整棵子树），所以最小改动是给 11 个顶层键各加一次 `.volatile()`。
 * 实测：`volatileForm(Config) !== undefined`，且 `isVolatilePath` 对任意
 * 字段路径都返回 `true`。
 *
 * 副作用（必须知道）：schema 解析出的值里，这些键变成 cosmokit 的
 * `Volatile<T>` 引用（只读快照，用 `.get()` 取）。所以 `apply()` 拿到的
 * `config` **必须先过 `plainConfig()`**，否则 `deepMerge` 会把一个引用对象
 * 当成普通对象合并 —— 结果是一个空对象，全部字段静默丢成默认值。
 * `lib/config/index.js` 的 `plainConfig` 就是干这个的。
 *
 * ## 为什么 schema 里不填 `.default()`
 *
 * 见 `defaults.js` 文件头：默认值与「用户显式配置」无法区分，会在解析时
 * 永久遮蔽环境变量回退。类型/范围在这里校验，默认值与回退只在 `defaults.js`。
 */

import z from '@deepseek-ai/schemastery'

/**
 * 界面上的六个分组。
 *
 * `keys` 是对应到 `Config` 顶层键的路径（`thresholds.content` 这种嵌套用
 * `parent.child` 表示）。分组的顺序就是界面上的顺序。
 */
export const GROUPS = Object.freeze([
  {
    id: 'autonomy',
    label: { zh: '自主度', en: 'Autonomy' },
    description: { zh: 'Agent 能自己决定多少。这一项决定其他所有阈值的**上限**。', en: 'How much the agent may decide on its own.' },
    keys: ['autonomy'],
  },
  {
    id: 'thresholds',
    label: { zh: '审核阈值', en: 'Gate thresholds' },
    description: { zh: '十道门的数值判据。默认值来自实测语料，改之前先跑 `bench/g1-eval.mjs`。', en: 'Numeric criteria of the ten gates.' },
    keys: ['thresholds'],
  },
  {
    id: 'capture',
    label: { zh: '捕获', en: 'Capture' },
    description: { zh: '什么时候自动把一轮对话变成候选记忆。', en: 'When a turn becomes a candidate memory.' },
    keys: ['capture'],
  },
  {
    id: 'recall',
    label: { zh: '召回', en: 'Recall' },
    description: { zh: '每步注入多少上下文。**这是每轮都付的 token 成本。**', en: 'How much context is injected per step.' },
    keys: ['recall'],
  },
  {
    id: 'quota',
    label: { zh: '配额', en: 'Quota' },
    description: { zh: '记忆库的硬上限与棘轮切换点。', en: 'Hard limit and ratchet switch point.' },
    keys: ['quota'],
  },
  {
    id: 'advanced',
    label: { zh: '高级', en: 'Advanced' },
    description: { zh: '六要素模板、根目录、密钥规则、语义通道。改错会静默降级。', en: 'Templates, root directory, secret rules, semantic channel.' },
    keys: ['root', 'template', 'safety', 'conflict', 'promote', 'embedding'],
  },
])

const D = (zh, en) => ({ zh, en })

export const Config = z.object({
  root: z
    .string()
    .description('记忆库的项目根目录（绝对路径）；默认取会话工作目录，可被 DSH_MEMORY_ROOT 回退覆盖')
    .volatile(),
  autonomy: z
    .union([z.const('manual'), z.const('balanced'), z.const('autonomous')])
    .description('自主度：manual（全靠确认）/ balanced（默认，高置信自动）/ autonomous（全自动）')
    .volatile(),
  thresholds: z
    .object({
      autoAcceptFloor: z.number().min(0).max(1).step(0.01).description('自动落盘的置信地板；默认 0.60'),
      deferFloor: z.number().min(0).max(1).step(0.01).description('低于这个值直接丢弃、不建提案；默认 0.35'),
      duplicate: z.number().min(0).max(1).step(0.01).description('近重复相似度阈值；默认 0.82'),
      coverageFloor: z.number().min(0).max(1).step(0.01).description('覆盖门地板；默认 0.45'),
      contentTier: z.number().min(0).max(1).step(0.01).description('content 档的 gate 分数门槛；默认 0.85'),
      exactAnchorContent: z.number().min(0).max(1).step(0.01).description('单 token 符号查询的豁免门槛；默认 0.5'),
      // **四道门的分类型阈值**。`defaultConfig()` 里一直有它，而 schema 里没有 ——
      // 于是用户在行配置里写 `thresholds.content.natural` 会被 schemastery 直接丢掉，
      // 而且不会有任何提示。
      content: z
        .object({
          identifier: z.number().min(0).max(1).step(0.01).description('查询像标识符（`foo.bar`）时的门槛'),
          path: z.number().min(0).max(1).step(0.01).description('查询像文件路径时的门槛'),
          error: z.number().min(0).max(1).step(0.01).description('查询像报错信息时的门槛'),
          natural: z.number().min(0).max(1).step(0.01).description('自然语言查询的门槛（未列出的标签回退到这里）'),
          decision: z.number().min(0).max(1).step(0.01).description('决策型查询的门槛'),
          mixed: z.number().min(0).max(1).step(0.01).description('混合型查询的门槛'),
        })
        .description('按查询分类的相关性门槛；未列出的标签回退 natural'),
    })
    .description('审核与召回阈值')
    .volatile(),
  template: z
    .array(z.string())
    .description('六要素标题（缺一个 → G2 refuse）；默认「功能名 / 生效条件 / 子功能 / 执行 / 验证方式 / 不适用条件」')
    .volatile(),
  safety: z
    .object({
      forbidden: z.array(z.string()).description('G3 的**附加**密钥规则（正则字符串）；**只增不减**，不会替换内置规则表'),
    })
    .description('安全门附加规则')
    .volatile(),
  conflict: z
    .object({
      semantic: z.boolean().description('G6 是否启用语义冲突检测（需要语义通道开着才有意义）；默认 false'),
    })
    .description('冲突门')
    .volatile(),
  quota: z
    .object({
      repo: z.number().min(1).step(1).description('项目层硬上限；默认 200'),
      growthThreshold: z.number().min(1).step(1).description('growth → ratchet 的切换点；默认 50'),
    })
    .description('配额棘轮（**只有项目层** —— 本插件不做全局记忆）')
    .volatile(),
  capture: z
    .object({
      enabled: z.boolean().description('是否启用自动捕获；默认 true'),
      mode: z.union([z.const('strict'), z.const('steady')]).description('信号窗口：strict 只看当前轮（默认）/ steady 看最近几轮'),
      draft: z
        .union([z.const('template'), z.const('subagent')])
        .description('正文起草：template 纯确定性（默认，填不满留占位符 → DEFER）/ subagent 后台跑一次模型'),
      draftProvider: z.string().description('draft=subagent 时使用的子 Agent provider；默认 in-process'),
      // S7 是「显式工具调用」的来源标签（`memory_remember` 自己打上的），
      // **不是可检测的捕获信号** —— 它没有可从事件里判定的形态。
      signals: z.array(z.string()).description('启用的捕获信号 S1–S6；默认全部。S7 由 memory_remember 直接标注，不在此列'),
    })
    .description('捕获')
    .volatile(),
  recall: z
    .object({
      inject: z.boolean().description('是否在每步注入召回结果；默认 true'),
      maxBytes: z.number().min(100).step(1).description('注入预算（字节）；默认 4000'),
      maxPointers: z.number().min(1).max(10).step(1).description('指针档最多几条；默认 3'),
    })
    .description('召回')
    .volatile(),
  promote: z
    .object({
      format: z
        .union([z.const('markdown'), z.const('json'), z.const('both')])
        .description('推广包格式；默认 both'),
      minConfidence: z
        .union([z.const('verified'), z.const('inferred'), z.const('stale')])
        .description('进入推广包的置信地板；默认 verified'),
      includeProjectSpecific: z
        .boolean()
        .description('是否把「证据全指向项目内路径」的条目也放进包（会标注）；默认 true'),
    })
    .description('推广到全局记忆：**只产出包，不写全局存储**')
    .volatile(),
  embedding: z
    .object({
      provider: z
        .union([z.const('none'), z.const('lexical'), z.const('http')])
        .description('none（默认，关闭）/ lexical（本地确定性，实测不足以做 G1 判决）/ http（OpenAI 兼容 /embeddings）'),
      model: z.string().description('http provider 的模型名；默认 text-embedding-3-small'),
      endpoint: z.string().description('http provider 的 /embeddings 地址；不填则降级为关闭'),
      timeoutMs: z.number().min(100).step(1).description('单次调用超时；默认 10000'),
      g1Threshold: z
        .number()
        .min(0)
        .max(1)
        .description('G1 用余弦判决的阈值；**null = 不参与判决**（只做诊断）。开闸前先跑 bench/embedding-experiment.mjs'),
    })
    .description('语义通道；**默认关**')
    .volatile(),
})

/** 哪些顶层键属于「仓库属性」而不是「用户偏好」（界面 3 的边界）。 */
const PROJECT_TOP_KEYS = new Set(['capture', 'quota', 'template', 'safety'])

/**
 * 把 schema 摊平成 UI 可直接渲染的字段描述表。
 *
 * 为什么不让客户端自己读 schema：客户端**不能** `require('@deepseek-ai/*')`
 * （`practices.md:35`），也拿不到服务端的 ESM 模块。所以描述表由 host 算好，
 * 走 RPC 一次性推给界面 —— 字段、默认值、来源、可写性全部算在同一处。
 *
 * 返回的每一项：
 * ```
 * { path, group, type, enum?, min?, max?, step?, itemType?, description }
 * ```
 * `path` 是点分路径（`thresholds.content.natural`），界面上用它来定位控件。
 */
export function describeFields() {
  /** @type {Map<string, string>} 顶层键 → 分组 id */
  const groupOf = new Map()
  for (const group of GROUPS) {
    for (const key of group.keys) groupOf.set(key.split('.')[0], group.id)
  }

  /** @type {Array<Record<string, unknown>>} */
  const fields = []

  const walk = (schema, path, topKey) => {
    const meta = schema?.meta ?? {}
    const description = meta.description
    const node = {
      path,
      group: groupOf.get(topKey) ?? 'advanced',
      top: topKey,
      type: schema?.type ?? 'unknown',
      description: typeof description === 'string' ? description : (description?.zh ?? ''),
      projectScoped: PROJECT_TOP_KEYS.has(topKey),
      hidden: meta.hidden === true,
    }
    if (meta.min !== undefined) node.min = meta.min
    if (meta.max !== undefined) node.max = meta.max
    if (meta.step !== undefined) node.step = meta.step
    if (meta.role !== undefined) node.role = meta.role

    // 枚举：schema.toJSON() 对 union-of-const 不保留 value，只能从源码侧的
    // `dict`/`list` 拿。schemastery 的 union 在这里表现为 type 'union' + list。
    if (schema?.type === 'union') {
      const values = (schema.list ?? [])
        .map((item) => item?.value ?? item?.meta?.default)
        .filter((value) => value !== undefined)
      if (values.length > 0) node.enum = values
    }
    if (schema?.type === 'array') {
      node.itemType = schema.inner?.type ?? 'unknown'
      if (schema.inner?.meta?.min !== undefined) node.itemMin = schema.inner.meta.min
    }

    // 对象分组本身不是控件，但它的子字段是。叶子才收进表单。
    const children = schema?.type === 'object' ? Object.entries(schema.dict ?? {}) : []
    if (children.length === 0) {
      fields.push(node)
      return
    }
    node.children = children.map(([key]) => `${path}.${key}`)
    fields.push(node)
    for (const [key, child] of children) walk(child, `${path}.${key}`, topKey)
  }

  for (const [key, schema] of Object.entries(Config.dict ?? {})) {
    walk(schema, key, key)
  }

  return { groups: GROUPS, fields }
}

export { PROJECT_TOP_KEYS }
export { D as bilingual }
