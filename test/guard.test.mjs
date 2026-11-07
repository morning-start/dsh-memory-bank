/**
 * 写入口收口（`lib/guard.js`）+ 路径身份（`util.canonicalPath`）。
 *
 * 这一组钉住的不是「正则对不对」，而是**它会不会误拦**：
 *
 *   - 一个把 `.dsh-memory-evil/` 当成记忆库的守卫，会在别人的仓库里
 *     `ask` 一次毫无理由的问题 —— 而一次假拦截就足以让人关掉整个守卫。
 *   - 一个在 Linux 上折叠大小写的 `canonicalPath`，会把
 *     `src/Foo.ts` 与 `src/foo.ts` 合并成一条证据锚点。
 *
 * 所以一半的用例是反例，而反例比正例更值得写在注释里。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MEMORY_DIR_TOKEN,
  extractWritePaths,
  inspectToolCall,
  memoryTokens,
  shellWritesMemory,
  stripShellQuoted,
} from '../lib/guard.js'
import { CASE_INSENSITIVE_FS, canonicalPath, normalizeRef } from '../lib/util.js'

const ROOT = process.platform === 'win32' ? 'E:\\repo' : '/repo'
const join = (...parts) => (process.platform === 'win32' ? parts.join('\\') : parts.join('/'))

/* ── 路径身份 ───────────────────────────────────────────────────── */

describe('canonicalPath：同一个文件只有一个身份', () => {
  it('三种写法得到同一个值（这是它存在的全部理由）', () => {
    const spellings = [
      join(ROOT, MEMORY_DIR_TOKEN, 'memories', 'x.md'),
      `${MEMORY_DIR_TOKEN}/memories/x.md`,
      `${MEMORY_DIR_TOKEN}\\memories\\x.md`,
      `./${MEMORY_DIR_TOKEN}/memories/x.md`,
      `${MEMORY_DIR_TOKEN}//memories//x.md`,
    ]
    const canonical = new Set(spellings.map((raw) => canonicalPath(ROOT, raw)))
    assert.equal(canonical.size, 1, `规范形式不止一个：${JSON.stringify([...canonical])}`)
    assert.equal([...canonical][0], `${MEMORY_DIR_TOKEN}/memories/x.md`)
  })

  it('逃出仓库返回 null（不是「原样返回」）', () => {
    assert.equal(canonicalPath(ROOT, '../outside.md'), null)
    assert.equal(canonicalPath(ROOT, join(ROOT, '..', 'outside.md')), null)
  })

  it('空值 / 非字符串返回 null，不抛', () => {
    assert.equal(canonicalPath(ROOT, ''), null)
    assert.equal(canonicalPath(ROOT, null), null)
    assert.equal(canonicalPath(ROOT, undefined), null)
    assert.equal(canonicalPath(ROOT, 42), null)
  })

  it('大小写折叠**按平台** —— 这是 Linux 上两条锚点不能合并的原因', () => {
    const upper = canonicalPath(ROOT, '.DSH-Memory/memories/X.md')
    if (CASE_INSENSITIVE_FS) {
      assert.equal(upper, `${MEMORY_DIR_TOKEN}/memories/x.md`)
    } else {
      assert.equal(upper, '.DSH-Memory/memories/X.md', 'Linux 上折叠会把两个不同文件并成一个')
    }
  })

  it('normalizeRef 是展示形态：不折叠大小写，但折叠 `//` 与去空白', () => {
    assert.equal(normalizeRef('  ./a//b\\c.md  '), 'a/b/c.md')
    assert.equal(normalizeRef('A/B.md'), 'A/B.md', 'normalizeRef 不该折叠大小写')
  })
})

/* ── 参数提取 ───────────────────────────────────────────────────── */

describe('extractWritePaths', () => {
  it('认得各家的单值键', () => {
    assert.deepEqual(extractWritePaths({ path: 'a.md' }), ['a.md'])
    assert.deepEqual(extractWritePaths({ file_path: 'b.md' }), ['b.md'])
    assert.deepEqual(extractWritePaths({ filePath: 'c.md' }), ['c.md'])
  })

  it('multiedit 的 edits[].path', () => {
    assert.deepEqual(extractWritePaths({ edits: [{ path: 'a.md' }, { filePath: 'b.md' }] }), ['a.md', 'b.md'])
  })

  it('unified diff 头（只取 b/ 侧，a/ 与 b/ 同路径会去重）', () => {
    const patch = '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new\n'
    assert.deepEqual(extractWritePaths({ patch }), ['src/x.ts'])
  })

  it('OpenAI patch 格式', () => {
    const patch = '*** Begin Patch\n*** Update File: src/y.ts\n@@\n-a\n+b\n*** Delete File: src/z.ts\n*** End Patch'
    assert.deepEqual(extractWritePaths({ patch }), ['src/y.ts', 'src/z.ts'])
  })

  it('参数缺失 / 不是对象时返回空数组，不抛', () => {
    assert.deepEqual(extractWritePaths(null), [])
    assert.deepEqual(extractWritePaths('nope'), [])
    assert.deepEqual(extractWritePaths({}), [])
  })
})

/* ── shell ──────────────────────────────────────────────────────── */

