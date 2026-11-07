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
 *
 * 以及第五种，它的存在是为了**不撒谎**：
 *
 *   `unsafe-path`  锚点路径逃出了仓库（`../secret.txt` / 盘符绝对路径）
 *                  —— 既不是「文件不存在」（那是我们拼错了路），也不该去读库外
 *
 * 哈希一律走 `anchor.js` —— 那是写入（gate）与复查（drift）共用的唯一算法。
 * 两侧各算一套就是「带行号锚点 100% 假 advisory」那个 bug 的根源。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { anchorHash, lineCountOf, parseFileRef, symbolBodyHash } from './anchor.js'
// `escapeRegex` 原来在这里与 `anchor.js` 各有一份逐字节相同的复制品。
// 两份实现的常规输入完全一样，所以漂移只会在有人先改了一处时暴露 ——
// 而那时一侧会把 `a.b` 当模式跑、另一侧当字面量，同一个符号名得到两个判决。
import { escapeRegex } from './kernel/text.js'
import { toRepoPath } from './util.js'

export const DRIFT = Object.freeze({
  healthy: 'healthy',
  quarantined: 'quarantined',
  advisory: 'advisory',
  notADefinition: 'symbol-not-a-definition',
  unsafePath: 'unsafe-path',
  unverifiable: 'unverifiable',
})

/** 可以按「文件内容有没有变」复查的锚点类型。 */
const FILE_LIKE = new Set(['file', 'doc'])

/** 无法机器复查的锚点类型 —— 诚实地说不知道。 */
const UNVERIFIABLE_KINDS = new Set(['commit', 'command', 'user'])

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

/* ── 路径解析 ─────────────────────────────────────────────────────── */

/**
 * 把 ref 里的路径解析成**仓库内**的绝对路径；越界返回 null。
 *
 * 不能用 `join`：**join 不重置根**。`join(root, 'E:\\repo\\lib\\x.js')` 得到
 * `E:\\repo\\E:\\repo\\lib\\x.js`，于是绝对路径锚点必然「文件不存在」——
 * 那不是漂移，是我们自己拼错了路。反过来 `../secret.txt` 用 join 能读到库外，
 * 那是一次**越权读取**。
 *
 * 两种都不该被当成「目标消失」，所以越界单独判 `unsafe-path`。
 */
function resolveAnchorPath(root, path) {
  const absolute = resolve(root, path)
  // toRepoPath 越界返回 null —— 它才是「在仓库内」的判据，不是字符串前缀
  return toRepoPath(root, absolute) === null ? null : absolute
}

/* ── 锚点解析 ─────────────────────────────────────────────────────── */

/** `src/a.ts#Name` / `Name` */
function parseSymbolRef(ref) {
  const text = String(ref).trim()
  const hash = text.lastIndexOf('#')
  if (hash > 0) return { path: text.slice(0, hash), name: text.slice(hash + 1) }
  return { path: null, name: text }
}

/* ── 测试名索引 ───────────────────────────────────────────────────── */

/** `node --test` 的目录约定；`tests/`、`__tests__/` 是常见变体。 */
const TEST_DIRS = ['test', 'tests', '__tests__']

/** 只扫测试文件 —— 扫全仓会把源码里的字符串也算成「测试名」。 */
const TEST_FILE = /\.(?:test|spec)\.(?:mjs|cjs|js|mts|cts|jsx|tsx)$/iu

