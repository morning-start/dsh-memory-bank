/**
 * 锚点解析与哈希 —— **gate 写入与 drift 复查共用的唯一事实源**。
 *
 * 为什么这几个函数必须单独拎出来：它们原来在 gate.js 与 drift.js 各写了一份，
 * 而且两份**算法不同** —— gate 写入时哈希整个文件，drift 复查时哈希切片。
 * 于是只要锚点带行号，两侧的哈希就永远对不上，**100% 报假 advisory**：
 *
 *   写入：hash = sha256(整个文件)
 *   复查：hash = sha256(第 17-30 行)   → 不相等 → "切片变了"
 *
 * 假警报比不报警更糟。每一次重构都会把整库标成「不可信」，然后所有人学会
 * 忽略这个警告 —— 那正是漂移检测存在的理由被抵消的样子。
 *
 * 所以：**任何一侧要算锚点哈希，都必须调用这里**。两个实现就是漂移 bug 的根源。
 *
 * 这一层是叶子模块（只依赖 `node:crypto` 的哈希 + 两个同为叶子的原语模块），
 * 因为 gate.js / drift.js 都会 import 它，引入业务依赖会制造循环，
 * 也会让写入路径依赖可选的复查层。
 *
 * 哈希本身**不在这里实现**：`sha256` 是 `util.js` 的导出。上一版这里复制了一份
 * —— 而「同一算法两套实现」正是本文件开头那个假 advisory bug 的成因，
 * 复制一份哈希等于把这个 bug 请回来。`escapeRegex` 同理（`kernel/text.js`）。
 */

import { escapeRegex } from './kernel/text.js'
import { sha256 } from './util.js'

/**
 * 去掉开头的 BOM。
 *
 * BOM 不是内容，但它会同时破坏两件事：
 *   - `^[ \t]*export` 之类的行首锚定在第 1 行失配（BOM 不是空白字符）；
 *   - 写入侧剥了、复查侧没剥时哈希不同 —— 又是「同一算法两套实现」。
 *
 * 所以归一化放在**这一层**：两侧都调用这里的函数，就都不需要记得先剥。
 */
function withoutBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/* ── 文件锚点 ─────────────────────────────────────────────────────── */

/**
 * 解析 `path`、`path:from` 或 `path:from-to`。
 *
 * **不能用 `split(':')`**：Windows 盘符（`E:\work\x.js`）里第一个冒号属于路径，
 * 分开就得到空路径。判据是「最后一个 `:` 之后全是数字（或 `数字-数字`）」——
 * 行号只有这一种形态，别的都是路径的一部分。
 *
 * 解析不出路径（null / 空串 / 纯空白）返回 **null**，让调用方报 `unverifiable`，
 * 而不是拿一个空路径去撞文件系统、再谎报「文件不存在」。
 *
 * @param {unknown} ref
 * @returns {{ path: string, from: number|null, to: number|null } | null}
 */
export function parseFileRef(ref) {
  const text = String(ref ?? '').trim()
  if (!text) return null

  // 贪婪 `.*` 等价于「按最后一个冒号切」，且天然兼容盘符与 POSIX 绝对路径
  const line = /^(.*):(\d+)(?:-(\d+))?$/.exec(text)
  if (line) {
    const path = line[1].trim()
    if (!path) return null
    const from = Number(line[2])
    // 只写了一个行号时，切片就是那一行 —— 用 from 兜底，而不是让 to 变 null
    return { path, from, to: line[3] ? Number(line[3]) : from }
  }

  return { path: text, from: null, to: null }
}

/**
 * 按 **1-based** 行号取切片。`from` 为 null 时返回整个 text。
 *
 * 越界不抛：`slice` 天然夹到边界，越界由调用方（drift）单独判 `quarantined`，
 * 这样「切片没了」和「切片变了」还是两个判决。
 *
 * @param {unknown} text
 * @param {number|null|undefined} from
 * @param {number|null|undefined} to
 * @returns {string}
 */
export function sliceOf(text, from, to) {
  const source = withoutBom(String(text ?? ''))
  if (from === null || from === undefined) return source
  const start = Math.max(1, Number(from))
  const end = to === null || to === undefined ? start : Math.max(start, Number(to))
  return source.split('\n').slice(start - 1, end).join('\n')
}

/**
 * 锚点哈希：`sliceOf` 之后的 sha256。**gate 写入与 drift 复查共用的唯一算法。**
 *
 * @param {unknown} text 文件全文（调用方负责读盘 —— 本模块不做 IO，纯函数）
 * @param {unknown} ref  `path` / `path:from` / `path:from-to`
 * @returns {string|null} ref 解析不出路径时 null（调用方据此报 unverifiable）
 */
export function anchorHash(text, ref) {
  const parsed = parseFileRef(ref)
  if (!parsed) return null
  return sha256(sliceOf(text, parsed.from, parsed.to))
}

/**
 * 行数。**尾部换行不是一行** —— 直接 `split('\n').length` 会让每个以换行结尾的
 * 文件多算一行，于是 `file:最后一行的下一行` 永远不越界，锚点指向不存在的行也报 healthy。
 * 空文件是 0 行。
 *
 * @param {unknown} text
 * @returns {number}
 */
