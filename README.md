# dsh-memory-bank

DSH 的**协议驱动记忆插件**：Agent 知道自己什么时候该记、什么时候不该记；每次写入过八道门自审；协议判不了的，以**提案**交你裁决。

不是「存了再检索」，是**先审再决定存不存**。

---

## 一句话

> 一条说「PR #10 还开着」的记忆是在做**断言**。它写的时候为真，**永不为跟踪世界而改写**。
> 解析另存。这样「记忆会过时」这个无解问题，就变成一个可枚举、可对账、可矛盾检测的**结构化积压**。

**只做项目级记忆。** 记忆是仓库级制品 —— 它随仓库进 git、随 PR review、随回滚消失。
跨项目的那一层由别的插件负责。本插件只提供**出口**（`memory_promote` / `/memory promote`），
把项目记忆整理成可推广的包，**不写、不读、不索引任何全局存储**。

---

## 安装

```bash
# 本地链接安装（开发）
dsh plugin install link:/path/to/dsh-memory-bank
```

或在 **设置 → 插件** 里搜 `dsh-memory-bank`。

装完立刻在**任何**会话里可用（`inject: ['tools', 'systemPrompt']`，不绑定预设）。

### 配置

全部可选；行 config > 环境变量 > 默认值：

```yaml
# cordis.patch.yml
- id: memory-bank
  name: 'dsh-memory-bank'
  config:
    autonomy: balanced        # manual | balanced | autonomous
    thresholds:
      autoAcceptFloor: 0.60   # 自动落盘的置信地板
      deferFloor: 0.35        # 低于这个值直接丢弃，不建提案
      duplicate: 0.82         # 近重复阈值
      coverageFloor: 0.45     # 覆盖门地板
    quota:
      repo: 200               # 项目层硬上限（**只有项目层** —— 本插件不做全局记忆）
      growthThreshold: 50     # growth → ratchet 的切换点
    capture:
      enabled: true
      signals: [S1, S2, S3, S4, S5, S6, S7]
    recall:
      inject: true
      maxBytes: 4000
      maxPointers: 3
    promote:
      format: both            # markdown | json | both
      minConfidence: verified
      includeProjectSpecific: true
    embedding:                # 语义通道；**默认关**
      provider: none          # none | lexical | http
      model: text-embedding-3-small
      endpoint: null          # http 的 /embeddings 地址
      g1Threshold: null       # G1 用余弦判决的阈值；null = 不参与判决
```

| 环境变量 | 作用 |
|---|---|
| `DSH_MEMORY_ROOT` | 记忆库项目根（默认取会话工作目录） |
| `DSH_MEMORY_AUTONOMY` | 自主度 |
| `DSH_MEMORY_AUTO_ACCEPT_FLOOR` / `DSH_MEMORY_DEFER_FLOOR` | 阈值 |

**非法值直接抛错**，不静默回退 —— 一个拼错的 `autonomy` 绝不能悄悄变成更激进的档位。

---

## 七个工具 + 一条命令

| 工具 | 作用 |
|---|---|
| `memory_remember` | 提议一条记忆（走完整协议） |
| `memory_recall` | 主动召回（三级交付） |
| `memory_pending` | 列待决提案（记忆提案 + 图提案） |
| `memory_resolve` | accept / reject / edit 一条提案 |
| `memory_audit` | 全量审计：断言对账 + 生命周期 + 漂移 + `dream` |
| `memory_promote` | 整理成可推广到全局记忆的包（只读、只提名） |
| `memory_forget` | 退休 / 删除（破坏性） |

刻意只有 7 个 —— DSH 的工具是稀缺上下文资源。第 7 个是**出口**：没有它，项目记忆是一条单行道。

**工具面是给 Agent 的，命令面是给人的。**

```
/memory                    状态总览
/memory pending            待决提案
/memory accept <id>        接受（硬门仍会重跑）
/memory reject <id>        拒绝（永久：同样的计算会得出同样的结论）
/memory recall <查询>       直接召回
/memory audit              全量审计
/memory dream              跑 dream pass 并暂存提案
/memory promote [--json]   生成可推广到全局记忆的包
/memory retire <id>        退休一条记忆
```

