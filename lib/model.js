/**
 * 记忆条目的形态：类型、校验、frontmatter 序列化与解析。
 *
 * 为什么自己写 YAML 子集而不是引 js-yaml：
 *   1. 插件包不该为一段 20 行的 frontmatter 引入一个解析器依赖；
 *   2. 我们只需要「标量 + 字符串数组 + 一层对象数组」，写死子集比通用解析器更容易证明正确；
 *   3. 序列化必须是确定性的（key 顺序固定），否则每次重写都产生无意义 diff。
 *
 * 格式约定：字符串一律 JSON 双引号（JSON 是合法 YAML），数组用 flow 形式，
 * 证据用 block 形式（人读得懂）。解析器只认这套形态，遇到别的形态直接报错 ——
 * 静默降级会让一条写坏的记忆看起来是好的。
 */

import { collapse, sha256, stableJson } from './util.js'

/** 记忆类型：每一类对应一种「值得记」的形态。 */
export const KINDS = Object.freeze([
  'decision',
  'pitfall',
  'convention',
  'correction',
  'fact',
  'capability',
])

/** 可信度：可不可信。 */
export const CONFIDENCES = Object.freeze(['verified', 'inferred', 'stale', 'deprecated'])

/**
 * 置信标签的**序**：`3` 最强，`0` 最弱。
 *
 * ## 为什么它必须在 `model.js` 里只有一份
 *
 * 这个映射被三处需要，上一版各抄一份（`lifecycle.bestOf` 的局部 `rank`、
 * `promote.js` 的 `CONFIDENCE_RANK`、`gate.weakness` 的 0–1 版本）。
 * 值当时一样，但**没有任何东西保证以后一样** —— 而这个仓库已经为
 * 「一张表活着、没人往里写」付过两次账（`index-build.js:66-73`
 * 的 `graphKindStrength` 死表、`authority` 死字段）。
 *
 * ## 它编码的那条不变量
 *
 * **权威只能保持或降低，不能提高。** 凡是「由多条派生一条」的操作
 * （合并 / 摘要 / 提炼），置信必须取 `min`，不是取 max。
 * 见 `lifecycle.weakestConfidence`。
 */
export const CONFIDENCE_RANK = Object.freeze({ verified: 3, inferred: 2, stale: 1, deprecated: 0 })

/**
 * 置信**分数**（0–1）→ 置信**标签**。阈值只有这一份。
 *
 * 上一版这个映射被复制了两份（`lib/tools.js` 与 `lib/host/mutations.js`），
 * 而 `lib/host/mutations.js` 的注释自己写着「与 `lib/tools.js` 的同名私有函数
 * 一致（阈值不可各自发明）」—— **那就是在等一次漂移**。
 *
 * 0.3.1 把 `CONFIDENCE_RANK` 收敛成一份时留下了它（两者不是一个东西：
 * 那是排序，这是分档）。现在一并收敛。
 */
export function confidenceLabel(score) {
  if (score >= 0.85) return 'verified'
  if (score >= 0.55) return 'inferred'
  return 'stale'
}

/** 来源：怎么信上的。与可信度**正交**。 */
export const PROVENANCES = Object.freeze([
  'user-asserted',
  'measured',
  'file-derived',
  'self-concluded',
])

/**
 * 权威：**谁给这条记忆背了书**。
 *
 * ## 它回答的问题，`provenance` 回答不了
 *
 * `provenance` 说「怎么信上的」（模型总结的 / 实测的 / 用户说的）；
 * `authority` 说「有没有人核过」。两者可以交叉：
 * `provenance: self-concluded` + `authority: user-confirmed` = 模型自己写的，
 * 但人看过并签了字。
 *
 * ## 为什么只有两个值
 *
 * `docs/03` 的 `Receipt` schema 里曾经列过四个（`observed` / `advisory` /
 * `normative` / `user-confirmed`），但只有两个有产生机制：
 *
 * - `observed`        模型或自动捕获观察到的。**默认值。**
 * - `user-confirmed`  人在 `memory_resolve` 里裁决过。
 *
 * `normative` 没有产生机制；`advisory` 与 `LIFECYCLE_STATES` 里的 `advisory`
 * 同名不同轴（一个是「权威未确认」，一个是「生命周期未激活」），是**混淆源**。
 * 一个永不产生的枚举值是本仓库记录过两次的 bug 类型（`graphKindStrength` 死表、
 * `authority` 死字段），所以只留会真的被写出来的那两个。
 *
 * ## 它为什么必须由**写入通道**决定，而不是内容声明
 *
 * 「这条记忆声称自己很权威」不是权威。`memory_remember` 的 `authority` 参数
 * 只允许 `observed`；`user-confirmed` **只能**由 `memory_resolve` 的 accept
 * 分支写入 —— 那是唯一一个人真的看过正文的动作。
 */
