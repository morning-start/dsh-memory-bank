/**
 * host / client 共用的 RPC 契约。
 *
 * ## 为什么单一事实源在这里，而不是两边各写一份
 *
 * 0.1.1 刚修完一类 bug：`gateQuota` 用黑名单、`activeEntries` 用白名单，
 * 两边对不上，于是「活跃条目」在两个地方是两个集合。**同一个错误不要再犯第二次。**
 *
 * 客户端拿不到这个模块 —— `client/client.js` 是 `window.__ModuleLoader__`
 * 加载**自包含脚本**，`require` 只能解析平台种子表里的包，不能 `import './x.js'`。
 * 所以客户端里必然有一份字符串副本。防漂移的办法不是「记得同步」，
 * 而是 `test/endpoints.test.mjs`：它逐条比对这里的常量和 `client/client.js`
 * 里的字面量，**少一条就红**。
 *
 * ## 命名规则（已从宿主源码坐实）
 *
 * 线上方法名 = `<namespace>/<method>`，`namespace` 默认取 Cordis 服务键
 * （`dsh-typert-protocol/lib/index.js:329` 的 `options.namespace ?? serviceKey`）。
 * 所以 `super(ctx, 'memoryBank')` + `async overview()` → `memoryBank/overview`，
 * 客户端经 `ctx.remote.memoryBank.overview()` 调用。
 *
 * 命名空间段必须匹配 `/^[A-Za-z0-9_$.-]+$/` 且不是 `.` / `..`
 * （`dsh-typert-protocol/lib/index.js:306-311`）。`memoryBank` 合法。
 */

/** Cordis 服务键 == 线上命名空间。**改它等于换一份协议。** */
export const NAMESPACE = 'memoryBank'

/**
 * 只读查询。**必须复用现有实现，不许重写过滤条件**（见 `lib/host/queries.js`）。
 *
 * 每一项的 `args` 是客户端传的参数数组（JSON 编码，原样过线）。
 */
export const QUERIES = Object.freeze({
  /** 健康概览：一行数字，界面 2 的顶部。 */
  overview: Object.freeze({ method: 'overview', args: [] }),
  /** 待决提案列表。`limit` 默认 10，范围 1-50。 */
  pending: Object.freeze({ method: 'pending', args: ['limit'] }),
  /** 记忆检索。`query` 为空串时退化为「最近的条目」。 */
  memories: Object.freeze({ method: 'memories', args: ['query', 'limit'] }),
  /** 漂移三桶：quarantined / advisory / unsafePath。 */
  drift: Object.freeze({ method: 'drift', args: [] }),
  /** 断言对账：open / contradicted / unverified。 */
  claims: Object.freeze({ method: 'claims', args: [] }),
  /** 审计时间线（ledger 尾部）。 */
  ledger: Object.freeze({ method: 'ledger', args: ['limit'] }),
  /** 四层配置快照 + 每个字段的来源/可写性（界面 1 的数据源）。 */
  config: Object.freeze({ method: 'config', args: [] }),
  /** 项目层配置（界面 3 的抽屉）。 */
  projectConfig: Object.freeze({ method: 'projectConfig', args: [] }),
})

/**
 * 写操作。**每一个都必须走 `lib/host/mutations.js` 的共享实现**，
 * 而那个实现同时被 `/memory` 命令面调用 —— 两条路径不许各写一份。
 */
export const MUTATIONS = Object.freeze({
  /** 接受一条待决提案。 */
  accept: Object.freeze({ method: 'accept', args: ['id'] }),
  /** 拒绝一条待决提案（进 `pending/rejected/` 留档）。 */
  reject: Object.freeze({ method: 'reject', args: ['id', 'reason'] }),
  /** 编辑后接受。`patch` 只认内容字段。 */
  edit: Object.freeze({ method: 'edit', args: ['id', 'patch'] }),
  /** 退休一条记忆（软删除）。 */
  retire: Object.freeze({ method: 'retire', args: ['id', 'reason'] }),
  /** 永久删除。**必须 `confirm: true`** —— 破坏性操作不能靠默认值发生。 */
  forget: Object.freeze({ method: 'forget', args: ['id', 'confirm'] }),
  /** 跑一次 dream pass 并暂存提案（**不改记忆**）。 */
  dream: Object.freeze({ method: 'dream', args: [] }),
  /** 生成可推广到全局记忆的包（**只产出，不写全局存储**）。 */
  promote: Object.freeze({ method: 'promote', args: ['options'] }),
  /** 写项目层（`<repo>/.dsh-memory/config.json`）。只认仓库属性。 */
  setProjectConfig: Object.freeze({ method: 'setProjectConfig', args: ['patch'] }),
  /** 重置项目层（清空仓库级覆盖）。 */
  resetProjectConfig: Object.freeze({ method: 'resetProjectConfig', args: [] }),
})