命令**不经过模型** —— 你输入 `/memory accept p_xxx` 就是你的裁决，不需要先让模型转述一遍。这是「拿不准时你有足够强的掌握能力」的落点。

---

## 推广：只产出包，不做全局记忆

**本插件不做全局记忆。** 记忆是仓库级制品；跨项目那一层由别的插件负责。

`memory_promote` 只回答一个问题：**哪些项目记忆换一个仓库还成立？**

```bash
/memory promote              # 人读的 Markdown 包
/memory promote --json       # 机器读（schema dsh-memory.promotion/v1）
/memory promote --write      # 写到 .dsh-memory/export/，返回路径
```

### 硬排除（永远不出现在包里）

| 条件 | 为什么 |
|---|---|
| 终态（`deprecated` / `rejected` / `superseded`） | 已经作废的东西不该扩散 |
| 含密钥 | **一条泄漏的秘密比一百条没推广的记忆贵** |
| 没有证据 | 在别的仓库里无法复核 |
| 置信低于地板 | 默认 `verified` |

### 软标记（进包，但标注出来）

| 标记 | 含义 |
|---|---|
| `project-specific-evidence` | 证据全指向项目内路径 —— 换仓库前先确认它是不是通用做法 |
| `scoped-to-repo` | 适用面限定在当前仓库 |
| `needs-review` | 已过复查期 —— 推广前先核对 |
| `dormant` | 90 天未被召回 —— 可能已经不再成立 |

`project-specific-evidence` 刻意**不是**排除条件。「staging 超时先查连接池上限」锚在 `src/db/pool.ts` 上，
但它换一个仓库仍然成立。机器分不清这两者，所以只标注，**让你在包里看见**。

### 输出必须可移植

包里的绝对路径、会话 id、机器名**一个都不能有**。只保留：仓库名、提交 sha、仓库相对路径。

测试里有一条专门钉这个：`assert.ok(!json.includes(root))`。

### 三种纪律

1. **只提名，不搬运。** 推广与否是人的判断 —— 和 dream 只提议结构、G7 只列最弱候选、`memory_forget` 不自动退休是同一条纪律。
2. **硬排除必须硬。**
3. **输出必须可移植。**

---

## 断言：记忆会过时，但正文永不改写

一条说「PR #10 还开着」的记忆是在做**断言**。它写的时候为真，`state` **永不改写**；
世界往前走了，我们把「后来学到了什么」另存三列（`resolvedState` / `resolvedBy` / `resolvedAt`）。

没有这个原语时，唯一能记录「PR #10 已合并」的办法是改写记忆 —— 而 dogfooding 语料因此长出了 **37 条记忆上的 160 种横幅风格**。

三个被语料打出来的规则（`lib/claims.js`，每条都有实测，别「优化」掉）：

| 规则 | 实测 |
|---|---|
| **无状态 ref ≠ open** | 1,161 条记忆里 225 条 ref 没断言状态，对 223 条真 claim，而它们绝大多数在叙述**已完成**的工作（`"Fixed in PR #873"`）。默认成 open 会把积压翻倍，全是历史。→ 独立状态 `unverified`：**是索引，不是队列** |
| **引用不是断言** | wiki-link 里的 `[[PR #10 open: …]]` 是指向同名记忆的**链接**。785 条语料上 11 条 claim 来自这里，**每一条都错**。→ 抽取前抹空 |
| **`shipped` / `fixed` 不算 resolved** | `"doc shipped PR #168"` 指 PR 被**创建**；`"Merge HELD"` 是明确的**未合并**。漏一条是静默的，猜错一条会教读者彻底忽略 claims |

`memory_audit` 报 **open / openActionable / resolved / unverified / contradicted** 五个数字 ——
少了 `openActionable`，一个比较 `open` 与 `sample.length` 的调用者会发现一个缺口却得不到解释。

---

## 生命周期：休眠不是腐烂