export const AUTHORITIES = Object.freeze(['observed', 'user-confirmed'])

/** 生命周期：状态机与合法迁移。终态不可逆。 */
export const LIFECYCLE_STATES = Object.freeze([
  'observed',
  'candidate',
  'shadow',
  'advisory',
  'active',
  'stale',
  'deprecated',
  'rejected',
  'superseded',
])

const TRANSITIONS = Object.freeze({
  observed: new Set(['candidate', 'rejected']),
  candidate: new Set(['shadow', 'advisory', 'rejected']),
  shadow: new Set(['advisory', 'rejected']),
  advisory: new Set(['active', 'stale', 'deprecated', 'rejected', 'superseded']),
  active: new Set(['stale', 'deprecated', 'superseded']),
  stale: new Set(['advisory', 'active', 'deprecated', 'rejected', 'superseded']),
  deprecated: new Set(),
  rejected: new Set(),
  superseded: new Set(),
})

/** 可注入（能进上下文）的生命周期状态。 */
export function lifecycleInjectable(state) {
  return state === 'active' || state === 'advisory'
}

export function lifecycleTransitionAllowed(from, to) {
  if (from === null || from === undefined) {
    return ['observed', 'candidate', 'advisory', 'active'].includes(to)
  }
  if (!LIFECYCLE_STATES.includes(from) || !LIFECYCLE_STATES.includes(to)) return false
  if (from === to) return true
  return TRANSITIONS[from].has(to)
}

export function assertLifecycleTransition(from, to) {
  if (!lifecycleTransitionAllowed(from, to)) {
    throw new Error(`memory lifecycle transition is not allowed: ${from ?? 'null'} -> ${to}`)
  }
}

/**
 * 行动风险的关键词表。
 *
 * ## 英文为什么**显式列形态**
 *
 * 上一版是 `\b(?:drop|delete|...)\b` —— 于是 `deployment` / `deleted` /
 * `published` 全部**不命中**（词尾被 `\b` 挡住），而中文用裸 alternation
 * （`部署` 在任意位置命中）。**同一个意思，中文记忆被判得更高危。**
 * 实测：`staging deployment health check timeout` → `R1`，
 * `staging 部署健康检查超时` → `R4`。
 *
 * 改成 `stem\w*` 又会误伤 —— `tokenize` / `tokenizer` 会被当成 SECURITY，
 * 于是一条讲分词器的记忆变成「涉密」。所以**显式列形态**：宁可长，不可猜。
 * 刻意**收窄**的：`sent`（英文里太常见的动词，`the error was sent to the log`
 * 不该是 R4）、`tokenize*`（见上）。
 *
 * ## 中文为什么仍然「出现即命中」
 *
 * 中文没有词边界，`(?<![不没未别])部署` 只能挡住最常见的几种否定，
 * 挡不住「部署健康检查超时」—— 那里的「部署」是在描述**被排查的对象**，
 * 不是在**指示**一个不可逆动作。要判对只能靠语义，而语义通道实测分离度
 * −0.020 ~ +0.063（不可用）。
 *
 * 所以中文保持「出现即命中」。**这是安全的那一侧**：`actionRisk` 的后果是
 * 多一行「⚠ 照做之前回读原文」，不是拦截。少警告（英文漏 `deployment`）是
 * **unsafe**，多警告是 **noisy** —— 两者不对称，所以只修英文。
 */
