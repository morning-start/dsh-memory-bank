/**
 * 记忆面板（`conversation.view`）与它里面的项目配置抽屉。
 *
 * ## 为什么是会话视图、不是设置页
 *
 * 0.4.x 之前挂在 `settings.section`（设置弹窗左侧导航的一栏）。那个位置的
 * 问题是**要两级点击才能看见**：设置 → 记忆。而设置页是「改一次就不再进来」
 * 的地方，记忆库恰恰是「每天看一眼有没有积压」的地方 —— 入口的选择反了。
 *
 * 现在挂在对话区顶部那行 View 标签里（`对话 / 轨迹 / 团队视图 / … / 记忆`），
 * 和它并列的都是**当前会话正在看的东西**。这才是它的实际使用频率。
 *
 * 代价是它**只在有会话时存在**（`conversation.view` 的 scope 是 `session`）。
 * 这是可接受的：没有会话就没有仓库根，面板本来也只能显示「读不到」。
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
 * （`lib/adjudicate.js`）。面板里不许再写一份过滤或裁决逻辑。
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
 *
 * @param {{ remote: { memoryBank: Record<string, Function> } }} ctx
 * @param {Function} t
 * @param {{ current: string | null }} [sessionRef] 当前面板所属的会话。
 *   门面每次调用都会读它（`SESSION_ARG`）—— 宿主据此解析仓库根。
 *   `apply` 传同一个对象进来，`MemoryView` 挂载时写。
 */
function createMemoryController(ctx, t, sessionRef = { current: null }) {
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

    /**
     * 记住「这一栏现在属于哪个会话」。
     *
     * 必须在 `load()` **之前**调 —— 门面每次 RPC 都读它（`SESSION_ARG`），
     * 宿主用 `ctx.agents.get(sessionId)` 换回 Agent 再解析仓库根。
     *
     * 传空值（`undefined` / `''`）等于「不知道」：门面不传这个字段，宿主退回
     * `memo` / fallback，并在界面上把来源标出来（只要 `lastSource` 修好了）。
     *
     * @param {unknown} sessionId
     */
    useSession(sessionId) {
      sessionRef.current = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
    },

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
 * `conversation.view` 的注册体 —— 对话区顶部 View 标签里的一栏。
 *
 * 容器用 `mb-panel--view` 而不是 `mb-panel`：设置页由 section 容器给内边距，
 * 对话视图没有那一层，**而且它要自己吃掉整个面板高度**（否则短内容时下面
 * 留一片空白，长内容时被裁掉）。
 *
 * @param {{ t: Function, memory: any, config: any, sessionId?: string }} props
 */
function MemoryView(props) {
  const { t, sessionId } = props
  const memory = props.memory
  const state = React.useSyncExternalStore(memory.subscribe, memory.getSnapshot)

  /**
   * **切到这一栏（挂载）时：先报会话，再重新读一次。**
   *
   * 为什么不能只靠 `apply` 里那一轮：插件的客户端半边在**页面加载**时就装了，
   * 那时还没有任何会话 —— 宿主 `resolveRoot()` 拿不到 live Agent，只能回退到
   * 进程 cwd（profile 目录）。于是面板显示的是 profile 里的 0 条记忆，而路径
   * 看起来**像一条正常的绝对路径**，不手动刷新根本看不出问题。
   *
   * 而**光重读不够**：宿主那份 `memo` 是插件实例级的，切到另一个仓库的会话
   * 之后它还是上一个仓库。所以必须把 `sessionId` 一起带上去 ——
   * `useSession` 写进门面读的那个引用，宿主用 `ctx.agents.get(sessionId)`
   * 换回 Agent 再走同一条 `resolveRoot(agent)`。
   *
   * `load()` 不写 `status: 'loading'`，所以重读不会闪一下空白：旧数据一直
   * 留在屏幕上，直到新数据到达。
   */
  React.useEffect(() => {
    memory.useSession(sessionId)
    void memory.load()
  }, [memory, sessionId])

  return h(
    'div',
    { className: 'mb-panel mb-panel--view' },
    h(
      'div',
      { className: 'mb-panel__head' },
      h(
        'div',
        { className: 'mb-panel__headMain' },
        h('h2', { className: 'mb-panel__title' }, t('panelTitle')),
        h('p', { className: 'mb-panel__sub' }, t('panelSub')),
        state.overview?.root
          ? h(
              'p',
              { className: 'mb-panel__root' },
              h('span', { className: 'mb-panel__rootPath' }, state.overview.root),
              state.overview.rootSource === 'fallback'
                ? h(
                    'span',
                    { className: 'mb-badge mb-badge--warn', title: t('rootFallbackHint') },
                    t('rootFallback'),
                  )
                : null,
            )
          : null,
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
    state.overview?.rootSource === 'fallback' ? h(Note, { tone: 'error' }, t('rootFallbackHint')) : null,
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
