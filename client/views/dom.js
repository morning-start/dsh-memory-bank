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