| 信号 | 阈值 | 行为 |
|---|---|---|
| 休眠 | 90 天未被召回 | **只报告，绝不改 `confidence`** |
| 建议弃用 | 180 天 | **建议**，不自动执行（「Never forget」） |
| 到期复查 | `review_by` 到了 | 提示 |
| 已过期 | `expires_at` 到了 | 提示 |
| 合并候选 | 同 kind 且相似度 ≥ .82 | 进待决队列，**不自动合并** |

**参考时间 = 三个候选的 MAX，不是 COALESCE。** COALESCE 返回第一个非空，所以「上一次确认之后做的内容编辑」会被静默丢弃，记忆会按更早的瞬间被计分。

`reviewHints` 的三个**有门**信号（锚点 ≥14 天才点火，且永不在时间无关类型上点火）：
`open-pr-reference` / `waiting-on` / `unmerged-branch`。`waiting-on` 额外要求 60 字符内有一个**具名 agent** ——
`"waiting for EOF"` 和 `"waiting for the init container image pull"` 一个都没命名，它们在描述机制，不是状态。

代价是真实的且有界：对小写未具名名词的等待（`"waiting on the vendor"`）不再点火。**实测把精度从 0.65 提到 0.79。**

---

## 漂移：**目标消失 ≠ 切片变了**

`memory_audit` 复查每条记忆引用的锚点，判决分**五种**：

| 判决 | 含义 | 该做什么 |
|---|---|---|
| `healthy` | 目标还在，切片没变 | 不用管 |
| **`quarantined`** | **目标消失了**（文件删了 / 符号不存在 / 行号越界） | 退休，或补新锚点后重写 |
| `advisory` | 目标还在，**切片变了** | **不用管** —— 重构不是攻击 |
| `symbol-not-a-definition` | 锚点落在注释 / 字符串 / 调用处 | 指错了，**不重新签名** |
| `unverifiable` | 机器无法判断（`commit` / `command` / `user`） | 不撒谎 |

前两种混为一谈的后果是具体的：**每一次改名、挪行、重新格式化都会把整个记忆库
标成「不可信」，然后所有人学会忽略这个警告。** 那比不做漂移检测更糟。

第四种同样重要：一个只出现在注释里的名字，看起来「还在」，但它已经不再指向任何东西 ——
把它当成 `healthy` 是把错的锚点固化下来。

第五种是诚实：`git commit abc123` 还在不在，机器人不知道。报「健康」是撒谎，报「漂移」是误伤。

### 内容寻址：写入 / 解析 / 哈希的**同一套**规范形式

```
canonicalBody(body) = body.replace(/\r\n/g, '\n').trimEnd()
```

三处必须共用：

| 位置 | 为什么 |
|---|---|
| `serializeEntry` | 文件里写的就是规范形式 |
| `parseEntry` | 读回来必须逐字节相同（**只剥 serialize 加的那一个换行**） |
| `contentHash` | 否则「写进去的」和「读回来的」算出不同的哈希 |

这一条曾经不成立：`serializeEntry` 调 `trimEnd()` 并加 `\n`，`parseEntry` 不剥、
`contentHash` 又直接哈希原始 body —— 于是

> **每一条正常写入的记忆都被判成 `tampered`，回执层从未生效，
> 而且它用「正文被改」这个措辞做了一次虚假的篡改指控。**

`test/drift.test.mjs` 里有一条专门钉这个往返。

---

## G1 实测：拿本仓库自己的文档当语料

```bash
node bench/g1-eval.mjs
```

5 份 owner 文档（README + `docs/*.md`，约 52,000 字），15 条候选分三组：

| 组 | 期望 | 结果 |
|---|---|---|
| **A 逐字**（文档里**已经说过**的断言） | 拒 | **10 / 10** |
| **B 无关**（文档里没有、值得记的项目事实） | 过 | **5 / 5** |
| **C 改写**（同义不同词） | 拒（但会漏） | **0 / 5** |

完整八道门终审：**15 / 15**（G1 的拒绝没有被别的门盖掉，B 组真的走到了 `ACCEPT`）。

### C 组 0/5 不是 bug，是方法的硬天花板

试过用**滑窗字符 n-gram 覆盖率**去救改写，三组分数如下：

```
A 逐字   1.000
C 改写   0.000 – 0.364
B 无关   0.000 – 0.208
```

