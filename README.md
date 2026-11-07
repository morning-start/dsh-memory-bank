# dsh-memory-bank

> DSH 的**项目级**记忆插件：Agent 自主判断该不该记，每次写入过**十道门**自审，判不了才以提案交你裁决。

不是「存了再检索」，是**先审再决定存不存**。

---

## 它解决什么

带记忆的 Agent 有两个经典失败模式：

**什么都记。** 上下文变成一个永不清理的待办清单。三个月后模型学会忽略它，而你不知道是从哪一天开始的。

**什么都不记。** 每次新会话从零开始。同一个人对着同一个坑踩第四遍，每次都以为这是第一遍。

这个插件的答案是**审核**：一条候选记忆要过十道门才能落盘。过不了的，要么可机械判定地回给模型改（`REJECT` + `next`），要么**留给你裁决**（`DEFER` → 提案）。

「记忆会过时」是个无解问题。这里不假装解决它 —— 而是把它拆成一个**可枚举、可对账、可矛盾检测的结构化积压**：

> 一条说「PR #10 还开着」的记忆是在做**断言**。它写的时候为真，**永不为跟踪世界而改写**。
> 解析另存。于是「这条还成立吗」变成一个可以定期跑、可以出报告、可以吵起来的问题。

**只做项目级记忆。** 记忆是仓库级制品 —— 随仓库进 git、随 PR review、随回滚消失。跨项目那一层由别的插件负责；本插件只提供**出口**（`memory_promote`），把项目记忆整理成可推广的包，**不写、不读、不索引任何全局存储**。

---

## 安装

```bash
# 从 GitHub 安装（写进 desktop profile）
dsh plugin --profile desktop add morning-start/dsh-memory-bank

# 开发时用本地链接（改源码立刻生效）
dsh plugin --profile desktop add link:/path/to/dsh-memory-bank
```

`dsh plugin` 是 **pnpm 的转发器** —— 它把剩下的参数原样交给 profile 目录里的 pnpm。
所以 GitHub 简写、`link:`、npm 包名三种形式都直接可用，装进哪里由 `--profile` 决定。

装完在**任何**会话里可用 —— 不绑定预设。

> **改 JS 后要重启宿主**。`link:` 安装的源码改动会直接反映在链接目录里，但模块代际不会热更新。刷新页面不算。

卸载：`dsh plugin --profile desktop remove dsh-memory-bank`

---

## 快速开始

不用配置。直接说话：

```
你：记住：这个仓库的集成测试要先起 redis，用 docker compose -f test/compose.yml up -d。
```

Agent 调 `memory_remember`，十道门跑完：

```
已记住：集成测试要先起 redis
  id=integration_needs_redis · kind=convention · 置信=0.785 · 风险=R1
  文件：.dsh-memory/memories/integration_needs_redis.md
这条记忆会在后续会话里被召回。它现在进了 git —— 像代码一样 review 它。
```

下一个会话（或者下一个 Agent）开始工作时，它会**自动出现在上下文里**，不需要谁去「查询记忆」。

判不了的时候（两条都成立但互相矛盾、或者置信不够）：

```
已提交待决：连接池上限 vs worker 数量
  proposal=p_20261106... 理由：G6:conflict
  /memory pending 看，/memory accept p_20261106... 接受
```

命令**不经过模型** —— 你输入的就是你的裁决。

---

## 七个工具

刻意少。DSH 的工具是稀缺上下文资源。

| 工具 | 作用 |
|---|---|
| `memory_remember` | 提议一条记忆（走完整协议） |
| `memory_recall` | 主动召回（三级交付：content / pointers / abstain） |
| `memory_pending` | 列待决提案 |
| `memory_resolve` | accept / reject / edit 一条提案 |
| `memory_audit` | 全量审计：断言对账 + 生命周期 + 漂移 |
| `memory_promote` | 整理成可推广到全局记忆的包（只读、只提名） |
| `memory_forget` | 退休 / 删除（破坏性） |

**工具面给 Agent，命令面给人**：

```
/memory                    状态总览
/memory pending            待决提案
/memory accept <id>        接受（硬门仍会重跑）
/memory reject <id>        拒绝（永久）
/memory recall <查询>       直接召回
/memory audit              全量审计
/memory promote [--json]   生成推广包
/memory retire <id>        退休一条记忆
```

---

## 核心概念

| 概念 | 一句话 | 详 |
|---|---|---|
| **三值裁决** | `ACCEPT` 落盘 / `REJECT` 回给模型改 / `DEFER` 交人裁决 | [03](docs/03-审核协议.md) |
| **十道门** | 7 道硬门（归属/形态/安全/注入/证据/重复/配额）+ 3 道软门（草稿/冲突/置信） | [03](docs/03-审核协议.md) |
| **断言** | 记忆正文永不改写；世界变了另存三列（`resolvedState` / `resolvedBy` / `resolvedAt`） | [03](docs/03-审核协议.md) |
| **漂移** | 目标**消失** = `quarantined`；目标还在但**切片变了** = `advisory`（重构不是攻击） | [03](docs/03-审核协议.md) |
| **三级交付** | 有把握给正文，没把握给指针，无关就 `abstain` 并说出拒的是哪道门 | [02](docs/02-设计.md) |
| **捕获** | `agent/turn-stopping` 只做确定性判定 + 落盘入队（p50 2.4–3.3 ms），十道门在后台 drain 里跑 | [05](docs/05-实测与踩坑.md) |
| **推广** | 只提名，不搬运 —— 哪些项目记忆换一个仓库还成立，是人的判断 | [02](docs/02-设计.md) |
| **自主度** | `manual` 全靠确认 / `balanced`（默认）高置信自动 / `autonomous` 全自动 | [02](docs/02-设计.md) |

