/**
 * 锚点复查（drift）：一条记忆引用的东西，现在还在吗？还是只是「还在，但变了」？
 *
 * **这个判决必须分两种，否则整个协议会失去可信度：**
 *
 *   `quarantined`  目标**消失**了（文件被删 / 符号不存在 / 行号越界）
 *                  —— 这条记忆引用的东西已经不在，它可能整个失效
 *
 *   `advisory`     目标还在，但**切片变了**（文件内容变了 / 符号体改了）
 *                  —— 重构不是攻击。改名、挪行、重新格式化都会命中这个
 *
 * 如果两者混为一谈，每一次重构都会把整个记忆库标成「不可信」，然后所有人
 * 学会忽略这个警告 —— 那比不做漂移检测更糟。
 *
 * 第三种判决同样重要：
 *
 *   `symbol-not-a-definition`  锚点落在注释、字符串或调用处，而不是定义处
 *                              —— 它**指错了**，不该被当成「符号还在」，
 *                              也**不该重新签名**（那是把错的锚点固化下来）
 *
 * 还有第四种，最容易被省略但最该说出来：
 *
 *   `unverifiable`  机器人无法判断（`git commit` / `command` / `user` 锚点）
 *                   —— 报「健康」是撒谎，报「漂移」是误伤。说实话。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const DRIFT = Object.freeze({
  healthy: 'healthy',
  quarantined: 'quarantined',
  advisory: 'advisory',
  notADefinition: 'symbol-not-a-definition',
  unverifiable: 'unverifiable',
})

/** 可以按「文件内容有没有变」复查的锚点类型。 */
const FILE_LIKE = new Set(['file', 'doc'])

/** 无法机器复查的锚点类型 —— 诚实地说不知道。 */
const UNVERIFIABLE_KINDS = new Set(['commit', 'command', 'user'])

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 一次 audit 内的文件内容缓存 —— 同一次扫描里同一个文件不该读两遍。 */
function createFileCache() {
  const cache = new Map()
  return {
    read(absolute) {
      if (cache.has(absolute)) return cache.get(absolute)
      let value = null
      try {
        if (statSync(absolute).isFile()) value = readFileSync(absolute, 'utf8')
      } catch {
        value = null
      }
      cache.set(absolute, value)
      return value
    },
  }
}

/* ── 锚点解析 ─────────────────────────────────────────────────────── */

/** `src/a.ts:17` / `src/a.ts:17-30` / `src/a.ts` */
function parseFileRef(ref) {
  const match = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(String(ref).trim())
  if (!match) return { path: String(ref), from: null, to: null }
  return {
    path: match[1],
    from: match[2] ? Number(match[2]) : null,
    to: match[3] ? Number(match[3]) : match[2] ? Number(match[2]) : null,
  }
}

/** `src/a.ts#Name` / `Name` */
function parseSymbolRef(ref) {
  const text = String(ref).trim()
  const hash = text.lastIndexOf('#')
  if (hash > 0) return { path: text.slice(0, hash), name: text.slice(hash + 1) }
  return { path: null, name: text }
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 找出符号的定义处。**只认定义形态** —— 这正是 `symbol-not-a-definition`
 * 存在的理由：一个只出现在注释里的名字，看起来「还在」，但它已经不再指向任何东西。
 */
function findDefinition(text, name) {
  const escaped = escapeRegex(name)
  const patterns = [
    // function / class / interface / type / enum / namespace
    new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:default[ \\t]+)?(?:async[ \\t]+)?(?:function[*]?|class|interface|type|enum|namespace)[ \\t]+${escaped}\\b`, 'm'),
    // const / let / var（含箭头函数）
    new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:const|let|var)[ \\t]+${escaped}[ \\t]*[:=]`, 'm'),
    // 方法简写 / 类成员：`name(` 或 `get name(`
    new RegExp(`^[ \\t]*(?:static[ \\t]+)?(?:async[ \\t]+)?(?:get[ \\t]+|set[ \\t]+)?${escaped}[ \\t]*\\(`, 'm'),
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match) return { offset: match.index, line: text.slice(0, match.index).split('\n').length }
  }
  return null
}

