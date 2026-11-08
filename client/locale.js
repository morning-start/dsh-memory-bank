/**
 * `memoryBank` 命名空间的页面文案。
 *
 * ## 为什么放在 bundle 里，而不是 `locale/*.json`
 *
 * `locale/<lang>.json` 是插件**清单元数据**（插件卡片上的标题与简介），由
 * Loader 读；这里是**页面内文案**，由 `ctx.locale.register()` 装进宿主 locale
 * 服务。两者是两条独立的路，只能手工保持一致（`.tmp-api/CONTRACT.md` §6.3）。
 * 本文件的 `configTitle` 与 `locale/zh.json` 的 `meta.title` 必须同字。
 *
 * ## 为什么中英必须键集合一致
 *
 * 少一条时 `t()` 会**静默回退成键名**（`dsh-client-locale/lib/client.js:1424`
 * 的 `?? key`）—— 界面上出现 `saveFailed` 这种字面量，没有任何报错。
 * `test/client.test.mjs` 逐键比对两份字典，少一条就红。
 */

/** 本插件拥有的字典命名空间。改它等于换一份协议。 */
const NS = 'memoryBank'

/** 英文文案。 */
const en = {
  // ---- 注册项标题（宿主用于导航行 / 卡片标题）----
  configTitle: 'Memory bank',
  panelTitle: 'Memory',

  // ---- 插件卡片 ----
  cardSummary:
    'Project-scoped memory: the agent decides what is worth remembering, ten gates review every write, and anything the protocol cannot settle is handed to you as a proposal.',
  configSummary: 'Autonomy, gate thresholds, capture and recall for the memory bank.',

  // ---- 通用 ----
  loading: 'Loading…',
  reload: 'Refresh',
  close: 'Close',
  cancel: 'Cancel',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  reset: 'Reset to default',
  retry: 'Retry',
  code: 'code',
  addItem: 'Add one',
  removeItem: 'Remove {item}',
  invalidNumber: 'must be a number',

  // ---- 来源徽标 ----
  'source.default': 'Default',
  'source.project': 'Project',
  'source.env': 'Environment',
  'source.row': 'Deployment',
  sourceLabel: 'Source',

  // ---- 作用域提示条 ----
  scopeIntro:
    'Configuration resolves in four layers; the badge on each field is where that value comes from:',
  scopeOrder: 'Deployment > Environment > Project > Default',
  scopeNote:
    'Fields that come from a layer above the project are locked — editing them here has no effect, and the badge tells you where to change them.',
  /**
   * 行配置页的只读说明。
   *
   * 这一页的语义是**部署配置层**（`cordis.patch.yml` 的 `config:`），
   * 而插件只有一个写入口：项目层（`<repo>/.dsh-memory/config.json`）。
   * 在这一页保存会把部署配置**静默写进仓库**、来源徽标当场翻层 —— 所以这一页
   * 只读，写明正确的改法。
   */
  rowConfigReadOnlyTitle: '这一页只读：它显示的是部署配置层',
  rowConfigReadOnlyBody:
    '这一层来自 profile 的 cordis.patch.yml（插件行 config），改它要编辑那个文件并重启宿主。仓库级的配置请到「设置 → 插件 → 记忆库 → 配置」改 —— 那才是写进 .dsh-memory/config.json 的那一层。',

  // ---- 字段 ----
  defaultValue: 'default {value}',
  lockedByEnv: 'Set by an environment variable; editing it here has no effect.',
  lockedByRow: 'Set by the deployment; editing it here has no effect.',
  lockedGeneric: 'Overridden by a higher layer; editing it here has no effect.',
  choiceDefault: 'default',
  advancedThresholds: 'Advanced: per-query-type thresholds',
  advancedCount: '{count} fields',

  // ---- 自主度选项（设计稿定死的三张卡）----
  autonomyTitle: 'Autonomy',
  'autonomy.manual': 'Manual',
  'autonomy.manualDesc':
    'Written only when you say “remember this”. For repositories where every word is a promise.',
  'autonomy.balanced': 'Balanced',
  'autonomy.balancedDesc':
    'Written when a capture signal fires; below the confidence floor it becomes a pending proposal. The everyday choice.',
  'autonomy.autonomous': 'Autonomous',
  'autonomy.autonomousDesc':
    'Judges and writes on its own, and only asks when two memories conflict. For long-running experiment branches.',

  // ---- 语义通道（未开闸）----
  semanticTitle: 'Semantic channel',
  semanticLocked: 'Not opened',
  semanticReason:
    'The switch is not missing — the gate is shut: the measured channel separation is only +0.063, short of the 0.15 threshold for starting work.',
  semanticHowTo:
    'Run `node bench/embedding-experiment.mjs` and come back once it reports ≥ 0.15.',
  semanticValue: 'embedding.provider = {value}',

  // ---- 保存条 ----
  dirtyCount: '{count} changed',
  noChanges: 'No changes',
  saveNote: 'Saved to {path}; it goes into git and rides along with PR review.',
  saveFailed: 'The deployment rejected these values.',
  saveRejected: 'Rejected: {message}',

  // ---- 项目配置读取问题（types.d.ts 要求界面必须显示）----
  problemsTitle: 'The project configuration has problems',
  loadFailed: 'Could not read the configuration: {message}',

  // ---- 项目配置抽屉 ----
  drawerTitle: 'Project configuration',
  drawerSub: 'Applies to this repository only',
  drawerNotice:
    'These fields go into git and ride along with PR review. They are team consensus, not personal preference.',
  drawerInherit: 'The other {count} fields live under Plugins → Memory bank → Configure',
  drawerOpen: 'Project configuration',
  drawerFooter: 'Written back to config.json and takes effect immediately',
  drawerSaveFailed: 'Could not write the project configuration: {message}',

  // ---- 记忆面板：健康概览 ----
  'health.active': 'Active',
  'health.pending': 'Pending',
  'health.drift': 'Drift',
  'health.quota': 'Quota',
  'health.open': 'open {open} (actionable {actionable})',
  'health.contradicted': 'contradicted {count}',
  'health.dormant': 'dormant {count}',
  'health.reviewDue': 'due {count}',
  'health.expired': 'expired {count}',
  'health.inbox': 'queued {count}',
  'health.problems': 'bad files {count}',
  panelSub: 'Health and pending queue of the memory bank for this repository.',
  rootFallback: 'wrong directory',
  rootFallbackHint:
    'The panel has no session working directory, so it reads the process cwd — that is not your repository and will always be empty. Run one tool call in the session, or set DSH_MEMORY_ROOT.',

  // ---- 未初始化 ----
  //
  // 「0 条」和「没装过」是两件不同的事：前者是结论，后者是**还没开始**。
  // 混在一起用户会以为记忆坏了。未初始化状态下这一栏只有一个动作。
  //
  // **文案里不写反引号。** 这些是**纯文本**，反引号会照原样显示 ——
  // 0.4.x 的界面上就真的显示成了「` .dsh-memory/ `」。要不要等宽由渲染端
  // 决定，不靠 Markdown 语法。
  uninitializedTitle: 'This repository has no memory bank yet',
  uninitializedDesc:
    'Automatic capture and recall injection stay off until .dsh-memory/ exists — nothing has been written behind your back.',
  uninitializedCreates: 'Initializing creates',
  uninitializedExtras: 'plus an empty config.json, a receipt store and .gitignore.',
  uninitializedIdempotent: 'Idempotent: existing files are never touched.',
  uninitializedAction: 'Initialize memory bank',
  uninitializedDone: 'Memory bank initialized. Automatic capture and recall are now on.',

  // ---- 记忆面板：tab ----
  'tab.pending': 'Pending',
  'tab.memories': 'Memories',
  'tab.drift': 'Drift',
  'tab.ledger': 'Audit',

  // ---- 待决 ----
  pendingEmptyTitle: 'No pending proposals.',
  pendingEmptyDesc: 'Anything the protocol cannot settle shows up here.',
  pendingWhy: 'Why is the queue backing up?',
  pendingWhyHint: 'Lower the auto-accept floor, or switch to another autonomy level.',
  pendingAccept: 'Accept',
  pendingEdit: 'Edit',
  pendingReject: 'Reject',
  pendingWeights: 'Confidence {value}',
  pendingUnknownWeight: 'confidence unknown',
  pendingEditTitle: 'Title',
  pendingEditSave: 'Save and accept',
  pendingRejectReason: 'Reason (archived under pending/rejected/)',
  pendingConfirmReject: 'Confirm reject',
  pendingBusy: 'Working…',

  // ---- 记忆列表 ----
  memorySearchPlaceholder: 'Search memories (blank lists the most recent)',
  memorySearch: 'Search',
  memoryEmpty: 'No matching memories.',
  memoryLoading: 'Searching…',
  memoryRecalled: 'recalled {count}×',
  memoryNeverRecalled: 'never recalled',
  memoryRetire: 'Retire',
  memoryRetireReason: 'Retirement reason',
  memoryConfirmRetire: 'Confirm retirement',
  memoryForget: 'Delete permanently',
  memoryForgetConfirm: 'Click again to delete permanently',
  memoryUpdated: 'updated {when}',

  // ---- 漂移 ----
  driftEmpty: 'Every anchor is healthy ({count} checked).',
  driftAnchors: 'Anchors',
  driftDetail: 'Detail',

  // ---- 审计 ----
  ledgerEmpty: 'The audit log is still empty.',
  ledgerDecision: 'decision {value}',

  // ---- 状态 / 类型 / 桶 / 账本 ----
  'status.active': 'active',
  'status.dormant': 'dormant',
  'status.expired': 'expired',
  'status.retired': 'retired',
  'status.unknown': 'unknown',
  'kind.candidate': 'candidate',
  'kind.merge': 'merge',
  'kind.edge': 'edge',
  'kind.cluster': 'cluster',
  'kind.core': 'core',
  'kind.unknown': 'other',
  'bucket.quarantined': 'Quarantined',
  'bucket.advisory': 'Advisory',
  'bucket.unsafePath': 'Unsafe path',
  'ledger.attempt': 'attempt',
  'ledger.resolve': 'settled',
  'ledger.dreamAccept': 'dream accepted',
  'ledger.discard': 'discarded',
  'ledger.other': 'other',

  // ---- 十道门的名字（文案与 shared/endpoints.js 的 GATE_HINTS[*].name.en 同字）----
  'gate.G1': 'Ownership',
  'gate.G2': 'Shape',
  'gate.G2b': 'Draft',
  'gate.G3': 'Secret',
  'gate.G3b': 'Injection',
  'gate.G4': 'Evidence',
  'gate.G5': 'Duplicate',
  'gate.G6': 'Conflict',
  'gate.G7': 'Quota',
  'gate.G8': 'Confidence',

  // ---- 相对时间 ----
  'time.justNow': 'just now',
  'time.minutesAgo': '{count} min ago',
  'time.hoursAgo': '{count} h ago',
  'time.daysAgo': '{count} d ago',
  'time.unknown': 'unknown',

  // ---- 面板级错误 ----
  panelLoadFailed: 'Could not read the memory bank: {message}',
  panelUnavailable: 'The memory bank Host half is not loaded, so this panel has nothing to show.',
  mutationFailed: 'That did not go through: {message}',
}