/** 全部方法（宿主注册时按这个顺序，测试也按它比对）。 */
export const METHODS = Object.freeze([
  ...Object.values(QUERIES).map((entry) => entry.method),
  ...Object.values(MUTATIONS).map((entry) => entry.method),
])

/**
 * 线上方法名。客户端用 `ctx.remote.memoryBank[method]` 调。
 *
 * @param {string} method
 * @returns {string} `<namespace>/<method>`
 */
export function wireName(method) {
  return `${NAMESPACE}/${method}`
}

/**
 * 配置层的名字。界面上的来源徽标直接用它，**不要在组件里再写一份中英对照**。
 * @type {ReadonlyArray<{ id: string, zh: string, en: string, tone: string }>}
 */
export const SOURCES = Object.freeze([
  { id: 'default', zh: '默认值', en: 'Default', tone: 'muted' },
  { id: 'project', zh: '项目配置', en: 'Project', tone: 'info' },
  { id: 'env', zh: '环境变量', en: 'Environment', tone: 'warning' },
  { id: 'row', zh: '部署配置', en: 'Deployment', tone: 'danger' },
])

/**
 * 十道门 → 一句人话：「为什么没过」+「改哪里能过」。
 *
 * 「审核中」是**没有信息量**的说法。用户要知道改哪里才能让这条过去 ——
 * 这正是这一版界面比 `/memory pending` 强的地方。
 *
 * 门名与裁决来自 `docs/03-审核协议.md:73-81` 与 `lib/gate.js` 的
 * `HARD_GATES`（`G1 G2 G3 G3b G4 G5 G7` 是硬门，不可 DEFER）。
 * **顺序是协议里的顺序**，界面直接按它排。
 */
export const GATE_HINTS = Object.freeze({
  G1: {
    name: { zh: '归属门', en: 'Ownership' },
    decision: 'REJECT',
    hint: '正文提到了锚点，但 `scope` 为空，判据 3–5 全部落空。补一个 `scope: ["repo:..."]` 就能过。',
  },
  G2: {
    name: { zh: '形态门', en: 'Shape' },
    decision: 'REJECT',
    hint: '正文缺少六要素模板里的标题。缺一个就 refuse —— 按 `template` 把标题补齐。',
  },
  G2b: {
    name: { zh: '草稿门', en: 'Draft' },
    decision: 'DEFER',
    hint: '草稿值得记，只是正文里还有没填的占位符。补完内容再提交。',
  },
  G3: {
    name: { zh: '安全门', en: 'Secret' },
    decision: 'REJECT',
    hint: '正文命中密钥规则。**不要编辑成能过扫描的样子** —— 把那段凭据删掉。',
  },
  G3b: {
    name: { zh: '注入门', en: 'Injection' },
    decision: 'REJECT',
    hint: '正文里有「指挥宿主」的句子。**改写成人话**，不要写成命令 —— 这道门不可 DEFER。',
  },
  G4: {
    name: { zh: '证据门', en: 'Evidence' },
    decision: 'REJECT',
    hint: '证据锚点解析不到。检查路径和行号，或者换成一条可复核的命令。',
  },
  G5: {
    name: { zh: '重复门', en: 'Duplicate' },
    decision: 'REJECT',
    hint: '已经有一条近重复的记忆。用 `supersedes` 指过去，或者放弃这条。',
  },
  G6: {
    name: { zh: '冲突门', en: 'Conflict' },
    decision: 'DEFER',
    hint: '与已有记忆矛盾。「谁对」是人的判断 —— 先裁决哪一条对。',
  },
  G7: {
    name: { zh: '配额门', en: 'Quota' },
    decision: 'REJECT',
    hint: '记忆库到硬上限了。最弱候选已经列在详情里 —— 退休一条再加。',
  },
  G8: {
    name: { zh: '置信门', en: 'Confidence' },
    decision: 'DEFER',
    hint: '分数低于自动落盘地板。补证据、补 scope，或者等人工裁决。',
  },
})

