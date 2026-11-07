/**
 * 锚点解析与哈希（唯一事实源）。
 *
 * gate 写入与 drift 复查都走这里，所以这个文件的每一条断言都是**跨文件契约**：
 * 改了解析规则，写入侧与复查侧会同时变，但历史上出过一次两边各算一套的漂移，
 * 于是这里把边界钉死 —— 尤其是 Windows 盘符（`E:\repo\lib\x.js:17-30`），
 * 它就是 `split(':')` 会当场断掉的那种输入。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { anchorHash, lineCountOf, parseFileRef, sliceOf, symbolBodyHash } from '../lib/anchor.js'

describe('parseFileRef', () => {
  it('Windows 盘符不被当成行号分隔符', () => {
    assert.deepEqual(parseFileRef('E:\\repo\\lib\\x.js:17-30'), { path: 'E:\\repo\\lib\\x.js', from: 17, to: 30 })
    assert.deepEqual(parseFileRef('E:\\repo\\lib\\x.js:17'), { path: 'E:\\repo\\lib\\x.js', from: 17, to: 17 })
    assert.deepEqual(parseFileRef('E:\\repo\\lib\\x.js'), { path: 'E:\\repo\\lib\\x.js', from: null, to: null })
  })

  it('POSIX 路径与纯文件名', () => {
    assert.deepEqual(parseFileRef('src/a.ts:1-3'), { path: 'src/a.ts', from: 1, to: 3 })
    assert.deepEqual(parseFileRef('src/a.ts'), { path: 'src/a.ts', from: null, to: null })
    assert.deepEqual(parseFileRef('  src/a.ts:9  '), { path: 'src/a.ts', from: 9, to: 9 })
  })

  it('解析不出路径 → null（不拿空路径去撞文件系统）', () => {
    for (const ref of [null, undefined, '', '   ', ':17']) assert.equal(parseFileRef(ref), null, String(ref))
  })
})

describe('sliceOf', () => {
  const text = ['a', 'b', 'c', ''].join('\n') // 以换行结尾

  it('1-based 行号', () => {
    assert.equal(sliceOf(text, 1, 2), 'a\nb')
    assert.equal(sliceOf(text, 2, 2), 'b')
    assert.equal(sliceOf(text, 3, 3), 'c')
  })

  it('from 为 null → 整个 text', () => {
    assert.equal(sliceOf(text, null, null), text)
    assert.equal(sliceOf(text), text)
  })

  it('越界夹到边界（越界判决由 drift 单独做）', () => {
    assert.equal(sliceOf(text, 99), '')
    assert.equal(sliceOf('', 1), '')
  })
})

describe('anchorHash', () => {
  const text = ['one', 'two', 'three', ''].join('\n')

  it('只依赖切片内容：同行号 → 同哈希；不同切片 → 不同哈希', () => {
    assert.equal(anchorHash(text, 'f.ts:2'), anchorHash(text, 'f.ts:2-2'))
    assert.notEqual(anchorHash(text, 'f.ts:2'), anchorHash(text, 'f.ts:1'))
    assert.equal(anchorHash(text, 'f.ts'), anchorHash(text, 'f.ts:1-4'))
  })

  it('ref 解析不出路径 → null', () => {
    assert.equal(anchorHash(text, ''), null)
    assert.equal(anchorHash(text, null), null)
  })

  /* ── 回归：BOM 不能改变哈希（写入侧剥了、复查侧没剥就是假 advisory） ── */

  it('BOM 不参与哈希', () => {
    const withBom = `\uFEFF${text}`
    assert.equal(anchorHash(withBom, 'f.ts'), anchorHash(text, 'f.ts'))
    assert.equal(anchorHash(withBom, 'f.ts:1'), anchorHash(text, 'f.ts:1'))
  })
})

describe('lineCountOf', () => {
  it('尾部换行不算一行', () => {
    assert.equal(lineCountOf('a\nb\n'), 2)
    assert.equal(lineCountOf('a\nb'), 2)
  })

  it('空文件是 0 行', () => {
    assert.equal(lineCountOf(''), 0)
    assert.equal(lineCountOf(null), 0)
  })
})

describe('symbolBodyHash', () => {
  it('体变了 → 哈希变（解构参数 / 字符串里的 } 都不能截断体）', () => {
    const a = symbolBodyHash('export function pick({ id, name }) { return id }', 'pick')
    const b = symbolBodyHash('export function pick({ id, name }) { return name }', 'pick')
    assert.ok(a && b)
    assert.notEqual(a.hash, b.hash)

    const c = symbolBodyHash("function format(n) { return '}' }", 'format')
    const d = symbolBodyHash("function format(n) { return '}}' }", 'format')
    assert.notEqual(c.hash, d.hash)
  })

  it('体没变 → 哈希稳定（同输入同输出）', () => {
    const text = 'export function createPool() {\n  return 1\n}\n'
    assert.equal(symbolBodyHash(text, 'createPool').hash, symbolBodyHash(text, 'createPool').hash)
  })

  it('报定义所在行号（1-based）', () => {
    const text = ['// 头注释', '', 'class A {', '  get value() {', '    return 1', '  }', '}'].join('\n')
    assert.equal(symbolBodyHash(text, 'value').line, 4)
  })

  it('行首调用点不是定义 → null', () => {
    assert.equal(symbolBodyHash('createPool({ max: 10 })', 'createPool'), null)
  })

  it('BOM 不影响符号定位（否则第 1 行的定义永远找不到）', () => {
    const withBom = '\uFEFFexport function createPool() {\n  return 1\n}\n'
    const plain = 'export function createPool() {\n  return 1\n}\n'
    assert.equal(symbolBodyHash(withBom, 'createPool').hash, symbolBodyHash(plain, 'createPool').hash)
    assert.equal(symbolBodyHash(withBom, 'createPool').line, 1)
  })
})
