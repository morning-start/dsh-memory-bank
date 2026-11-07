/* 由 scripts/build-client.mjs 从 client/*.js 生成 —— 不要手改。 */
window.__ModuleLoader__.load({
  id: "dsh-memory-bank",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const h = React.createElement;

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

/**
 * 组件样式（注入成一个 `<style data-plugin-css>` 标签）。
 *
 * ## 三条规则
 *
 * 1. **只用 `--dsw-alias-*`**。宿主主题换肤时跟着变；写死色值会在浅色档里
 *    变成黑底黑字（`practices.md:34`）。
 * 2. **类名一律 `mb-` 前缀**。这些是照宿主 CSS Modules 抄的数值，前缀是
 *    `practices.md:35` 的硬要求 —— 不撞名，宿主升级也不会互相踩。
 * 3. **不碰 `html` / `body` / `*`**。这个标签是全局的，选择器出了 `mb-`
 *    就是改别人的页面。
 *
 * 数值来源：`design/app.css`（照 `ui-layout` / `ui-plugin-manager` /
 * `ui-settings-plugins` 抄的实测值）。间距与圆角是字面量，**颜色一律走
 * token** —— `test/client.test.mjs` 会正则扫这一段，出现裸色值就红。
 */

const CSS = `
.mb-config,
.mb-panel,
.mb-drawer,
.mb-scrim {
  box-sizing: border-box;
}

.mb-config *,
.mb-panel *,
.mb-drawer * {
  box-sizing: border-box;
}

/* ============================== 配置页 ============================== */

.mb-config {
  display: flex;
  flex-direction: column;
  gap: 24px;
  /* 设计稿：内容最大 960 —— 再宽一行会跑得眼睛跟不上。 */
  max-width: 960px;
  margin: 0;
  padding: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
}

/* 作用域提示条：这一页最该被读的一句话 */
.mb-scope {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 28%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, transparent);
}

.mb-scope__glyph {
  flex: none;
  margin-top: 2px;
  color: var(--dsw-alias-state-business-primary);
}

.mb-scope p {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 19px;
}

.mb-scope b {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}

/* 项目配置读取问题 */
.mb-problems {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.mb-problems__title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--dsw-alias-state-error-secondary);
  font-weight: 500;
}

.mb-problems ul {
  margin: 0;
  padding-left: 18px;
}

.mb-problems code {
  color: var(--dsw-alias-label-secondary);
}

/* 分组 */
.mb-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 4px;
}

.mb-group__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 6px;
}

.mb-group__title {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
}

.mb-group__desc {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.mb-group__rule {
  flex: 1;
  height: 0.5px;
  min-width: 12px;
  background: var(--dsw-alias-border-l1);
}

.mb-group__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 字段行 */
.mb-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 168px;
  align-items: center;
  gap: 24px;
  padding: 12px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.mb-field:last-child {
  border-bottom: 0;
}

.mb-field--wide {
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 10px;
}

.mb-field__main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.mb-field__labelRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.mb-field__label {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
}

.mb-field__hint {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.mb-field__hint--locked {
  color: var(--dsw-alias-state-warn-secondary);
}

.mb-field__control {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

.mb-code {
  color: var(--dsw-alias-label-caption);
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px;
  white-space: nowrap;
}

/* 数值网格（阈值 / 配额这类成组的数字） */
.mb-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px 20px;
  padding: 8px 0;
}

.mb-grid--two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.mb-grid__cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.mb-grid__label {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 18px;
}

/* 输入框 */
.mb-input,
.mb-textarea {
  width: 100%;
  height: 40px;
  padding: 0 14px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 12px;
  outline: none;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.mb-input:hover,
.mb-textarea:hover {
  border-color: var(--dsw-alias-label-caption);
}

.mb-input:focus,
.mb-textarea:focus {
  border-color: var(--dsw-alias-state-business-primary);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-state-business-primary);
}

.mb-input:disabled,
.mb-textarea:disabled {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  cursor: default;
}

.mb-input--number {
  text-align: right;
}

.mb-input--chip {
  width: 160px;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 12px;
}

.mb-textarea {
  min-height: 76px;
  padding: 10px 14px;
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px;
  line-height: 20px;
  resize: vertical;
}

/* 来源徽标 */
.mb-source {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 7px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}

.mb-source::before {
  content: "";
  width: 4px;
  height: 4px;
  border-radius: 999px;
  background: currentColor;
}

.mb-source--default {
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-tertiary);
}

.mb-source--project {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 15%, transparent);
  color: var(--dsw-alias-state-business-primary);
}

.mb-source--env {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 15%, transparent);
  color: var(--dsw-alias-state-warn-secondary);
}

.mb-source--row {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 15%, transparent);
  color: var(--dsw-alias-state-error-secondary);
}

/* 开关 */
.mb-switch {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  width: 40px;
  height: 24px;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3);
  cursor: pointer;
  transition: background 0.2s ease;
}

.mb-switch::after {
  content: "";
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--dsw-alias-label-tertiary);
  transition: transform 0.2s ease, background 0.2s ease;
}

.mb-switch[aria-checked="true"] {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent);
}

.mb-switch[aria-checked="true"]::after {
  transform: translateX(16px);
  background: var(--dsw-alias-label-primary-inverted);
}

.mb-switch:disabled {
  opacity: 0.45;
  cursor: default;
}

/* 分段控件 */
.mb-segmented {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
}

.mb-segmented__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 14px;
  border: 0;
  border-radius: 9px;
  background: none;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
  white-space: nowrap;
}

.mb-segmented__item:hover {
  color: var(--dsw-alias-label-primary);
}

.mb-segmented__item[aria-selected="true"] {
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}

.mb-segmented__item:disabled {
  opacity: 0.45;
  cursor: default;
}

/* 三选一卡片 */
.mb-choiceRow {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.mb-choice {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.1s ease, background 0.1s ease;
}

.mb-choice:hover {
  border-color: var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-2);
}

.mb-choice[aria-checked="true"] {
  border-color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent);
}

.mb-choice:disabled {
  opacity: 0.55;
  cursor: default;
}

.mb-choice__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mb-choice__radio {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: 1px solid var(--dsw-alias-label-caption);
  border-radius: 999px;
}

.mb-choice[aria-checked="true"] .mb-choice__radio {
  border-color: var(--dsw-alias-state-business-primary);
}

.mb-choice[aria-checked="true"] .mb-choice__radio::after {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--dsw-alias-state-business-primary);
}

.mb-choice__title {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}

.mb-choice__desc {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

/* chips（字符串数组编辑） */
.mb-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.mb-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 4px 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.mb-chip__remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 999px;
  background: none;
  color: var(--dsw-alias-label-caption);
  cursor: pointer;
}

.mb-chip__remove:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.mb-chip--add {
  padding: 0 10px;
  border-style: dashed;
  background: none;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}

.mb-chip--add:hover {
  border-color: var(--dsw-alias-border-l4);
  color: var(--dsw-alias-label-primary);
}

.mb-chip--add:disabled {
  opacity: 0.45;
  cursor: default;
}

/* 可折叠的「高级」子块 */
.mb-details {
  margin: 6px 0 0;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
}

.mb-details__summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
  list-style: none;
}

.mb-details__summary::-webkit-details-marker {
  display: none;
}

.mb-details__summary:hover {
  color: var(--dsw-alias-label-primary);
}

.mb-details__count {
  margin-left: auto;
}

.mb-details__body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 16px 16px;
}

/* 只读能力块（语义通道） */
.mb-readonly {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}

.mb-readonly__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}

.mb-readonly__glyph {
  flex: none;
  color: var(--dsw-alias-label-caption);
}

.mb-readonly__desc {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.mb-readonly__values {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 20px;
  margin: 0;
}

.mb-readonly__pair {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding-top: 6px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}

.mb-readonly__key {
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mb-readonly__value {
  flex: none;
  color: var(--dsw-alias-label-secondary);
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px;
}

/* 保存条 */
.mb-saveBar {
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
  padding: 14px 0 16px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
}

.mb-saveBar__note {
  flex: 1;
  min-width: 180px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.mb-saveBar__note b {
  color: var(--dsw-alias-label-secondary);
  font-weight: 500;
}

.mb-saveBar__note--bad b {
  color: var(--dsw-alias-state-error-secondary);
}

/* =============================== 按钮 =============================== */

.mb-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: 12px;
  background: none;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.1s ease;
}

.mb-btn--primary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-inverted);
  font-weight: 500;
}

.mb-btn--primary:hover {
  background: var(--dsw-alias-button-primary-hover);
}

.mb-btn--secondary {
  border: 0.5px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}

.mb-btn--secondary:hover {
  background: var(--dsw-alias-bg-layer-3);
}

.mb-btn--ghost {
  color: var(--dsw-alias-label-secondary);
}

.mb-btn--ghost:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.mb-btn--danger {
  color: var(--dsw-alias-state-error-secondary);
}

.mb-btn--danger:hover {
  background: var(--dsw-alias-interactive-bg-hover-danger);
}

.mb-btn--sm {
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  font-size: 12.5px;
}

.mb-btn--icon {
  width: 28px;
  padding: 0;
}

.mb-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

/* =========================== 徽标 / 状态点 =========================== */

.mb-badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}

.mb-badge--ok {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);
  color: var(--dsw-alias-state-success-secondary);
}

.mb-badge--warn {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);
  color: var(--dsw-alias-state-warn-secondary);
}

.mb-badge--error {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);
  color: var(--dsw-alias-state-error-secondary);
}

.mb-badge--info {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);
  color: var(--dsw-alias-state-business-primary);
}

.mb-badge--mono {
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
}

.mb-dot {
  display: inline-block;
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--dsw-alias-label-caption);
}

.mb-dot--ok {
  background: var(--dsw-alias-state-success-primary);
}

.mb-dot--warn {
  background: var(--dsw-alias-state-warn-primary);
}

.mb-dot--error {
  background: var(--dsw-alias-state-error-primary);
}

/* ============================== 记忆面板 ============================== */

.mb-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
}

.mb-panel__head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.mb-panel__headMain {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.mb-panel__title {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  font-weight: 500;
  line-height: 22px;
}

.mb-panel__sub {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.mb-panel__error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
}

/* 健康概览 */
.mb-health {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-border-l1);
}

.mb-health__cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-1);
}

.mb-health__num {
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  font-weight: 500;
  line-height: 22px;
  font-variant-numeric: tabular-nums;
}

.mb-health__num small {
  margin-left: 2px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  font-weight: 400;
}

.mb-health__label {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 16px;
}

.mb-health__cell[data-tone="warn"] .mb-health__num {
  color: var(--dsw-alias-state-warn-secondary);
}

.mb-health__cell[data-tone="error"] .mb-health__num {
  color: var(--dsw-alias-state-error-secondary);
}

.mb-healthFoot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: -8px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 16px;
}

.mb-healthFoot b {
  color: var(--dsw-alias-label-secondary);
  font-weight: 500;
}

.mb-healthFoot i {
  color: var(--dsw-alias-border-l4);
  font-style: normal;
}

/* tab */
.mb-tabs {
  display: flex;
  align-items: flex-end;
  gap: 22px;
  margin-top: 2px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}

.mb-tab {
  position: relative;
  padding: 7px 1px 9px;
  border: 0;
  background: none;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}

.mb-tab:hover,
.mb-tab[aria-selected="true"] {
  color: var(--dsw-alias-label-primary);
}

.mb-tab[aria-selected="true"]::after {
  content: "";
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--dsw-alias-label-primary);
}

.mb-tab__count {
  margin-left: 5px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* 待决提案 */
.mb-proposals {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mb-proposal {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}

.mb-proposal:hover {
  border-color: var(--dsw-alias-border-l3);
}

.mb-proposal[data-open="true"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 30%, transparent);
}

.mb-proposal__top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.mb-proposal__title {
  flex: 1;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}

.mb-proposal__conf {
  flex: none;
  color: var(--dsw-alias-label-secondary);
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.mb-proposal__reason {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.mb-proposal__reason code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--dsw-alias-markdown-code-block);
  color: var(--dsw-alias-label-secondary);
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px;
}

.mb-proposal__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.mb-proposal__meta {
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}

.mb-proposal__editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 空态 */
.mb-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 36px 16px;
  border: 0.5px dashed var(--dsw-alias-border-l3);
  border-radius: 12px;
  text-align: center;
}

.mb-empty__title {
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}

.mb-empty__desc {
  max-width: 380px;
  margin: 0;
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  line-height: 18px;
}

/* 提示条 */
.mb-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.mb-note__glyph {
  flex: none;
  margin-top: 1px;
  color: var(--dsw-alias-state-warn-secondary);
}

.mb-note--error {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
}

.mb-note--error .mb-note__glyph {
  color: var(--dsw-alias-state-error-secondary);
}

.mb-caption {
  margin: 0;
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  line-height: 18px;
}

.mb-link {
  border: 0;
  background: none;
  color: var(--dsw-alias-state-business-primary);
  font: inherit;
  cursor: pointer;
}

.mb-link:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}

/* 记忆列表 */
.mb-search {
  display: flex;
  gap: 8px;
}

.mb-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.mb-list__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}

.mb-list__main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.mb-list__title {
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mb-list__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 16px;
}

.mb-list__end {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
}

/* ============================ 项目配置抽屉 ============================ */

.mb-scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: var(--dsw-alias-bg-mask-2);
}

.mb-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 61;
  display: flex;
  flex-direction: column;
  width: 440px;
  max-width: calc(100vw - 24px);
  border-left: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
  box-shadow: -18px 0 48px -18px var(--dsw-alias-bg-mask-2);
}

.mb-drawer__head {
  display: flex;
  flex: none;
  align-items: flex-start;
  gap: 12px;
  padding: 22px 20px 16px 22px;
}

.mb-drawer__headMain {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.mb-drawer__title {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
  line-height: 22px;
}

.mb-drawer__sub {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.mb-drawer__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  padding: 0 22px 18px;
  overflow-y: auto;
}

.mb-drawer__foot {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 14px 22px 18px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
}

.mb-drawer__footNote {
  flex: 1;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.mb-inherit {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}

.mb-inherit__title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
}

.mb-inherit__list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.mb-inherit__list li {
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-tertiary);
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px;
}

/* ============================== 工具类 ============================== */

.mb-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.mb-mono {
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px;
}

.mb-muted {
  color: var(--dsw-alias-label-tertiary);
}
`

/**
 * 手工控件 —— 这一版最大的工作量来源。
 *
 * ## 为什么不 `require` 宿主的 `ui-primitives`
 *
 * `practices.md:35` 明令禁止。它们**能** `require`（在 11 个种子词里），但
 * 第三方插件没有类型检查，宿主一升级就是整片白（`slot entry crashed`）。
 * 所以这里照宿主 `Switch` / `TextField` / `Modal` 的 **markup + 行为** 重写：
 * `role="switch"` + `aria-checked`、`<label>` 关联、`button` 而不是 `div`
 * 保证键盘可达。样式在 `client/styles/app.js`，类名一律 `mb-` 前缀。
 *
 * ## 为什么有一个手写的 store
 *
 * `useSyncExternalStore` 要求 `getSnapshot` 返回**稳定引用**，所以状态对象
 * 不可变替换。宿主有个 `dsh-client-store`，但那是 `@deepseek-ai/*` ——
 * 同样的理由不 require。30 行足够。
 */

/**
 * 宿主主题的作用域层名。**逐字抄自 `shared/endpoints.js` 的 `SOURCES`** ——
 * 客户端拿不到那个模块（自包含脚本不能 `import`），只能复制一份；
 * `test/client.test.mjs` 逐条比对，少一条就红。
 */
const SOURCES = Object.freeze([
  { id: 'default', zh: '默认值', en: 'Default', tone: 'muted' },
  { id: 'project', zh: '项目配置', en: 'Project', tone: 'info' },
  { id: 'env', zh: '环境变量', en: 'Environment', tone: 'warning' },
  { id: 'row', zh: '部署配置', en: 'Deployment', tone: 'danger' },
])

/** 来源 id → 文案键。不写 `'source.' + id`，否则键覆盖测试看不见它。 */
const SOURCE_KEYS = Object.freeze({
  default: 'source.default',
  project: 'source.project',
  env: 'source.env',
  row: 'source.row',
})

/**
 * 十道门 → 「为什么没过」+「改哪里能过」。
 *
 * **逐字抄自 `shared/endpoints.js` 的 `GATE_HINTS`。** 「审核中」没有信息量：
 * 用户要知道改哪里才能让这条过去。`test/client.test.mjs` 逐条比对 `hint`。
 *
 * 门名走字典（`GATE_NAME_KEYS`）而不是直接读 `name.zh` —— 否则英文界面里
 * 会冒出中文。
 */
const GATE_HINTS = Object.freeze({
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

/** 门 id → 文案键。门名是界面文案，走字典才能跟着语言变。 */
const GATE_NAME_KEYS = Object.freeze({
  G1: 'gate.G1',
  G2: 'gate.G2',
  G2b: 'gate.G2b',
  G3: 'gate.G3',
  G3b: 'gate.G3b',
  G4: 'gate.G4',
  G5: 'gate.G5',
  G6: 'gate.G6',
  G7: 'gate.G7',
  G8: 'gate.G8',
})

/** 记忆状态 → 文案键。 */
const STATUS_KEYS = Object.freeze({
  active: 'status.active',
  dormant: 'status.dormant',
  expired: 'status.expired',
  retired: 'status.retired',
})

/** 提案类型 → 文案键。 */
const KIND_KEYS = Object.freeze({
  candidate: 'kind.candidate',
  merge: 'kind.merge',
  edge: 'kind.edge',
  cluster: 'kind.cluster',
  core: 'kind.core',
})

/** 漂移桶 → 文案键。 */
const BUCKET_KEYS = Object.freeze({
  quarantined: 'bucket.quarantined',
  advisory: 'bucket.advisory',
  unsafePath: 'bucket.unsafePath',
})

/** 审计条目类型 → 文案键。 */
const LEDGER_KEYS = Object.freeze({
  attempt: 'ledger.attempt',
  resolve: 'ledger.resolve',
  'dream-accept': 'ledger.dreamAccept',
  discard: 'ledger.discard',
})

/** 图标几何。只画路径，颜色一律 `currentColor`（不能写裸色值）。 */
const ICON_PATHS = Object.freeze({
  close: ['M4 4l8 8', 'M12 4l-8 8'],
  plus: ['M8 3.5v9', 'M3.5 8h9'],
  'chevron-down': ['M4 6.5l4 4 4-4'],
  'chevron-right': ['M6 4l4 4-4 4'],
  search: ['M10.8 10.8L14 14', 'M11.6 7.2a4.4 4.4 0 1 1-8.8 0 4.4 4.4 0 0 1 8.8 0z'],
  alert: ['M8 2.6l6 10.8H2z', 'M8 6.6v3.4', 'M8 12.1v.2'],
  shield: ['M8 1.8l5 2v4.1c0 3-2.1 5.2-5 6.1-2.9-.9-5-3.1-5-6.1V3.8z'],
  info: ['M8 7.2v4.2', 'M8 4.9v.2', 'M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8z'],
  memory: ['M3.2 3.2h9.6v9.6H3.2z', 'M6.4 6.1v.2', 'M9.6 6.1v.2', 'M6.1 9.6h3.8'],
  database: ['M8 2.2c3 0 5 1 5 2.2s-2 2.2-5 2.2-5-1-5-2.2S5 2.2 8 2.2z', 'M3 4.4v7.4c0 1.2 2 2.2 5 2.2s5-1 5-2.2V4.4'],
  refresh: ['M12.9 7.2a5 5 0 1 0-.6 3.5', 'M13.2 3.4v3.9h-3.9'],
})

/**
 * 一个极小的快照 store，给 `React.useSyncExternalStore` 用。
 * @param {unknown} initial - 初始快照。
 * @returns {{ getSnapshot: () => unknown, subscribe: (fn: () => void) => () => void, set: (next: unknown) => void, update: (fn: (current: any) => unknown) => void }}
 */
function createStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next) {
      if (Object.is(next, value)) return
      value = next
      // 复制一份再迭代：监听器里退订是合法的。
      for (const listener of [...listeners]) listener()
    },
    update(project) {
      this.set(project(value))
    },
  }
}

/**
 * 拼类名。
 * @param {...(string | false | null | undefined)} names
 * @returns {string}
 */
function cx(...names) {
  return names.filter((name) => typeof name === 'string' && name.length > 0).join(' ')
}

/**
 * 把 schema 说明里的行内 markdown（`` `code` `` 与 `**bold**`）变成节点。
 *
 * 说明文字是 `lib/config/schema.js` 写的，带反引号和 `**`。直接 `textContent`
 * 会把反引号原样画出来 —— 宿主其它设置页也是这么转的。
 * @param {unknown} text
 * @returns {unknown}
 */
function inlineText(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g
  const nodes = []
  let last = 0
  let match = pattern.exec(text)
  while (match !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    if (match[1] !== undefined) {
      nodes.push(h('code', { className: 'mb-code', key: `c${match.index}` }, match[1]))
    } else {
      nodes.push(h('strong', { key: `b${match.index}` }, match[2]))
    }
    last = match.index + match[0].length
    match = pattern.exec(text)
  }
  if (last < text.length) nodes.push(text.slice(last))
  if (nodes.length === 0) return text
  return nodes.length === 1 && typeof nodes[0] === 'string' ? nodes[0] : nodes
}

/**
 * 相对时间。设计稿上是「2 分钟前」这种。
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 * @param {unknown} iso
 * @returns {string}
 */
function relativeTime(t, iso) {
  if (typeof iso !== 'string' || iso.length === 0) return t('time.unknown')
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return t('time.unknown')
  const minutes = Math.floor((Date.now() - then) / 60000)
  if (minutes < 1) return t('time.justNow')
  if (minutes < 60) return t('time.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hoursAgo', { count: hours })
  return t('time.daysAgo', { count: Math.floor(hours / 24) })
}

/**
 * 内联 SVG 图标。`aria-hidden`：图标旁边永远有可读文字，读屏不该念它。
 * @param {{ name: string, size?: number, className?: string }} props
 */
function Icon({ name, size = 14, className }) {
  const paths = ICON_PATHS[name] ?? ICON_PATHS.info
  return h(
    'svg',
    {
      className,
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    paths.map((d, index) => h('path', { key: index, d })),
  )
}

/**
 * 来源徽标：这一项的值从哪一层来。
 *
 * 非 `project` 层来的字段输入框会 `disabled`（由 `isLocked` 按
 * `ConfigField.writable` / `.source` 决定），徽标是用户唯一的解释。
 *
 * 未知的 `source` 退化成 `default` —— 宿主加一层新来源时界面显示「默认值」，
 * 而不是一片 `mb-source--undefined` 的空白。
 * @param {{ t: Function, source: string }} props
 */
function SourceBadge({ t, source }) {
  const entry = SOURCES.find((candidate) => candidate.id === source) ?? SOURCES[0]
  const label = t(SOURCE_KEYS[entry.id])
  return h(
    'span',
    {
      className: `mb-source mb-source--${entry.id}`,
      title: `${t('sourceLabel')}：${label}`,
    },
    h('span', { className: 'mb-sr-only' }, `${t('sourceLabel')}：`),
    label,
  )
}

/**
 * 开关。`role="switch"` + `aria-checked` 是宿主的行为契约，不能省。
 * @param {{ checked: boolean, disabled?: boolean, label: string, onChange: (next: boolean) => void }} props
 */
function Switch({ checked, disabled, label, onChange }) {
  return h('button', {
    type: 'button',
    role: 'switch',
    className: 'mb-switch',
    'aria-checked': checked ? 'true' : 'false',
    'aria-label': label,
    disabled: disabled === true,
    onClick: () => {
      if (disabled === true) return
      onChange(checked !== true)
    },
  })
}

/**
 * 一行字段：左标签 + 来源徽标 + 说明，右控件（或整行控件）。
 *
 * `hint` 是 schema 里那句中文说明；`note` 是「被上层覆盖」的解释，单独一行
 * 且用警示色 —— 两句话性质不同，不能挤成一句。
 * @param {{ t: Function, label: unknown, code?: string, source?: string, locked?: boolean, wide?: boolean, hint?: unknown, note?: unknown, control?: unknown }} props
 */
function Field({ t, label, code, source, locked, wide, hint, note, control }) {
  const hasHint = hint !== undefined && hint !== null && hint !== ''
  const hasNote = note !== undefined && note !== null && note !== ''
  return h(
    'div',
    { className: wide === true ? 'mb-field mb-field--wide' : 'mb-field' },
    h(
      'div',
      { className: 'mb-field__main' },
      h(
        'div',
        { className: 'mb-field__labelRow' },
        h('span', { className: 'mb-field__label' }, label),
        code === undefined ? null : h('code', { className: 'mb-code' }, code),
        source === undefined ? null : h(SourceBadge, { t, source }),
      ),
      hasHint ? h('p', { className: 'mb-field__hint' }, inlineText(hint)) : null,
      hasNote ? h('p', { className: 'mb-field__hint mb-field__hint--locked' }, inlineText(note)) : null,
    ),
    wide === true ? control : h('div', { className: 'mb-field__control' }, control),
  )
}

/**
 * 空态。比按钮更常被看到，所以文案要写全。
 * @param {{ title: string, desc?: string, action?: unknown }} props
 */
function EmptyState({ title, desc, action }) {
  return h(
    'div',
    { className: 'mb-empty' },
    h('span', { className: 'mb-empty__title' }, title),
    desc === undefined ? null : h('p', { className: 'mb-empty__desc' }, desc),
    action,
  )
}

/**
 * 一条提示（warning / error 两种语气）。
 * @param {{ tone?: 'warn' | 'error', icon?: string, children: unknown }} props
 */
function Note({ tone, icon, children }) {
  return h(
    'div',
    { className: tone === 'error' ? 'mb-note mb-note--error' : 'mb-note' },
    h(Icon, { name: icon ?? 'alert', size: 14, className: 'mb-note__glyph' }),
    h('span', null, children),
  )
}

/**
 * 配置面：插件卡片（`plugins.item`）、配置页（`plugins.row.config`）、
 * 项目配置抽屉（`MemorySection` 里的 `ProjectConfigDrawer`）。
 *
 * ## 这一页唯一的职责：把「作用域」画出来
 *
 * 0.1.1 修的三个配置缺陷（环境变量全死、默认值遮蔽、`config.json` 不读）
 * 本质是同一件事 —— **用户不知道这个值是从哪一层来的**。所以：
 *
 * - 每个字段都挂**来源徽标**，值来自 `ConfigField.source`；
 * - `ConfigField.writable === false` 时输入框 `disabled`，并写明为什么；
 * - `ConfigField.defaultValue` 原样显示成「默认 0.60」。
 *
 * **这三样都不在客户端推导。** 宿主 `config()` 一次算好推过来
 * （`lib/config/schema.js` 的 `describeFields` 就是为此存在的）。
 *
 * ## 为什么是暂存表单而不是即时写
 *
 * 宿主不提供 `SettingsFormModel`（那是 Harness Client 内部包，禁止
 * require），所以 `draft` + 保存/放弃/重置三个动作全部手写。
 * `form.mutate` 那套乐观并发在这里没有对应物 —— 我们走的是
 * `memoryBank/setProjectConfig` 这条普通 RPC。
 */

/** 少数字段的**呈现方式**由设计稿定死；其余一律按 `type` / `enum` 推导。 */
const CHOICE_CARDS = Object.freeze(new Set(['autonomy']))

/** 正则数组用 textarea（一行一条），别的字符串数组用 chips。 */
const ARRAY_AS_TEXTAREA = Object.freeze(new Set(['safety.forbidden']))

/** 语义通道：只读、不开闸、写清为什么。 */
const SEMANTIC_TOP = 'embedding'

/** 自主度三个选项的标题键。 */
const AUTONOMY_KEYS = Object.freeze({
  manual: 'autonomy.manual',
  balanced: 'autonomy.balanced',
  autonomous: 'autonomy.autonomous',
})

/** 自主度三个选项的说明键。 */
const AUTONOMY_DESC_KEYS = Object.freeze({
  manual: 'autonomy.manualDesc',
  balanced: 'autonomy.balancedDesc',
  autonomous: 'autonomy.autonomousDesc',
})

/** 路径最后一段 —— 字段没有独立 label，就用它当标题。 */
function lastSegment(path) {
  const segments = String(path).split('.')
  return segments[segments.length - 1]
}

/**
 * 把 RPC 失败原因变成一句能显示的话。
 * `{ ok: false, error }` 里的 `error` 可能是 Error、字符串或普通对象。
 * @param {unknown} error
 * @returns {string}
 */
function describeFailure(error) {
  if (error === undefined || error === null) return ''
  if (typeof error === 'string') return error
  if (typeof error === 'object' && typeof error.message === 'string') return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * 这一项能不能在界面上改。
 *
 * **取「宿主说的」和「层级说的」里更严的那个。** 宿主给
 * `ConfigField.writable`；而 `source === 'row'`（部署配置层）和 `env` 一样，
 * 任何文件层都盖不住 —— 改这里不生效的字段必须是只读的，否则「改了没反应」
 * 正是 0.1.1 修的三个配置缺陷之一。
 *
 * 当前 `lib/config/index.js` 的 `describeConfig` 只把 `env` 标成不可写
 * （`writable: source !== 'env'`），所以这里补上 `row`。**判据没有重新推导**
 * —— 只是把「不可写」的两个来源都认下来。
 * @param {{ writable?: boolean, source?: string }} field
 * @returns {boolean}
 */
function isLocked(field) {
  return field.writable === false || field.source === 'row'
}

/**
 * 字段被锁住时该说的话。**按来源说，不按原因猜。**
 * @param {Function} t
 * @param {{ source?: string }} field
 * @returns {string}
 */
function lockedHint(t, field) {
  if (field.source === 'env') return t('lockedByEnv')
  if (field.source === 'row') return t('lockedByRow')
  return t('lockedGeneric')
}

/**
 * 写操作的两层信封。
 *
 * 线上返回是 `RpcEnvelope<MutationResult>`：**外层 `ok` 是传输**（HTTP /
 * rpcId / 序列化），**内层 `value.ok` 是领域**（这条提案还在不在、硬门过没过）。
 * 只看外层会把「被硬门拒绝」当成成功（`lib/host/mutations.js` 文件头：
 * 「失败不是异常」）。
 * @param {unknown} response
 * @returns {{ ok: boolean, text: string, message: string }}
 */
function unwrapMutation(response) {
  if (response === null || typeof response !== 'object') return { ok: false, text: '', message: '' }
  if (response.ok !== true) return { ok: false, text: '', message: describeFailure(response.error) }
  const result = response.value
  if (result !== null && typeof result === 'object' && result.ok === false) {
    return { ok: false, text: '', message: describeFailure(result.error) }
  }
  const text =
    result !== null && typeof result === 'object' && typeof result.text === 'string' ? result.text : ''
  return { ok: true, text, message: '' }
}

/**
 * 显示用的值。`undefined` / `null` 画成破折号，不要画成空字符串。
 * @param {{ type?: string }} field
 * @param {unknown} value
 * @returns {string}
 */
function formatValue(field, value) {
  if (value === undefined || value === null) return '—'
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.join(', ')
  if (typeof value === 'boolean') return value === true ? 'true' : 'false'
  return String(value)
}

/**
 * 把暂存值转成要过线的类型。转不动就报 `{ ok: false }`，由保存条报出来
 * —— **不要静默丢掉用户的修改**。
 * @param {{ type?: string, path: string }} field
 * @param {unknown} raw
 * @returns {{ ok: true, value: unknown } | { ok: false }}
 */
function coerce(field, raw) {
  if (field.type === 'number') {
    const text = String(raw).trim()
    if (text === '') return { ok: false }
    const value = Number(text)
    return Number.isFinite(value) ? { ok: true, value } : { ok: false }
  }
  if (field.type === 'array') {
    const items = Array.isArray(raw) ? raw : [raw]
    // 「一行一条正则」的编辑器会留下空行 —— 那是打字留下的，不是规则。
    return { ok: true, value: items.map((item) => String(item)).filter((item) => item.trim() !== '') }
  }
  return { ok: true, value: raw }
}

/**
 * 把点分路径的暂存表摊成嵌套对象。
 * `{ 'thresholds.content.natural': 0.6 }` → `{ thresholds: { content: { natural: 0.6 } } }`
 * @param {Record<string, unknown>} draft
 * @returns {Record<string, unknown>}
 */
function buildPatch(draft) {
  const root = {}
  for (const [path, value] of Object.entries(draft)) {
    const segments = String(path).split('.')
    let node = root
    for (let index = 0; index < segments.length - 1; index += 1) {
      const key = segments[index]
      if (typeof node[key] !== 'object' || node[key] === null || Array.isArray(node[key])) node[key] = {}
      node = node[key]
    }
    node[segments[segments.length - 1]] = value
  }
  return root
}

/**
 * 两个值算不算「一样」。数组按元素比 —— 否则每次编辑数组都算脏。
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function sameValue(left, right) {
  if (Object.is(left, right)) return true
  if (!Array.isArray(left) || !Array.isArray(right)) return false
  return left.length === right.length && left.every((item, index) => Object.is(item, right[index]))
}

/**
 * 配置页的状态机。**只做四件事**：读快照、暂存修改、写项目层、重置。
 * @param {{ remote: { memoryBank: Record<string, Function> } }} ctx
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 */
function createConfigController(ctx, t) {
  const store = createStore({
    status: 'loading',
    error: null,
    groups: [],
    fields: [],
    projectPath: '',
    problems: [],
    draft: {},
    save: 'idle',
    saveError: null,
  })

  /** 只让最后一次读取写回状态 —— 连点「刷新」不能旧值覆盖新值。 */
  let generation = 0

  const patch = (next) => store.update((current) => ({ ...current, ...next }))

  const fieldOf = (path) => store.getSnapshot().fields.find((field) => field.path === path)

  const api = {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,

    /** 当前值：暂存里改过就用暂存，否则用宿主给的归一化值。 */
    valueOf(field) {
      const draft = store.getSnapshot().draft
      return Object.prototype.hasOwnProperty.call(draft, field.path) ? draft[field.path] : field.value
    },

    /** 暂存里改了几项。 */
    dirtyCount() {
      return Object.keys(store.getSnapshot().draft).length
    },

    /**
     * 暂存一项修改。改回原值就把这一项从暂存里摘掉（「没有修改」要真的没有）。
     * @param {string} path
     * @param {unknown} value
     */
    edit(path, value) {
      store.update((current) => {
        const draft = { ...current.draft }
        const field = current.fields.find((entry) => entry.path === path)
        const original = field === undefined ? undefined : field.value
        if (sameValue(original, value)) delete draft[path]
        else draft[path] = value
        return { ...current, draft, save: 'idle', saveError: null }
      })
    },

    /** 丢掉全部暂存。 */
    discard() {
      patch({ draft: {}, save: 'idle', saveError: null })
    },

    /** 读一次快照。失败不抛 —— 界面要显示原因，不是崩掉。 */
    async load() {
      const mine = (generation += 1)
      try {
        const response = await ctx.remote.memoryBank.config()
        if (mine !== generation) return
        if (response?.ok !== true) {
          patch({ status: 'error', error: describeFailure(response?.error) })
          return
        }
        const value = response.value ?? {}
        patch({
          status: 'ready',
          error: null,
          groups: Array.isArray(value.groups) ? value.groups : [],
          fields: Array.isArray(value.fields) ? value.fields : [],
          projectPath: typeof value.projectPath === 'string' ? value.projectPath : '',
          problems: Array.isArray(value.problems) ? value.problems : [],
          draft: {},
          save: 'idle',
          saveError: null,
        })
      } catch (error) {
        if (mine !== generation) return
        patch({ status: 'error', error: describeFailure(error) })
      }
    },

    /** 写项目层。被拒就是被拒（`ok: false`），不要 try/catch 当异常吞。 */
    async save() {
      const current = store.getSnapshot()
      if (current.status !== 'ready' || current.save === 'saving') return
      const patchBody = {}
      for (const [path, raw] of Object.entries(current.draft)) {
        const field = fieldOf(path)
        const parsed = field === undefined ? { ok: true, value: raw } : coerce(field, raw)
        if (parsed.ok === false) {
          patch({ save: 'failed', saveError: `${path} ${t('invalidNumber')}` })
          return
        }
        patchBody[path] = parsed.value
      }
      if (Object.keys(patchBody).length === 0) return
      patch({ save: 'saving', saveError: null })
      try {
        const result = unwrapMutation(
          await ctx.remote.memoryBank.setProjectConfig(buildPatch(patchBody)),
        )
        if (result.ok !== true) {
          patch({ save: 'failed', saveError: result.message })
          return
        }
        await api.load()
      } catch (error) {
        patch({ save: 'failed', saveError: describeFailure(error) })
      }
    },

    /** 清空项目层（回到继承 profile 层的状态）。 */
    async reset() {
      if (store.getSnapshot().save === 'saving') return
      patch({ save: 'saving', saveError: null })
      try {
        const result = unwrapMutation(await ctx.remote.memoryBank.resetProjectConfig())
        if (result.ok !== true) {
          patch({ save: 'failed', saveError: result.message })
          return
        }
        await api.load()
      } catch (error) {
        patch({ save: 'failed', saveError: describeFailure(error) })
      }
    },

    /** 卸载：没有订阅者要清，留接口给 `apply` 的 effect。 */
    dispose() {
      generation += 1
    },
  }

  return api
}

/* ============================== 视图 ============================== */

/**
 * 一整页配置。宿主只给我们一张字段表，分组与控件全部由它推出来。
 * @param {{ t: Function, config: ReturnType<typeof createConfigController> }} props
 */
function ConfigForm({ t, config }) {
  const state = React.useSyncExternalStore(config.subscribe, config.getSnapshot)

  if (state.status === 'loading') {
    return h('div', { className: 'mb-config' }, h(EmptyState, { title: t('loading') }))
  }

  if (state.status === 'error') {
    return h(
      'div',
      { className: 'mb-config' },
      h(Note, { tone: 'error' }, t('loadFailed', { message: state.error || '' })),
      h(
        'div',
        { className: 'mb-saveBar' },
        h('span', { className: 'mb-saveBar__note' }, ''),
        h(
          'button',
          {
            type: 'button',
            className: 'mb-btn mb-btn--secondary',
            onClick: () => {
              void config.load()
            },
          },
          t('retry'),
        ),
      ),
    )
  }

  const dirty = Object.keys(state.draft).length

  return h(
    'div',
    { className: 'mb-config' },
    state.problems.length === 0 ? null : h(Problems, { t, problems: state.problems }),
    h(ScopeBar, { t }),
    state.groups.map((group) => h(GroupSection, { key: group.id, t, config, state, group })),
    h(SaveBar, { t, config, state, dirty }),
  )
}

/** 作用域提示条：整页最该被读的一句话。 */
function ScopeBar({ t }) {
  return h(
    'div',
    { className: 'mb-scope' },
    h(Icon, { name: 'shield', size: 15, className: 'mb-scope__glyph' }),
    h('p', null, t('scopeIntro'), h('b', null, t('scopeOrder')), ' ', t('scopeNote')),
  )
}

/** 项目配置读坏了（坏 JSON、写错的键名）—— `types.d.ts` 要求界面必须显示。 */
function Problems({ t, problems }) {
  return h(
    'div',
    { className: 'mb-problems' },
    h('div', { className: 'mb-problems__title' }, h(Icon, { name: 'alert' }), t('problemsTitle')),
    h(
      'ul',
      null,
      problems.map((problem, index) => h('li', { key: index }, String(problem))),
    ),
  )
}

/**
 * 一个分组。
 *
 * 三块，按字段路径的深度切：
 * - 路径 ≤ 2 段 → 直接铺（连续的数字合成一个网格）；
 * - 路径 > 2 段（`thresholds.content.*`）→ 折进「高级」；
 * - `embedding.*` → 只读的语义通道块。
 * @param {{ t: Function, config: any, state: any, group: any }} props
 */
function GroupSection({ t, config, state, group }) {
  const leaves = state.fields.filter(
    (field) =>
      field.group === group.id && field.hidden !== true && Array.isArray(field.children) === false,
  )
  const direct = []
  const nested = []
  const semantic = []
  for (const field of leaves) {
    if (field.top === SEMANTIC_TOP) semantic.push(field)
    else if (String(field.path).split('.').length > 2) nested.push(field)
    else direct.push(field)
  }

  const description = bilingual(group.description)

  return h(
    'section',
    { className: 'mb-group', 'aria-label': groupLabel(group) },
    h(
      'div',
      { className: 'mb-group__head' },
      h('h2', { className: 'mb-group__title' }, groupLabel(group)),
      description === '' ? null : h('p', { className: 'mb-group__desc' }, description),
      h('span', { className: 'mb-group__rule' }),
    ),
    h(
      'div',
      { className: 'mb-group__body' },
      renderFields(t, config, direct),
      nested.length === 0
        ? null
        : h(
            'details',
            { className: 'mb-details' },
            h(
              'summary',
              { className: 'mb-details__summary' },
              h(Icon, { name: 'chevron-down', size: 12 }),
              t('advancedThresholds'),
              h(
                'span',
                { className: 'mb-badge mb-details__count' },
                t('advancedCount', { count: nested.length }),
              ),
            ),
            h('div', { className: 'mb-details__body' }, renderFields(t, config, nested)),
          ),
      semantic.length === 0 ? null : h(SemanticChannel, { t, config, fields: semantic }),
    ),
  )
}

/**
 * `{ zh, en }` → 当前语言的一句。宿主给的分组元数据是双语的
 * （`ConfigGroup.label` / `.description`），而客户端只拿得到翻译函数、
 * 拿不到 locale 快照，所以按 `zh` 优先取 —— 少一处语言判断。
 *
 * 未知形状一律退化成空串：界面上少一行说明，好过 `[object Object]`。
 * @param {unknown} value
 * @returns {string}
 */
function bilingual(value) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return ''
  if (typeof value.zh === 'string' && value.zh !== '') return value.zh
  if (typeof value.en === 'string' && value.en !== '') return value.en
  return ''
}

/**
 * 分组标题。
 * @param {{ label?: unknown, id?: unknown }} group
 * @returns {string}
 */
function groupLabel(group) {
  const label = bilingual(group === undefined ? undefined : group.label)
  return label === '' ? String(group?.id ?? '') : label
}

/**
 * 把一串字段铺成节点：连续的数字字段合成一个网格（设计稿的 `thresholdGrid`），
 * 其余每个字段一整行。
 * @param {Function} t
 * @param {any} config
 * @param {ReadonlyArray<any>} fields
 * @returns {ReadonlyArray<unknown>}
 */
function renderFields(t, config, fields) {
  const nodes = []
  let run = []
  const flush = () => {
    if (run.length === 0) return
    const className = run.length === 2 ? 'mb-grid mb-grid--two' : 'mb-grid'
    nodes.push(
      h(
        'div',
        { key: `grid:${run[0].path}`, className },
        run.map((field) => h(NumberCell, { key: field.path, t, config, field })),
      ),
    )
    run = []
  }
  for (const field of fields) {
    if (field.type === 'number') {
      run.push(field)
      continue
    }
    flush()
    nodes.push(h(FieldControl, { key: field.path, t, config, field }))
  }
  flush()
  return nodes
}

/** 数字字段：标签在上、输入框在下，塞进网格。 */
function NumberCell({ t, config, field }) {
  const locked = isLocked(field)
  const id = `mb-field-${field.path}`
  const value = config.valueOf(field)
  return h(
    'label',
    { className: 'mb-grid__cell', htmlFor: id },
    h(
      'span',
      { className: 'mb-grid__label' },
      h('code', { className: 'mb-code' }, lastSegment(field.path)),
      field.source === undefined ? null : h(SourceBadge, { t, source: field.source }),
    ),
    h('input', {
      id,
      className: 'mb-input mb-input--number',
      type: 'text',
      inputMode: 'decimal',
      value: formatValue(field, value),
      disabled: locked,
      title: field.description ?? field.path,
      onChange: (event) => config.edit(field.path, event.target.value),
    }),
    field.description === undefined || field.description === ''
      ? null
      : h('p', { className: 'mb-field__hint' }, inlineText(field.description)),
    locked
      ? h('p', { className: 'mb-field__hint mb-field__hint--locked' }, lockedHint(t, field))
      : null,
  )
}

/**
 * 按 `type` / `enum` 选控件。**这是唯一一处「按类型分支」的地方** ——
 * 加一种 schemastery 类型只需要动这里。
 * @param {{ t: Function, config: any, field: any }} props
 */
function FieldControl({ t, config, field }) {
  if (field.type === 'boolean') return h(ToggleField, { t, config, field })
  if (field.type === 'union' && Array.isArray(field.enum) && field.enum.length > 0) {
    return CHOICE_CARDS.has(field.path)
      ? h(AutonomyField, { t, config, field })
      : h(SegmentedField, { t, config, field })
  }
  if (field.type === 'array') {
    return ARRAY_AS_TEXTAREA.has(field.path)
      ? h(ArrayTextareaField, { t, config, field })
      : h(ArrayChipsField, { t, config, field })
  }
  return h(TextField, { t, config, field })
}

/** 开关行（左标题右开关）。 */
function ToggleField({ t, config, field }) {
  const locked = isLocked(field)
  const label = lastSegment(field.path)
  return h(Field, {
    t,
    label,
    code: field.path,
    source: field.source,
    locked,
    hint: field.description,
    note: locked ? lockedHint(t, field) : undefined,
    control: h(Switch, {
      checked: config.valueOf(field) === true,
      disabled: locked,
      label: `${label} (${field.path})`,
      onChange: (next) => config.edit(field.path, next),
    }),
  })
}

/** 枚举行（分段控件）。 */
function SegmentedField({ t, config, field }) {
  const locked = isLocked(field)
  const value = config.valueOf(field)
  return h(Field, {
    t,
    label: lastSegment(field.path),
    code: field.path,
    source: field.source,
    locked,
    hint: field.description,
    note: locked ? lockedHint(t, field) : undefined,
    control: h(
      'div',
      { className: 'mb-segmented', role: 'tablist', 'aria-label': field.path },
      field.enum.map((option) =>
        h(
          'button',
          {
            key: String(option),
            type: 'button',
            role: 'tab',
            className: 'mb-segmented__item',
            'aria-selected': Object.is(value, option) ? 'true' : 'false',
            disabled: locked,
            onClick: () => config.edit(field.path, option),
          },
          String(option),
        ),
      ),
    ),
  })
}

/** 自主度：三张带说明的选择卡（设计稿定死的唯一一处）。 */
function AutonomyField({ t, config, field }) {
  const locked = isLocked(field)
  const value = config.valueOf(field)
  return h(
    'div',
    { className: 'mb-field mb-field--wide' },
    h(
      'div',
      { className: 'mb-field__main' },
      h(
        'div',
        { className: 'mb-field__labelRow' },
        h('span', { className: 'mb-field__label' }, t('autonomyTitle')),
        h('code', { className: 'mb-code' }, field.path),
        field.source === undefined ? null : h(SourceBadge, { t, source: field.source }),
      ),
      field.description === undefined || field.description === ''
        ? null
        : h('p', { className: 'mb-field__hint' }, inlineText(field.description)),
      locked
        ? h('p', { className: 'mb-field__hint mb-field__hint--locked' }, lockedHint(t, field))
        : null,
    ),
    h(
      'div',
      { className: 'mb-choiceRow', role: 'radiogroup', 'aria-label': field.path },
      field.enum.map((option) =>
        h(
          'button',
          {
            key: String(option),
            type: 'button',
            role: 'radio',
            className: 'mb-choice',
            'aria-checked': Object.is(value, option) ? 'true' : 'false',
            disabled: locked,
            onClick: () => config.edit(field.path, option),
          },
          h(
            'span',
            { className: 'mb-choice__head' },
            h('span', { className: 'mb-choice__radio' }),
            h('span', { className: 'mb-choice__title' }, t(AUTONOMY_KEYS[option] ?? String(option))),
            option === 'balanced' ? h('span', { className: 'mb-badge' }, t('choiceDefault')) : null,
          ),
          h('span', { className: 'mb-choice__desc' }, t(AUTONOMY_DESC_KEYS[option] ?? String(option))),
        ),
      ),
    ),
  )
}

/** 文本行。 */
function TextField({ t, config, field }) {
  const locked = isLocked(field)
  return h(Field, {
    t,
    label: lastSegment(field.path),
    code: field.path,
    source: field.source,
    locked,
    hint: field.description,
    note: locked ? lockedHint(t, field) : undefined,
    control: h('input', {
      className: 'mb-input',
      type: 'text',
      value: String(config.valueOf(field) ?? ''),
      disabled: locked,
      onChange: (event) => config.edit(field.path, event.target.value),
    }),
  })
}

/** 字符串数组：chips + 加一项。 */
function ArrayChipsField({ t, config, field }) {
  const locked = isLocked(field)
  const value = config.valueOf(field)
  const items = Array.isArray(value) ? value.map((item) => String(item)) : []
  const [pending, setPending] = React.useState('')
  const label = lastSegment(field.path)
  const chips = items.map((item, index) =>
    h(
      'span',
      { key: `${index}:${item}`, className: 'mb-chip' },
      item,
      h(
        'button',
        {
          type: 'button',
          className: 'mb-chip__remove',
          'aria-label': t('removeItem', { item }),
          disabled: locked,
          onClick: () => config.edit(field.path, items.filter((_, at) => at !== index)),
        },
        h(Icon, { name: 'close', size: 10 }),
      ),
    ),
  )
  if (locked === false) {
    chips.push(
      h('input', {
        key: '__pending',
        className: 'mb-input mb-input--chip',
        type: 'text',
        value: pending,
        placeholder: t('addItem'),
        'aria-label': t('addItem'),
        onChange: (event) => setPending(event.target.value),
      }),
    )
    chips.push(
      h(
        'button',
        {
          key: '__add',
          type: 'button',
          className: 'mb-chip mb-chip--add',
          onClick: () => {
            const next = pending.trim()
            if (next === '') return
            config.edit(field.path, [...items, next])
            setPending('')
          },
        },
        h(Icon, { name: 'plus', size: 10 }),
        t('addItem'),
      ),
    )
  }
  return h(Field, {
    t,
    label,
    code: field.path,
    source: field.source,
    locked,
    wide: true,
    hint: field.description,
    note: locked ? lockedHint(t, field) : undefined,
    control: h('div', { className: 'mb-chips' }, chips),
  })
}

/** 正则数组：一行一条。**空行在过线前被丢掉**（那是打字留下的，不是规则）。 */
function ArrayTextareaField({ t, config, field }) {
  const locked = isLocked(field)
  const value = config.valueOf(field)
  const text = Array.isArray(value) ? value.map((item) => String(item)).join('\n') : ''
  return h(Field, {
    t,
    label: lastSegment(field.path),
    code: field.path,
    source: field.source,
    locked,
    wide: true,
    hint: field.description,
    note: locked ? lockedHint(t, field) : undefined,
    control: h('textarea', {
      className: 'mb-textarea',
      rows: 3,
      value: text,
      disabled: locked,
      onChange: (event) => config.edit(field.path, event.target.value.split('\n')),
    }),
  })
}

/** 语义通道：只读、写明为什么没开闸。 */
function SemanticChannel({ t, config, fields }) {
  const providerField = fields.find((field) => field.path === 'embedding.provider')
  const provider =
    providerField === undefined ? 'none' : String(config.valueOf(providerField) ?? 'none')
  const shut = provider === 'none'
  return h(
    'div',
    { className: 'mb-readonly' },
    h(
      'div',
      { className: 'mb-readonly__head' },
      h(Icon, { name: 'shield', size: 15, className: 'mb-readonly__glyph' }),
      h('span', null, t('semanticTitle')),
      h(
        'span',
        { className: shut ? 'mb-badge mb-badge--warn' : 'mb-badge' },
        shut ? t('semanticLocked') : provider,
      ),
      h('code', { className: 'mb-code' }, t('semanticValue', { value: provider })),
    ),
    h('p', { className: 'mb-readonly__desc' }, t('semanticReason')),
    h('p', { className: 'mb-readonly__desc' }, inlineText(t('semanticHowTo'))),
    h(
      'dl',
      { className: 'mb-readonly__values' },
      fields.map((field) =>
        h(
          'div',
          { key: field.path, className: 'mb-readonly__pair' },
          h('dt', { className: 'mb-readonly__key' }, field.path),
          h('dd', { className: 'mb-readonly__value' }, formatValue(field, config.valueOf(field))),
        ),
      ),
    ),
  )
}

/** 底部保存条：改了几项、存到哪、三个动作。 */
function SaveBar({ t, config, state, dirty }) {
  const failed = state.save === 'failed'
  const saving = state.save === 'saving'
  return h(
    'div',
    { className: 'mb-saveBar' },
    h(
      'span',
      { className: failed ? 'mb-saveBar__note mb-saveBar__note--bad' : 'mb-saveBar__note' },
      failed
        ? h('b', null, t('saveRejected', { message: state.saveError || t('saveFailed') }))
        : dirty === 0
          ? t('noChanges')
          : [
              h('b', { key: 'count' }, t('dirtyCount', { count: dirty })),
              ` · ${t('saveNote', { path: state.projectPath || 'config.json' })}`,
            ],
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'mb-btn mb-btn--ghost',
        disabled: dirty === 0 || saving,
        onClick: () => config.discard(),
      },
      t('discard'),
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'mb-btn mb-btn--ghost',
        disabled: saving,
        onClick: () => {
          void config.reset()
        },
      },
      t('reset'),
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'mb-btn mb-btn--primary',
        disabled: dirty === 0 || saving,
        onClick: () => {
          void config.save()
        },
      },
      saving ? t('saving') : t('save'),
    ),
  )
}

