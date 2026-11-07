/**
 * 待决队列 —— **只进不出的队列是死信办公室。**
 *
 * ## 它钉住的两个不变量
 *
 * 1. **队列有上限，且满了要喊出来。** 积到几百条，人就会盖章通过；而盖过章的
 *    「我看过了」比不审更危险 —— 它带来虚假的保证。所以满了必须抛
 *    `queue-full`，让调用方降级成 DISCARD（记 ledger）或回「先裁决」，
 *    **不能静默丢弃**（静默丢弃一条本该记住的记忆是这个系统最坏的失败方式）。
 * 2. **队列有出口，且出口不留垃圾。** 到期（`PROPOSAL_TTL_DAYS`）自动退场，
 *    进 `pending/rejected/` **留档不删除**，并且 `expiredAt` 与 `rejectedAt`
 *    分开记 —— 过期是「两周没人看」，拒绝是「我看过了，不要」，
 *    两者混在一起会让「拒答率」这个数字失真。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  PROPOSAL_QUEUE_LIMIT,
  PROPOSAL_TTL_DAYS,
  clearStoreCache,
  expireProposals,
  readProposals,
  readRejectedProposals,
  removeProposal,
  writeProposal,
} from '../lib/store.js'

let root

const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString()

const proposal = (id, overrides = {}) => ({
  id,
  candidate: { id, title: `记忆 ${id}` },
  gates: [{ gate: 'G8', kind: 'refuse', code: 'confidence' }],
  deferredBy: ['G8'],
  why: ['G8:confidence'],
  status: 'pending',
  ...overrides,
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-mem-queue-'))
  clearStoreCache()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  clearStoreCache()
})

describe('待决队列 · 上限', () => {
  it(`写满 ${PROPOSAL_QUEUE_LIMIT} 条后再写必须抛 \`queue-full\``, () => {
    for (let index = 0; index < PROPOSAL_QUEUE_LIMIT; index += 1) {
      writeProposal(root, proposal(`p_${String(index).padStart(4, '0')}`))
    }
    assert.equal(readProposals(root).length, PROPOSAL_QUEUE_LIMIT)

    assert.throws(
      () => writeProposal(root, proposal('p_overflow')),
      (error) => {
        assert.equal(error.code, 'queue-full')
        assert.equal(error.count, PROPOSAL_QUEUE_LIMIT)
        assert.equal(error.limit, PROPOSAL_QUEUE_LIMIT)
        assert.match(error.message, /先裁决/)
        return true
      },
    )
    assert.equal(readProposals(root).length, PROPOSAL_QUEUE_LIMIT, '拒绝时不能多写一条')
  })

  it('裁决掉一条就能再写进去 —— 出口通了入口才不堵', () => {
    for (let index = 0; index < PROPOSAL_QUEUE_LIMIT; index += 1) {
      writeProposal(root, proposal(`p_${String(index).padStart(4, '0')}`))
    }
    assert.throws(() => writeProposal(root, proposal('p_overflow')))

    removeProposal(root, 'p_0000', { reject: true })
    assert.doesNotThrow(() => writeProposal(root, proposal('p_now_fits')))
    assert.equal(readProposals(root).length, PROPOSAL_QUEUE_LIMIT)
  })
})

describe('待决队列 · 到期退场', () => {
  it('超过 TTL 的提案进 `pending/rejected/` 留档，不删除', () => {
    writeProposal(root, proposal('p_old', { createdAt: daysAgo(PROPOSAL_TTL_DAYS + 1) }))
    writeProposal(root, proposal('p_new', { createdAt: daysAgo(0) }))

    const expired = expireProposals(root)
    assert.deepEqual(expired, ['p_old'])
    assert.deepEqual(
      readProposals(root).map((item) => item.id),
      ['p_new'],
      '未到期的一条都不能动',
    )

    const archived = readRejectedProposals(root)
    assert.equal(archived.length, 1, '过期是留档不是删除')
    assert.equal(archived[0].id, 'p_old')
  })

  it('**过期不是拒绝** —— `expiredAt` 与 `rejectedAt` 分开记', () => {
    writeProposal(root, proposal('p_expired', { createdAt: daysAgo(PROPOSAL_TTL_DAYS + 3) }))
    expireProposals(root)

    const [archived] = readRejectedProposals(root)
    assert.ok(archived.expiredAt, '过期必须留 datetime —— 否则「它消失了」没有解释')
    assert.equal(archived.rejectedAt, undefined, '过期时没有人拒绝过它，不能伪造 rejectedAt')
    assert.equal(archived.ttlDays, PROPOSAL_TTL_DAYS)
  })

  it('幂等：同一条不会被归档两次', () => {
    writeProposal(root, proposal('p_old', { createdAt: daysAgo(PROPOSAL_TTL_DAYS + 1) }))
    assert.deepEqual(expireProposals(root), ['p_old'])
    assert.deepEqual(expireProposals(root), [])
    assert.equal(readRejectedProposals(root).length, 1)
  })

  it('时间戳坏掉的提案**不**被过期（看不懂就不动它）', () => {
    writeProposal(root, proposal('p_broken', { createdAt: 'not-a-date' }))
    assert.deepEqual(expireProposals(root), [])
    assert.equal(readProposals(root).length, 1)
  })

  it('没有队列目录时返回空数组，不抛', () => {
    assert.deepEqual(expireProposals(join(root, 'nope')), [])
  })
})
