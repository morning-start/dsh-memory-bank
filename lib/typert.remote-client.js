/**
 * 客户端面的 Typert 清单（`package.json` 的 `exports["./remote"]`）。
 *
 * ## 手写，不是生成器产物
 *
 * 理由与 `lib/typert.host.js` 文件头相同：这个仓库没有构建步骤，也没有装
 * `@deepseek-ai/dsh-typert-generator`。手写能成立的依据是
 * `createTypertRemoteInfo`（`@deepseek-ai/dsh-typert-protocol/remote-info`）
 * 只做**惰性组装**：它把 `spec.methods` 摊成 `descriptors` + `methods`，
 * 参数 schema 只在有人调 `method.input()` 时才构造。
 *
 * ## 为什么 `result.mode` 是 `'src-json'`
 *
 * 与宿主面一致（见 `lib/host/service.js` 文件头的调查）：本包走 **SRC 回退**
 * 派发，没有严格 codec。所以这里没有 `typeSymbol` / `create`，只有
 * `{ mode: 'src-json' }` —— 网关用 `encodeRuntimeResult` 做 JSON 可序列化
 * 校验后原样过线。
 *
 * 代价：**参数只做字段名精确匹配，不做 schema 校验**；返回值只校验
 * JSON 可序列化。收益：零 codegen、零构建。
 *
 * ## 依赖说明（**重要**）
 *
 * 这个文件 `import { z } from 'zod'`，与生成器产物一字不差
 * （`dsh-client-ui-plugin-manager/lib/typert.remote-client.js:1-4`）。
 * `zod` **没有**写进本包的 `package.json`（那份文件不在本次改动范围内）。
 * 在浏览器侧这不是问题：`zod` 是平台种子表里的词（`CONTRACT.md` §1.4 第 6 条），
 * `require('zod')` 直接命中。但如果将来有非浏览器消费者，必须先补上这条依赖。
 *
 * 本文件**没有任何宿主侧读取点** —— 它是给客户端 bundle 用的。
 */

import { z } from 'zod'

import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'

import { MUTATIONS, METHODS, NAMESPACE, QUERIES } from '../shared/endpoints.js'

/**
 * 参数的说明文案。
 *
 * 与 `shared/endpoints.js` 的 `args` 数组**同位**：那份文件是字段名的事实源，
 * 这里只补「这个字段是干什么的」。两边少一条会在下面 `parametersOf` 里直接抛。
 */
const PARAMETER_DESCRIPTIONS = Object.freeze({
  limit: '条数上限。缺省由方法自己决定（pending / memories 默认 10，ledger 默认 50）。',
  query: '检索词。传空串时退化为「最近的条目」，不会报错。',
  id: '目标 id：待决提案的 `p_…` 或记忆的 snake_case 键。',
  reason: '为什么这样裁 / 为什么退休，写进审计日志。可省略。',
  patch: '要合并进去的字段。`edit` 只认内容字段；`setProjectConfig` 只认仓库属性（capture / quota / template / safety）。',
  confirm: '破坏性操作的显式确认。**必须 `true`** —— 这是用户的确认，不是调用方能自己给的。',
  options: '推广选项：`format` / `minConfidence` / `write`。',
})

/** 线上方法 → 参数名数组（事实源在 `shared/endpoints.js`）。 */
const ARGUMENTS = Object.freeze(
  Object.fromEntries([...Object.values(QUERIES), ...Object.values(MUTATIONS)].map((entry) => [entry.method, entry.args])),
)

function parametersOf(method) {
  const args = ARGUMENTS[method]
  if (!Array.isArray(args)) throw new Error(`typert: 方法 ${method} 没有登记参数表 —— 与 shared/endpoints.js 漂移了`)
  return args.map((name) => {
    const description = PARAMETER_DESCRIPTIONS[name]
    if (typeof description !== 'string') {
      throw new Error(`typert: 参数 ${name} 没有说明文案 —— 新参数请补 PARAMETER_DESCRIPTIONS`)
    }
    return {
      name,
      wire: name,
      source: 'json',
      // `src-json` = 只做 JSON 可序列化校验，没有 schema。见文件头。
      codec: { mode: 'src-json' },
      description,
    }
  })
}

