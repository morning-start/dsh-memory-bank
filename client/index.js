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