const RISK_TERMS = Object.freeze({
  destructive: Object.freeze([
    'drop', 'drops', 'dropped', 'dropping',
    'delete', 'deletes', 'deleted', 'deleting', 'deletion',
    'erase', 'erases', 'erased', 'erasing', 'erasure',
    'purge', 'purges', 'purged', 'purging',
    'destroy', 'destroys', 'destroyed', 'destroying', 'destruction',
    'remove', 'removes', 'removed', 'removing', 'removal',
    '删除', '清空', '销毁', '强删',
  ]),
  external: Object.freeze([
    'publish', 'publishes', 'published', 'publishing', 'publication',
    'deploy', 'deploys', 'deployed', 'deploying', 'deployment', 'deployments',
    'push', 'pushes', 'pushed', 'pushing',
    'release', 'releases', 'released', 'releasing',
    'send', 'sends', 'sending',
    'upload', 'uploads', 'uploaded', 'uploading',
    'charge', 'charges', 'charged', 'charging',
    'bill', 'bills', 'billed', 'billing',
    'purchase', 'purchases', 'purchased', 'purchasing',
    '发布', '部署', '推送', '发送', '上传', '付费', '购买', '扣费', '上线',
  ]),
  security: Object.freeze([
    'credential', 'credentials',
    'secret', 'secrets',
    'token', 'tokens',
    'password', 'passwords',
    'permission', 'permissions',
    'entitlement', 'entitlements',
    'auth', 'authentication', 'authorization', 'authorize', 'authorized',
    '凭据', '密钥', '密码', '权限', '鉴权', '授权',
  ]),
})

/** ASCII 词走词边界；CJK 没有词边界，裸匹配（见 `RISK_TERMS` 的取舍）。 */
function riskPattern(terms) {
  const ascii = terms.filter((term) => /^[a-z]+$/i.test(term))
  const cjk = terms.filter((term) => !/^[a-z]+$/i.test(term))
  const parts = []
  if (ascii.length > 0) parts.push(String.raw`\b(?:${ascii.join('|')})\b`)
  if (cjk.length > 0) parts.push(`(?:${cjk.join('|')})`)
  return new RegExp(parts.join('|'), 'iu')
}

const DESTRUCTIVE = riskPattern(RISK_TERMS.destructive)
const EXTERNAL = riskPattern(RISK_TERMS.external)
const SECURITY = riskPattern(RISK_TERMS.security)

/**
 * 由内容算行动风险。**B 站式免责声明不算**：记忆正文里写「我很安全」不降级。
 *
 * 注意 `actionRisk` **进 `contentHash`** —— 改这个函数只影响**新写入**的条目
 * （存量条目存的是当时算出的值，不会被重算），所以**不需要**升
 * `RECEIPT_HASH_VERSION`、也不需要迁移。
 */
export function actionRiskOf({ kind, body = '' }) {
  const text = String(body)
  const destructive = DESTRUCTIVE.test(text)
  const external = EXTERNAL.test(text)
  const security = SECURITY.test(text)
  if (destructive && security) return 'R5'
  if (destructive || external) return 'R4'
  if (security) return 'R3'
  if (kind === 'correction' || kind === 'convention') return 'R2'
  return 'R1'
}

/** id 规则：snake_case，全局唯一键，也是文件名。 */
export const ID_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/

/** 补哈希后仍然不超过 64 字符。 */
const ID_BASE_LENGTH = 55

/**
 * 由标题推导 id。
 *
 * 只保留 ASCII 字母数字：id 要跨文件系统、跨 URL、跨 shell 安全。
 *
 * **只要归一化丢过信息，就必须补短哈希。** 上一版只判「slug 长度 < 4」，
 * 于是「连接池上限 vs worker 数量」与「连接池下限 vs worker 数量」都得到
 * `vs_worker` —— 中文被整体丢掉，slug 却还有 9 个字符，守卫放行。
 * 第二条记忆会把第一条**静默覆盖**掉（`writeEntry` 用 `${id}.md` 当文件名），
 * 正文、回执、`supersedes` 链一起消失，没有任何痕迹。
 *
 * 三种丢信息的情形都要补哈希：
 *   1. 原文含 ASCII 之外的字符（中文 / 日文 / emoji 被整体丢弃）；
 *   2. slug 太短（`a`、`vs` 这种没有区分度）；
 *   3. 发生了截断（两条长标题共享前 55 个字符）。
 *
 * 截断之后还要再剥一次尾下划线：`ID_PATTERN` 不允许尾 `_`，而 id 是工具自动
 * 推出来的，用户没有任何办法去修它。
 */