/**
 * 取符号的体：从定义处做花括号匹配。
 *
 * 拿不到体（比如 `export const X = 42` 没有花括号）就退化到「这一行到分号」。
 * 退化是可接受的：它只会让 `advisory` 更敏感，不会造成误判成 `quarantined`。
 */
function symbolBody(text, offset, name) {
  const open = text.indexOf('{', offset)
  const semicolon = text.indexOf(';', offset)
  const newline = text.indexOf('\n', offset)

  // 没有花括号，或者分号在花括号之前 → 单行定义
  if (open < 0 || (semicolon >= 0 && semicolon < open)) {
    const end = semicolon >= 0 ? semicolon : newline >= 0 ? newline : text.length
    return text.slice(offset, end + 1)
  }

  // 花括号匹配（跳过字符串与注释会过于复杂；这里只做朴素计数，
  // 因为它的用途是「体变了没有」，不是解析器）
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(offset, index + 1)
    }
  }
  return text.slice(offset)
}

/* ── 单锚点复查 ───────────────────────────────────────────────────── */

/**
 * 复查一个锚点。返回 `{ kind, ref, verdict, detail }`。
 *
 * 永不抛：一个读不了的文件不该让整次 audit 失败。
 */
export function checkAnchor(root, anchor, { files = createFileCache() } = {}) {
  const kind = String(anchor?.kind ?? 'unknown')
  const ref = String(anchor?.ref ?? '')
  const result = (verdict, detail) => ({ kind, ref, verdict, detail })

  if (!ref) return result(DRIFT.unverifiable, '锚点为空')
  if (UNVERIFIABLE_KINDS.has(kind)) {
    return result(DRIFT.unverifiable, `${kind} 锚点无法机器复查（不撒谎：既不是健康也不是漂移）`)
  }

  if (kind === 'symbol') {
    const { path, name } = parseSymbolRef(ref)
    if (!name) return result(DRIFT.unverifiable, '符号锚点缺少名字')

    // 裸符号名：在整个仓库里找（只扫 .ts/.js/.mjs/.cjs）
    if (!path) {
      return result(DRIFT.unverifiable, '符号锚点没有文件路径，无法定位')
    }

    const absolute = join(root, path)
    const text = files.read(absolute)
    if (text === null) return result(DRIFT.quarantined, `文件不存在：${path}`)

    const definition = findDefinition(text, name)
    if (!definition) {
      // 名字还在文件里（注释、字符串、调用处）→ 指错了，不是消失了
      if (new RegExp(`\\b${escapeRegex(name)}\\b`).test(text)) {
        return result(DRIFT.notADefinition, `${name} 出现在 ${path} 但不在定义处（注释 / 字符串 / 调用点）`)
      }
      return result(DRIFT.quarantined, `符号不存在：${path}#${name}`)
    }

    if (anchor.hash && sha256(symbolBody(text, definition.offset, name)) !== anchor.hash) {
      return result(DRIFT.advisory, `${path}#${name} 的体变了（第 ${definition.line} 行）—— 重构不是攻击`)
    }
    return result(DRIFT.healthy, `${path}#${name} 在第 ${definition.line} 行`)
  }

  if (kind === 'test') {
    // 测试锚点：ref 是测试名，仓库里能不能找到这个字符串
    const candidates = ['.', 'test', 'tests', '__tests__']
    for (const dir of candidates) {
      const absolute = join(root, dir)
      if (!existsSync(absolute)) continue
      try {
        const stat = statSync(absolute)
        if (!stat.isDirectory()) continue
      } catch {
        continue
      }
      // 只做「测试名还在某个测试文件里」的粗查 —— 目录级
      // 更细的解析需要知道项目用哪个测试框架，Spec 层不假设
    }
    return result(DRIFT.unverifiable, `测试锚点「${ref}」需要项目级索引才能复查`)
  }

  if (FILE_LIKE.has(kind)) {
    const { path, from, to } = parseFileRef(ref)
    if (!path) return result(DRIFT.unverifiable, '文件锚点缺少路径')

    const absolute = join(root, path)
    const text = files.read(absolute)
    if (text === null) return result(DRIFT.quarantined, `文件不存在：${path}`)

    if (from !== null) {
      const lineCount = text.split('\n').length
      if (from > lineCount) {
        return result(DRIFT.quarantined, `${path} 只有 ${lineCount} 行，锚点在 ${from} 行 —— 切片消失了`)
      }
    }

    if (anchor.hash) {
      // 切片哈希：有行号就只哈希那几行，没有就哈希整个文件
      const slice =
        from === null
          ? text
          : text
              .split('\n')
              .slice(from - 1, (to ?? from))
              .join('\n')
      if (sha256(slice) !== anchor.hash) {
        return result(DRIFT.advisory, `${path}${from !== null ? `:${from}` : ''} 的切片变了 —— 重构不是攻击`)
      }
    }

    return result(DRIFT.healthy, `${path}${from !== null ? `:${from}` : ''} 仍在`)
  }

  return result(DRIFT.unverifiable, `未知锚点类型：${kind}`)
}