export function lineCountOf(text) {
  const body = withoutBom(String(text ?? '')).replace(/\n$/, '')
  return body === '' ? 0 : body.split('\n').length
}

/* ── 符号锚点 ─────────────────────────────────────────────────────── */

/**
 * 找出符号的**定义处**。只认定义形态 —— 这正是 `symbol-not-a-definition`
 * 存在的理由：一个只出现在注释或调用点的名字，看起来「还在」，但它已经不再指向任何东西。
 *
 * 第三条模式（方法简写 / 类成员）曾经是 `^\\s*(?:static |async )?NAME\\s*\\(`，
 * 同时匹配定义和**行首调用**，于是漂移检测会把调用点当成定义、永远报 healthy。
 * 收紧成「参数表 + 可选返回类型 + 行尾 `{`」—— 只有真的开出函数体的才算定义。
 */
function findDefinition(text, name) {
  const escaped = escapeRegex(name)
  const patterns = [
    // function / class / interface / type / enum / namespace
    new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:default[ \\t]+)?(?:async[ \\t]+)?(?:function[*]?|class|interface|type|enum|namespace)[ \\t]+${escaped}\\b`, 'm'),
    // const / let / var（含箭头函数）
    new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:const|let|var)[ \\t]+${escaped}[ \\t]*[:=]`, 'm'),
    // 方法简写 / 类成员：名字 + 参数表 + 可选返回类型 + 体
    new RegExp(
      `^[ \\t]*(?:export[ \\t]+)?(?:default[ \\t]+)?(?:static[ \\t]+)?(?:async[ \\t]+)?(?:get[ \\t]+|set[ \\t]+)?${escaped}\\s*\\([^)]*\\)\\s*(?::[^{;=]+)?\\s*\\{`,
      'm',
    ),
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match) return { offset: match.index, line: text.slice(0, match.index).split('\n').length }
  }
  return null
}

/** 跳过字符串 / 模板字面量，返回闭合引号之后的下标。引号里的括号不是结构。 */
function skipLiteral(text, index) {
  const quote = text[index]
  let cursor = index + 1
  while (cursor < text.length) {
    const char = text[cursor]
    if (char === '\\') {
      cursor += 2
      continue
    }
    if (char === quote) return cursor + 1
    cursor += 1
  }
  return text.length
}

/**
 * 取符号的体：从定义处做**括号栈**匹配。
 *
 * 旧实现是「找第一个 `{` 再数花括号」，命中的可能是解构参数 `({ id, name })`，
 * 深度在参数表就归零 —— 切片只到参数表，**函数体真改了也报 healthy（漏报）**。
 * 字符串里的 `}`（`return '}'`）同理。
 *
 * 所以必须同时跟踪 `(` `[` `{`：只有当 `{` 是**最外层**（另两种深度都为 0）时
 * 才算函数体起点，然后配平到深度归零；字符串与注释整体跳过。
 *
 * 拿不到体（`export const X = 42` 没有花括号）就退化到「这一行到分号」。
 * 退化是可接受的：它只会让 `advisory` 更敏感，不会造成误判成 `quarantined`。
 */
function symbolBody(text, offset) {
  let brace = 0
  let round = 0
  let square = 0
  let started = false
  let index = offset

  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]

    // 字符串 / 模板字面量里的括号不是结构：`return '}'` 会把朴素计数提前归零
    if (char === '"' || char === "'" || char === '`') {
      index = skipLiteral(text, index)
      continue
    }
    // 注释同理：`// 别忘了这里的 }` 会让朴素计数提前归零
    if (char === '/' && next === '/') {
      const newline = text.indexOf('\n', index)
      index = newline < 0 ? text.length : newline + 1
      continue
    }
    if (char === '/' && next === '*') {
      const close = text.indexOf('*/', index + 2)
      index = close < 0 ? text.length : close + 2
      continue
    }

    if (char === '(') {
      round += 1
    } else if (char === ')') {
      round = Math.max(0, round - 1)
    } else if (char === '[') {
      square += 1
    } else if (char === ']') {
      square = Math.max(0, square - 1)
    } else if (char === '{') {
      // 只有外层括号都归零的 `{` 才是函数体起点；参数表里的解构 `{` 不是
      if (round === 0 && square === 0) {
        brace += 1
        started = true
      }
    } else if (char === '}' && brace > 0) {
      brace -= 1
      if (brace === 0) return text.slice(offset, index + 1)
    }

    index += 1
  }

  if (started) return text.slice(offset)
  // 没有花括号 → 单行定义
  const semicolon = text.indexOf(';', offset)
  const newline = text.indexOf('\n', offset)
  const end = semicolon >= 0 ? semicolon : newline >= 0 ? newline : text.length
  return text.slice(offset, end + 1)
}

/**
 * 符号体哈希：**gate 写入与 drift 复查共用的唯一算法**。
 *
 * @param {unknown} text 文件全文
 * @param {unknown} name 符号名（`createPool`）
 * @returns {{ hash: string, line: number } | null} 名字没有定义形态时 null
 */
export function symbolBodyHash(text, name) {
  const source = withoutBom(String(text ?? ''))
  const definition = findDefinition(source, String(name ?? ''))
  if (!definition) return null
  return { hash: sha256(symbolBody(source, definition.offset)), line: definition.line }
}