C 的最高分（0.364）离 B 的最高分（0.208）太近 —— 阈值卡在哪里都抓不到改写，
只会开始误伤 B。

所以 G1 的实际能力边界是清楚的：

> **它抓的是「Agent 把文档里的一行抄进记忆」这个最常见的失败，不是语义重复。**

设计文档写的「保守实现，误判方向偏向 ACCEPT」在这个数据上成立了 ——
但「偏向 ACCEPT」的代价是**改写一律漏过**，这一点现在有数字了。

### 语义通道：做成了，但**默认关着**

第二次实验用**加权包含度**（不是余弦 —— 余弦被窗口长度惩罚，逐字候选只拿到 0.079，
那是度量的错）：

```
A 逐字（该拒）  最低 0.264
B 无关（该过）  最高 0.200
C 改写（该拒）  最低 0.204
分离 = +0.004
```

**+0.004 不是分离，是 15 个手挑样本上的巧合。** 拿它开闸就是拿误伤换漏报，
而且用户会以为自己买到了召回。

所以 `lib/embedding.js` 是一个可插拔通道，但开闸不是「配置里写个 true」—— 是跑你自己的语料：

```bash
node bench/embedding-experiment.mjs
# 看最后一行：分离（C 最低 - B 最高）
#   < 0.05  不要开。任何阈值都是噪音。
#   ≥ 0.15  可以考虑。阈值取两组的中间值，把数字写进 commit message。
```

| provider | 状态 |
|---|---|
| `none` | **默认。** G1 走逐字包含 |
| `lexical` | 本地确定性向量，**实测不足以做 G1 判决**，只用于诊断 |
| `http` | 唯一可能真的有效的实现（OpenAI 兼容 `/embeddings`） |

**架构上的硬约束**：`recall` 和 `gate` 都是同步的（每轮 prompt 装配），
而 HTTP 是异步的。所以 embedding **不在门里调用**，它是**可预先计算的数据**：

```
语料向量   → 算一次，挂在 owners 数组上（WeakMap）
候选向量   → 在 memory_remember / 后台 drain（本来就是 async）里算
门         → 只做同步余弦；拿不到向量就退回逐字包含
```

**默认路径仍然是同步的。** 只有通道真的开着、而且配了 `g1Threshold` 时
`memory_remember` 才返回 Promise。这不是为了性能，是为了**诚实**：
默认配置下的行为和以前逐字节相同，任何一个老测试的通过或失败都还是它自己说的那件事。

### 顺带挖出的一个静默丢弃

跑这个基准时 B 组全部 `DEFER` 而不是 `ACCEPT`。根因：

```js
const confidence = candidate.confidence ?? computeConfidence(candidate)   // ← 错
```

`confidence` 这个字段名被两个东西共用 —— 条目上是**标签**（`verified`），
门要的是**分数**（0–1）。于是只要调用方带了标签（schema 完全允许），
比较就变成 `'verified' >= 0.6`，恒为 false，候选掉进 `confidence.low` 分支：

> 不建提案、不落盘、只剩一行 `discard: true` 没人看。
> **静默丢弃一条本该记住的记忆，是这个系统最坏的失败方式。**

修法：只有 `typeof candidate.confidence === 'number'` 时才当分数用。

---

## dream：只提议结构，不写记忆

| pass | 算法 | 提议 | **刻意不提议** |
|---|---|---|---|
| `centrality` | PageRank | 一条记忆的**排名** | 「central」是否意味着「属于身份层」 |
| `clusters` | label propagation | 一个**成员集合** | 这个簇是关于什么的（那是散文，是判断） |
| `orphans` | 两阶段（检索 → 绝对重打分） | **哪两条**记忆该连 | 关系**类型** |

**这使 cron 安全**：一次坏跑最多浪费一个读者的时间。
`dream/` 里**没有任何东西写 `memories`，也没有任何东西写 relation** —— 全部产出都是**提议**。