**配置全部可选**，行 config > 环境变量 > 默认值。完整配置见 [02-设计](docs/02-设计.md)。

---

## 它不做什么

- **不做全局记忆。** 跨项目那一层由别的插件负责。本插件只提供出口，不写、不读、不索引任何全局存储。
- **不做云同步。** 一个 brain，一个 Markdown 目录，全本地。零网络调用。
- **不做 LLM-as-judge。** 协议是纯算术，可复现 —— 同样的候选 + 同样的仓库 → 同样的裁决。
- **不做自动删除。** 唯一的移除路径是显式 `memory_forget`，且 `hard_delete` 需要你确认。
- **不做语义去重**（v1）。通道实现好了，但本地实测分离度 **−0.020 ~ +0.063**（同一批候选，改几段文档就翻号），连开闸线都够不到 —— 见 [05](docs/05-实测与踩坑.md)。

---

## 状态

| | |
|---|---|
| 版本 | **0.3.1**（合并不得放大权威：`confidence` 取最弱、`actionRisk` 取最高、`lastVerifiedAt` 不重置） |
| 测试 | **506 条**，`node --test "test/*.test.mjs"`（链接 peer 依赖后；不链接则少 15 条接线测试） |
| 验收 | 设计文档 §14 的 7 条**全部通过**（`node bench/acceptance.mjs`） |
| 基准 | G1 真阳性 **4/10** · 完整协议 **9/15** · 精度 **60.0%**；语义分离 **−0.139**（不可分离，见 `bench/embedding-experiment.mjs`） |
| 规模 | **33** 个服务端模块 + 浏览器端 `client/` · 约 420 KB |
| 依赖 | 仅 `@deepseek-ai/schemastery`（peer）；浏览器端零依赖（React 由平台种子表提供） |

```bash
npm test                      # 495 条单测（需先链接 peer，见 docs/07 §5）
npm run doctor                # 自检：装好了吗（10 项，只读，退出码 0/1）
node bench/acceptance.mjs     # 验收 7 条
node bench/g1-eval.mjs        # G1 拿本仓库自己的文档实测
node bench/assembly.mjs       # 装配路径基准
node bench/capture.mjs        # 捕获路径基准
```

> 0.1.0 的「196 条全绿、G1 10/10、P95 < 5ms」在 0.1.1 的审计里被逐条推翻。
> 差在哪、怎么修的，见 [CHANGELOG](CHANGELOG.md) 与 [05](docs/05-实测与踩坑.md) 第 7 节。

---

## 配置面

0.2.0 之前，改配置只有三个入口：手写 `cordis.patch.yml`、设 `DSH_MEMORY_*`、
或者读 `/memory status` 干看着。**没有任何一个入口能按仓库改配置** ——
而记忆库是仓库级制品。

0.2.0 把配置搬进界面：设置 → 插件 → 「记忆库」卡片 → 配置。四层
（**默认 → 项目 → 环境 → 行 config**）合并，每个字段右侧画一个**来源徽标**：

```
默认值（灰）  项目配置（蓝）  环境变量（黄）  部署配置（红）
```

从「项目配置」之外的层来的字段，输入框变灰只读 —— 改这里不生效。
0.1.1 修的三个配置缺陷（环境变量全死、默认值遮蔽、`config.json` 不读）
本质是同一件事：**作用域不可见**。界面把它画出来。

另有一个「记忆」设置页（设置 → 记忆）：健康概览 + 待决 / 记忆 / 漂移 / 审计
四个 tab，以及仓库级 `config.json` 的抽屉。

设计见 [07-配置面UI设计](docs/07-配置面UI设计.md)，视觉稿在 [`design/`](design/README.md)。


---

## 文档

| | |
|---|---|
| **[06-场景式使用指南](docs/06-场景式使用指南.md)** | **先看这个** —— 按场景讲「遇到这件事怎么办」：该记什么、被拒了看哪、待决队列怎么清、记忆过时了怎么处理、排障速查 |
| [01-参考分析](docs/01-参考分析.md) | OwnMem / gingugu / bireturn 三个参考库的机制萃取 |
| [02-设计](docs/02-设计.md) | 架构、存储、召回、配置 |
| [03-审核协议](docs/03-审核协议.md) | **MRP v1** —— 十道门的完整判据与合成规则 |
| [04-实施计划](docs/04-实施计划.md) | 里程碑与当前状态 |
| [05-实测与踩坑](docs/05-实测与踩坑.md) | 真 bug 的复盘（0.1.0 四个 + 0.1.1 十七个）、G1 与语义通道的实验数据 |
| [07-配置面UI设计](docs/07-配置面UI设计.md) | 把配置从 yaml / 环境变量挪到人机界面的模块设计（**设计稿，未实现**） |
| [08-代码审核](docs/08-代码审核.md) | v0.2.0 的代码审核：P0 × 5 · P1 × 25 · P2 × 48，以及修复状态 |
| [09-参考分析-memory-bank-skill](docs/09-参考分析-memory-bank-skill.md) | 对着 chuck-ma/memory-bank-skill 逐机制对照：注入面缺什么、哪些该抄、哪些是陷阱 |
| [CHANGELOG](CHANGELOG.md) | 每个版本的修复清单 |

---

## License

MIT
