/**
 * 自检（`scripts/doctor.mjs`）。
 *
 * 这一组钉住的不是「检查项全不全」，而是**它会不会说谎**：
 *
 *   - 一个把「没初始化」判成 `error` 的 doctor，会在每个新仓库里红一次；
 *   - 一个把「坏配置」判成 `ok` 的 doctor，比没有 doctor 更糟 —— 它给了
 *     一个「已检查」的假保证。
 *
 * 所以一半用例在**临时仓库**上跑：本仓库自己没有 `.dsh-memory/`，
 * 那几项永远是 `skip`，在它上面测等于没测。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { renderDoctor, runDoctor } from '../scripts/doctor.mjs'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 慢且与本文件无关的检查（跑子进程）。 */
const SLOW = ['client']

const byId = (report, id) => report.checks.find((check) => check.id === id)

let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-doctor-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/* ── 本仓库 ─────────────────────────────────────────────────────── */

describe('本仓库自检', () => {
  it('全部检查都有结论，且没有 error', async () => {
    const report = await runDoctor(REPO_ROOT, { skip: SLOW })
    assert.equal(report.ok, true, renderDoctor(report))
    assert.equal(report.errors, 0)
    // 每一项都必须有 level —— `undefined` 会在渲染时悄悄变成「没检查」
    for (const check of report.checks) {
      assert.ok(['ok', 'warn', 'error', 'skip'].includes(check.level), `${check.id} 的 level 不合法：${check.level}`)
      assert.ok(check.label, `${check.id} 没有 label`)
    }
  })

  it('peer 依赖与模块 import 真的跑了（不是恒 skip）', async () => {
    const report = await runDoctor(REPO_ROOT, { skip: SLOW })
    assert.equal(byId(report, 'peers')?.level, 'ok')
    assert.equal(byId(report, 'modules')?.level, 'ok')
    assert.match(byId(report, 'modules')?.detail ?? '', /\d+ 个/)
  })

  it('未初始化记忆库时 layout 是 **skip 不是 error**（新仓库不该红）', async () => {
    const report = await runDoctor(root, { skip: SLOW })
    assert.equal(byId(report, 'layout')?.level, 'skip')
    assert.equal(report.ok, true, '没有 .dsh-memory 不该让自检失败')
  })
})

/* ── 临时仓库：真的检查 ─────────────────────────────────────────── */

