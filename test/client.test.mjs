/**
 * `client/client.js` 的验收。
 *
 * ## 为什么要在 `node:vm` 里真跑一遍
 *
 * 这个文件是**自包含 classic script**，没有 `import`、没有类型检查、没有
 * 构建期的符号解析。它错在哪一行，只有「加载它」能发现：
 *
 * - `id` 与 `package.json` 的 `name` 差一个字符 → `bundle ... loaded without
 *   registering` 抛在浏览器里，测试全绿（`CONTRACT.md` §1.2）；
 * - `require` 一个种子表外的包 → 同一个静默失败（§1.4）；
 * - `t('typo')` → 界面上出现 `typo` 字面量，不报错（§8 第 13 条）。
 *
 * 所以这里既做**源码级断言**（正则扫不能出现的东西），也做**真加载 + 真渲染**
 * （用假 React 跑一遍组件树，断可见文案）。
 *
 * ## 为什么假 React 只有五个 hook
 *
 * 组件用的是 `useSyncExternalStore`（读控制器快照）+ `useState`（chips 输入框）
 * + `useEffect`（抽屉的 Escape）。`useSyncExternalStore` 直接 `getSnapshot()`
 * 就够 —— 快照是普通的不可变对象，不需要订阅。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

import { GATE_HINTS, METHODS, NAMESPACE, SOURCES } from '../shared/endpoints.js'
import { OUTPUT, PARTS, buildClient } from '../scripts/build-client.mjs'

/** 签入的产物。所有源码级断言都扫它，不是扫 `views/*.js`。 */
const SOURCE = readFileSync(OUTPUT, 'utf8')

/* ============================ 假环境 ============================ */

/**
 * 假 `document`：`querySelector` 永远 null（强制走注入分支），
 * `createElement` 返回一个能记 `dataset` / `textContent` 的壳。
 */
function createFakeDocument() {
  const styles = []
  return {
    styles,
    querySelector() {
      return null
    },
    createElement() {
      return { dataset: {}, textContent: '' }
    },
    head: {
      appendChild(element) {
        styles.push(element)
      },
    },
    addEventListener() {},
    removeEventListener() {},
  }
}

/** 假 React。`createElement` 产出可遍历的普通对象。 */
function createFakeReact() {
  return {
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
      }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useRef(value) {
      return { current: value }
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
  }
}

/**
 * 把组件树展开成一串**宿主元素**（`type` 是字符串）与文字。
 *
 * 假 React 的 `createElement` 不展开函数组件 —— React 是在协调阶段调它们的。
 * 所以这里自己走一遍：遇到函数组件就调它，把返回值接着摊平。
 * @param {unknown} node
 * @param {Array<{ type?: unknown, props?: any, text?: string }>} [out]
 * @returns {Array<{ type?: unknown, props?: any, text?: string }>}
 */
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ text: String(node) })
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (typeof node === 'function') {
    flatten(node({}), out)
    return out
  }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'function') {
    const children = node.children.length === 1 ? node.children[0] : node.children
    flatten(node.type({ ...node.props, children }), out)
    return out
  }
  out.push({ type: node.type, props: node.props })
  for (const child of node.children) flatten(child, out)
  return out
}

/** 摊成一整段文字，方便 `includes`。 */
function textOfTree(tree) {
  return flatten(tree)
    .map((node) => node.text ?? '')
    .join('')
}

/** 找到树里所有满足条件的宿主元素。 */
function findAll(tree, predicate) {
  return flatten(tree).filter((node) => node.type !== undefined && predicate(node))
}

/* ============================ 假控制器 ============================ */

