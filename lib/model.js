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

/** 来源：怎么信上的。与可信度**正交**。 */
export const PROVENANCES = Object.freeze([
  'user-asserted',
  'measured',
  'file-derived',
  'self-concluded',
])

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

const DESTRUCTIVE = /\b(?:drop|delete|erase|purge|destroy|force[- ]?remove)\b|删除|清空|销毁|强删/iu
const EXTERNAL = /\b(?:publish|deploy|push|release|send|upload|charge|bill|purchase)\b|发布|部署|推送|发送|上传|付费|购买|扣费|上线/iu
const SECURITY = /\b(?:credential|secret|token|password|permission|entitlement|auth(?:entication|orization)?)\b|凭据|密钥|密码|权限|鉴权|授权/iu

/**
 * 由内容算行动风险。**B 站式免责声明不算**：记忆正文里写「我很安全」不降级。
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