describe('在真的记忆库上', () => {
  const seed = async () => {
    const { appendReceipt, ensureLayout, writeEntry } = await import('../lib/store.js')
    const { ensureSnapshot } = await import('../lib/index-build.js')
    ensureLayout(root)
    const entry = writeEntry(root, {
      id: 'redis_dep',
      title: '集成测试要先起 redis',
      kind: 'convention',
      about: '跑集成测试之前必须先起 redis',
      body: '# 功能名\n集成测试依赖\n\n# 执行\n先起 redis。',
      evidence: [{ kind: 'file', ref: 'README.md' }],
    })
    // 回执由 `memory_remember` 签，`writeEntry` 不签 —— 少了它
    // `receipts` 一项会报 `missing`，用例就测不到「健康」那条路。
    appendReceipt(root, entry, { verifier: { kind: 'user', id: 'doctor-test' } })
    ensureSnapshot(root, { force: true })
  }

  const seedPackageJson = () => writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'acme' }), 'utf8')

  it('布局 / 快照 / 回执三项从 skip 变成实际结论', async () => {
    await seed()
    const report = await runDoctor(root, { skip: SLOW })

    assert.equal(byId(report, 'layout')?.level, 'ok', renderDoctor(report))
    assert.equal(byId(report, 'snapshot')?.level, 'ok')
    assert.equal(byId(report, 'receipts')?.level, 'ok')
    assert.match(byId(report, 'snapshot')?.detail ?? '', /1 条/, '快照里应该有 1 条记忆')
  })

  it('布局缺项判 **error**（不是 warn）—— 写盘被拦是硬故障', async () => {
    await seed()
    rmSync(join(root, '.dsh-memory', 'trust'), { recursive: true, force: true })
    const report = await runDoctor(root, { skip: SLOW })
    const layout = byId(report, 'layout')
    assert.equal(layout?.level, 'error')
    assert.match(layout?.detail ?? '', /trust/)
    assert.equal(report.ok, false, '缺目录却报通过 —— 那 doctor 就是假的')
  })

  it('坏配置 JSON 判 **error** 并给修法', async () => {
    await seed()
    writeFileSync(join(root, '.dsh-memory', 'config.json'), '{ 坏掉的 json', 'utf8')
    const report = await runDoctor(root, { skip: SLOW })
    const config = byId(report, 'config')
    assert.equal(config?.level, 'error')
    assert.ok(config?.hint, 'error 必须给修法，否则用户只能猜')
  })

  it('记忆比快照新 → **warn**（不是 ok，也不是 error）', async () => {
    await seed()
    // 绕过 `writeEntry` 直接写一个更新的文件 —— 模拟「进程在重建前被杀」
    const memories = join(root, '.dsh-memory', 'memories')
    const { serializeEntry } = await import('../lib/model.js')
    const { readAll } = await import('../lib/store.js')
    const entry = readAll(root).entries[0]
    writeFileSync(
      join(memories, 'newer.md'),
      serializeEntry({ ...entry, id: 'newer', title: '更新的一条' }),
      'utf8',
    )

    const report = await runDoctor(root, { skip: SLOW })
    assert.equal(byId(report, 'snapshot')?.level, 'warn', renderDoctor(report))
    assert.equal(report.ok, true, '陈旧只是 warn —— 它不影响正确性，只影响「看到的是不是最新」')
    assert.equal(report.warnings >= 1, true)
  })

  it('inbox 积压到 20 条以上才 warn', async () => {
    await seed()
    const inbox = join(root, '.dsh-memory', 'inbox')
    mkdirSync(inbox, { recursive: true })
    for (let index = 0; index < 5; index += 1) writeFileSync(join(inbox, `i_${index}.json`), '{}', 'utf8')
    let report = await runDoctor(root, { skip: SLOW })
    assert.equal(byId(report, 'inbox')?.level, 'ok', '5 条不算积压')

    for (let index = 5; index < 25; index += 1) writeFileSync(join(inbox, `i_${index}.json`), '{}', 'utf8')
    report = await runDoctor(root, { skip: SLOW })
    assert.equal(byId(report, 'inbox')?.level, 'warn')
  })

  it('目录缺 README → warn（CI 才是硬门，自检不重复拦）', async () => {
    writeFileSync(join(root, 'README.md'), '[c](CHANGELOG.md)', 'utf8')
    writeFileSync(join(root, 'CHANGELOG.md'), '', 'utf8')
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', '01-a.md'), '', 'utf8')

    const report = await runDoctor(root, { skip: SLOW })
    const routes = byId(report, 'routes')
    assert.equal(routes?.level, 'warn')
    assert.match(routes?.detail ?? '', /docs/)
  })
})

/* ── 编排 ───────────────────────────────────────────────────────── */

describe('编排', () => {
  it('`only` 只跑指定项', async () => {
    const report = await runDoctor(REPO_ROOT, { only: ['node'] })
    assert.deepEqual(report.checks.map((check) => check.id), ['node'])
  })

  it('`skip` 真的跳过', async () => {
    const report = await runDoctor(REPO_ROOT, { skip: [...SLOW, 'routes'] })
    assert.equal(byId(report, 'routes'), undefined)
  })

  it('只读：跑完不创建任何东西', async () => {
    await runDoctor(root, { skip: SLOW })
    assert.equal(
      (await import('node:fs')).existsSync(join(root, '.dsh-memory')),
      false,
      '自检建了目录 —— 那它就不能在被怀疑的时候跑',
    )
  })

  it('渲染：每条 error / warn 都带修法', async () => {
    // `.dsh-memory/` 不存在时 `config` 会走 skip，测不到 error 分支 —— 先建目录，
    // 再放一个坏 JSON。
    mkdirSync(join(root, '.dsh-memory'), { recursive: true })
    writeFileSync(join(root, '.dsh-memory', 'config.json'), '{ bad json', 'utf8')

    const report = await runDoctor(root, { skip: SLOW })
    const text = renderDoctor(report)
    assert.match(text, /自检/)
    for (const check of report.checks) {
      if (check.level === 'ok' || check.level === 'skip') continue
      assert.ok(check.hint, `${check.id} 是 ${check.level} 却没有 hint`)
    }
  })
})