/** 界面 1 的数据源：三个分组，含一个嵌套字段、一个只读的语义通道字段。 */
const CONFIG_SNAPSHOT = {
  groups: [
    {
      id: 'autonomy',
      label: { zh: '自主度', en: 'Autonomy' },
      description: { zh: 'Agent 能自己决定多少。', en: 'How much.' },
      keys: ['autonomy'],
    },
    {
      id: 'thresholds',
      label: { zh: '审核阈值', en: 'Gate thresholds' },
      description: { zh: '十道门的数值判据。', en: 'Numeric criteria.' },
      keys: ['thresholds'],
    },
    {
      id: 'advanced',
      label: { zh: '高级', en: 'Advanced' },
      description: { zh: '改错会静默降级。', en: 'Wrong values degrade silently.' },
      keys: ['embedding', 'recall'],
    },
  ],
  fields: [
    {
      path: 'recall.maxBytes',
      group: 'advanced',
      top: 'recall',
      type: 'number',
      min: 100,
      step: 1,
      description: '注入预算（字节）；默认 4000',
      value: 4000,
      defaultValue: 4000,
      source: 'row',
      writable: true,
      projectScoped: false,
      projectWritable: false,
    },
    {
      path: 'autonomy',
      group: 'autonomy',
      top: 'autonomy',
      type: 'union',
      enum: ['manual', 'balanced', 'autonomous'],
      description: '自主度：manual / balanced / autonomous',
      value: 'balanced',
      defaultValue: 'balanced',
      source: 'project',
      writable: true,
      projectScoped: false,
      projectWritable: false,
    },
    {
      path: 'thresholds.autoAcceptFloor',
      group: 'thresholds',
      top: 'thresholds',
      type: 'number',
      min: 0,
      max: 1,
      step: 0.01,
      description: '自动落盘的置信地板；默认 0.60',
      value: 0.6,
      defaultValue: 0.6,
      source: 'default',
      writable: true,
      projectScoped: false,
      projectWritable: false,
    },
    {
      path: 'thresholds.content.natural',
      group: 'thresholds',
      top: 'thresholds',
      type: 'number',
      min: 0,
      max: 1,
      step: 0.01,
      description: '自然语言查询的门槛',
      value: 0.5,
      defaultValue: 0.5,
      source: 'default',
      writable: true,
      projectScoped: false,
      projectWritable: false,
    },
    {
      path: 'embedding.provider',
      group: 'advanced',
      top: 'embedding',
      type: 'union',
      enum: ['none', 'lexical', 'http'],
      description: 'none（默认，关闭）/ lexical / http',
      value: 'none',
      defaultValue: 'none',
      source: 'row',
      writable: false,
      projectScoped: false,
      projectWritable: false,
    },
    {
      path: 'embedding.timeoutMs',
      group: 'advanced',
      top: 'embedding',
      type: 'number',
      min: 100,
      step: 1,
      description: '单次调用超时；默认 10000',
      value: 10000,
      defaultValue: 10000,
      source: 'row',
      writable: false,
      projectScoped: false,
      projectWritable: false,
    },
  ],
  projectPath: 'E:\\repo\\.dsh-memory\\config.json',
  problems: ['config.json: 未知的键 "threshods"'],
}

const OVERVIEW = {
  root: 'E:\\repo\\.dsh-memory',
  active: 42,
  pending: 3,
  inbox: 0,
  problems: 1,
  claims: { open: 7, openActionable: 3, contradicted: 2, unverified: 1, resolved: 4 },
  lifecycle: { dormant: 9, reviewDue: 4, expired: 2, suggestsDeprecation: 0 },
  snapshot: { id: 'snap-1', compiledAt: '2026-11-01T00:00:00.000Z', documents: 42 },
  quota: { used: 42, limit: 50, mode: 'growth' },
}

const PENDING = [
  {
    id: 'p_1',
    kind: 'candidate',
    title: '连接池上限按 CPU 核数 × 2 定',
    confidence: '0.51',
    actionRisk: 'low',
    gates: ['G1'],
    why: ['scope 为空'],
    createdAt: new Date(Date.now() - 120_000).toISOString(),
  },
]

const DRIFT = [
  {
    id: 'm_1',
    bucket: 'quarantined',
    code: 'anchor-missing',
    detail: '被引用的文件不见了',
    anchors: ['src/db/pool.ts:42'],
  },
]

const LEDGER = [
  {
    at: new Date(Date.now() - 3_600_000).toISOString(),
    kind: 'resolve',
    id: null,
    proposalId: 'p_1',
    decision: 'accept',
    gate: 'G1',
    code: null,
    confidence: 0.51,
  },
]

/**
 * 假 `ctx.remote.memoryBank`。每个方法都记下调用，方便断言「写的是不是它」。
 *
 * 返回形状**照 `lib/host/queries.js` 的实际实现**：`pending` 是
 * `{ total, items }`、`drift` 是四个桶 + `counts` + `checked`，都不是裸数组。
 * 写操作返回 `MutationResult`（`{ ok: true, value, text }`），外面还套一层
 * RPC 信封 —— 和真实线上一致。
 * @returns {{ calls: Array<{ method: string, args: unknown[] }>, face: Record<string, Function> }}
 */
