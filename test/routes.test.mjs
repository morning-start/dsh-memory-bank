/**
 * 目录 README 路由层（`lib/routes.js`）。
 *
 * 这一组钉住的不是「扫描对不对」，而是**它会不会说谎** ——
 * 一个把「别处的引用」当成「本目录登记了」的解析器，会产出**假的 missing**；
 * 而假失败会训练人忽略这个检查，比没有检查更糟。所以一半的用例是反例。
 *
 * 最后一条用例是**自检**：本仓库自己的 `docs/` 必须过这个检查。
 * 否则「CI 强制」就只是文档里的一句话。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ROUTE_INDEX_NAME,
  clearRouteCache,
  inspectFolder,
  listDocFolders,
  parseListedFiles,
  routeFallbackHint,
  routeReport,
  summarizeRoutes,
} from '../lib/routes.js'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 建一棵临时目录树：`{ 'docs/README.md': '...', 'docs/a.md': '' }` */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-routes-'))
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, ...relative.split('/'))
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
  return root
}

/* ── 解析：三种写法都要命中 ─────────────────────────────────────── */

describe('parseListedFiles：三种列法', () => {
  it('表格里的相对链接', () => {
    const listed = parseListedFiles('| 想做什么 | 读这个 |\n|---|---|\n| 改门禁 | [01-门](01-门.md) |')
    assert.deepEqual([...listed], ['01-门.md'])
  })

  it('反引号里的裸文件名', () => {
    assert.deepEqual([...parseListedFiles('先看 `02-设计.md` 再说')], ['02-设计.md'])
  })

  it('裸列（`- x.md`）', () => {
    assert.deepEqual([...parseListedFiles('- 03-审核协议.md\n- 04-实施计划.md')].sort(), [
      '03-审核协议.md',
      '04-实施计划.md',
    ])
  })

  it('带目录前缀时只认**本目录**', () => {
    assert.deepEqual([...parseListedFiles('[x](docs/01-a.md)', 'docs')], ['01-a.md'])
    assert.deepEqual([...parseListedFiles('[x](01-a.md)', 'docs')], ['01-a.md'])
  })
})

/* ── 解析：反例（这些**不能**被算成「本目录登记了」） ─────────────── */

describe('parseListedFiles：反例', () => {
  it('`**/*.md` 这种 glob 残片不算', () => {
    assert.equal(parseListedFiles('用 `glob("docs/**/*.md")` 兜底').size, 0)
  })

  it('行号引用 `file.md:191-202` 不算 —— 否则跨仓库引用会变成假的 missing', () => {
    assert.equal(parseListedFiles('对方的 `design-index-first-architecture.md:191-202` 这么写').size, 0)
  })

  it('索引文件自己不参与（否则每个 README 都欠自己一条）', () => {
    assert.equal(parseListedFiles('见 `README.md` 的维护约定').size, 0)
  })

  it('别的目录的引用不算进本目录', () => {
    // 仓库根的 README 会列 `docs/01-a.md` —— 那些文件不在根目录。
    // 按 basename 折叠的话，根的索引会声称自己登记了 `01-a.md`。
    assert.equal(parseListedFiles('[a](docs/01-a.md)\n[b](design/README.md)').size, 0)
  })
})

/* ── 目录发现 ────────────────────────────────────────────────────── */