export function normalizeId(raw) {
  const text = collapse(raw)
  const slug = text
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')

  const base = slug.slice(0, ID_BASE_LENGTH).replace(/_+$/, '')
  const lossy = base.length < 4 || base.length !== slug.length || /[^\x20-\x7e]/.test(text)
  if (!lossy) return base

  const digest = sha256(text).slice(0, 8)
  return base ? `${base}_${digest}` : `m_${digest}`
}

/* ── 校验 ─────────────────────────────────────────────────────────── */

/**
 * 校验候选/条目。返回 `{ ok, errors: string[] }`，**不抛**（门要用它）。
 * 只做形态校验，语义判定在 gate 层。
 */
export function validateEntry(entry) {
  const errors = []
  const add = (field, why) => errors.push(`${field}: ${why}`)

  if (!entry || typeof entry !== 'object') return { ok: false, errors: ['entry: 不是对象'] }

  if (typeof entry.id !== 'string' || !entry.id) add('id', '必填')
  else if (!ID_PATTERN.test(entry.id)) add('id', `必须匹配 ${ID_PATTERN}，收到「${entry.id}」`)

  if (typeof entry.title !== 'string' || !entry.title.trim()) add('title', '必填')
  else if ([...entry.title].length > 120) add('title', '不超过 120 字')
  else if (entry.title.includes('\n')) add('title', '不能含换行')

  if (!KINDS.includes(entry.kind)) add('kind', `只能是 ${KINDS.join(' / ')}`)

  if (typeof entry.about !== 'string' || !entry.about.trim()) add('about', '必填（这条记忆是干什么用的）')

  if (typeof entry.body !== 'string' || !entry.body.trim()) add('body', '必填')
  else {
    const length = [...entry.body].length
    if (length < 80) add('body', `至少 80 字（收到 ${length}）—— 太短的记忆无法验证也无法拒绝`)
    else if (length > 8000) add('body', `不超过 8000 字（收到 ${length}）`)
  }

  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
    add('evidence', '至少 1 条（没有证据的断言就是猜测）')
  } else {
    entry.evidence.forEach((item, index) => {
      if (!item || typeof item !== 'object') return add(`evidence[${index}]`, '不是对象')
      if (typeof item.kind !== 'string' || !item.kind) add(`evidence[${index}].kind`, '必填')
      if (typeof item.ref !== 'string' || !item.ref.trim()) add(`evidence[${index}].ref`, '必填')
    })
  }

  if (!PROVENANCES.includes(entry.provenance)) {
    add('provenance', `只能是 ${PROVENANCES.join(' / ')}`)
  }
  if (entry.authority !== undefined && !AUTHORITIES.includes(entry.authority)) {
    add('authority', `只能是 ${AUTHORITIES.join(' / ')}`)
  }
  if (entry.confidence !== undefined && !CONFIDENCES.includes(entry.confidence)) {
    add('confidence', `只能是 ${CONFIDENCES.join(' / ')}`)
  }
  if (entry.scope !== undefined && !Array.isArray(entry.scope)) add('scope', '必须是字符串数组')
  if (entry.triggers !== undefined && !Array.isArray(entry.triggers)) add('triggers', '必须是字符串数组')
  if (entry.supersedes !== undefined && !Array.isArray(entry.supersedes)) {
    add('supersedes', '必须是字符串数组')
  }
  if (entry.status !== undefined && !LIFECYCLE_STATES.includes(entry.status)) {
    add('status', `只能是 ${LIFECYCLE_STATES.join(' / ')}`)
  }

  return { ok: errors.length === 0, errors }
}