/**
 * 项目配置抽屉：只显示**仓库属性**（`ConfigField.projectScoped`）。
 *
 * 这条边界是硬要求（`docs/07` §4 界面 3）—— 否则「为什么我的配置在这个仓库
 * 不生效」会变成最常见的支持问题。其余分组在下面列出来，指向配置页。
 * @param {{ t: Function, config: any, onClose: () => void }} props
 */
function ProjectConfigDrawer({ t, config, onClose }) {
  const state = React.useSyncExternalStore(config.subscribe, config.getSnapshot)
  React.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const projectFields = state.fields.filter(
    (field) =>
      field.projectScoped === true &&
      field.hidden !== true &&
      Array.isArray(field.children) === false,
  )
  const inherited = state.groups.filter(
    (group) => projectFields.every((field) => field.group !== group.id),
  )
  const dirty = Object.keys(state.draft).length
  const failed = state.save === 'failed'
  const saving = state.save === 'saving'

  return [
    h('div', { key: 'scrim', className: 'mb-scrim', onClick: onClose, 'aria-hidden': 'true' }),
    h(
      'aside',
      {
        key: 'drawer',
        className: 'mb-drawer',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('drawerTitle'),
      },
      h(
        'div',
        { className: 'mb-drawer__head' },
        h(
          'div',
          { className: 'mb-drawer__headMain' },
          h('h2', { className: 'mb-drawer__title' }, t('drawerTitle')),
          h(
            'p',
            { className: 'mb-drawer__sub' },
            t('drawerSub'),
            ' · ',
            h('code', { className: 'mb-code' }, state.projectPath || '.dsh-memory/config.json'),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'mb-btn mb-btn--ghost mb-btn--sm mb-btn--icon',
            'aria-label': t('close'),
            onClick: onClose,
          },
          h(Icon, { name: 'close' }),
        ),
      ),
      h(
        'div',
        { className: 'mb-drawer__body' },
        h(Note, { tone: 'warn', icon: 'alert' }, t('drawerNotice')),
        failed
          ? h(Note, { tone: 'error' }, t('drawerSaveFailed', { message: state.saveError || '' }))
          : null,
        projectFields.length === 0
          ? h(EmptyState, { title: t('loading') })
          : h('div', { className: 'mb-group__body' }, renderFields(t, config, projectFields)),
        h(
          'div',
          { className: 'mb-inherit' },
          h(
            'span',
            { className: 'mb-inherit__title' },
            h(Icon, { name: 'info', size: 12 }),
            t('drawerInherit', { count: inherited.length }),
          ),
          h(
            'ul',
            { className: 'mb-inherit__list' },
            inherited.map((group) => h('li', { key: group.id }, String(group.id))),
          ),
        ),
      ),
      h(
        'div',
        { className: 'mb-drawer__foot' },
        h('span', { className: 'mb-drawer__footNote' }, t('drawerFooter')),
        h('button', { type: 'button', className: 'mb-btn mb-btn--ghost', onClick: onClose }, t('cancel')),
        h(
          'button',
          {
            type: 'button',
            className: 'mb-btn mb-btn--primary',
            disabled: dirty === 0 || saving,
            onClick: () => {
              void config.save()
            },
          },
          saving ? t('saving') : t('save'),
        ),
      ),
    ),
  ]
}