/* ── 条目 / 语料复查 ─────────────────────────────────────────────── */

/** 一条判决：条目级取最坏的锚点（quarantined > advisory > 其余）。 */
const SEVERITY = {
  [DRIFT.quarantined]: 3,
  [DRIFT.advisory]: 2,
  [DRIFT.notADefinition]: 1,
  [DRIFT.unverifiable]: 0,
  [DRIFT.healthy]: -1,
}

export function worstOf(verdicts) {
  let worst = DRIFT.healthy
  for (const verdict of verdicts) {
    if ((SEVERITY[verdict] ?? 0) > (SEVERITY[worst] ?? -1)) worst = verdict
  }
  return worst
}

/** 复查一条记忆的全部锚点。 */
export function checkEvidence(root, entry, { files = createFileCache() } = {}) {
  const anchors = (entry.evidence ?? []).map((anchor) => checkAnchor(root, anchor, { files }))
  return {
    id: entry.id,
    verdict: anchors.length === 0 ? DRIFT.unverifiable : worstOf(anchors.map((anchor) => anchor.verdict)),
    anchors,
    // **点名漂移的锚点** —— 设计 §14 第 5 条要求的就是这一句
    drifted: anchors.filter((anchor) => anchor.verdict === DRIFT.quarantined || anchor.verdict === DRIFT.advisory),
  }
}

/**
 * 全语料锚点复查。只返回**有问题的**条目 —— 健康的条目没有信息量，
 * 而 audit 的输出是给人读的。
 */
export function driftReport(root, entries, { now = Date.now() } = {}) {
  const files = createFileCache()
  const quarantined = []
  const advisory = []
  const notADefinition = []
  let unverifiable = 0

  for (const entry of entries) {
    const result = checkEvidence(root, entry, { files })
    if (result.verdict === DRIFT.quarantined) quarantined.push(result)
    else if (result.verdict === DRIFT.advisory) advisory.push(result)
    else if (result.verdict === DRIFT.notADefinition) notADefinition.push(result)
    else if (result.verdict === DRIFT.unverifiable) unverifiable += 1
  }

  return { quarantined, advisory, notADefinition, unverifiable, checked: entries.length, at: now }
}

/** 一行摘要，给 audit 用。 */
export function summarizeDrift(report) {
  const parts = []
  if (report.quarantined.length > 0) parts.push(`quarantined ${report.quarantined.length}`)
  if (report.advisory.length > 0) parts.push(`advisory ${report.advisory.length}`)
  if (report.notADefinition.length > 0) parts.push(`not-a-definition ${report.notADefinition.length}`)
  if (report.unverifiable > 0) parts.push(`unverifiable ${report.unverifiable}`)
  return parts.length > 0 ? parts.join(' · ') : `全部健康（${report.checked} 条）`
}