describe('listDocFolders', () => {
  it('只列一层，跳过 node_modules 与点目录', () => {
    const root = tree({
      'docs/a.md': '',
      'design/b.md': '',
      'node_modules/pkg/c.md': '',
      '.cache/d.md': '',
      'lib/e.js': '',
    })
    try {
      // `lib` 也列出来 —— 「有没有 .md」是 `inspectFolder` 的判定，
      // 不是发现层的。发现层只负责「这个目录存在且不是构建产物」。
      assert.deepEqual(listDocFolders(root), ['design', 'docs', 'lib'])
      assert.equal(inspectFolder(root, 'lib'), null, '没有 .md 的目录不参与路由')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/* ── 单目录 ──────────────────────────────────────────────────────── */

describe('inspectFolder', () => {
  it('没有 .md 的目录返回 null（不是错误）', () => {
    const root = tree({ 'lib/a.js': '', 'README.md': 'x' })
    try {
      assert.equal(inspectFolder(root, 'lib'), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('分开报告 unlisted 与 missing', () => {
    const root = tree({
      'docs/README.md': '- 01-a.md\n- 03-已删.md\n',
      'docs/01-a.md': '',
      'docs/02-b.md': '',
    })
    try {
      const folder = inspectFolder(root, 'docs')
      assert.equal(folder.hasReadme, true)
      assert.deepEqual(folder.files, ['01-a.md', '02-b.md'])
      assert.deepEqual(folder.unlisted, ['02-b.md'], '02 存在但没登记')
      assert.deepEqual(folder.missing, ['03-已删.md'], '03 登记了但不存在')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('缺 README 时 files 仍然要数出来（否则报错信息是空的）', () => {
    const root = tree({ 'docs/a.md': '', 'docs/b.md': '' })
    try {
      const folder = inspectFolder(root, 'docs')
      assert.equal(folder.hasReadme, false)
      assert.equal(folder.files.length, 2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/* ── 全量报告 ────────────────────────────────────────────────────── */

describe('routeReport', () => {
  it('全部合规时 ok=true', () => {
    const root = tree({
      'README.md': '[c](CHANGELOG.md)',
      'CHANGELOG.md': '',
      'docs/README.md': '- 01-a.md\n- 02-b.md',
      'docs/01-a.md': '',
      'docs/02-b.md': '',
    })
    try {
      const report = routeReport(root, { useCache: false })
      assert.equal(report.ok, true, JSON.stringify(report))
      assert.deepEqual(report.folders.map((folder) => folder.dir), ['', 'docs'])
      assert.equal(report.folders[0].files.length, 1, '根只数 CHANGELOG（README 自己不算）')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('缺索引 / 未登记 / 登记失效 三类都能报出来', () => {
    const root = tree({
      'README.md': '',
      'CHANGELOG.md': '',
      'docs/README.md': '- 09-没了.md',
      'docs/01-a.md': '',
      'design/x.md': '',
    })
    try {
      const report = routeReport(root, { useCache: false })
      assert.equal(report.ok, false)
      assert.deepEqual(report.missingReadme, ['design'])
      // 注意 `design/x.md` 也出现在 unlisted 里 —— 缺索引的目录，它的每个文件
      // 都「没被登记」。两条都报是有意的：`missingReadme` 说「建个索引」，
      // `unlisted` 说「建的时候别漏了这几个」。
      assert.deepEqual(report.unlisted, [
        { dir: '', file: 'CHANGELOG.md' },
        { dir: 'design', file: 'x.md' },
        { dir: 'docs', file: '01-a.md' },
      ])
      assert.deepEqual(report.missing, [{ dir: 'docs', entry: '09-没了.md' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('缓存会因**目录内**新增文件而失效（只看根的 mtime 会失明）', () => {
    const root = tree({
      'README.md': '',
      'docs/README.md': '- 01-a.md',
      'docs/01-a.md': '',
    })
    try {
      clearRouteCache()
      assert.equal(routeReport(root).ok, true)
      writeFileSync(join(root, 'docs', '02-新来的.md'), '', 'utf8')
      const after = routeReport(root)
      assert.equal(after.ok, false, '新增文件后缓存必须失效，否则这条检查对「加了文档」失明')
      assert.deepEqual(after.unlisted, [{ dir: 'docs', file: '02-新来的.md' }])
    } finally {
      clearRouteCache()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/* ── 渲染 ────────────────────────────────────────────────────────── */

describe('摘要与兜底', () => {
  it('健康时一句话说清「几个目录」', () => {
    const root = tree({ 'README.md': '[c](CHANGELOG.md)', 'CHANGELOG.md': '' })
    try {
      const summary = summarizeRoutes(routeReport(root, { useCache: false }))
      assert.match(summary, /健康/)
      assert.match(summary, /1 个文档目录/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('兜底提示给的是**确定性动作**，不是「试试别的查询」', () => {
    const root = tree({
      'README.md': '',
      'docs/README.md': '- 01-a.md',
      'docs/01-a.md': '',
    })
    try {
      const hint = routeFallbackHint(routeReport(root, { useCache: false }))
      assert.match(hint, /docs\/README\.md/, '必须点名具体索引文件')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('没有索引时不编造路径，改给 glob', () => {
    const root = tree({ 'lib/a.js': '' })
    try {
      const hint = routeFallbackHint(routeReport(root, { useCache: false }))
      assert.match(hint, /glob/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/* ── 自检：本仓库必须过 ─────────────────────────────────────────── */

describe('本仓库自检', () => {
  it(`每个含 .md 的目录都有 ${ROUTE_INDEX_NAME} 且列全（否则 scripts/check.mjs 会红）`, () => {
    const report = routeReport(REPO_ROOT, { useCache: false })
    assert.deepEqual(report.missingReadme, [], '有目录缺 README.md')
    assert.deepEqual(report.unlisted, [], '有文件没登记到目录 README')
    assert.deepEqual(report.missing, [], '目录 README 登记了不存在的文件')
    assert.ok(report.folders.length >= 2, `只扫到 ${report.folders.length} 个目录，路由层可能没生效`)
  })

  it('CI 硬门真的接了（`check.mjs` 调 routeReport，不是只写在文档里）', () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts', 'check.mjs'), 'utf8')
    assert.match(
      source,
      /routeReport/,
      '`scripts/check.mjs` 没调 routeReport —— 「CI 强制」就只是 `docs/README.md` 里的一句话',
    )
    assert.match(source, /process\.exitCode\s*=\s*1/, '路由失败必须让退出码非零，否则 CI 是绿的')
  })

  it('死导出硬门也接了，且允许名单**必须带理由**', () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts', 'check.mjs'), 'utf8')
    assert.match(source, /deadExportPhase/, '`check.mjs` 没跑死导出检查')
    assert.match(
      source,
      /DEAD_EXPORT_ALLOWLIST/,
      '没有允许名单 —— 那么第一条合法豁免就会被硬编码成 `if (path === …) continue`',
    )
    assert.match(
      source,
      /Map<string, string>/,
      '允许名单必须是 `路径#名字 → 理由` 的 Map，不是 Set —— 一个不给理由的豁免就是一个忘记删的死代码',
    )
  })
})