/**
 * `plugins.item` 的注册体：插件卡片。
 *
 * `view === 'summary'` 是卡片上的一行说明（Plugins 页自己提供标题、图标、
 * 开关）；`view === 'page'` 是点开后的整页配置。
 * @param {{ t: Function, view: string, config: any }} props
 */
function MemoryCard(props) {
  const { t, view } = props
  if (view === 'summary') return t('cardSummary')
  return h(ConfigForm, { t, config: props.config })
}

/**
 * `plugins.row.config` 的注册体：行配置页（key = `<包名>#<row id>`）。
 * @param {{ t: Function, view: string, config: any }} props
 */
function ConfigPage(props) {
  const { t, view } = props
  if (view === 'summary') return t('configSummary')
  return h(ConfigForm, { t, config: props.config })
}

/**
 * 记忆面板（`settings.section`）与它里面的项目配置抽屉。
 *
 * ## 为什么默认落在「待决」
 *
 * 待决队列是**协议判不了**的结果，不是错误。它是这一页唯一需要人动手的
 * 东西 —— 所以默认看它，有积压时 tab 上带数字。
 *
 * ## 为什么每条提案写「哪道门没过」而不是「审核中」
 *
 * 「审核中」没有信息量。用户要知道**改哪里**才能让它过去，所以文案逐字
 * 取自 `shared/endpoints.js` 的 `GATE_HINTS`（`test/client.test.mjs` 比对），
 * 门名走字典（`GATE_NAME_KEYS`）—— 否则英文界面里会冒出中文。
 *
 * ## 双实现不许漂移
 *
 * 这些动作全部走 `memoryBank/<method>`，和 `/memory` 命令面**调同一个函数**
 * （`lib/host/mutations.js`）。面板里不许再写一份过滤或裁决逻辑。
 *
 * ## 返回形状是「有包裹的」
 *
 * `pending` 返回 `{ total, items }`，`drift` 返回四个桶 + `counts` + `checked`
 * （`lib/host/queries.js`）—— **不是裸数组**。写操作还要拆两层信封：
 * 外层 `ok` 是传输，内层 `value.ok` 是领域（见 `unwrapMutation`）。
 */