function createFakeRemote() {
  const calls = []
  const record = (method, value) => (...args) => {
    calls.push({ method, args })
    return Promise.resolve({ ok: true, value })
  }
  const mutation = (method) => (...args) => {
    calls.push({ method, args })
    return Promise.resolve({ ok: true, value: { ok: true, value: null, text: '已处理' } })
  }
  return {
    calls,
    face: {
      overview: record('overview', OVERVIEW),
      pending: record('pending', { total: PENDING.length, items: PENDING }),
      memories: record('memories', [
        {
          id: 'm_1',
          title: '只用 --dsw-alias-* token',
          kind: 'convention',
          status: 'active',
          confidence: '0.8',
          updatedAt: new Date(Date.now() - 600_000).toISOString(),
          accessCount: 4,
          lastRecalledAt: new Date(Date.now() - 300_000).toISOString(),
        },
      ]),
      drift: record('drift', {
        quarantined: DRIFT,
        advisory: [],
        unsafePath: [],
        notADefinition: [],
        counts: { quarantined: 1, advisory: 0, unsafePath: 0, notADefinition: 0 },
        checked: 12,
        unverifiable: 0,
        at: new Date().toISOString(),
      }),
      claims: record('claims', {
        open: 7,
        openActionable: 3,
        contradicted: 2,
        unverified: 1,
        resolved: 4,
        total: 14,
      }),
      ledger: record('ledger', LEDGER),
      config: record('config', CONFIG_SNAPSHOT),
      projectConfig: record('projectConfig', { path: 'config.json', exists: true, value: {} }),
      accept: mutation('accept'),
      reject: mutation('reject'),
      edit: mutation('edit'),
      retire: mutation('retire'),
      forget: mutation('forget'),
      dream: mutation('dream'),
      promote: mutation('promote'),
      setProjectConfig: mutation('setProjectConfig'),
      resetProjectConfig: mutation('resetProjectConfig'),
    },
  }
}

/**
 * 假 `ctx`。`effect` 立即执行回调（cordis 语义），`slots.inject` 记下回调
 * 等测试自己去调（真实语义是「槽声明时同步跑」）。
 */
function createFakeCtx() {
  const registrations = []
  const injections = []
  const disposers = []
  const dictionaries = []
  const remote = createFakeRemote()

  const locale = {
    register(ns, dicts) {
      dictionaries.push({ ns, dicts })
      return () => {}
    },
    bind(ns) {
      return (key, params) => {
        const dict = dictionaries.find((entry) => entry.ns === ns)?.dicts?.zh ?? {}
        const template = typeof dict[key] === 'string' ? dict[key] : key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) =>
          name in params ? String(params[name]) : match,
        )
      }
    },
  }

  const slots = {
    inject(owner, callback) {
      injections.push({ owner, callback })
      return () => {}
    },
    register(options, component) {
      const dispose = () => {}
      registrations.push({ options, component, dispose })
      return dispose
    },
  }

  const ctx = {
    locale,
    slots,
    remote: { memoryBank: remote.face },
    effect(callback) {
      const dispose = callback()
      disposers.push(dispose)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }

  return { ctx, registrations, injections, disposers, dictionaries, calls: remote.calls }
}

/**
 * 加载产物，跑 `apply`，把三个槽的注册体都装出来。
 * @returns {Promise<{ module: any, registrations: any[], injections: any[], styles: any[], t: Function, calls: any[], disposers: any[] }>}
 */
async function mount() {
  let captured
  const document = createFakeDocument()
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) {
          captured = spec
        },
      },
    },
    document,
    console,
    setTimeout,
    clearTimeout,
  }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'client/client.js' })

  assert.ok(captured !== undefined, '产物没有调用 window.__ModuleLoader__.load')

  const react = createFakeReact()
  const required = []
  const module_ = captured.factory((spec) => {
    required.push(spec)
    assert.equal(spec, 'react', `只允许 require('react')，实际 require(${JSON.stringify(spec)})`)
    return react
  })
  assert.deepEqual(required, ['react'])

  const fake = createFakeCtx()
  module_.apply(fake.ctx)

  // 槽声明时回调同步跑 —— 这里手动模拟一次。
  for (const injection of fake.injections) {
    const dispose = injection.callback()
    assert.equal(
      typeof dispose,
      'function',
      `slots.inject('${injection.owner}') 的回调必须返回 disposer（CONTRACT §8 第 9 条）`,
    )
  }

  // 控制器在 apply 里就发起了第一轮读取；等微任务落地。
  await new Promise((resolve) => setTimeout(resolve, 0))

  return {
    module: module_,
    registrations: fake.registrations,
    injections: fake.injections,
    styles: document.styles,
    t: fake.ctx.locale.bind('memoryBank'),
    dictionaries: fake.dictionaries,
    calls: fake.calls,
    disposers: fake.disposers,
  }
}