// `stripShellQuoted`（不是 `stripQuoted`）：这个名字是**消歧**。
// `lifecycle.js` 的 `stripQuotedProse` 做的是同一类动作，但定界符集合、
// `\` 转义规则、长度保证全不同 —— 同名不同义的两份实现是漂移的温床。
describe('stripShellQuoted', () => {
  it('引号内容变空格，长度不变（写指示符判定不被字符串字面量骗到）', () => {
    const command = 'echo "a > b"'
    const stripped = stripShellQuoted(command)
    assert.equal(stripped.length, command.length)
    assert.doesNotMatch(stripped, />/, '引号里的 `>` 不该被当成重定向')
  })

  it('转义也吃掉', () => {
    assert.doesNotMatch(stripShellQuoted('echo \\>'), />/)
  })
})

describe('memoryTokens', () => {
  it('切出指向记忆库的 token', () => {
    assert.deepEqual(memoryTokens(`cp x ${MEMORY_DIR_TOKEN}/memories/a.md`), [`${MEMORY_DIR_TOKEN}/memories/a.md`])
  })

  it('不碰记忆库的命令返回空（O(1) 预筛）', () => {
    assert.deepEqual(memoryTokens('ls src'), [])
  })
})

describe('shellWritesMemory', () => {
  const writes = [
    `echo hi > ${MEMORY_DIR_TOKEN}/memories/a.md`,
    `echo hi >> ${MEMORY_DIR_TOKEN}/memories/a.md`,
    `cat x | tee ${MEMORY_DIR_TOKEN}/memories/a.md`,
    `cp /tmp/a.md ${MEMORY_DIR_TOKEN}/memories/a.md`,
    `mv ${MEMORY_DIR_TOKEN}/memories/a.md /tmp/`,
    `rm -rf ${MEMORY_DIR_TOKEN}`,
    `sed -i 's/a/b/' ${MEMORY_DIR_TOKEN}/memories/a.md`,
  ]
  for (const command of writes) {
    it(`拦：${command}`, () => assert.equal(shellWritesMemory(command), true))
  }

  const reads = [
    `cat ${MEMORY_DIR_TOKEN}/memories/a.md`,
    `grep -r foo ${MEMORY_DIR_TOKEN}`,
    `ls -la ${MEMORY_DIR_TOKEN}/memories`,
    `git status --porcelain`,
    `echo "a > b"`,
    `echo "${MEMORY_DIR_TOKEN} 是个目录"`,
  ]
  for (const command of reads) {
    it(`放行：${command}`, () => assert.equal(shellWritesMemory(command), false))
  }
})

/* ── 判定 ───────────────────────────────────────────────────────── */

describe('inspectToolCall', () => {
  const ask = (exec) => inspectToolCall(exec, { root: ROOT })

  it('write 记忆库 → ask，且点名 memory_remember', () => {
    const decision = ask({ name: 'write', arguments: { file_path: `${MEMORY_DIR_TOKEN}/memories/x.md`, content: '' } })
    assert.equal(decision?.kind, 'ask')
    assert.match(decision.displayReason.zh, /memory_remember/, '错误消息必须给可执行的下一步')
    assert.match(decision.displayReason.en, /memory_remember/)
  })

  it('edit / multiedit / apply_patch 都拦', () => {
    for (const name of ['edit', 'multiedit', 'apply_patch', 'patch', 'str_replace_editor']) {
      assert.equal(ask({ name, arguments: { path: `${MEMORY_DIR_TOKEN}/memories/x.md` } })?.kind, 'ask', name)
    }
  })

  it('**前缀陷阱**：`.dsh-memory-evil/` 不是记忆库（假拦截会毁掉守卫的信任）', () => {
    assert.equal(ask({ name: 'write', arguments: { path: `${MEMORY_DIR_TOKEN}-evil/x.md` } }), null)
  })

  it('**逃出仓库**：`../.dsh-memory/x.md` 不是本仓库的记忆库', () => {
    assert.equal(ask({ name: 'write', arguments: { path: `../${MEMORY_DIR_TOKEN}/x.md` } }), null)
  })

  it('普通源码文件放行', () => {
    assert.equal(ask({ name: 'write', arguments: { file_path: 'src/db/pool.ts' } }), null)
  })

  it('bash 写记忆库 → ask', () => {
    const decision = ask({ name: 'bash', arguments: { command: `echo hi > ${MEMORY_DIR_TOKEN}/memories/x.md` } })
    assert.equal(decision?.kind, 'ask')
  })

  it('bash 删掉**整个**记忆库 → ask（裸目录是最该拦的一种）', () => {
    assert.equal(ask({ name: 'bash', arguments: { command: `rm -rf ${MEMORY_DIR_TOKEN}` } })?.kind, 'ask')
  })

  it('bash 里的**前缀陷阱**也放行（切出来的 token 要过 canonicalPath 才算数）', () => {
    assert.equal(ask({ name: 'bash', arguments: { command: `rm -rf ${MEMORY_DIR_TOKEN}-evil/` } }), null)
  })

  it('bash 读记忆库放行', () => {
    assert.equal(ask({ name: 'bash', arguments: { command: `cat ${MEMORY_DIR_TOKEN}/memories/x.md` } }), null)
  })

  it('未知工具不管（收紧名单比放开安全）', () => {
    assert.equal(ask({ name: 'memory_recall', arguments: { query: 'x' } }), null)
  })

  it('拿不到 root 时放行 —— 守卫崩溃不能变成「什么都做不了」', () => {
    assert.equal(inspectToolCall({ name: 'write', arguments: { path: `${MEMORY_DIR_TOKEN}/x.md` } }, { root: null }), null)
  })
})