/* ── 序列化 ───────────────────────────────────────────────────────── */

const SCALAR_KEYS = [
  'id',
  'title',
  'kind',
  'about',
  'confidence',
  'provenance',
  'authority',
  'status',
  'actionRisk',
  'createdAt',
  'modifiedAt',
  'lastVerifiedAt',
  'reviewBy',
  'expiresAt',
  'pinned',
]
const STRING_ARRAY_KEYS = ['scope', 'triggers', 'supersedes']

function scalarLine(key, value) {
  if (value === undefined || value === null) return `${key}: null`
  if (typeof value === 'boolean' || typeof value === 'number') return `${key}: ${value}`
  return `${key}: ${JSON.stringify(String(value))}`
}

function flowArray(key, values) {
  if (!Array.isArray(values) || values.length === 0) return `${key}: []`
  return `${key}: [${values.map((value) => JSON.stringify(String(value))).join(', ')}]`
}

/** 条目 → Markdown 文档（frontmatter + 正文）。确定性输出。 */
export function serializeEntry(entry) {
  const lines = ['---']
  for (const key of SCALAR_KEYS) lines.push(scalarLine(key, entry[key] ?? null))
  for (const key of STRING_ARRAY_KEYS) lines.push(flowArray(key, entry[key] ?? []))

  lines.push('evidence:')
  if (!entry.evidence?.length) {
    lines[lines.length - 1] = 'evidence: []'
  } else {
    for (const item of entry.evidence) {
      lines.push(`  - kind: ${JSON.stringify(String(item.kind))}`)
      lines.push(`    ref: ${JSON.stringify(String(item.ref))}`)
      if (item.hash) lines.push(`    hash: ${JSON.stringify(String(item.hash))}`)
      if (item.excerpt) lines.push(`    excerpt: ${JSON.stringify(String(item.excerpt))}`)
      if (item.symbol) lines.push(`    symbol: ${JSON.stringify(String(item.symbol))}`)
    }
  }

  lines.push('relations:')
  if (!entry.relations?.length) {
    lines[lines.length - 1] = 'relations: []'
  } else {
    for (const rel of entry.relations) {
      lines.push(`  - type: ${JSON.stringify(String(rel.type))}`)
      lines.push(`    target: ${JSON.stringify(String(rel.target))}`)
    }
  }

  lines.push('claims:')
  if (!entry.claims?.length) {
    lines[lines.length - 1] = 'claims: []'
  } else {
    for (const claim of entry.claims) {
      lines.push(`  - kind: ${JSON.stringify(String(claim.kind))}`)
      lines.push(`    ref: ${JSON.stringify(String(claim.ref))}`)
      lines.push(`    state: ${JSON.stringify(String(claim.state))}`)
      /**
       * `evidence` **必须**落盘。
       *
       * 上一版只写 kind / ref / state / 三列 resolution，于是读回来
       * `claim.evidence` 恒为 `undefined`，而 `syncClaims` 的判据是
       * `old.evidence === claim.evidence` —— **恒 false**：
       *
       * > 重写一条记忆（哪怕只改 `scope`）都会把已学到的对账结果丢掉。
       *
       * 而且丢得**没有声音**：`memory_remember` 返回「已记住」，回执正常，
       * 只有下一次 `memory_audit` 发现 open claim 又回来了。
       *
       * 它**不进** `contentHash`（见 `contentHash` 的注释：claims 只哈希
       * 身份三列）—— 它是抽取器的产物，不是「这条断言是什么」的一部分。
       */
      if (claim.evidence) lines.push(`    evidence: ${JSON.stringify(String(claim.evidence))}`)
      if (claim.resolvedState) lines.push(`    resolvedState: ${JSON.stringify(String(claim.resolvedState))}`)
      if (claim.resolvedBy) lines.push(`    resolvedBy: ${JSON.stringify(String(claim.resolvedBy))}`)
      if (claim.resolvedAt) lines.push(`    resolvedAt: ${JSON.stringify(String(claim.resolvedAt))}`)
    }
  }

  lines.push('---', '', canonicalBody(entry.body), '')
  return lines.join('\n')
}