/** 按槽名取注册体。 */
function registrationOf(registrations, name) {
  const found = registrations.filter((entry) => entry.options.name === name)
  assert.equal(found.length, 1, `槽 ${name} 应该正好注册一次，实际 ${found.length} 次`)
  return found[0]
}

/* ============================== 构建 ============================== */

test('client 构建：签入的 client/client.js 与一次全新构建逐字节一致', () => {
  const fresh = buildClient()
  assert.equal(
    SOURCE,
    fresh,
    'client/client.js 与 views/*.js 不同步；跑 node scripts/build-client.mjs 重新生成',
  )
  assert.ok(fresh.length > 10_000, `产物只有 ${fresh.length} 字节，像是少拼了片段`)
})

test('client 构建：片段顺序固定，装配点最后', () => {
  assert.deepEqual(PARTS[PARTS.length - 1], 'client/index.js')
  assert.deepEqual(PARTS[0], 'client/locale.js')
  // 纯函数：连跑两次必须同字节（不读时间、不读 env）。
  assert.equal(buildClient(), buildClient())
})

test('client 产物：UTF-8 无 BOM 的 classic script', () => {
  assert.notEqual(SOURCE.charCodeAt(0), 0xfeff, '产物带 BOM')
  assert.ok(SOURCE.startsWith('/*'), '产物应该以注释开头')
  assert.equal(/^\s*import\s/m.test(SOURCE), false, '产物不能有 import 语句')
  assert.equal(/^\s*export\s/m.test(SOURCE), false, '产物不能有 export 语句')
  assert.equal(SOURCE.includes('\r\n'), false, '产物必须是 LF（.gitattributes 是 eol=lf）')
})

/* ============================ loader 契约 ============================ */

test('client 加载：id 等于包名，factory 返回带 apply 的 exports', async () => {
  const { module: mod } = await mount()
  assert.equal(mod.apply === undefined, false)
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject))
})

test('client 加载：inject 只声明必然存在的服务（**不**写 remote.memoryBank）', async () => {
  const { module: mod } = await mount()
  assert.ok(mod.inject.includes('slots'), 'inject 缺 slots')
  assert.ok(mod.inject.includes('locale'), 'inject 缺 locale')
  assert.ok(mod.inject.includes('remote'), 'inject 缺 remote（网关的客户端半边）')

  // **这是回归，不是洁癖。** `remote.memoryBank` 是点号服务键，宿主把面板服务
  // 注册好之前它不存在 —— 写进 `inject` 就是硬依赖，整个客户端条目会停在
  // `pending (waiting for service: remote.memoryBank)`，**三块界面一个都不挂载**。
  // 实测过一次：dsh web 首屏直接显示 `web boot: 1 entry did not activate`。
  assert.equal(
    mod.inject.includes(`remote.${NAMESPACE}`),
    false,
    `inject 不许写 remote.${NAMESPACE} —— 那是硬依赖，会拖死整片 UI。` +
      '命名空间在调用时由 memoryBankFacade 惰性解析。',
  )
})

test('client 加载：id 必须等于 package.json 的 name', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(
    SOURCE.includes(`id: "${pkg.name}"`),
    `产物的 loader id 必须逐字等于 package.json 的 name（${pkg.name}）`,
  )
})

/* ============================== 槽注册 ============================== */

test('client 槽注册：正好三个，name / id / key / order 都对', async () => {
  const { registrations } = await mount()
  assert.equal(registrations.length, 3, `应该正好 3 个注册，实际 ${registrations.length}`)
  assert.deepEqual(
    registrations.map((entry) => entry.options.name).sort(),
    ['plugins.item', 'plugins.row.config', 'settings.section'],
  )

  const item = registrationOf(registrations, 'plugins.item')
  assert.equal(item.options.id, 'memory-bank')
  assert.equal(item.options.order, 60)
  assert.equal(item.options.locale, 'memoryBank')
  assert.equal(typeof item.options.label, 'function', 'plugins.item 的 label 必须是 thunk')
  assert.equal(item.options.label(), '记忆库')

  const row = registrationOf(registrations, 'plugins.row.config')
  assert.equal(row.options.key, 'dsh-memory-bank#memory-bank')
  assert.equal(row.options.id, undefined)

  const section = registrationOf(registrations, 'settings.section')
  assert.equal(section.options.id, 'memory-bank')
  assert.equal(section.options.order, 40)
  assert.equal(section.options.locale, 'memoryBank')
  assert.equal(typeof section.options.label, 'function', 'settings.section 的 label 必须是 thunk')
  assert.equal(section.options.label(), '记忆')
})