- **为什么 PageRank 而不是度数**：度数只数邻居就停了；PageRank 用**邻居自身的地位**加权地数邻居。
- **为什么 label propagation 而不是 Louvain**：Louvain 需要分辨率参数，**挑一个就是选择答案该有多粗 —— 一种扮成设置的偏好**。
- **`MIN_DENSITY = 0.5` 不是调优阈值** —— 多数翻转点是这里唯一自身有意义的截断。
- **一条没有近邻的孤儿应该保持孤儿**。回退到「连到排名最高的任何东西」会让图更糟，因为扩散激活会随后把种子的预算花在它们身上。

---

## 三值裁决，不是二值

```
ACCEPT  全部 pass                    → 落盘 + 写回执
REJECT  某个硬门 refuse              → 回给模型（可机械判定、可修，**必须**带 next）
DEFER   只有 G6 冲突 / G8 置信不足    → 交用户裁决
```

**REJECT 和 DEFER 不是同一种失败。**

- `REJECT` 是「协议说不，告诉模型怎么改」；
- `DEFER` 是「协议判不了，人裁」。

把两者混成一个「失败」，模型就会重试同一件事，用户就会被无意义地打扰。

---

## 八道门

| 门 | 问的 | 硬/软 | 典型拒绝 |
|---|---|---|---|
| **G1** 归属 | 这断言是不是**已经有主人**？ | 硬 | 已由 `AGENTS.md` / 文档 / 测试拥有 → 再进记忆只会多一份**会漂移的副本** |
| **G2** 形态 | 一条记忆只讲一件事？六要素齐？ | 硬 | 缺「不适用条件」的记忆会污染所有它看起来相关的判断 |
| **G3** 安全 | 含密钥 / 令牌 / PII？ | 硬 | 命中即拒，**且不回显命中片段**（回给模型是二次泄露） |
| **G3b** 注入 | 这条记忆在**指挥宿主**？ | 硬 | 三段必须相邻（动词 + 被寻址的层 + 它命名的产物） |
| **G4** 证据 | 每条断言都有可解析锚点？现在还对得上？ | 硬 | 首写算 hash；复查不一致 → advisory；目标消失 → 拒 |
| **G5** 重复 | 是不是同一件事的另一种写法？ | 硬 | **双阈值合取**（SimHash ≥.84 **且** MinHash ≥.72） |
| **G6** 冲突 | 与既有条目矛盾？ | **软** | 「谁对」是人的判断 |
| **G7** 配额 | 到顶了吗？ | 硬 | **棘轮**：只降不升；只列最弱候选，**不替你挑** |
| **G8** 置信 | 值不值得记？ | **软** | 五项加权和；`≥.60` 自动，`[.35,.60)` 待决，`<.35` 丢弃 |
| **G2b** 草稿 | 六要素填实了吗？ | **软** | 还有占位符 → **DEFER**（草稿值得记，只是还写不好） |

**为什么 G8 的 coverage 是「正文有没有提到它引用的东西」，不是「与既有语料多像」**：

后者会让**第二条同类型记忆比第一条更难落盘** —— 等于惩罚「积累」，而积累是这个系统唯一的目的。
更糟的是它不单调：同一个候选在不同大小的语料上得到不同裁决，而「同样的候选 + 同样的仓库 → 同样的裁决」是协议敢自动跑的前提。

现在的权重按「一条形态完备但来源不明的记忆刚好过 0.6 地板」反解：
`0.30·0.7 + 0.25·0.8 + 0.15·0.5 + 0.20·1 + 0.10·1 = 0.785`；
正文没提到锚点时掉到 **0.585**，正好低于地板 —— **引用了却不去看，是它唯一的错。**

**为什么 G1 最有价值**：记忆的边际价值是**负的**。同一条断言若已被规则文件、文档、测试或代码拥有，多一份副本就多一个会漂移的真相来源。

---

## 记忆形态

