/**
 * 行动风险（`actionRiskOf`）—— **中英文必须同判**。
 *
 * ## 它钉住的那个不对称
 *
 * 上一版英文用 `\b(?:drop|delete|...)\b`，中文用裸 alternation。于是同一个意思：
 *
 * ```
 * "staging deployment health check timeout"  -> R1
 * "staging 部署健康检查超时"                  -> R4
 * ```
 *
 * `deployment` 因为词尾被 `\b` 挡住而不命中 —— 这**不是保守，是漏判**。
 * 而 `actionRisk` 决定「⚠ 照做之前回读原文」这行警告、决定推广包里的风险标注、
 * 还进 `contentHash`。一个语言比另一个语言更容易拿到警告，是**偏差**不是风格。
 *
 * ## 它同时钉住的**收窄**
 *
 * 修法是显式列形态，不是 `stem\w*` —— 后者会把 `tokenize` 判成 SECURITY、
 * 把 `sent` 判成 external。**宁可长，不可猜。**
 *
 * ## 中文为什么仍然「出现即命中」
 *
 * 中文没有词边界，`部署健康检查超时` 里的「部署」是在描述**被排查的对象**，
 * 不是指示不可逆动作 —— 要判对只能靠语义。保持裸匹配是**安全的那一侧**：
 * `actionRisk` 的后果是多一行警告，不是拦截。少警告 unsafe，多警告 noisy。
 * 最后一个用例把这个取舍**钉住**，免得以后有人把它当 bug「修」成漏判。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { actionRiskOf } from '../lib/model.js'

const risk = (body, kind = 'fact') => actionRiskOf({ kind, body })

describe('行动风险 · 中英同判', () => {
  it('**`deployment` 与 `部署` 同一个风险等级**（上一版是 R1 vs R4）', () => {
    assert.equal(risk('staging deployment health check timeout'), 'R4')
    assert.equal(risk('staging 部署健康检查超时'), 'R4')
  })

  it('英文屈折形式全部命中', () => {
    for (const body of [
      'deleted the stale rows',
      'deleting the stale rows',
      'deletion of stale rows',
      'removal of the old flag',
      'removed the old flag',
      'destroyed the volume',
      'destruction of the volume',
      'purged the cache',
      'erased the disk',
      'published the package',
      'pushed to main',
      'released the tag',
      'uploaded the artifact',
      'billed the customer',
      'purchased the license',
      'dropped the table',
    ]) {
      assert.equal(risk(body), 'R4', `「${body}」必须命中 R4`)
    }
  })

  it('**收窄**：`tokenize` / `sent` / `authentic` 不算风险', () => {
    for (const body of ['tokenize the input', 'tokenizer performance', 'the error was sent to the log', 'authentic response']) {
      assert.equal(risk(body), 'R1', `「${body}」是误伤 —— 这些词太常见，不能进词表`)
    }
  })

  it('中文保持「出现即命中」（安全的那一侧）', () => {
    for (const body of ['删除生产库', '部署到生产', '发布包', '清空缓存', '强删目录', '凭据轮换', '授权失败']) {
      assert.notEqual(risk(body), 'R1', `「${body}」必须命中 —— 少警告是 unsafe`)
    }
  })
})

describe('行动风险 · 五档', () => {
  it('R5 = 不可逆 **且** 涉密', () => {
    assert.equal(risk('删除生产库的密码'), 'R5')
    assert.equal(risk('drop the table with the credential'), 'R5')
  })

  it('R4 = 不可逆 **或** 对外可见', () => {
    assert.equal(risk('删除生产库'), 'R4')
    assert.equal(risk('publish to npm'), 'R4')
  })

  it('R3 = 仅涉密', () => {
    assert.equal(risk('token 存在环境变量里'), 'R3')
    assert.equal(risk('auth 走 cookie'), 'R3')
  })

  it('R2 = 纠错 / 约定，且无关键词', () => {
    assert.equal(risk('连接池上限是 10', 'correction'), 'R2')
    assert.equal(risk('连接池上限是 10', 'convention'), 'R2')
  })

  it('R1 = 默认', () => {
    assert.equal(risk('连接池上限是 10', 'fact'), 'R1')
    assert.equal(risk('', 'fact'), 'R1')
  })

  it('**免责声明不降级** —— 正文里写「我很安全」不算', () => {
    assert.equal(risk('这很安全。删除生产库之前先备份。'), 'R4')
  })
})

/* ── 回归：中文过宽是**刻意的** ─────────────────────────────────── */

/**
 * **不要把这条「修」成漏判。**
 *
 * `部署健康检查超时` 是一条纯粹的排障记忆，`actionRisk` 判它 R4 是**误报**。
 * 但修它需要语义（「部署」在这里是**被排查的对象**，不是**被指示的动作**），
 * 而语义通道实测分离度 −0.020 ~ +0.063 —— 不可用。
 *
 * 保持误报的理由是**不对称**：`actionRisk` 的后果是多一行「⚠ 照做之前
 * 回读原文」，不是拦截、不是丢弃、不是降级。多一行警告是 noisy，
 * 漏一行警告是 unsafe。**在两者之间选 noisy。**
 */
describe('行动风险 · 已知误报（刻意保留）', () => {
  it('中文排障记忆被判 R4 —— 这是误报，但方向安全', () => {
    assert.equal(risk('staging 部署健康检查超时的排查顺序'), 'R4')
  })
})