test('client 槽注册：priority 由运行时分配，不许硬编码', async () => {
  const { registrations } = await mount()
  for (const entry of registrations) {
    assert.equal(
      entry.options.priority,
      undefined,
      'priority 是运行时分配的（CONTRACT §2.1），硬编码会让 shadowing 顺序不可预期',
    )
  }
})

test('client 槽注册：每个 disposer 都是函数，且三个槽都走 inject', async () => {
  const { registrations, injections, disposers } = await mount()
  for (const entry of registrations) {
    assert.equal(typeof entry.dispose, 'function', `${entry.options.name} 没有返回 disposer`)
  }
  assert.deepEqual(
    injections.map((injection) => injection.owner).sort(),
    ['plugins.item', 'plugins.row.config', 'settings.section'],
    '每一次 register 都必须包在 ctx.slots.inject 里',
  )
  // effect 的清理函数：字典 + 面板数据各一个。
  assert.equal(disposers.length, 2, `apply 里应该有两个 ctx.effect，实际 ${disposers.length}`)
  for (const dispose of disposers) {
    assert.equal(typeof dispose, 'function', 'ctx.effect 的回调必须返回清理函数')
  }
})

/* ============================ 硬约束（源码级） ============================ */

test('硬约束：不 require 任何 @deepseek-ai/* 包', () => {
  const match = SOURCE.match(/require\(\s*["'`]@deepseek-ai\//)
  assert.equal(match, null, `禁止 require Harness Client 包（practices.md:35）：${match?.[0]}`)
})

test('硬约束：不用 main 槽', () => {
  const match = SOURCE.match(/\bname\s*:\s*["']main["']/)
  assert.equal(match, null, 'main 槽会替换宿主中央面板（docs/07 §2.9 ①）')
})

test('硬约束：不写 document.body，不在组件外动 DOM', () => {
  assert.equal(
    /document\.body\.(append|insert|prepend)/.test(SOURCE),
    false,
    '不要在 document.body 上挂东西（practices.md:36）',
  )
})

test('硬约束：样式标签在 factory 体里注入，并自带 data-plugin', async () => {
  const { styles } = await mount()
  assert.equal(styles.length, 1, `应该正好注入一个 <style>，实际 ${styles.length}`)
  assert.equal(styles[0].dataset.plugin, 'dsh-memory-bank')
  assert.equal(styles[0].dataset.pluginCss, 'dsh-memory-bank/app.css')
  assert.ok(styles[0].textContent.length > 2_000, '样式表太短，像是没拼进来')
})

test('样式：只用 --dsw-alias-* / --mb-* token，没有裸色值', async () => {
  const { styles } = await mount()
  const css = styles[0].textContent

  const rawColor = /(#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\()/
  const bad = css.match(rawColor)
  assert.equal(bad, null, `CSS 里出现裸色值：${bad?.[0]}`)

  const tokens = new Set([...css.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)].map((match) => match[1]))
  assert.ok(tokens.size > 10, '一个 token 都没用，说明没走宿主主题')
  for (const token of tokens) {
    assert.ok(
      token.startsWith('--dsw-alias-') || token.startsWith('--mb-'),
      `未授权的自定义属性 ${token}（只允许 --dsw-alias-* / --mb-*）`,
    )
  }

  // 类名必须带 mb- 前缀，否则会和宿主撞名。
  const classes = new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((match) => match[1]))
  for (const name of classes) {
    assert.ok(name.startsWith('mb-'), `类名 ${name} 没有 mb- 前缀（practices.md:35）`)
  }
})

/* ======================== 与 shared/ 的防漂移 ======================== */

test('漂移：GATE_HINTS 与 shared/endpoints.js 逐条一致', async () => {
  const { dictionaries } = await mount()
  const { zh, en } = dictionaries[0].dicts
  const gates = Object.keys(GATE_HINTS)
  assert.ok(gates.length >= 10, `十道门里少了（只有 ${gates.length} 道）`)
  for (const gate of gates) {
    const entry = GATE_HINTS[gate]
    assert.ok(
      SOURCE.includes(entry.hint),
      `GATE_HINTS.${gate}.hint 与 shared/endpoints.js 不一致 —— 客户端里那份是复制来的，必须逐字相同`,
    )
    assert.equal(zh[`gate.${gate}`], entry.name.zh, `字典里的 ${gate} 门名与 shared/endpoints.js 不一致`)
    assert.equal(en[`gate.${gate}`], entry.name.en, `字典里的 ${gate} 英文门名不一致`)
    assert.ok(
      ['REJECT', 'DEFER'].includes(entry.decision),
      `GATE_HINTS.${gate}.decision 只能是 REJECT / DEFER`,
    )
  }
})

test('漂移：SOURCES 的四个层名与 shared/endpoints.js 一致', () => {
  assert.deepEqual(
    SOURCES.map((source) => source.id),
    ['default', 'project', 'env', 'row'],
  )
  for (const source of SOURCES) {
    assert.ok(SOURCE.includes(source.zh), `来源文案 ${source.zh} 不在产物里`)
    assert.ok(SOURCE.includes(source.en), `来源文案 ${source.en} 不在产物里`)
    assert.ok(SOURCE.includes(`mb-source--${source.id}`), `缺少 .mb-source--${source.id} 样式`)
  }
})

test('漂移：调用的 RPC 方法都在 shared/endpoints.js 的 METHODS 里', () => {
  const called = new Set(
    [...SOURCE.matchAll(/memoryBank\.([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]),
  )
  assert.ok(called.size >= 14, `只调用了 ${called.size} 个方法，像是少了一块界面`)
  for (const method of called) {
    assert.ok(METHODS.includes(method), `memoryBank.${method} 不在 METHODS 里（拼错了？）`)
  }
  for (const method of [
    'overview',
    'pending',
    'memories',
    'drift',
    'claims',
    'ledger',
    'config',
    'setProjectConfig',
    'resetProjectConfig',
    'accept',
    'reject',
    'edit',
    'retire',
    'forget',
  ]) {
    assert.ok(called.has(method), `没有调用 memoryBank/${method}，界面上少一块数据`)
  }
})

/* ============================== 文案 ============================== */

test('文案：中英字典键集合完全一致，且没有空值', async () => {
  const { dictionaries } = await mount()
  assert.equal(dictionaries.length, 1, '应该注册一份字典')
  assert.equal(dictionaries[0].ns, 'memoryBank')

  const { zh, en } = dictionaries[0].dicts
  assert.deepEqual(
    Object.keys(zh).sort(),
    Object.keys(en).sort(),
    '中英字典的键集合不一致 —— t() 会在另一种语言里回退成键名',
  )
  for (const [key, value] of Object.entries(zh)) {
    assert.equal(typeof value, 'string', `zh.${key} 不是字符串`)
    assert.ok(value.length > 0, `zh.${key} 是空串`)
  }
  for (const [key, value] of Object.entries(en)) {
    assert.equal(typeof value, 'string', `en.${key} 不是字符串`)
    assert.ok(value.length > 0, `en.${key} 是空串`)
  }
})

test('文案：t() 用到的每个键都在字典里（否则界面上出现键名）', async () => {
  const { t, dictionaries } = await mount()
  const { zh } = dictionaries[0].dicts

  // 直接写出来的键。
  for (const match of SOURCE.matchAll(/\bt\('([^']+)'/g)) {
    assert.ok(match[1] in zh, `t('${match[1]}') 没有中文文案`)
  }
  // 通过映射表写出来的键（`t(KIND_KEYS[x] ?? 'kind.unknown')` 这种）。
  for (const match of SOURCE.matchAll(
    /'((?:source|status|kind|bucket|ledger|tab|autonomy|health|time)\.[A-Za-z]+)'/g,
  )) {
    assert.ok(match[1] in zh, `文案键 ${match[1]} 不在字典里`)
  }

  assert.equal(t('save'), '保存')
  assert.equal(t('dirtyCount', { count: 2 }), '2 项已修改')
  assert.equal(t('saveNote', { path: 'config.json' }), '保存在 config.json，会进 git 随 PR review。')
})

test('文案：未开闸的那句话逐字在产物里', () => {
  assert.ok(
    SOURCE.includes(
      '不是漏了开关，是闸没开：本地实测的通道分离度只有 +0.063，够不到 0.15 的开工判据。',
    ),
    '语义通道的「为什么」必须逐字出现在界面上（docs/07 §3 ③）',
  )
})

/* ============================== 渲染 ============================== */

test('渲染：插件卡片 summary 是一句话，page 是整页配置', async () => {
  const { registrations, t } = await mount()
  const item = registrationOf(registrations, 'plugins.item')
  const injected = item.options.inject()

  const summary = item.component({ t, view: 'summary', ...injected })
  assert.equal(typeof summary, 'string')
  assert.ok(summary.includes('记忆'), `summary 不像一句话：${summary}`)

  const page = item.component({ t, view: 'page', ...injected })
  const text = textOfTree(page)
  for (const expected of [
    '配置分四层生效', // 作用域提示条
    '项目配置有问题', // problems（types.d.ts 要求必须显示）
    '自主度', // 分组标题
    'Agent 能自己决定多少。', // 分组说明（宿主给的是 { zh, en }）
    '项目配置', // 来源徽标
    '默认值', // 来源徽标
    '部署配置', // 来源徽标（embedding.provider）
    '来自部署配置，改这里不生效。', // 锁住的解释
    '高级：按查询类型分开设阈值', // 嵌套字段折叠
    '语义通道', // 只读能力块
    '未开闸',
    '不是漏了开关，是闸没开',
    '没有修改', // 保存条
  ]) {
    assert.ok(text.includes(expected), `配置页上没找到「${expected}」`)
  }
})

test('渲染：只读字段的输入框真的带 disabled', async () => {
  const { registrations, t } = await mount()
  const item = registrationOf(registrations, 'plugins.item')
  const page = item.component({ t, view: 'page', ...item.options.inject() })

  const inputs = findAll(page, (node) => node.type === 'input')
  const text = textOfTree(page)
  assert.ok(inputs.length > 0, '一个输入框都没有')
  const ids = inputs.map((node) => node.props.id).filter(Boolean)
  assert.ok(ids.includes('mb-field-thresholds.autoAcceptFloor'), '阈值输入框不见了')

  // 语义通道是只读的：那两个字段根本不渲染 input（走 dl/dd 展示）。
  assert.equal(
    ids.includes('mb-field-embedding.timeoutMs'),
    false,
    '语义通道是只读块，不该有输入框',
  )
  assert.ok(text.includes('10000'), '语义通道没有把 timeoutMs 显示出来')
  assert.ok(text.includes('embedding.provider'), '语义通道没有把字段路径显示出来')
})

test('渲染：暂存修改 → 保存条出现计数，保存走 setProjectConfig 且摊成嵌套对象', async () => {
  const { registrations, t, calls } = await mount()
  const item = registrationOf(registrations, 'plugins.item')
  const injected = item.options.inject()
  const { config } = injected

  config.edit('thresholds.autoAcceptFloor', '0.7')
  config.edit('thresholds.content.natural', '0.55')

  const page = item.component({ t, view: 'page', ...injected })
  assert.ok(textOfTree(page).includes('2 项已修改'), '保存条没有反映暂存数量')

  await config.save()

  const saved = calls.filter((call) => call.method === 'setProjectConfig')
  assert.equal(saved.length, 1, '应该写一次项目层')
  // 跨 realm：vm 里造出来的对象原型不同，先过一遍 JSON。
  assert.deepEqual(JSON.parse(JSON.stringify(saved[0].args[0])), {
    thresholds: { autoAcceptFloor: 0.7, content: { natural: 0.55 } },
  })
})

test('渲染：改回原值就从暂存里摘掉（「没有修改」要真的没有）', async () => {
  const { registrations } = await mount()
  const item = registrationOf(registrations, 'plugins.item')
  const { config } = item.options.inject()
  config.edit('thresholds.autoAcceptFloor', '0.7')
  assert.equal(config.dirtyCount(), 1)
  config.edit('thresholds.autoAcceptFloor', 0.6)
  assert.equal(config.dirtyCount(), 0)
})

test('渲染：配置页 summary 是一句话', async () => {
  const { registrations, t } = await mount()
  const row = registrationOf(registrations, 'plugins.row.config')
  const summary = row.component({ t, view: 'summary', ...row.options.inject() })
  assert.equal(typeof summary, 'string')
  assert.ok(summary.length > 4)
})

test('渲染：记忆面板健康概览 + 待决 + 四道门的解释', async () => {
  const { registrations, t } = await mount()
  const section = registrationOf(registrations, 'settings.section')
  const injected = section.options.inject()

  const tree = section.component({ t, close: () => {}, ...injected })
  const text = textOfTree(tree)

  for (const expected of [
    '记忆', // 面板标题
    '活跃',
    '待决',
    '漂移',
    '配额',
    'open 7（可行动 3）', // claims
    '休眠 9',
    '队列 0',
    '通过',
    '编辑',
    '拒绝',
    'G1', // 哪道门没过
    '归属门', // GATE_HINTS 的正文
  ]) {
    assert.ok(text.includes(expected), `记忆面板上没找到「${expected}」`)
  }

  // 四道门 → 四个 tab
  const tabs = findAll(tree, (node) => node.props.role === 'tab')
  assert.equal(tabs.length, 4, `应该有四个 tab，实际 ${tabs.length}`)
})

test('渲染：切 tab 能出记忆 / 漂移 / 审计', async () => {
  const { registrations, t } = await mount()
  const section = registrationOf(registrations, 'settings.section')
  const injected = section.options.inject()
  const { memory } = injected

  memory.setTab('memories')
  let tree = section.component({ t, close: () => {}, ...injected })
  assert.ok(
    findAll(tree, (node) => node.type === 'input' && typeof node.props.placeholder === 'string').some(
      (node) => node.props.placeholder.includes('搜索记忆'),
    ),
    '记忆 tab 没有搜索框',
  )
  assert.ok(textOfTree(tree).includes('只用 --dsw-alias-* token'), '记忆列表没有内容')

  memory.setTab('drift')
  tree = section.component({ t, close: () => {}, ...injected })
  let text = textOfTree(tree)
  assert.ok(text.includes('隔离'), '漂移 tab 没有桶名')
  assert.ok(text.includes('src/db/pool.ts:42'), '漂移 tab 没有锚点')

  memory.setTab('ledger')
  tree = section.component({ t, close: () => {}, ...injected })
  text = textOfTree(tree)
  assert.ok(text.includes('裁决'), '审计 tab 没有条目类型')
})

test('渲染：项目配置抽屉只列仓库属性，并指向配置页', async () => {
  const { registrations, t } = await mount()
  const section = registrationOf(registrations, 'settings.section')
  const injected = section.options.inject()
  const { memory, config } = injected

  // 造一个带仓库属性的快照：直接改控制器里那份数据太脏，用 setProjectConfig
  // 的返回值不方便，所以这里只验证「抽屉打开时用 projectScoped 过滤」。
  memory.openDrawer()
  const tree = section.component({ t, close: () => {}, ...injected })
  const text = textOfTree(tree)
  assert.ok(text.includes('项目配置'), '抽屉标题不在')
  assert.ok(text.includes('只对这个仓库生效'), '抽屉副标题不在')
  assert.ok(text.includes('进 git'), '抽屉的边界说明不在')
  assert.ok(text.includes('config.json'), '抽屉没有显示文件路径')

  // 夹具里没有 projectScoped 字段 → 全部继承 → 列出其余分组。
  assert.ok(text.includes('其余'), '继承提示不在')
  assert.ok(config !== undefined)
})

test('渲染：翻译函数缺键时回退成键名而不是崩', async () => {
  const { registrations } = await mount()
  const item = registrationOf(registrations, 'plugins.item')
  const t = (key) => key
  const summary = item.component({ t, view: 'summary', ...item.options.inject() })
  assert.equal(summary, 'cardSummary')
})

/* ============================== 形状 ============================== */

test('形状：describeFields() 的字段表能被这一页直接渲染（可选，缺 peer 时跳过）', async (t) => {
  let describeFields
  try {
    ;({ describeFields } = await import('../lib/config/schema.js'))
  } catch {
    t.skip('@deepseek-ai/schemastery 没链接，跳过')
    return
  }
  const { groups, fields } = describeFields()
  assert.ok(groups.length >= 6, `应该有六个分组，实际 ${groups.length}`)
  for (const field of fields) {
    assert.equal(typeof field.path, 'string')
    assert.equal(typeof field.group, 'string')
    assert.equal(typeof field.type, 'string')
    assert.equal(typeof field.projectScoped, 'boolean')
    // 叶子才有值；容器靠 children 认出来。
    if (field.children === undefined) {
      assert.ok(field.path.split('.').length >= 1)
    }
  }
})