/** `it('名字')` / `test("名字")` 的第一个字符串字面量。 */
const TEST_CALL = /(?<![\w$.])(?:it|test)\s*\(\s*(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/gu

/**
 * 收集仓库里出现过的测试名。
 *
 * 原来这个分支是个空壳（只 `continue`，无条件 `unverifiable`），于是**所有**测试锚点
 * 永远查不了。本仓库自己就用 `node --test "test/*.test.mjs"` + `it(...)`，
 * 不实现它等于关掉了这一整类锚点。
 *
 * 缓存挂在 `files` 上 —— 它的生命周期就是一次 audit。
 */
function collectTestNames(root, files) {
  if (files.testNames) return files.testNames

  const names = new Set()
  let complete = true
  let scanned = 0

  const walk = (absolute) => {
    let entries
    try {
      entries = readdirSync(absolute, { withFileTypes: true })
    } catch {
      complete = false
      return
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = join(absolute, entry.name)
      if (entry.isDirectory()) {
        // 依赖目录与隐藏目录不是这个项目的测试
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        walk(child)
        continue
      }
      if (!TEST_FILE.test(entry.name)) continue
      const text = files.read(child)
      if (text === null) {
        // 读不了就不能断言「名字不存在」—— 那可能是谎报
        complete = false
        continue
      }
      scanned += 1
      for (const match of text.matchAll(TEST_CALL)) names.add(match[2])
    }
  }

  for (const dir of TEST_DIRS) {
    const absolute = resolve(root, dir)
    try {
      if (!statSync(absolute).isDirectory()) continue
    } catch {
      continue // 目录不存在不是错误 —— 项目可能不用这三个名字
    }
    walk(absolute)
  }

  // 一个测试文件都没读到（或中途读不了）→ 没资格下「不存在」的判决
  const result = { names, complete: complete && scanned > 0 }
  files.testNames = result
  return result
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
    if (!path) return result(DRIFT.unverifiable, '符号锚点没有文件路径，无法定位')

    const absolute = resolveAnchorPath(root, path)
    if (absolute === null) return result(DRIFT.unsafePath, `${path} 逃出了仓库 —— 拒绝读取库外文件`)

    const text = files.read(absolute)
    if (text === null) return result(DRIFT.quarantined, `文件不存在：${path}`)

    const definition = symbolBodyHash(text, name)
    if (!definition) {
      // 名字还在文件里（注释、字符串、调用处）→ 指错了，不是消失了
      if (new RegExp(`\\b${escapeRegex(name)}\\b`, 'u').test(text)) {
        return result(DRIFT.notADefinition, `${name} 出现在 ${path} 但不在定义处（注释 / 字符串 / 调用点）`)
      }
      return result(DRIFT.quarantined, `符号不存在：${path}#${name}`)
    }

    if (anchor.hash && definition.hash !== anchor.hash) {
      return result(DRIFT.advisory, `${path}#${name} 的体变了（第 ${definition.line} 行）—— 重构不是攻击`)
    }
    return result(DRIFT.healthy, `${path}#${name} 在第 ${definition.line} 行`)
  }

  if (kind === 'test') {
    // ref 是测试名：仓库里能不能找到这个字符串（本仓库用 node --test 的 it(...)）
    const { names, complete } = collectTestNames(root, files)
    if (names.has(ref)) return result(DRIFT.healthy, `测试「${ref}」仍在`)
    if (!complete) return result(DRIFT.unverifiable, `测试锚点「${ref}」无法完整复查（有测试文件读不了）`)
    return result(DRIFT.quarantined, `测试不存在：${ref}`)
  }

  if (FILE_LIKE.has(kind)) {
    const { path, from } = parseFileRef(ref) ?? {}
    if (!path) return result(DRIFT.unverifiable, '文件锚点缺少路径')

    const absolute = resolveAnchorPath(root, path)
    if (absolute === null) return result(DRIFT.unsafePath, `${path} 逃出了仓库 —— 拒绝读取库外文件`)

    const text = files.read(absolute)
    if (text === null) return result(DRIFT.quarantined, `文件不存在：${path}`)

    if (from !== null && from !== undefined) {
      // 行数**先去掉尾部换行**再数：否则每个以换行结尾的文件都多一行，
      // 指向「最后一行下一行」的锚点永远不越界（off-by-one 让消失的切片报 healthy）
      const lineCount = lineCountOf(text)
      if (from > lineCount) {
        return result(DRIFT.quarantined, `${path} 只有 ${lineCount} 行，锚点在 ${from} 行 —— 切片消失了`)
      }
    }

    if (anchor.hash) {
      // 切片哈希必须走 anchor.js（gate 写入也走它）。两侧各算一套就是假 advisory 的根源。
      const digest = anchorHash(text, ref)
      if (digest !== anchor.hash) {
        return result(DRIFT.advisory, `${path}${from !== null ? `:${from}` : ''} 的切片变了 —— 重构不是攻击`)
      }
    }

    return result(DRIFT.healthy, `${path}${from !== null ? `:${from}` : ''} 仍在`)
  }

  return result(DRIFT.unverifiable, `未知锚点类型：${kind}`)
}

/* ── 条目 / 语料复查 ─────────────────────────────────────────────── */

/** 一条判决：条目级取最坏的锚点（unsafe-path > quarantined > advisory > 其余）。 */
const SEVERITY = {
  [DRIFT.unsafePath]: 4,
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

/** 需要在 audit 里**点名**的判决 —— 健康的和「查不了」的都不算漂移。 */
const DRIFTED = new Set([DRIFT.unsafePath, DRIFT.quarantined, DRIFT.advisory, DRIFT.notADefinition])

/** 复查一条记忆的全部锚点。 */
export function checkEvidence(root, entry, { files = createFileCache() } = {}) {
  const anchors = (entry.evidence ?? []).map((anchor) => checkAnchor(root, anchor, { files }))
  return {
    id: entry.id,
    verdict: anchors.length === 0 ? DRIFT.unverifiable : worstOf(anchors.map((anchor) => anchor.verdict)),
    anchors,
    // **点名漂移的锚点** —— 设计 §14 第 5 条要求的就是这一句。
    // `symbol-not-a-definition` 也算漂移：锚点指错了，不点名等于默许它继续指错。
    drifted: anchors.filter((anchor) => DRIFTED.has(anchor.verdict)),
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
  const unsafePath = []
  // 按**锚点**计，不是按条目计：audit 文案说的是「条锚点」，
  // 一条记忆带五个 commit 锚点却算成 1 会让读者以为只有一条查不了
  let unverifiable = 0

  for (const entry of entries) {
    const result = checkEvidence(root, entry, { files })
    unverifiable += result.anchors.filter((anchor) => anchor.verdict === DRIFT.unverifiable).length
    if (result.verdict === DRIFT.unsafePath) unsafePath.push(result)
    else if (result.verdict === DRIFT.quarantined) quarantined.push(result)
    else if (result.verdict === DRIFT.advisory) advisory.push(result)
    else if (result.verdict === DRIFT.notADefinition) notADefinition.push(result)
  }

  // `at` 必须是 ISO 串：其它字段都是给人读的时间，毫秒数混在里面只会让人再算一次
  return {
    quarantined,
    advisory,
    notADefinition,
    unsafePath,
    unverifiable,
    checked: entries.length,
    at: new Date(now).toISOString(),
  }
}

