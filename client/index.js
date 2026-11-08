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
 * `conversation.view` 由 `client-ui-conversation` 声明 —— 都是「条目挂着
 * 才有」。所以每一次 `register` 都必须包在 `ctx.slots.inject(owner, cb)` 里：
 * 槽塌陷时 effect 被释放，槽回来时 cb **重新跑一遍**。
 * 因此 cb 里**不许有副作用**，且必须返回 disposer（`CONTRACT.md` §8 第 9 条）。
 *
 * ## 为什么记忆面板挂在 `conversation.view` 而不是设置页
 *
 * 0.4.x 之前挂在 `settings.section`（设置 → 记忆）。那个位置要**两级点击**
 * 才能看见，而设置页是「改一次就不再进来」的地方 —— 记忆库恰恰是
 * 「每天看一眼有没有积压」的东西，入口的选择反了。
 *
 * 现在它是对话区顶部 View 标签里的一栏（`对话 / 轨迹 / 团队视图 / … / 记忆`），
 * 和它并列的都是**当前会话正在看的东西**。
 *
 * 代价：`conversation.view` 的 scope 是 `session`，所以**没有会话就没有这一栏**。
 * 可接受 —— 没有会话就没有仓库根，面板本来也只能显示「读不到」。
 *
 * ## 为什么不改成 `main` 槽
 *
 * `main` 是「侧栏条目选中后渲染的中央面板」，key 由 owner 派发。挂上去等于
 * 在侧栏多开一个入口去承载一个只读列表 —— 而侧栏是**切换工作上下文**的地方，
 * 不是「看当前仓库的积压」的地方。View 标签正好是后者。
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
 * 所以直觉上该写 `'remote.memoryBank'` —— 但**第三方包拿不到那一面**，
 * 而且写进 `inject` 是**硬依赖**。
 *
 * 实测（`dsh --profile web --port 0`，界面直接显示）：
 *
 * ```
 * web boot: 1 entry did not activate dsh-memory-bank:
 *   pending (waiting for service: remote.memoryBank)
 * ```
 *
 * 三块界面一个都不挂载 —— 包括那张本来只需要 `slots` 的卡片。
 *
 * ## 为什么改走 `connection.rpc.call`
 *
 * `ctx.remote.<ns>` 的 spec 是**构建期**产物：`dsh-api-remotes/lib/client.js`
 * 里把每个**随 dsh 发布**的包的 `typert.remote-client.js` 内联成二十几段
 * `//#region`。零构建的第三方插件没有那一环，`./remote` 导出没有任何东西会在
 * 浏览器里加载 —— 所以 `ctx.remote.memoryBank` **永远不存在**。
 *
 * 但**原始载体**是通的：`POST /api/memoryBank/<method>`，body 是
 * `{ type:'client-request', rpcId, method, payload:{ args } }`，
 * 回 `{ ok:true, value } | { ok:false, error }`。已实测三个端点全部 `ok:true`
 * 并带回真实数据。
 *
 * `connection` 是网关的客户端半边（`dsh-client-connection`），随任何 Web 宿主
 * 必然存在；`memoryBank` 这个命名空间在**调用时**才拼（见 `memoryBankFacade`）。
 */
const inject = ['slots', 'locale', 'connection']

/**
 * 方法的**具名参数表** —— 位置参数 → 线上字段名。
 *
 * 网关要求 `payload.args` 是**一个普通对象**（`assertExactArguments` 会按名字
 * 逐字段校验），不是数组。实测：传 `{ args: [] }` 会被
 * `Remote payload must contain exactly one plain-object args field` 拒掉。
 *
 * 客户端拿不到 `shared/endpoints.js`（自包含脚本不能 `import`），所以这里必有
 * 一份副本 —— 防漂移靠 `test/client.test.mjs` 的「与 shared 的防漂移」断言：
 * 方法集合与参数名逐条比对，少一条就红。
 */
const ARG_NAMES = Object.freeze({
  overview: [],
  pending: ['limit'],
  memories: ['query', 'limit'],
  drift: [],
  claims: [],
  ledger: ['limit'],
  config: [],
  projectConfig: [],
  init: [],
  accept: ['id'],
  reject: ['id', 'reason'],
  edit: ['id', 'patch'],
  retire: ['id', 'reason'],
  forget: ['id', 'confirm'],
  dream: [],
  promote: ['options'],
  setProjectConfig: ['patch'],
  resetProjectConfig: [],
})

/**
 * 每个面板方法都带的**公共参数**：调用方所在的会话 id。
 *
 * **逐字抄自 `shared/endpoints.js` 的 `SESSION_ARG`**（自包含脚本不能
 * `import`）。`test/client.test.mjs` 的防漂移断言比对「`ARG_NAMES` 每条
 * 加上这个尾巴」与 `shared/` 的 `args` 表，少一条就红。
 *
 * ## 为什么必须传
 *
 * 面板是 `conversation.view`，scope 是 `session` —— 它显示的**必须**是当前
 * 会话所在仓库。宿主在 RPC 面上拿不到 live Agent，只有 `memo` 可以兜底，
 * 而 `memo` 是**插件实例级**的：切到别的会话之后它还是上一个仓库。
 *
 * 客户端只报「我是谁」，目录由宿主用 `ctx.agents.get(sessionId)` 解析
 * （`lib/host/service.js` 的 `root()`）—— **不把路径交给客户端**。
 */
const SESSION_ARG = 'sessionId'