/** 面板的四个 tab。第一个是默认。 */
const TABS = Object.freeze([
  ['pending', 'tab.pending'],
  ['memories', 'tab.memories'],
  ['drift', 'tab.drift'],
  ['ledger', 'tab.ledger'],
])

/** 漂移的四个桶（`notADefinition` 在宿主侧就归进 quarantined）。 */
const DRIFT_BUCKETS = Object.freeze(['quarantined', 'advisory', 'unsafePath', 'notADefinition'])

/**
 * 记忆面板的状态机。数据全部来自只读查询 + 写操作 RPC。
 * @param {{ remote: { memoryBank: Record<string, Function> } }} ctx
 * @param {Function} t
 */
function createMemoryController(ctx, t) {
  const store = createStore({
    status: 'loading',
    error: null,
    tab: 'pending',
    overview: null,
    pending: { total: 0, items: [] },
    memories: [],
    memoryQuery: '',
    drift: { items: [], checked: 0 },
    claims: null,
    ledger: [],
    drawer: false,
    busy: null,
    notice: null,
    editing: null,
    rejecting: null,
    retiring: null,
    forgetArmed: null,
  })

  /** 只让最后一次读取写回状态。 */
  let generation = 0

  const patch = (next) => store.update((current) => ({ ...current, ...next }))

  /** 统一的写操作包装：被拒就是 `ok: false`，不是异常。 */
  const mutate = async (id, call) => {
    patch({ busy: id, notice: null })
    try {
      const result = unwrapMutation(await call())
      if (result.ok !== true) {
        patch({
          busy: null,
          notice: { tone: 'error', text: t('mutationFailed', { message: result.message }) },
        })
        return false
      }
      patch({ busy: null })
      await api.load()
      return true
    } catch (error) {
      patch({
        busy: null,
        notice: { tone: 'error', text: t('mutationFailed', { message: describeFailure(error) }) },
      })
      return false
    }
  }

  const api = {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,

    /** 读一轮快照。六个查询并发，任意一个失败就整页报错（不显示半截数字）。 */
    async load() {
      const mine = (generation += 1)
      const query = store.getSnapshot().memoryQuery
      try {
        const [overview, pending, drift, claims, ledger, memories] = await Promise.all([
          ctx.remote.memoryBank.overview(),
          ctx.remote.memoryBank.pending(20),
          ctx.remote.memoryBank.drift(),
          ctx.remote.memoryBank.claims(),
          ctx.remote.memoryBank.ledger(50),
          ctx.remote.memoryBank.memories(query, 30),
        ])
        if (mine !== generation) return
        const failed = [overview, pending, drift, claims, ledger, memories].find(
          (response) => response?.ok !== true,
        )
        if (failed !== undefined) {
          patch({ status: 'error', error: describeFailure(failed?.error) })
          return
        }
        const pendingValue = pending.value
        const driftValue = drift.value
        patch({
          status: 'ready',
          error: null,
          overview: overview.value ?? null,
          pending: {
            total: Number(pendingValue?.total ?? 0),
            items: Array.isArray(pendingValue?.items) ? pendingValue.items : [],
          },
          drift: {
            items: DRIFT_BUCKETS.flatMap((bucket) =>
              Array.isArray(driftValue?.[bucket]) ? driftValue[bucket] : [],
            ),
            checked: Number(driftValue?.checked ?? 0),
          },
          claims: claims.value ?? null,
          ledger: Array.isArray(ledger.value) ? ledger.value : [],
          memories: Array.isArray(memories.value) ? memories.value : [],
        })
      } catch (error) {
        if (mine !== generation) return
        patch({ status: 'error', error: describeFailure(error) })
      }
    },

    /** 切 tab。 */
    setTab(tab) {
      patch({ tab, notice: null })
    },

    /** 搜记忆。空串退化成「最近的条目」（由宿主定义，客户端不重新解释）。 */
    searchMemories(query) {
      patch({ memoryQuery: query })
    },

    openDrawer() {
      patch({ drawer: true })
    },

    closeDrawer() {
      patch({ drawer: false })
    },

    // ---- 待决 ----
    accept(id) {
      return mutate(id, () => ctx.remote.memoryBank.accept(id))
    },

    startEdit(proposal) {
      patch({ editing: { id: proposal.id, title: String(proposal.title ?? '') } })
    },

    setEditTitle(title) {
      store.update((current) => ({ ...current, editing: { ...current.editing, title } }))
    },

    cancelEdit() {
      patch({ editing: null })
    },

    async commitEdit() {
      const editing = store.getSnapshot().editing
      if (editing === null) return
      const ok = await mutate(editing.id, () =>
        ctx.remote.memoryBank.edit(editing.id, { title: editing.title }),
      )
      if (ok) patch({ editing: null })
    },

    startReject(proposal) {
      patch({ rejecting: { id: proposal.id, reason: '' } })
    },

    setRejectReason(reason) {
      store.update((current) => ({ ...current, rejecting: { ...current.rejecting, reason } }))
    },

    cancelReject() {
      patch({ rejecting: null })
    },

    async commitReject() {
      const rejecting = store.getSnapshot().rejecting
      if (rejecting === null) return
      const ok = await mutate(rejecting.id, () =>
        ctx.remote.memoryBank.reject(rejecting.id, rejecting.reason),
      )
      if (ok) patch({ rejecting: null })
    },

    // ---- 记忆 ----
    startRetire(memory) {
      patch({ retiring: { id: memory.id, reason: '' } })
    },

    setRetireReason(reason) {
      store.update((current) => ({ ...current, retiring: { ...current.retiring, reason } }))
    },

    cancelRetire() {
      patch({ retiring: null })
    },

    async commitRetire() {
      const retiring = store.getSnapshot().retiring
      if (retiring === null) return
      const ok = await mutate(retiring.id, () =>
        ctx.remote.memoryBank.retire(retiring.id, retiring.reason),
      )
      if (ok) patch({ retiring: null })
    },

    /** 永久删除：第一次点只「上膛」，第二次才真的删。 */
    armForget(id) {
      patch({ forgetArmed: store.getSnapshot().forgetArmed === id ? null : id })
    },

    async commitForget(id) {
      if (store.getSnapshot().forgetArmed !== id) return
      const ok = await mutate(id, () => ctx.remote.memoryBank.forget(id, true))
      if (ok) patch({ forgetArmed: null })
    },

    /** 卸载：没有订阅者要清，留接口给 `apply` 的 effect。 */
    dispose() {
      generation += 1
    },
  }

  return api
}