/** 一个方法的描述符（不含 `id` / `namespace` / `method` —— 那些由 `RemoteInfo` 派生）。 */
function methodSpec(method, description) {
  return {
    service: NAMESPACE,
    description,
    invocation: { kind: 'direct' },
    parameters: parametersOf(method),
    result: { mode: 'src-json' },
  }
}

const METHODS_SPEC = Object.freeze({
  [`${NAMESPACE}/overview`]: methodSpec('overview', '健康概览：一行数字，界面 2 的顶部。口径与 `/memory status` 逐字一致。'),
  [`${NAMESPACE}/pending`]: methodSpec('pending', '待决提案列表（最新的在前）。`gates` 是**没过的那几道**，界面据此写「改哪里」。'),
  [`${NAMESPACE}/memories`]: methodSpec('memories', '记忆检索。走真实召回（与 Agent 看到同一套排序）；`query` 为空串时退化成「最近的条目」。'),
  [`${NAMESPACE}/drift`]: methodSpec('drift', '漂移三桶：quarantined（目标消失）/ advisory（切片变了）/ unsafePath（锚点逃出仓库）。'),
  [`${NAMESPACE}/claims`]: methodSpec('claims', '断言对账：open / openActionable / contradicted / unverified / resolved。'),
  [`${NAMESPACE}/ledger`]: methodSpec('ledger', '审计时间线（ledger 尾部）。只读。'),
  [`${NAMESPACE}/config`]: methodSpec('config', '四层配置快照 + 每个字段的来源/可写性（界面 1 的数据源）。'),
  [`${NAMESPACE}/projectConfig`]: methodSpec('projectConfig', '项目层配置（界面 3 的抽屉）。读的是原始文件，不经过合并。'),
  [`${NAMESPACE}/accept`]: methodSpec('accept', '接受一条待决提案。**会重跑硬门** —— 裁决权不是豁免权。'),
  [`${NAMESPACE}/reject`]: methodSpec('reject', '拒绝一条待决提案（进 `pending/rejected/` 留档，不参与召回）。'),
  [`${NAMESPACE}/edit`]: methodSpec('edit', '编辑后接受。`patch` 只认内容字段；id / status / 时间戳由系统管。'),
  [`${NAMESPACE}/retire`]: methodSpec('retire', '退休一条记忆（软删除）：转 deprecated，正文保留，退出召回。'),
  [`${NAMESPACE}/forget`]: methodSpec('forget', '永久删除。**必须 `confirm: true`** —— 破坏性操作不能靠默认值发生。'),
  [`${NAMESPACE}/dream`]: methodSpec('dream', '跑一次 dream pass 并暂存提案（**不改记忆、不写关系**）。'),
  [`${NAMESPACE}/promote`]: methodSpec('promote', '生成可推广到全局记忆的包（**只产出，不写全局存储**）。'),
  [`${NAMESPACE}/setProjectConfig`]: methodSpec('setProjectConfig', '写项目层（`<repo>/.dsh-memory/config.json`）。只认仓库属性。'),
  [`${NAMESPACE}/resetProjectConfig`]: methodSpec('resetProjectConfig', '重置项目层（写回只有文件头的文件，不是删文件）。'),
})

/** 与 `METHODS` 的漂移检查。少一个方法 = 客户端拿到 `undefined`，而没有人会知道。 */
function assertParity() {
  const described = Object.keys(METHODS_SPEC).sort()
  const expected = [...METHODS].map((method) => `${NAMESPACE}/${method}`).sort()
  if (described.length !== expected.length || described.some((endpoint, index) => endpoint !== expected[index])) {
    throw new Error(
      `typert: 客户端清单与 shared/endpoints.js 的 METHODS 漂移（描述 ${JSON.stringify(described)}，期望 ${JSON.stringify(expected)}）`,
    )
  }
}

assertParity()

/**
 * 客户端面的 Remote 描述符。
 *
 * 客户端经 `ctx.remote.memoryBank.overview()` 调用；`descriptors` 里的
 * `id` 是 `<package>#<namespace>/<method>`，与宿主面一致。
 */
export const TYPERT_REMOTE = createTypertRemoteInfo(
  {
    package: 'dsh-memory-bank',
    methods: METHODS_SPEC,
  },
  z,
)

export default TYPERT_REMOTE