```markdown
---
id: "staging_timeout_pool_cap"
title: "staging 超时先查连接池上限"
kind: "pitfall"
about: "staging 部署健康检查超时的排查顺序"
confidence: "inferred"
provenance: "file-derived"
status: "active"
actionRisk: "R1"
createdAt: "2026-11-06T12:00:00Z"
modifiedAt: "2026-11-06T12:00:00Z"
lastVerifiedAt: "2026-11-06T12:00:00Z"
reviewBy: null
expiresAt: null
pinned: false
scope: ["repo:acme/api"]
triggers: ["staging 健康检查超时", "DB_POOL_MAX"]
evidence:
  - kind: "file"
    ref: "src/db/pool.ts:17"
    hash: "sha256:…"
relations: []
claims: []
---

# 功能名
staging 部署健康检查超时，根因是连接池上限，不是 worker 数。

# 生效条件
…
# 子功能
…
# 执行
…
# 验证方式
…
# 不适用条件
…
```

**`provenance` 与 `confidence` 正交** —— 一条 `verified` 的记忆仍然可以是 `self-concluded`。

---

## 召回：三级交付

```
content    分数够高 **且** 解释了足够多的查询  → 给原文
pointers   有合格候选但不到阈值                → 给「标题 + 一行 + 打开方式」，**明确不是答案**
abstain    没有合格候选                        → 空 + **点名是哪道门拒的**
```

两级的协议会逼所有边界情况二选一，而「自信地引用」是两种错误里更便宜的那个 —— 于是系统会对它根本无话可说的问题给出确定的答案。

**双相关性门**：

```js
gateScore  >= 0.60（按查询分类分档）   // ranker 有多确定
spanCoverage >= 0.45                    // 这个问题有多少被这条记忆解释了
```

后者是「语料认识这些词但没有答案」的唯一拦法。

**abstain 的 10 种原因**，`below-content-threshold`（找到了但压下）与 `no-trusted-candidate`（语料里没有）要求的动作**相反** —— 塌成一句「没匹配上」等于丢掉这个区分。

---

## 存储

```
<root>/.dsh-memory/
├── config.json          本项目配置
├── memories/<id>.md     一条记忆一个文件（进 git，像代码一样 review）
├── trust/receipts.json  信任回执（**与正文分离**，正文不能自证）
├── pending/             DEFER 的提案
│   └── rejected/        被拒的留档，不参与召回
├── inbox/               后台捕获队列（**先落盘再处理**，进程崩了不丢）
├── stats.json           访问遥测（**不写回 .md** —— 否则每次召回都让 git 变脏、让回执失效）
├── ledger.jsonl         全部写入尝试（append-only，永不删）
└── index/               内容寻址快照（可删可重建）
```

`.gitignore` 自动只忽略 `index/` 与 `ledger.jsonl`。**记忆正文与回执进 git。**

索引是**内容寻址**的：`snapshotId = sha256(compilerVersion ⊕ tokenizerProfile ⊕ sourceSha ⊕ contentSha)`。
同样查询 + 同样配置 + 同样快照，**永远同样的排序**。`gc` 在指针缺失时**什么都不删** —— 那是「GC 吃掉活快照」的唯一防线。

### 模块

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 接线：6 工具 + 1 命令 + 2 钩子 + 1 prompt context |
| `lib/config.js` | 行 config > 环境变量 > 默认值；非法值直接抛 |
| `lib/util.js` | 哈希、稳定序列化、原子写、分词、相似度 |
| `lib/model.js` | 条目类型、校验、frontmatter 序列化（自写 YAML 子集） |
| `lib/store.js` | 目录布局、读写、审计日志、访问遥测、待决提案 |
| `lib/index-build.js` | 内容寻址快照编译 |
| `lib/gate.js` | MRP v1 八道门 + 三值裁决 |
| `lib/claims.js` | 断言抽取、限定、状态判定、对账 |
| `lib/lifecycle.js` | 衰减、陈旧提示、合并、dream pass |
| `lib/capture.js` | S1–S7 确定性信号 + 草稿构造 + 收件箱 |
| `lib/draft.js` | 正文起草：template（默认）/ subagent |
| `lib/drift.js` | 锚点复查：healthy / quarantined / advisory / not-a-definition / unverifiable |
| `lib/embedding.js` | 语义通道：none / lexical / http（**默认关**，开闸看 bench 的 margin） |
| `lib/recall.js` | 5 路 + RRF + 双相关性门 + 三级交付 |
| `lib/tools.js` | 6 个 `memory_*` 工具 |
| `lib/command.js` | `/memory` 斜杠命令（人机入口） |
| `lib/hooks.js` | 召回注入 + 捕获 |