/* ============================== 视图 ============================== */

/**
 * `settings.section` 的注册体。
 * @param {{ t: Function, close: () => void, memory: any, config: any }} props
 */
function MemorySection(props) {
  const { t } = props
  const memory = props.memory
  const state = React.useSyncExternalStore(memory.subscribe, memory.getSnapshot)

  return h(
    'div',
    { className: 'mb-panel' },
    h(
      'div',
      { className: 'mb-panel__head' },
      h(
        'div',
        { className: 'mb-panel__headMain' },
        h('h2', { className: 'mb-panel__title' }, t('panelTitle')),
        h('p', { className: 'mb-panel__sub' }, t('panelSub')),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'mb-btn mb-btn--ghost mb-btn--sm',
          onClick: () => memory.openDrawer(),
        },
        t('drawerOpen'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'mb-btn mb-btn--ghost mb-btn--sm mb-btn--icon',
          'aria-label': t('reload'),
          title: t('reload'),
          onClick: () => {
            void memory.load()
          },
        },
        h(Icon, { name: 'refresh' }),
      ),
    ),
    state.notice === null ? null : h(Note, { tone: 'error' }, state.notice.text),
    state.status === 'loading'
      ? h(EmptyState, { title: t('loading') })
      : state.status === 'error'
        ? h(
            'div',
            { className: 'mb-panel__error' },
            h(Note, { tone: 'error' }, t('panelLoadFailed', { message: state.error || '' })),
            h(
              'button',
              {
                type: 'button',
                className: 'mb-btn mb-btn--secondary',
                onClick: () => {
                  void memory.load()
                },
              },
              t('retry'),
            ),
          )
        : h(HealthBlock, { t, state }),
    state.status === 'ready' ? h(TabBar, { t, memory, state }) : null,
    state.status === 'ready' ? h(TabBody, { t, memory, state }) : null,
    state.drawer
      ? h(ProjectConfigDrawer, { t, config: props.config, onClose: () => memory.closeDrawer() })
      : null,
  )
}