/**
 * 正文的**规范形式**：CRLF → LF，去尾部空白。
 *
 * 写入、解析、哈希三处**必须用同一个函数** —— 否则往返不可能逐字节相同，
 * 而 `contentHash` 的全部意义就是「读回来的和写进去的是不是同一条」。
 *
 * 曾经这里只有 `serializeEntry` 一处调 `trimEnd()`，`parseEntry` 不剥尾随换行、
 * `contentHash` 又直接哈希原始 body —— 结果**每一条记忆都被判成 `tampered`**，
 * 回执层从未生效，而且它对每一条正常写入的记忆做了一次虚假的篡改指控。
 */
export function canonicalBody(body) {
  return String(body ?? '')
    .replace(/\r\n/g, '\n')
    // **前导**换行也必须剥。上一版只 `trimEnd()`，而 `parseEntry` 额外剥了前导
    // 换行 —— 于是「正文以空行开头」的记忆写完就 `contentHash` 对不上，
    // `receiptStatus` 对一条**正常写入**的记忆报 `tampered`。
    // 模型的 body 以 `\n` 开头是常态，所以这条不是边角。
    .replace(/^\n+/, '')
    .trimEnd()
}

/* ── 解析 ─────────────────────────────────────────────────────────── */

function parseScalar(raw) {
  const text = raw.trim()
  if (text === '' || text === 'null' || text === '~') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  if (text.startsWith('"') || text.startsWith('[') || text.startsWith('{')) {
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new Error(`frontmatter 值不是合法 JSON：${text}`, { cause: error })
    }
  }
  return text
}

/**
 * 解析一个条目文档。**遇到不认识的形态就抛错** —— 静默跳过会让写坏的文件
 * 看起来是一条好记忆。调用方（store.read）负责把单个文件的错误隔离掉。
 */
export function parseEntry(text, { idFromPath } = {}) {
  const normalized = String(text).replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) {
    throw new Error('缺少 frontmatter 起始分隔符 `---`')
  }
  const end = normalized.indexOf('\n---\n', 3)
  if (end < 0) throw new Error('缺少 frontmatter 结束分隔符 `---`')

  const header = normalized.slice(4, end)
  /**
   * 正文 = `---` 之后的部分，**走 `canonicalBody`**。
   *
   * 这一步是内容寻址的地基。`serializeEntry` 输出 `...${body}\n`（POSIX 文本
   * 文件约定），如果这里不规范化，`parseEntry(serializeEntry(x)).body` 就和
   * `x.body` 不是同一个规范形式 —— 于是 `contentHash` 永远对不上：
   *
   *   - **每一条记忆都被判成 `tampered`**，整个回执层从未生效过；
   *   - 而且报警文案是「正文被改」—— 它对每一条正常写入的记忆
   *     做了一次**虚假的篡改指控**。那比没有回执更糟。
   *
   * 曾经这里自己写了一遍 `replace(/^\n+/,'').replace(/\n$/,'')`，而写入侧用的是
   * `canonicalBody`（当时只有 `trimEnd()`）—— 两份实现漂了，前导换行就是漏网的那一半。
   * 现在**只有一处**：`canonicalBody`。
   */
  const body = canonicalBody(normalized.slice(end + 5))

  const entry = { id: idFromPath, evidence: [], relations: [], claims: [], scope: [], triggers: [], supersedes: [] }
  const lines = header.split('\n')

  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }
    const match = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(line)
    if (!match) throw new Error(`frontmatter 第 ${index + 1} 行无法解析：${line}`)
    const [, key, rest] = match

    if (rest.trim() !== '') {
      entry[key] = parseScalar(rest)
      index += 1
      continue
    }

    // 空值：看后续缩进块
    index += 1
    const items = []
    let current = null
    while (index < lines.length) {
      const blockLine = lines[index]
      if (!blockLine.trim()) {
        index += 1
        continue
      }
      const itemMatch = /^\s{2}- (.*)$/.exec(blockLine)
      const fieldMatch = /^\s{4}([A-Za-z_][\w]*):\s*(.*)$/.exec(blockLine)
      if (itemMatch) {
        const inner = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(itemMatch[1])
        if (inner) {
          current = { [inner[1]]: parseScalar(inner[2]) }
          items.push(current)
        } else {
          current = null
          items.push(parseScalar(itemMatch[1]))
        }
        index += 1
        continue
      }
      if (fieldMatch && current) {
        current[fieldMatch[1]] = parseScalar(fieldMatch[2])
        index += 1
        continue
      }
      break
    }
    entry[key] = items
  }

  entry.body = body
  if (idFromPath) entry.id = entry.id ?? idFromPath
  return entry
}