---

## 自主度

| 档位 | 行为 |
|---|---|
| `manual` | 永不自动落盘，全靠确认 |
| **`balanced`**（默认） | 高置信自动；低置信进待决队列；连续 3 次 DEFER 当场提问 |
| `autonomous` | 几乎全自动，但**硬门仍然拒绝** |

`autonomy` 只调制 **G8 的地板**，不调制 G1–G5、G7 —— **自主度不是豁免权**。

---

## 验收

```bash
npm test
```

196 条测试（含 peer 依赖时 211 条），覆盖设计文档 §14 的 **7 条验收全部通过** + 全部子系统：

| 组 | 条数 | 覆盖 |
|---|---|---|
| 插件行接线 | 13 | 7 工具 + 1 命令 + 2 监听器 + 1 context；disposer 全部可调用；非法配置直接抛 |
| ACCEPT / REJECT / DEFER | 7 | 三值裁决 + 硬门重跑 + 日志脱敏 |
| 召回三级 | 5 | content / pointers / abstain + 确定性 + **MMR 不吞掉第二条** |
| 断言模型 | 25 | 11 条语料规则 + 对账 + sync/rederive 区分 |
| 生命周期 | 32 | 衰减地板 + 三个有门信号 + 合并 + dream 三个 pass |
| 漂移 | 23 | 五种判决 + **目标消失 ≠ 切片变了** + 内容寻址往返 |
| 索引与缓存 | 20 | 纯函数快照 + 发布/回滚/GC + 扫描缓存失效 |
| 捕获与起草 | 20 | 草稿门 + 收件箱 + 子 Agent 回退 + `markDirty` 是 O(1) |
| 推广包 | 27 | 硬排除 / 软标记 / 可移植性 + 密钥规则编译 |
| 语义通道 | 23 | 默认关 + 永不抛 + 降级要说出来 + 只在显式阈值下判决 |
| G8 置信 | 7 | 与语料规模无关 + 锚点覆盖率 + 否定词不误伤「区别」 + **标签不被当分数** |
| 存储 | 3 | 目录布局、`hard_delete` 需要 confirm |

```bash
node bench/acceptance.mjs     # 设计文档 §14 的 7 条，对真实代码跑
```

> `@deepseek-ai/schemastery` 是 peer 依赖，由 DSH profile 提供。没装 profile 的机器上
> 「插件行接线」这组会 **skip**（不是失败）—— 但别用替身骗过它：`Config` 的形状是
> Plugin Manager 的输入契约，真实验证必须在装了 profile 的环境里做。

### 已验证（本机 desktop profile）

```
$ dsh plugin install link:/path/to/dsh-memory-bank
✓ dsh-memory-bank 0.1.0  (application: applied)

$ cordis_inspect Tool.listTools
memory_remember  memory_recall  memory_pending
memory_resolve   memory_audit   memory_forget
```

---

## 设计文档

| 文档 | 内容 |
|---|---|
| [01-参考分析](docs/01-参考分析.md) | OwnMem 与 gingugu 的机制级萃取，逐条 `keep / adapt / drop` |
| [02-设计](docs/02-设计.md) | 存储布局、捕获信号、召回管线、生命周期、DSH 集成点 |
| [03-审核协议](docs/03-审核协议.md) | MRP v1：G1–G8、裁决合成、回执链、审计日志 |
| [04-实施计划](docs/04-实施计划.md) | M0–M7 里程碑与风险登记 |

---

## 捕获：不阻塞回合

`agent/turn-stopping` 是宿主 **await** 的路径 —— 它花多少，你就多等多少才看到回合结束。

```
旧实现   同步跑完「八道门 + 写记忆 + 重建索引」        92 ms
新实现   turn-stopping（确定性判定 + 落盘入队）        2.7 ms   ← 宿主 await 这条
         后台 drain（跑门 + 写记忆 + 标脏重建）          1.6 ms   ← 你看不到
```

```bash
node bench/capture.mjs
```

三处改动：