/** 顶部一行健康概览（只读）。 */
function HealthBlock({ t, state }) {
  const overview = state.overview ?? {}
  const claims = state.claims ?? overview.claims ?? {}
  const lifecycle = overview.lifecycle ?? {}
  const quota = overview.quota ?? { used: 0, limit: 0 }
  const drift = state.drift.items.length
  const pending = Number(overview.pending ?? state.pending.items.length)
  return [
    h(
      'div',
      { key: 'health', className: 'mb-health' },
      h(HealthCell, { tone: 'ok', dot: 'ok', value: overview.active ?? 0, label: t('health.active') }),
      h(HealthCell, {
        tone: pending > 0 ? 'warn' : 'ok',
        dot: pending > 0 ? 'warn' : 'ok',
        value: pending,
        label: t('health.pending'),
      }),
      h(HealthCell, {
        tone: drift > 0 ? 'error' : 'ok',
        dot: drift > 0 ? 'error' : 'ok',
        value: drift,
        label: t('health.drift'),
      }),
      h(HealthCell, {
        tone: 'ok',
        value: quota.used ?? 0,
        suffix: `/${quota.limit ?? 0}`,
        label: t('health.quota'),
      }),
    ),
    h(
      'div',
      { key: 'foot', className: 'mb-healthFoot' },
      h(
        'span',
        null,
        t('health.open', { open: claims.open ?? 0, actionable: claims.openActionable ?? 0 }),
      ),
      h('i', null, '·'),
      h('span', null, t('health.contradicted', { count: claims.contradicted ?? 0 })),
      h('i', null, '·'),
      h('span', null, t('health.dormant', { count: lifecycle.dormant ?? 0 })),
      h('i', null, '·'),
      h('span', null, t('health.expired', { count: lifecycle.expired ?? 0 })),
      h('i', null, '·'),
      h('span', null, t('health.inbox', { count: overview.inbox ?? 0 })),
    ),
  ]
}