/* ── 内容哈希 ─────────────────────────────────────────────────────── */

/**
 * 条目内容哈希。**只含语义字段**：时间戳与访问计数不进哈希 ——
 * 否则「重新验证一次」就会让回执失效。
 *
 * **字段集必须覆盖「改了就该重建索引」的全部语义字段。** 上一版漏了
 * `actionRisk` / `provenance` / `confidence` / `status` / `relations` / `claims`，
 * 而 `ensureSnapshot` 判「快照是否新鲜」用的就是这个哈希（`index-build.js`）——
 * 于是把一条记忆从 R1 改成 R5 之后索引不重建，召回永远渲染 R1，
 * 那句「涉及不可逆操作」的警告永不出现；`relations` 改了图边也永远是旧的。
 *
 * `claims` 只哈希**身份三列**（kind / ref / state），不哈希 `resolvedState` /
 * `resolvedBy` / `resolvedAt` —— 那是「世界变了另存」的独立轴，
 * 关掉一条断言不该让记忆的回执失效。
 *
 * 缓存挂在条目对象上（`WeakMap`）：装配路径每轮都要对全库求一次哈希
 * 判断快照是否新鲜，而 `stableJson` 的递归排序 + `sha256` 对 200 条记忆
 * 是装配路径上剩下最大的一笔。条目由 `readAll` 冻结，所以缓存永不陈旧。
 */
const contentHashCache = new WeakMap()

export function contentHash(entry) {
  if (entry !== null && typeof entry === 'object') {
    const cached = contentHashCache.get(entry)
    if (cached) return cached
  }
  const hash = sha256(
    stableJson({
      id: entry.id,
      title: entry.title,
      kind: entry.kind,
      about: entry.about,
      // **规范形式** —— 与 `serializeEntry` / `parseEntry` 用同一个函数。
      // 直接用原始 body 会让「写进去的」和「读回来的」差一个尾随换行。
      body: canonicalBody(entry.body),
      confidence: entry.confidence ?? null,
      provenance: entry.provenance ?? null,
      /**
       * `authority` 进哈希的理由：它落在快照 document 上、被 `renderRecall`
       * 渲染给模型看。改了它而不重建索引，模型看到的就还是旧权威 ——
       * 与改成 `R5` 却不重建是同一个 bug（见上面的注释）。
       *
       * 默认值 `observed` 与 `index-build` 的兜底同口径：**没写不等于可信**。
       */
      authority: entry.authority ?? 'observed',
      status: entry.status ?? null,
      actionRisk: entry.actionRisk ?? null,
      evidence: (entry.evidence ?? []).map((item) => ({
        kind: item.kind,
        ref: item.ref,
        hash: item.hash ?? null,
      })),
      relations: (entry.relations ?? []).map((item) => ({ type: item.type, target: item.target })),
      claims: (entry.claims ?? []).map((item) => ({ kind: item.kind, ref: item.ref, state: item.state })),
      scope: entry.scope ?? [],
      triggers: entry.triggers ?? [],
      supersedes: entry.supersedes ?? [],
    }),
  )
  if (entry !== null && typeof entry === 'object') contentHashCache.set(entry, hash)
  return hash
}

/** 证据根：排序后的证据哈希列表的摘要。 */
export function evidenceRoot(entry) {
  const hashes = (entry.evidence ?? [])
    .map((item) => `${item.kind}\u0000${item.ref}\u0000${item.hash ?? ''}`)
    .sort()
  return sha256(hashes.join('\u0001'))
}