1. **收件箱落盘**（`.dsh-memory/inbox/`）—— 纯内存队列在进程崩掉时丢数据，而「这条记忆该记」是你在那一轮里刚说出口的东西，丢了就再也回不来。
2. **索引重建挪到后台** —— 写入只 `markDirty`，编译在下一轮事件循环。正确性不依赖后台是否跑完（读路径仍然同步校验 `contentHash`），只是把「一次写」的代价从你等回合结束，挪到你看不见的地方。
3. **owner 文档与语料关键词缓存** —— 这两条路径都在 `turn-stopping` 上，而它们读的是「几个没变过的文件」。

### 自动捕获产出的是**草稿**，不是记忆

`buildCandidate` 从这一轮的真实内容里能填的就填：

| 六要素 | 从哪来 |
|---|---|
| 功能名 | 用户那句话 |
| 生效条件 | 用户那句话 |
| 子功能 | 编辑过的文件 |
| 执行 | 助手最后那段话 |
| 验证方式 | 跑过的命令 |
| **不适用条件** | **填不了 —— 留占位符** |

剩下的占位符由 **G2b 草稿门**拦成 **DEFER**：

> 把「我不知道」写成一句看起来像事实的话，是这个系统能犯的最严重的错。

### 让子 Agent 起草（默认关）

```yaml
capture:
  draft: subagent          # template（默认）| subagent
  draftProvider: in-process
```

打开后在**后台 drain 里**跑一次模型把六要素填实，产出仍然要过八道门，只是从「草稿」变成「成稿」。

**为什么默认关**：每条记忆一次模型调用是真实的钱和真实的时间。绝大多数捕获（S1 显式指令、S2 纠错）确定性模板就够了，剩下的本来就该你来裁。打开它意味着「我愿意为自动成稿付钱」—— 这是一个用户决定，不是默认值。

**为什么只能在 drain 里跑，不能在 hook 里**：在 `turn-stopping` 里 spawn 一个子 Agent 等于让你多等一次完整的模型往返（秒级），比同步重建索引还糟。

---

## 性能

装配路径（每轮 prompt 都跑那条）的基准，200 条记忆 / 305 个词表：

```
冷启动（无缓存）        ensureSnapshot                117 ms
热路径（缓存命中）      ensureSnapshot                0.66 ms
                        recall（5 路 + RRF + MMR）    3.97 ms
                        每轮合计                      4.62 ms
缓存失效后（改一条）    重建一次（200 条）             93 ms
```

```bash
node bench/assembly.mjs
```

三处优化，都在**每轮**路径上：

1. **扫描缓存**用「便宜戳 + 定期全量核对」：目录 mtime 1 次 `statSync` 命中；
   每 2 秒才跑一次逐文件全量戳。最坏是外部编辑器改了一行、2 秒后才被看见 ——
   在这个系统里，2 秒的陈旧远远好过每轮多付 3 毫秒。
2. **快照缓存**按指针内容失效（只有本进程会发布，指针就是充分信号）。
3. **派生集合**（字段 token / 3-gram / MMR 指纹 / 归一化 exact-map / 邻接表）
   全部 `WeakMap` 挂在对象上，快照换对象时自然回收。

`contentHash` 也缓存（挂在冻结的条目对象上）—— 装配路径每轮要对全库求一次哈希
判断快照新鲜度，而 `stableJson` 的递归排序 + `sha256` 对 200 条记忆是剩下最大的一笔。

> 数字只用于判断「这个优化值不值得」，**不作为性能承诺** ——
> 磁盘、杀毒软件、文件系统都会大幅改变绝对值。

---

## 非目标

- **不做全局记忆**。记忆是仓库级制品；跨项目那一层由别的插件负责。
  本插件只提供出口（`memory_promote`），把项目记忆整理成可推广的包 —— **不写、不读、不索引任何全局存储**。
- **不做云同步**。一个 brain，一个 SQLite/Markdown 目录，全本地。
- **不做 LLM-as-judge**。协议是纯算术，可复现。
- **不做自动删除**。唯一的移除路径是显式 `memory_forget`，且 `hard_delete` 需要用户确认。
- **不做 embedding**（v1）。权重常量是 0，A/B 过了才开。

---

## License

MIT