/** 中文文案。 */
const zh = {
  // ---- 注册项标题（宿主用于导航行 / 卡片标题）----
  configTitle: '记忆库',
  panelTitle: '记忆',

  // ---- 插件卡片 ----
  cardSummary:
    '项目级记忆：Agent 自己判断该不该记，十道门自审，判不了的才交人裁决。',
  configSummary: '记忆库的自主度、审核阈值、捕获与召回。',

  // ---- 通用 ----
  loading: '读取中…',
  reload: '刷新',
  close: '关闭',
  cancel: '取消',
  save: '保存',
  saving: '保存中…',
  discard: '放弃',
  reset: '重置为默认',
  retry: '重试',
  code: '代码',
  addItem: '加一项',
  removeItem: '移除 {item}',
  invalidNumber: '必须是数字',

  // ---- 来源徽标 ----
  'source.default': '默认值',
  'source.project': '项目配置',
  'source.env': '环境变量',
  'source.row': '部署配置',
  sourceLabel: '来源',

  // ---- 作用域提示条 ----
  scopeIntro: '配置分四层生效，页面上的徽标就是这一项的来源：',
  scopeOrder: '部署配置 > 环境变量 > 项目配置 > 默认值',
  scopeNote:
    '从项目配置之外的层来的字段会锁住 —— 改这里不生效，徽标会告诉你该去改哪里。',
  /** 行配置页的只读说明（见英文侧注释）。 */
  rowConfigReadOnlyTitle: '这一页只读：它显示的是部署配置层',
  rowConfigReadOnlyBody:
    '这一层来自 profile 的 cordis.patch.yml（插件行 config），改它要编辑那个文件并重启宿主。仓库级的配置请到「设置 → 插件 → 记忆库 → 配置」改 —— 那才是写进 .dsh-memory/config.json 的那一层。',

  // ---- 字段 ----
  defaultValue: '默认 {value}',
  lockedByEnv: '来自环境变量，改这里不生效。',
  lockedByRow: '来自部署配置，改这里不生效。',
  lockedGeneric: '被上层覆盖，改这里不生效。',
  choiceDefault: '默认',
  advancedThresholds: '高级：按查询类型分开设阈值',
  advancedCount: '{count} 项',

  // ---- 自主度选项（设计稿定死的三张卡）----
  autonomyTitle: '自主度',
  'autonomy.manual': '手动',
  'autonomy.manualDesc': '只在你说「记住这个」时写入。适合把每一个字都当承诺的仓库。',
  'autonomy.balanced': '均衡',
  'autonomy.balancedDesc': '命中捕获信号才记，置信度不够就进待决队列。日常用它。',
  'autonomy.autonomous': '自主',
  'autonomy.autonomousDesc': '自己判断、自己写入，只在冲突时问你。适合长期跑的实验分支。',

  // ---- 语义通道（未开闸）----
  semanticTitle: '语义通道',
  semanticLocked: '未开闸',
  semanticReason:
    '不是漏了开关，是闸没开：本地实测的通道分离度只有 +0.063，够不到 0.15 的开工判据。',
  semanticHowTo: '跑 `node bench/embedding-experiment.mjs` 拿到 ≥ 0.15 再回来。',
  semanticValue: 'embedding.provider = {value}',

  // ---- 保存条 ----
  dirtyCount: '{count} 项已修改',
  noChanges: '没有修改',
  saveNote: '保存在 {path}，会进 git 随 PR review。',
  saveFailed: '本部署没有接受这些值。',
  saveRejected: '被拒绝：{message}',

  // ---- 项目配置读取问题（types.d.ts 要求界面必须显示）----
  problemsTitle: '项目配置有问题',
  loadFailed: '读取配置失败：{message}',

  // ---- 项目配置抽屉 ----
  drawerTitle: '项目配置',
  drawerSub: '只对这个仓库生效',
  drawerNotice: '这里的字段会进 git、随 PR review。它是团队共识，不是个人偏好。',
  drawerInherit: '其余 {count} 项不在这里，去「插件 → 记忆库 → 配置」改',
  drawerOpen: '项目配置',
  drawerFooter: '写回 config.json，立即生效',
  drawerSaveFailed: '写回项目配置失败：{message}',

  // ---- 记忆面板：健康概览 ----
  'health.active': '活跃',
  'health.pending': '待决',
  'health.drift': '漂移',
  'health.quota': '配额',
  'health.open': 'open {open}（可行动 {actionable}）',
  'health.contradicted': '矛盾 {count}',
  'health.dormant': '休眠 {count}',
  'health.reviewDue': '到期 {count}',
  'health.expired': '过期 {count}',
  'health.inbox': '队列 {count}',
  'health.problems': '坏文件 {count}',
  panelSub: '本仓库记忆库的健康度与待决队列。',
  rootFallback: '读的不是这个仓库',
  rootFallbackHint:
    '面板没拿到会话工作目录，读的是进程 cwd —— 那个目录里不会有你的记忆，所以永远是 0。在会话里跑一次工具，或设 DSH_MEMORY_ROOT。',

  // ---- 未初始化 ----
  //
  // 「0 条」和「没装过」是两件不同的事：前者是结论，后者是**还没开始**。
  // 混在一起用户会以为记忆坏了。未初始化状态下这一栏只有一个动作。
  //
  // **文案里不写反引号。** 这些是**纯文本**，反引号会照原样显示 ——
  // 0.4.x 的界面上就真的显示成了「` .dsh-memory/ `」。要不要等宽由渲染端
  // 决定，不靠 Markdown 语法。
  uninitializedTitle: '这个仓库还没初始化记忆库',
  uninitializedDesc:
    '自动捕获与召回注入在 .dsh-memory/ 存在之前不会执行 —— 它没有在你背后写过任何东西。',
  uninitializedCreates: '初始化会建出',
  uninitializedExtras: '以及空的 config.json、空回执表和 .gitignore。',
  uninitializedIdempotent: '幂等：已有文件一个字节都不动。',
  uninitializedAction: '初始化记忆库',
  uninitializedDone: '记忆库已初始化。自动捕获与召回注入从现在起生效。',

  // ---- 记忆面板：tab ----
  'tab.pending': '待决',
  'tab.memories': '记忆',
  'tab.drift': '漂移',
  'tab.ledger': '审计',

  // ---- 待决 ----
  pendingEmptyTitle: '没有待决提案。',
  pendingEmptyDesc: '协议判不了的会出现在这里。',
  pendingWhy: '为什么会有积压？',
  pendingWhyHint: '调低「自动接受」阈值，或者换一种自主度。',
  pendingAccept: '通过',
  pendingEdit: '编辑',
  pendingReject: '拒绝',
  pendingWeights: '置信 {value}',
  pendingUnknownWeight: '置信未知',
  pendingEditTitle: '标题',
  pendingEditSave: '保存并通过',
  pendingRejectReason: '拒绝理由（进 pending/rejected/ 留档）',
  pendingConfirmReject: '确认拒绝',
  pendingBusy: '处理中…',

  // ---- 记忆列表 ----
  memorySearchPlaceholder: '搜索记忆（留空看最近条目）',
  memorySearch: '搜索',
  memoryEmpty: '没有匹配的记忆。',
  memoryLoading: '搜索中…',
  memoryRecalled: '召回 {count} 次',
  memoryNeverRecalled: '从未召回',
  memoryRetire: '退休',
  memoryRetireReason: '退休理由',
  memoryConfirmRetire: '确认退休',
  memoryForget: '永久删除',
  memoryForgetConfirm: '再点一次永久删除',
  memoryUpdated: '更新于 {when}',

  // ---- 漂移 ----
  driftEmpty: '锚点全部健康（检查了 {count} 条）。',
  driftAnchors: '锚点',
  driftDetail: '细节',

  // ---- 审计 ----
  ledgerEmpty: '审计日志还是空的。',
  ledgerDecision: '裁决 {value}',

  // ---- 状态 / 类型 / 桶 / 账本 ----
  'status.active': '活跃',
  'status.dormant': '休眠',
  'status.expired': '到期',
  'status.retired': '已退休',
  'status.unknown': '未知',
  'kind.candidate': '候选',
  'kind.merge': '合并',
  'kind.edge': '关系',
  'kind.cluster': '聚类',
  'kind.core': '核心',
  'kind.unknown': '其他',
  'bucket.quarantined': '隔离',
  'bucket.advisory': '建议',
  'bucket.unsafePath': '路径异常',
  'ledger.attempt': '尝试',
  'ledger.resolve': '裁决',
  'ledger.dreamAccept': 'dream 接受',
  'ledger.discard': '丢弃',
  'ledger.other': '其他',

  // ---- 十道门的名字（文案与 shared/endpoints.js 的 GATE_HINTS[*].name.zh 同字）----
  'gate.G1': '归属门',
  'gate.G2': '形态门',
  'gate.G2b': '草稿门',
  'gate.G3': '安全门',
  'gate.G3b': '注入门',
  'gate.G4': '证据门',
  'gate.G5': '重复门',
  'gate.G6': '冲突门',
  'gate.G7': '配额门',
  'gate.G8': '置信门',

  // ---- 相对时间 ----
  'time.justNow': '刚刚',
  'time.minutesAgo': '{count} 分钟前',
  'time.hoursAgo': '{count} 小时前',
  'time.daysAgo': '{count} 天前',
  'time.unknown': '未知',

  // ---- 面板级错误 ----
  panelLoadFailed: '读取记忆库失败：{message}',
  panelUnavailable: '记忆库的 Host 半边没有加载，这个面板暂时没有内容。',
  mutationFailed: '没有成功：{message}',
}