/** 健康概览的一格。 */
function HealthCell({ tone, dot, value, suffix, label }) {
  return h(
    'div',
    { className: 'mb-health__cell', 'data-tone': tone },
    h(
      'span',
      { className: 'mb-health__num' },
      String(value),
      suffix === undefined ? null : h('small', null, suffix),
    ),
    h(
      'span',
      { className: 'mb-health__label' },
      dot === undefined ? null : h('span', { className: `mb-dot mb-dot--${dot}` }),
      label,
    ),
  )
}

/** 四个 tab。计数是「这一栏现在有多少条」。 */
function TabBar({ t, memory, state }) {
  const counts = {
    pending: state.pending.items.length,
    memories: state.overview?.active ?? 0,
    drift: state.drift.items.length,
  }
  return h(
    'div',
    { className: 'mb-tabs', role: 'tablist', 'aria-label': t('panelTitle') },
    TABS.map(([id, key]) =>
      h(
        'button',
        {
          key: id,
          type: 'button',
          role: 'tab',
          className: 'mb-tab',
          'aria-selected': state.tab === id ? 'true' : 'false',
          onClick: () => memory.setTab(id),
        },
        t(key),
        counts[id] === undefined ? null : h('span', { className: 'mb-tab__count' }, String(counts[id])),
      ),
    ),
  )
}

/** 当前 tab 的内容。 */
function TabBody({ t, memory, state }) {
  if (state.tab === 'memories') return h(MemoryList, { t, memory, state })
  if (state.tab === 'drift') return h(DriftList, { t, state })
  if (state.tab === 'ledger') return h(LedgerList, { t, state })
  return h(PendingList, { t, memory, state })
}

/** 待决列表。 */
function PendingList({ t, memory, state }) {
  if (state.pending.items.length === 0) {
    return h(
      'div',
      null,
      h(EmptyState, { title: t('pendingEmptyTitle'), desc: t('pendingEmptyDesc') }),
      h('p', { className: 'mb-caption' }, `${t('pendingWhy')} ${t('pendingWhyHint')}`),
    )
  }
  return h(
    'div',
    { className: 'mb-proposals' },
    state.pending.items.map((proposal) =>
      h(ProposalCard, { key: proposal.id, t, memory, state, proposal }),
    ),
  )
}

/** 一条待决提案：类型 · 标题 · 置信 · 没过的那道门 · 三个动作。 */
function ProposalCard({ t, memory, state, proposal }) {
  const busy = state.busy === proposal.id
  const editing = state.editing !== null && state.editing.id === proposal.id
  const rejecting = state.rejecting !== null && state.rejecting.id === proposal.id
  const gates = Array.isArray(proposal.gates) ? proposal.gates.map(String) : []
  const why = Array.isArray(proposal.why) ? proposal.why.map(String) : []
  const confidence =
    proposal.confidence === null || proposal.confidence === undefined
      ? t('pendingUnknownWeight')
      : t('pendingWeights', { value: String(proposal.confidence) })

  return h(
    'article',
    { className: 'mb-proposal', 'data-open': editing || rejecting ? 'true' : 'false' },
    h(
      'div',
      { className: 'mb-proposal__top' },
      h(
        'span',
        { className: 'mb-badge mb-badge--info' },
        t(KIND_KEYS[proposal.kind] ?? 'kind.unknown'),
      ),
      h('span', { className: 'mb-proposal__title' }, String(proposal.title ?? proposal.id)),
      h('span', { className: 'mb-proposal__conf' }, confidence),
    ),
    gates.length === 0
      ? null
      : gates.map((gate) =>
          h(
            'p',
            { key: gate, className: 'mb-proposal__reason' },
            h('code', null, gate),
            ' ',
            h('strong', null, t(GATE_NAME_KEYS[gate] ?? 'kind.unknown')),
            '：',
            inlineText(GATE_HINTS[gate]?.hint ?? ''),
          ),
        ),
    why.length === 0 ? null : h('p', { className: 'mb-proposal__reason' }, why.join(' · ')),
    editing
      ? h(
          'div',
          { className: 'mb-proposal__editor' },
          h('label', { className: 'mb-field__label' }, t('pendingEditTitle')),
          h('input', {
            className: 'mb-input',
            type: 'text',
            value: state.editing.title,
            onChange: (event) => memory.setEditTitle(event.target.value),
          }),
          h(
            'div',
            { className: 'mb-proposal__actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'mb-btn mb-btn--primary mb-btn--sm',
                disabled: busy,
                onClick: () => {
                  void memory.commitEdit()
                },
              },
              busy ? t('pendingBusy') : t('pendingEditSave'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mb-btn mb-btn--ghost mb-btn--sm',
                onClick: () => memory.cancelEdit(),
              },
              t('cancel'),
            ),
          ),
        )
      : rejecting
        ? h(
            'div',
            { className: 'mb-proposal__editor' },
            h('label', { className: 'mb-field__label' }, t('pendingRejectReason')),
            h('textarea', {
              className: 'mb-textarea',
              rows: 2,
              value: state.rejecting.reason,
              onChange: (event) => memory.setRejectReason(event.target.value),
            }),
            h(
              'div',
              { className: 'mb-proposal__actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'mb-btn mb-btn--danger mb-btn--sm',
                  disabled: busy,
                  onClick: () => {
                    void memory.commitReject()
                  },
                },
                busy ? t('pendingBusy') : t('pendingConfirmReject'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mb-btn mb-btn--ghost mb-btn--sm',
                  onClick: () => memory.cancelReject(),
                },
                t('cancel'),
              ),
            ),
          )
        : h(
            'div',
            { className: 'mb-proposal__actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'mb-btn mb-btn--primary mb-btn--sm',
                disabled: busy,
                onClick: () => {
                  void memory.accept(proposal.id)
                },
              },
              t('pendingAccept'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mb-btn mb-btn--secondary mb-btn--sm',
                disabled: busy,
                onClick: () => memory.startEdit(proposal),
              },
              t('pendingEdit'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mb-btn mb-btn--danger mb-btn--sm',
                disabled: busy,
                onClick: () => memory.startReject(proposal),
              },
              t('pendingReject'),
            ),
            h('span', { className: 'mb-proposal__meta' }, relativeTime(t, proposal.createdAt)),
          ),
  )
}

/** 记忆列表：搜索框 + 行。 */
function MemoryList({ t, memory, state }) {
  return h(
    'div',
    { className: 'mb-proposals' },
    h(
      'div',
      { className: 'mb-search' },
      h('input', {
        className: 'mb-input',
        type: 'search',
        value: state.memoryQuery,
        placeholder: t('memorySearchPlaceholder'),
        'aria-label': t('memorySearchPlaceholder'),
        onChange: (event) => memory.searchMemories(event.target.value),
      }),
      h(
        'button',
        {
          type: 'button',
          className: 'mb-btn mb-btn--secondary',
          onClick: () => {
            void memory.load()
          },
        },
        t('memorySearch'),
      ),
    ),
    state.memories.length === 0
      ? h(EmptyState, { title: t('memoryEmpty') })
      : h(
          'ul',
          { className: 'mb-list' },
          state.memories.map((entry) =>
            h(
              'li',
              { key: entry.id, className: 'mb-list__row' },
              h(
                'div',
                { className: 'mb-list__main' },
                h('span', { className: 'mb-list__title' }, String(entry.title ?? entry.id)),
                h(
                  'span',
                  { className: 'mb-list__meta' },
                  h('span', { className: 'mb-badge' }, t(STATUS_KEYS[entry.status] ?? 'status.unknown')),
                  h('span', null, String(entry.kind ?? '')),
                  h(
                    'span',
                    null,
                    entry.lastRecalledAt === null || entry.lastRecalledAt === undefined
                      ? t('memoryNeverRecalled')
                      : t('memoryRecalled', { count: entry.accessCount ?? 0 }),
                  ),
                  h('span', null, relativeTime(t, entry.updatedAt)),
                ),
              ),
              h(
                'span',
                { className: 'mb-list__end' },
                state.retiring !== null && state.retiring.id === entry.id
                  ? [
                      h('input', {
                        key: 'reason',
                        className: 'mb-input',
                        type: 'text',
                        value: state.retiring.reason,
                        placeholder: t('memoryRetireReason'),
                        'aria-label': t('memoryRetireReason'),
                        onChange: (event) => memory.setRetireReason(event.target.value),
                      }),
                      h(
                        'button',
                        {
                          key: 'confirm',
                          type: 'button',
                          className: 'mb-btn mb-btn--danger mb-btn--sm',
                          disabled: state.busy === entry.id,
                          onClick: () => {
                            void memory.commitRetire()
                          },
                        },
                        t('memoryConfirmRetire'),
                      ),
                      h(
                        'button',
                        {
                          key: 'cancel',
                          type: 'button',
                          className: 'mb-btn mb-btn--ghost mb-btn--sm',
                          onClick: () => memory.cancelRetire(),
                        },
                        t('cancel'),
                      ),
                    ]
                  : [
                      h(
                        'button',
                        {
                          key: 'retire',
                          type: 'button',
                          className: 'mb-btn mb-btn--ghost mb-btn--sm',
                          disabled: state.busy === entry.id,
                          onClick: () => memory.startRetire(entry),
                        },
                        t('memoryRetire'),
                      ),
                      h(
                        'button',
                        {
                          key: 'forget',
                          type: 'button',
                          className:
                            state.forgetArmed === entry.id
                              ? 'mb-btn mb-btn--danger mb-btn--sm'
                              : 'mb-btn mb-btn--ghost mb-btn--sm',
                          disabled: state.busy === entry.id,
                          onClick: () => {
                            if (state.forgetArmed === entry.id) void memory.commitForget(entry.id)
                            else memory.armForget(entry.id)
                          },
                        },
                        state.forgetArmed === entry.id ? t('memoryForgetConfirm') : t('memoryForget'),
                      ),
                    ],
              ),
            ),
          ),
        ),
  )
}