/**
 * 把 `memoryBank/*` 包成**惰性门面**。
 *
 * 视图按 `remote.memoryBank.overview()` 这样调用，门面负责拼 RPC。
 * 拿不到 `connection.rpc` 时不该白屏，也不该静默 —— 每个方法返回一个
 * **带原因**的 rejection，界面显示「数据不可用」并说明为什么。
 *
 * 这不是防御性编程，是这一版的核心判断（`docs/07` §2.9 ⑥）：
 * **可选能力不许拖死本体。**
 *
 * @param {any} ctx 浏览器插件上下文
 * @param {() => string | null} readSessionId 当前面板所属的会话（切栏时由
 *   `MemoryView` 写入）。拿不到就**不传**这个字段 —— 宿主会退回 `memo` /
 *   fallback，并在界面上标出来源。
 */
function memoryBankFacade(ctx, readSessionId) {
  const call = (method, positional) => {
    const names = ARG_NAMES[method]
    if (names === undefined) {
      return Promise.reject(new Error(`memoryBank: 未知 RPC 方法「${method}」（协议漂移？）`))
    }
    const carrier = ctx?.connection?.rpc
    if (typeof carrier?.call !== 'function') {
      return Promise.reject(
        new Error('记忆面板数据不可用：宿主没有提供 connection.rpc —— 这不是一个 Web 宿主。'),
      )
    }

    // 只带**真的传了**的参数：`reject(id)` 不带 reason 时不能塞 `reason: undefined`，
    // 网关按名字做精确匹配，多余的 undefined 字段会被判成「参数不符」。
    const args = {}
    for (let index = 0; index < names.length; index += 1) {
      if (positional[index] !== undefined) args[names[index]] = positional[index]
    }

    // 会话 id 恒在最后，且**不接受调用方传**：它只从 `MemoryView` 的挂载
    // 状态来。这样「面板显示的是哪个仓库」只有一个来源，不会出现
    // 「某个调用点忘了传、静默退回 memo」。
    const sessionId = typeof readSessionId === 'function' ? readSessionId() : null
    if (typeof sessionId === 'string' && sessionId !== '') args[SESSION_ARG] = sessionId

    // **原样返回 RPC 信封**（`{ ok, value } | { ok:false, error }`），不在这里拆。
    //
    // 视图侧的 `unwrap` / `unwrapMutation` 已经处理了双层信封：外层是传输结果，
    // 内层是 `MutationResult`（`{ ok:true, value, text } | { ok:false, error }`）。
    // 在这里先拆一层，视图就只能看到一层 —— 那会让「硬门拒绝」被当成「成功」。
    return Promise.resolve(carrier.call('/api', `memoryBank/${method}`, { args })).catch((cause) => {
      // 传输层失败是**抛**出来的（HTTP、rpcId 不匹配），要包成信封形状，
      // 否则视图里那个 `await` 会直接炸掉整个 tab，而不是渲染一条错误。
      throw new Error(`memoryBank/${method} 传输失败：${cause?.message ?? cause}`)
    })
  }

  return new Proxy(
    {},
    {
      get(_target, method) {
        return (...args) => call(String(method), args)
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

  /**
   * 面板当前所属的会话。**单值足够**：`conversation.view` 一次只渲染一栏
   * （宿主 `renderSlot(..., { only: viewId })`），不存在两栏同时挂载。
   *
   * 为什么必须由视图写进来：`apply` 在**页面加载**时跑，那时还没有任何会话；
   * 只有 `conversation.view` 的 `inject(sessionId)` 知道「用户现在在看哪个
   * 会话」。少了它，宿主只能退回 `memo` —— 而 `memo` 是插件实例级的，
   * 切会话之后还是上一个仓库。
   */
  const sessionRef = { current: null }

  // 视图只碰 `remote.memoryBank`，所以传门面而不是整个 ctx：
  // 这样「RPC 面还没好」不会在 render 期间抛，只在真正调用时变成一条可读的错误。
  const view = { remote: { memoryBank: memoryBankFacade(ctx, () => sessionRef.current) } }

  // 两个控制器活在 `apply` 这一层：槽塌陷再恢复时，暂存的修改和已读的数据
  // 都还在（`inject` 的回调会被反复调用，状态不能放那里面）。
  const config = createConfigController(view, t)
  const memory = createMemoryController(view, t, sessionRef)


  ctx.effect(() => {
    void config.load()
    // **刻意不在这里读记忆面板。**
    //
    // `apply` 跑在**页面加载**时，那时还没有任何会话 —— 宿主解析不到仓库根，
    // 只能回退到进程 cwd（profile 目录）。读了就是一次「显示错误仓库」的
    // 快照，而它看起来像一条正常的绝对路径，用户看不出问题。
    //
    // 面板是 `conversation.view`（scope: session）：**切到这一栏时读**
    // （`MemoryView` 的 effect），那一刻既有会话 id、又能重读。
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

  // ③ 「记忆」View 标签（对话区顶部那行 `对话 / 轨迹 / 团队视图 / …` 里的一栏）
  //
  // 为什么放在最后而不是最前：`order` 决定它排在哪一栏。60 让它在团队视图
  // 之后、Git 之前 —— 这两个是「看当前会话的数据」，记忆面板和它们同类。
  //
  // **`inject` 收 `sessionId`**（`conversation.view` 的 scope 是 `session`）：
  // 面板显示的必须是**当前会话所在仓库**，而宿主在 RPC 面上没有 live Agent。
  // 视图把它交给控制器，门面再随每次调用传给宿主（`SESSION_ARG`）。
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'memory-bank',
        order: 60,
        label: () => t('panelTitle'),
        locale: NS,
        inject: (sessionId) => ({ memory, config, sessionId }),
      },
      MemoryView,
    ),
  )
}

injectStyles()
