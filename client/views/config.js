/**
 * 配置面：插件卡片（`plugins.item`）、配置页（`plugins.row.config`）、
 * 项目配置抽屉（`MemoryView` 里的 `ProjectConfigDrawer`）。
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
 *
 * @param {{
 *   t: Function,
 *   config: ReturnType<typeof createConfigController>,
 *   readOnly?: boolean,
 * }} props
 *
 * `readOnly` 是给「行配置页」（`plugins.row.config`）用的：那一页显示的是
 * **部署配置层**（`cordis.patch.yml` 的 `config:`），而插件唯一的写入口是
 * **项目层**（`<repo>/.dsh-memory/config.json`）。在这一页保存会把部署配置
 * 静默写进仓库、来源徽标当场从「部署配置」翻成「项目配置」——
 * 见 `docs/08` P0-4。整页只读，并写明正确的改法。
 */
function ConfigForm({ t, config, readOnly = false }) {
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

  const groups = state.groups.map((group) => h(GroupSection, { key: group.id, t, config, state, group }))

  return h(
    'div',
    { className: 'mb-config' },
    state.problems.length === 0 ? null : h(Problems, { t, problems: state.problems }),
    h(ScopeBar, { t }),
    readOnly
      ? h(
          'fieldset',
          { className: 'mb-readonlyFieldset', disabled: true },
          h(
            'div',
            { className: 'mb-readonly' },
            h(
              'div',
              { className: 'mb-readonly__head' },
              h(Icon, { name: 'shield', size: 15, className: 'mb-readonly__glyph' }),
              h('span', null, t('rowConfigReadOnlyTitle')),
            ),
            h('p', { className: 'mb-readonly__desc' }, t('rowConfigReadOnlyBody')),
          ),
          groups,
        )
      : groups,
    readOnly ? null : h(SaveBar, { t, config, state, dirty }),
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
 *
 * **只读。** 这一页的语义是部署配置层，而插件只有项目层一个写入口 ——
 * 在这里保存会把部署配置写进仓库（见 `docs/08` P0-4）。
 * @param {{ t: Function, view: string, config: any }} props
 */
function ConfigPage(props) {
  const { t, view } = props
  if (view === 'summary') return t('configSummary')
  return h(ConfigForm, { t, config: props.config, readOnly: true })
}