/** 漂移三桶（`notADefinition` 已由宿主归进 quarantined）。 */
function DriftList({ t, state }) {
  if (state.drift.items.length === 0) {
    return h(EmptyState, { title: t('driftEmpty', { count: state.drift.checked }) })
  }
  return h(
    'ul',
    { className: 'mb-list' },
    state.drift.items.map((item) =>
      h(
        'li',
        { key: `${item.bucket}:${item.id}`, className: 'mb-list__row' },
        h(
          'div',
          { className: 'mb-list__main' },
          h(
            'span',
            { className: 'mb-list__title' },
            h(
              'span',
              {
                className:
                  item.bucket === 'advisory' ? 'mb-badge mb-badge--warn' : 'mb-badge mb-badge--error',
              },
              t(BUCKET_KEYS[item.bucket] ?? 'bucket.advisory'),
            ),
            ' ',
            String(item.id),
          ),
          h(
            'span',
            { className: 'mb-list__meta' },
            h('code', { className: 'mb-code' }, String(item.code ?? '')),
            ' ',
            String(item.detail ?? ''),
          ),
          Array.isArray(item.anchors) && item.anchors.length > 0
            ? h(
                'span',
                { className: 'mb-list__meta' },
                `${t('driftAnchors')}: `,
                item.anchors.map(String).join(' · '),
              )
            : null,
        ),
      ),
    ),
  )
}

/** 审计时间线。只读。 */
function LedgerList({ t, state }) {
  if (state.ledger.length === 0) return h(EmptyState, { title: t('ledgerEmpty') })
  return h(
    'ul',
    { className: 'mb-list' },
    state.ledger.map((entry, index) =>
      h(
        'li',
        { key: `${entry.at ?? ''}:${index}`, className: 'mb-list__row' },
        h(
          'div',
          { className: 'mb-list__main' },
          h(
            'span',
            { className: 'mb-list__title' },
            h('span', { className: 'mb-badge' }, t(LEDGER_KEYS[entry.kind] ?? 'ledger.other')),
            ' ',
            String(entry.id ?? entry.proposalId ?? '—'),
          ),
          h(
            'span',
            { className: 'mb-list__meta' },
            relativeTime(t, entry.at),
            entry.gate === null || entry.gate === undefined
              ? null
              : h('code', { className: 'mb-code' }, String(entry.gate)),
            entry.decision === null || entry.decision === undefined
              ? null
              : h('span', null, t('ledgerDecision', { value: String(entry.decision) })),
          ),
        ),
      ),
    ),
  )
}

/**
 * 浏览器半边的装配点。
 *
 * ## 这个文件被 `window.__ModuleLoader__` 当作**自包含 classic script** 加载
 *
 * 不能 `import` 任何东西，`require` 只能解析平台种子表里的 11 个包
 * （`.tmp-api/CONTRACT.md` §1.4）。所以 `client/` 下全是**普通函数声明**，
 * 由 `scripts/build-client.mjs` 按固定顺序拼进这个 factory ——
 * 产物 `client/client.js` 是签入的，`test/client.test.mjs` 保证它与一次
 * 全新构建逐字节一致。
 *
 * ## 三个槽都只在这种时候存在
 *
 * `plugins.item` / `plugins.row.config` 由 `client-ui-plugin-manager` 声明，
 * `settings.section` 由 `client-ui-settings-general` 声明 —— 都是「条目挂着
 * 才有」。所以每一次 `register` 都必须包在 `ctx.slots.inject(owner, cb)` 里：
 * 槽塌陷时 effect 被释放，槽回来时 cb **重新跑一遍**。
 * 因此 cb 里**不许有副作用**，且必须返回 disposer（`CONTRACT.md` §8 第 9 条）。
 *
 * ## 为什么不用 `main` 槽
 *
 * 不是因为 `main` 危险（`replaceRisk: shadows-shipped-ui` 只对**已占用的
 * key** 生效），而是因为「记忆面板」本来就是设置页里的一栏 —— 放进 `main`
 * 等于多开一个侧栏入口去承载一个只读列表。这是产品判断（`docs/07` §2.9 ①）。
 */

/** 样式标签的 dedupe 键。改它等于换一份样式表 —— 旧标签会留着（HMR 陷阱）。 */
const STYLE_ID = 'dsh-memory-bank/app.css'

/** 样式标签的 owner id。卸载时 `removeOwnedStyles` 按它找。 */
const PACKAGE_NAME = 'dsh-memory-bank'

/**
 * 在 **factory 的同步执行窗口**里注入样式。
 *
 * 为什么必须在这里：模块加载器只认「factory 执行期间出现」的 `<style>` 标签
 * （`dsh-client-modules/lib/client.js:614-628` 的 `claimStyles`）。晚一步注入
 * （React effect、事件回调）就**不会被认领**，卸载后样式留在页面上。
 * 所以 `data-plugin` 也要自己写。见 `CONTRACT.md` §7.3。
 */
function injectStyles() {
  if (typeof document === 'undefined') return
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`
  if (document.querySelector(selector) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PACKAGE_NAME
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/**
 * 需要的服务（cordis fiber inject）。
 *
 * ## 为什么**不写** `remote.memoryBank`
 *
 * 线上命名空间确实等于 Cordis 服务键（`dsh-typert-protocol/lib/index.js:329`），
 * 所以直觉上该写 `'remote.memoryBank'` —— **但那是一个硬依赖**。
 *
 * 实测（`dsh --profile web --port 0`，界面直接显示）：
 *
 * ```
 * web boot: 1 entry did not activate dsh-memory-bank:
 *   pending (waiting for service: remote.memoryBank)
 * ```
 *
 * 那个点号服务键在**宿主把面板服务注册好之前不存在**，于是整个客户端条目停在
 * pending，**三块界面一个都不挂载** —— 包括那张本来只需要 `slots` 的卡片。
 * 一个「数据面可能还没好」的可选依赖，把整片 UI 拖成了空白。
 *
 * 所以依赖降级成 `remote`（网关的客户端半边，随 web-app 必然存在），
 * `memoryBank` 这个命名空间在**调用时**才解析（见 `memoryBankFacade`）。
 */
const inject = ['slots', 'locale', 'remote']

/**
 * 把 `remote.memoryBank` 包成**惰性门面**。
 *
 * 为什么不在 `inject` 里写死、也不在 `apply` 里直接取：拿不到时不该白屏，
 * 也不该静默 —— 每个方法返回一个**带原因**的 rejection，界面显示
 * 「数据不可用」并说明为什么，而不是一个空面板。
 *
 * 这不是防御性编程，是这一版的核心判断（`docs/07` §2.9 ⑥）：
 * **可选能力不许拖死本体。**
 *
 * @param {any} ctx 浏览器插件上下文
 */
function memoryBankFacade(ctx) {
  const face = () => {
    const namespace = ctx?.remote?.memoryBank
    if (!namespace) {
      throw new Error(
        '记忆面板数据不可用：宿主没有暴露 memoryBank RPC 面 —— ' +
          '通常是面板服务没有挂载（宿主启动日志里会有一条「面板服务未挂载：…」）。',
      )
    }
    return namespace
  }

  return new Proxy(
    {},
    {
      get(_target, method) {
        return (...args) => {
          try {
            const namespace = face()
            const call = namespace[method]
            if (typeof call !== 'function') {
              throw new Error(`memoryBank.${String(method)} 不是一个 RPC 方法（协议漂移？）`)
            }
            return Promise.resolve(call.apply(namespace, args))
          } catch (error) {
            return Promise.reject(error)
          }
        }
      },
    },
  )
}

/**
 * 装上三块界面。宿主没挂对应槽时什么都不发生 —— 这是设计意图。
 * @param {any} ctx - 浏览器插件上下文。
 */
function apply(ctx) {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'memory-bank: dictionaries')

  // 视图只碰 `remote.memoryBank`，所以传门面而不是整个 ctx：
  // 这样「RPC 面还没好」不会在 render 期间抛，只在真正调用时变成一条可读的错误。
  const view = { remote: { memoryBank: memoryBankFacade(ctx) } }

  // 两个控制器活在 `apply` 这一层：槽塌陷再恢复时，暂存的修改和已读的数据
  // 都还在（`inject` 的回调会被反复调用，状态不能放那里面）。
  const config = createConfigController(view, t)
  const memory = createMemoryController(view, t)


  ctx.effect(() => {
    void config.load()
    void memory.load()
    return () => {
      config.dispose()
      memory.dispose()
    }
  }, 'memory-bank: panel data')

  // ① 插件卡片（Plugins 页「已安装插件」组里的记忆库卡片）
  ctx.slots.inject('plugins.item', () =>
    ctx.slots.register(
      {
        name: 'plugins.item',
        id: 'memory-bank',
        order: 60,
        label: () => t('configTitle'),
        locale: NS,
        inject: () => ({ config }),
      },
      MemoryCard,
    ),
  )

  // ② 配置页（包的某一行自己的配置页，key = `<包名>#<row id>`）
  ctx.slots.inject('plugins.row.config', () =>
    ctx.slots.register(
      {
        name: 'plugins.row.config',
        key: 'dsh-memory-bank#memory-bank',
        inject: () => ({ t, config }),
      },
      ConfigPage,
    ),
  )

  // ③ 「记忆」设置页（设置弹窗左侧导航的一栏）
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'memory-bank',
        order: 40,
        label: () => t('panelTitle'),
        locale: NS,
        inject: () => ({ memory, config }),
      },
      MemorySection,
    ),
  )
}

injectStyles()

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
