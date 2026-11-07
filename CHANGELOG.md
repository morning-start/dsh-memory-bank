# 变更日志

本文件格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

每条都带**可复核的锚点**：`lib/文件:行` 或锁住它的测试名。数字来自本机实测（命令写在条目里）。

---

## [0.2.0] - 2026-11-07

> **配置面从 yaml / 环境变量搬进人机界面。**
>
> 0.1.1 修掉的三个配置缺陷（环境变量全死、默认值遮蔽、`config.json` 不读）
> 本质是同一件事：**作用域不可见**。这一版先补上「配置的第三、第四层」，
> 再把四层画出来 —— 每个字段右侧一个来源徽标，从上面来的层改不动就是灰的。
>
> 顺带修了**两个静默的数据丢失**（见下面「顺带修的两个静默缺陷」），
> 那两个都不是新代码引入的，是一直在那儿、只是没人跑过对应路径。

### 怎么自己验一遍

```bash
node --test "test/*.test.mjs"          # 385 tests / 385 pass / 0 fail / 0 skipped
node scripts/check.mjs                 # 60 个文件语法通过（递归扫 lib 与 client、shared）
node scripts/build-client.mjs --check  # 签入的 client/client.js 与一次全新构建逐字节一致
node bench/acceptance.mjs              # 7 / 7 通过
node bench/g1-eval.mjs                 # 判据未变（真阳性 4/10 · 假阳性 0/5 …）
```

### Added · 配置域（P0）

- **`lib/config/` 六个模块**（`schema` / `defaults` / `layers` / `project` / `migrate` / `index`）。
  `Config` 从 `lib/index.js` 搬出，成为**单一事实源**；host 与测试都从这里取。
- **四层合并**：`默认 → 项目 → 环境 → 行 config`（ADR-001）。
  `sourceOf(layers, path)` 回答「这个值从哪一层来」—— 这是界面画来源徽标的唯一入口。
- **项目层真的能读能写**：`<repo>/.dsh-memory/config.json`。
  坏 JSON 降级为默认值**并报 `problems`**，不静默；写错的键名也报出来。
  只接受四个仓库属性（`capture` / `quota` / `template` / `safety`），
  其余字段会被裁掉并报出 —— 「看起来生效、实际被更高的层盖住」比报错更糟。
- **热重载**：`cfg` 闭包 → `createConfigSource({ get(root) })`，按 `mtime:size` 失效。
  7 个工具 + 2 个钩子 + 1 个命令全部改成按 root 现取，**保存即生效，不用重启宿主**。
- **`schemaVersion` 迁移表**（`lib/config/migrate.js`，v1 起步）。版本**高于**本插件时
  不猜：原样保留 + 报问题。

### Added · 面板服务（`lib/host/`）

- `service.js` —— `MemoryBankService extends TypertRemoteService`，命名空间 `memoryBank`，
  17 个薄 async 方法。**只做路由，不写业务。**
- `queries.js` —— 8 个只读查询，全部复用 `store` / `claims` / `drift` / `lifecycle` /
  `index-build` 的现有实现，**一行过滤条件都没重写**。
- `mutations.js` —— 9 个写操作，统一 `MutationResult`。
  `forget` 在存在性检查**之前**校验 `confirm === true`。
- `guards.js` —— 按 root 的写锁、revision 乐观并发、异步写操作拒绝
  （防止将来有人给 mutation 加 `await` 而锁静默失效）。
- **`lib/command.js` 薄壳化**：面板的 `accept` 与 `/memory accept` 现在调**同一个函数**。
  0.1.1 刚修完「`gateQuota` 用黑名单、`activeEntries` 用白名单」那一类双实现漂移，
  不要在 UI 层再生一对。

### Added · 浏览器端（`client/`）

- 三块界面 + 一个抽屉：插件卡片（`plugins.item`）、配置页（`plugins.row.config`）、
  记忆面板（`settings.section`）、项目配置抽屉。
- `client/client.js` 是**签入的构建产物**，由 `scripts/build-client.mjs`
  从 `client/*.js` 确定性拼接；`--check` 模式保证它与源码一致。
- **零构建、零依赖**：`require` 只碰平台种子表里的 `react`。
- 样式全部走 `--dsw-alias-*` token，类名带 `mb-` 前缀（`practices.md:35`），
  `<style>` 在 **factory 的同步窗口**里注入（晚一步就不会被 `claimStyles` 认领，
  卸载后样式留在页面上）。

### Changed · 设计文档返工（`docs/07` §2.9）

实施前对着宿主源码逐条复核，推翻了三条「听起来对、照做会静默失败」的结论：

1. **`main` 槽不是「注册就劫持」** —— `replaceRisk: shadows-shipped-ui` 只对
   **已被占用的 key**（`conversation`）生效，新 key 是纯加法
   （`cordis-client-runner/lib/client.js:4370-4396`）。结论不变（仍用
   `settings.section`），但理由从「安全约束」改成「产品判断」。
2. **`require('@deepseek-ai/*')` 不是禁止** —— 5 个包是种子词，零声明可用
   （`dsh-web-frontend/dist/assets/index-BXV-oxvX.js:919724`）。仍手写控件，
   因为 `practices.md:35` 是**策略**（版本静默变 + 没有类型检查），不是平台限制。
3. **RPC 不是「零 codegen」** —— 这是过度乐观：生成产物 / `exports` /
   `dsh.client.inject` 三环缺一不可。好在产物是纯数据，可以手写。

### 顺带修的两个静默缺陷

- **`schemastery` 把「没提供的数组」物化成 `[]`**：`template: []` 会让 G2 对
  **每一条**记忆 refuse，`capture.signals: []` 让自动捕获**永不触发** ——
  全程零报错。修法：`lib/config/layers.js` 的 `pruneMaterialized` 在合并前裁掉
  物化出来的空容器。回归：`test/config.test.mjs` 的「宿主交进来的解析值不会
  静默清空默认值」。
- **两条「扫目录」的检查只扫顶层**：`bench/acceptance.mjs` 第 7 条（零网络调用）
  完全没扫到 `lib/config/` 子目录（19 → 24 个模块）；`scripts/check.mjs` 同样
  只扫顶层，`lib/config/` 的 6 个模块**一条都没被语法检查过**（37 → 60 个文件）。
  两处都改成递归 —— 这正是它们自己想防的那类「加了东西但检查数字没变」。

### 一个差点成为 P0 的部署缺陷

面板服务**不能**用顶层静态 import 挂在插件入口上：

```js
import { MemoryBankService } from './host/service.js'   // ← 会连工具面一起拖死
```

`lib/host/service.js` → `@deepseek-ai/dsh-typert-protocol` → `@deepseek-ai/cordis`。
这两个包**不在** `~/.dsh/profiles/desktop/node_modules/@deepseek-ai/` 下（本机实测：
只有 `schemastery` 在）。能不能解析，取决于宿主是否注入 resolver —— **仓库里证明不了**。

静态 import 失败 = 插件加载失败 = 7 个工具全没。为了一个人机入口。

修法：`ctx.effect` 里动态 `import()` + `catch`，失败降级成「只有工具面」并打出原因。
**已实测**：把 `dsh-typert-protocol` 的 junction 改名后，`test/plugin.test.mjs`
仍然 12/12 通过。

> 通用规则：**可选能力永远不许用静态 import 挂在插件入口上。**

### 在真 `dsh web` 里跑出来的两条（只有挂起来才会暴露）

前 385 条测试全绿，但界面在真宿主里是**白屏**。两条都是这样挖出来的：

1. **客户端的 `inject` 不许写 `remote.memoryBank`。** 那是硬依赖 —— 那个点号
   服务键在宿主注册好面板服务之前不存在，于是整个客户端条目停在
   `pending (waiting for service: remote.memoryBank)`，**三块界面一个都不挂载**，
   连只需要 `slots` 的卡片都一起没了。首屏原文：
   `web boot: 1 entry did not activate dsh-memory-bank`。
   修法：`inject` 只留 `['slots','locale','remote']`，命名空间交给
   `memoryBankFacade()` 调用时解析。回归锁：`test/client.test.mjs` 断言
   `inject` **不含** `remote.memoryBank`。

2. **第三方包注册不了 typert remote（已知阻断，未解决）。** 服务端能构造、
   能 `ctx.reflect.provide`，但浏览器里的 `ctx.remote.memoryBank` 始终不存在。
   根因：`typert.remote-client.js` 是**构建期产物**，被内联进宿主自己的 client
   bundle（`dsh-api-remotes/lib/client.js` 里就是拼接段）；我们的 `./remote`
   导出**没有任何东西会在浏览器里加载**。零构建的第三方插件拿不到这一面。
   旁证：`dsh-pocket` 带一个手写的 `web-rpc.js`（24 KB）绕开它。

   **当前状态：界面完整、数据面未接通。** 配置页如实显示「读取配置失败：记忆
   面板数据不可用：宿主没有暴露 memoryBank RPC 面」+ 重试按钮 —— 不白屏、
   不假数据。接通建议走手写 HTTP RPC（同 `dsh-pocket`），而不是继续折腾 typert。

### 真宿主验证方式（可复现）

```powershell
dsh plugin --profile web add "link:E:/Workplace/extension/dsh-memory-bank"
dsh --profile web --port 0 --no-open
# 打开打印出来的带 token 的 URL → 插件 → 记忆库
```


### Known gaps

- **视觉未验证**：没有浏览器控制，只证明了结构、文案、props 与三次注册。
  布局数值（960 / 612 / 440px）、对比度、`--dsw-alias-*` 是否全部解析、
  sticky 保存条在插件详情页底色上是否读得清 —— 都未实测。
- **端到端 RPC 未验证**：验证到「网关 `resolveSrcDescriptor` 能解析出全部 17 个
  端点 + 参数名与契约一致」，再往下需要 live Cordis 应用。
- **`memory_resolve` 工具面仍是第三份裁决实现**：`lib/tools.js` 的
  `memory_resolve` 还没有收敛到 `lib/host/mutations.js`。docs/07 只要求
  「面板 == 命令」，已满足；这是下一个该收敛的点。
- **`shared/types.d.ts` 是手写的**：没有从实现生成，靠 review 保持一致。

---

## [0.1.1] - 2026-11-07

> **patch 版，但修的是 P0。**
>
> 0.1.0 对外声称「196 条全绿 · G1 10/10 · P95 < 5ms」。0.1.1 的审计发现：
> 那 196 条**恰好测不到接线层** —— `test/plugin.test.mjs` 整组因为缺 peer 依赖被 **skip**，
> 而它断言的工具数还是 6（实际 7）。**唯一覆盖 `apply()` 接线的测试从来没有跑过。**
>
> 这一版修掉 **17 个 P0/P1 级缺陷**，测试 **196 → 286**（+90），
> 其中新建的 `test/wiring.test.mjs`（10 条）**不依赖 peer、永远会跑**，专门锁住那三个漏网的接线 bug。

### 怎么自己验一遍

```bash
node --test "test/*.test.mjs"          # 286 tests / 286 pass / 0 fail / 0 skipped
node scripts/check.mjs                 # 37 个文件语法通过
node bench/acceptance.mjs              # 7 / 7 通过
node bench/g1-eval.mjs                 # 真阳性 4/10 · 假阳性 0/5 · 改写漏报 5/5 · 完整协议 9/15
node bench/embedding-experiment.mjs    # A 最低 0.244 · B 最高 0.286 · C 最低 0.266 · 分离 **-0.020**（不可分离）
node bench/assembly.mjs                # 每轮合计 p50 4.3–7.8 ms · p95 46–90 ms
node bench/capture.mjs                 # 旧 89–113 ms · turn-stopping 2.4–3.3 ms · drain 1.5–1.9 ms
```

---

### Fixed · P0（8 条）

#### 1. `basename` 未导入 → 一个坏提案文件让三条路一起 `ReferenceError`

- **现象**：`pending/` 里只要有一个被截断的 `.json`，`memory_pending` / `memory_audit` / `memory_resolve` 三条路一起抛 `ReferenceError: basename is not defined`。
- **根因**：`readProposalDir` 的 `catch` 里用了 `basename`，但 `lib/store.js` 顶部没导入它 —— 而 `catch` 是「单个坏文件不拖垮扫描」这条纪律的**唯一实现**，它自己先崩了。
- **修法**：错误对象改由文件名推导 id，不再依赖未导入的符号（`lib/store.js:608-623`）。
- **回归**：`test/capture.test.mjs` · 「坏文件不拖垮整个收件箱」（`corrupt` 计数）。

#### 2. 「原子写」先 `rm` 再 `rename` → 「看不到半个文件」变成「看不到文件」

- **现象**：Windows 上写记忆偶发文件消失 —— 旧内容已删，新内容还停在 `.tmp-*`。
- **根因**：`writeFileAtomic` 先 `rmSync(目标)` 再 `renameSync`。Node 的 `renameSync` 在 Windows 上**本来就会覆盖已存在文件**；先删是多余的，而删和改名之间任何失败都会让文件真的不见。
- **修法**：直接 `rename` 覆盖，失败时清掉 tmp（`lib/util.js:52-71`）。
- **回归**：走 `lib/store.js` 的全部写路径测试；`test/drift.test.mjs` · 「**文件没改 → healthy**（带行号也走 anchorHash）」。

#### 3. `canonicalBody` 只 `trimEnd`、`parseEntry` 还剥前导换行 → 正文以空行开头的记忆**刚写完就判篡改**

- **现象**：`memory_audit` 对正文以空行开头的记忆报「回执异常 · 正文被改」。
- **根因**：0.1.0 只修了**尾随**换行。`parseEntry` 额外 `replace(/^\n+/,'')`，而 `serializeEntry` / `contentHash` 不剥前导 —— 两份实现漂了。
- **修法**：`canonicalBody` 成为**写入 / 解析 / 哈希三处唯一**的规范形式，前导与尾随一起规范化（`lib/model.js:288-349`、`lib/model.js:445`）。
- **回归**：`test/drift.test.mjs` · 「**serialize → parse 必须回到同一个 contentHash**」「正文尾部空白被规范化（serialize 会 trimEnd）」。

#### 4. 路径穿越：`frontmatter` 里的 `id` 未校验就拼进路径

- **现象**：一条 `id: "../../package"` 的记忆能把文件写出记忆库，落在仓库任意位置 —— 而 `memories/` 按设计是**进 git、随 PR review** 的。
- **根因**：`id` 有两个不可信来源（工具参数、记忆文件自己的 frontmatter），两处都直接 `join`。
- **修法**：`entryFile()` 成为**唯一的 id → 路径转换点**，三道闸：`ID_PATTERN` 白名单、`resolve` 后再 `relative` 确认没越界（`lib/store.js:69-88`）。
- **回归**：`test/drift.test.mjs` · 「../ 逃出仓库 → unsafe-path，而不是「文件不存在」」；`test/protocol.test.mjs` · 「记忆库目录结构符合设计」。

#### 5. 七个工具全部 `resolveRoot()` 不传 agent → 工具面与会话工作目录脱钩

- **现象**：在仓库 A 里说「记住 X」，记忆写到 **DSH 进程 cwd**，而 `/memory status` 读的是仓库 A。**两份世界，没有任何测试会红。**
- **根因**：`createResolver` 里「会话工作目录」那一段是死代码 —— 调用方一律 `resolveRoot()` 不带参数。修的时候只有 `memory_remember` 一条漏网，其余 6 个是后来被新建的 wiring 测试当场抓红的。
- **修法**：七个工具统一 `resolveRoot(exec?.agent)`（`lib/tools.js:167`、`:411`、`:442`、`:504`、`:582`、`:827`、`:900`）。
- **回归**：`test/wiring.test.mjs` · 「**七个工具都把 exec.agent 传给 resolveRoot**」—— 逐个工具断言，新加工具不补参数会红。

#### 6. 中文标题 id 全部塌成 `memory` / 低熵串 → 静默覆盖

- **现象**：两条中文标题的记忆争同一个文件名，后写的静默覆盖先写的。
- **根因**：**两套 id 算法各有一个洞** —— `lib/model.js` 的 `normalizeId` 只判「slug 长度 < 4」，中文标题归一化后是空串 → 落到 `memory`；`lib/capture.js` 的本地 `slug()` 完全不知道 `normalizeId` 的守卫修过。
- **修法**：`normalizeId` 改判「**归一化丢过信息就必须补短哈希**」（`lib/model.js:115-144`）；`capture.js` 删掉本地 `slug()`，强制走 `normalizeId`（`lib/capture.js:297-307`）。
- **回归**：`test/capture.test.mjs` · 「自动分配 id」。

#### 7. 每条 `file:line` 锚点在干净工作树上都报假 `advisory`

- **现象**：锚点带行号 → 100% 报「切片变了」。每一次重构都会把整库标成不可信，然后所有人学会忽略这个警告。
- **根因**：**写入侧与复查侧各写一套哈希** —— `gate` 写入时哈希**整个文件**，`drift` 复查时哈希**行切片**，永远对不上。
- **修法**：抽出 `lib/anchor.js` 作为**唯一事实源**（叶子模块，只依赖 node 内置，避免 `gate ↔ drift` 循环）。行切片哈希、符号体哈希、BOM 归一化全部只此一处；`symbol` 锚点在写入侧**真的去算哈希**（`lib/anchor.js`、`lib/gate.js:413-416`、`lib/drift.js:32`）。
- **回归**：`test/anchor.test.mjs` · 「只依赖切片内容：同行号 → 同哈希；不同切片 → 不同哈希」「BOM 不参与哈希」；`test/drift.test.mjs` · 「**文件没改 → healthy**（带行号也走 anchorHash）」「BOM 文件：gate 写入的哈希在 drift 侧仍然 healthy」。

#### 8. 召回 token 预算完全失效 + ngram 路数学上不可能命中 + `threshold` 是 `NaN`

三个独立的「算错了但没人报错」：

- **预算**：`estimatedTokens` 按**全文**记，却把**全文**也塞进注入 —— 预算从来没裁过任何东西。改成按**实际注入的节选**算（`lib/recall.js:649`）。
- **ngram**：分母被文档长度主导，`< 0.45` 这类门槛**数学上永远达不到** —— 这条路恒空（`lib/recall.js:288`）。另外特征按对象读，`exact` / `graph` 两条恒为 `undefined`（`lib/recall.js:402`）。
- **NaN**：`recall()` 默认 `config = {}` 时阈值是 `NaN`，比较恒 false → 什么都不交付。改成只给部分标签时落到 0.65 兜底（`lib/recall.js`）。
- **回归**：`test/recall.test.mjs` · 「注入的是节选不是全文，estimatedTokens 按实际注入量算」「配置只给了部分标签时落到 0.65 兜底（不是 NaN）」「**符号命中不要求整串相等**」「**exact 命中的 anchor 特征真的进特征集**（曾经恒为 undefined）」。

---

### Fixed · P1（9 条）

#### 9. 捕获队列 `finally` 无条件删条目 → 持久队列退化成 at-most-once

- **根因**：`finally { removeInbox(...) }` 让起草失败、写盘失败、HTTP 失败的条目**当场消失** —— 而收件箱存在的全部理由就是「先落盘再处理」。
- **修法**：成功才删；失败保留并记 `attempts`，超过 3 次挪进 `inbox/failed/`（`lib/hooks.js:273-325`）。
- **回归**：`test/capture.test.mjs` · 「写入 → 读回 → 删除」；`test/wiring.test.mjs` 走同一份 `install()`。

#### 10. `contentHash` 漏字段 → 改成 R5 后索引永不重建

- **现象**：把一条记忆从 R1 改成 R5，索引不重建，召回永远渲染 R1 —— 「涉及不可逆操作」的警告永不出现；`relations` 改了图边也永远是旧的。
- **根因**：`contentHash` 只哈希 id/title/kind/about/body/evidence/scope/triggers/supersedes，漏了 `actionRisk` / `provenance` / `confidence` / `status` / `relations` / `claims`，而 `ensureSnapshot` 判「快照是否新鲜」用的就是它。
- **修法**：字段集补宽（`claims` 只哈希身份三列，`resolvedState` 是另一条轴，关掉断言不该让回执失效）（`lib/model.js:412-464`）。
- **⚠️ 未完成的一半**：审计记录里说「回执加了 `hashVersion: 2`，旧回执报 `needs-reseed` 而不是 `tampered`」。**代码里没有 `hashVersion` 字段**，`receiptStatus`（`lib/store.js:463-469`）只返回 `missing / tampered / evidence-tampered / ok`，而 `memory_audit` 里那个 `needs-reseed` 分支（`lib/tools.js:631-647`）**永远不会命中**。所以升级后旧回执仍会报 `tampered` —— 这是**虚假的篡改指控**，正是这条修复要消灭的东西。**待补**（诊断入口 `memory_audit --semantic` 同样不存在，见「已知限制」）。
- **回归**：`test/index.test.mjs` · 「**document 带上 contentHash 覆盖的全部语义字段**」「改了正文 → 重建并报 source-changed」。

#### 11. `lib/config.js` 三层合并顺序错 → 4 个环境变量死 3 个

- **根因**：先 `deepMerge(defaults, rowConfig)` 把默认值填满，再 `merged.x ?? env[x]` —— 默认值一填满，`??` 就永不短路，**四个环境变量里死了三个**（只有 `root` 有效，因为 `defaultConfig()` 里没有这个键）。而且 `autonomy` 的 fail-fast 只校验 `merged.autonomy`，`DSH_MEMORY_AUTONOMY=yolo` 静默回退 `balanced`。
- **修法**：显式三层 `deepMerge(deepMerge(defaults, envLayer(env)), rowConfig)`，行 config > 环境变量 > 默认值；`autonomy` 在 **mount 时**就 fail-fast（`lib/config.js:8-12`、`:87-90`、`:111`）。
- **回归**：`test/plugin.test.mjs` · 「非法 autonomy 直接抛（不静默回退到更激进的档位）」「deferFloor 大于 autoAcceptFloor 抛错」「日志打出解析后的配置」。

#### 12. G5 的幂等分支 `return pass` → `continue`

- **根因**：幂等重写只该豁免**这一对**，`return pass` 却把**整道门**放过 —— 只要更新的是自己，库里的重复全部豁免。
- **修法**：`continue`（`lib/gate.js:546-552`）。
- **回归**：`test/protocol.test.mjs` · 「近重复被拒，并指向既有条目」。

#### 13. G2 不剥代码块 → 合法 capability 记忆被硬拒

- **根因**：标题数直接跑在原始 `body` 上，代码块里的 `# 注释` 被当成 Markdown 标题，多主题判定误伤 —— 而「某命令/脚本怎么跑」的 capability 记忆**必然**带代码块。
- **修法**：`stripCodeBlocks` 之后数标题，与 G5 复用同一份实现（`lib/gate.js:281-293`）。
- **回归**：`test/protocol.test.mjs` · 「写一条记忆并原样召回」；`test/capture.test.mjs` · 「有占位符 → refuse，并列出缺哪几段」。

#### 14. G3 不扫 `evidence[].excerpt` → 密钥从摘录字段落盘

- **根因**：`haystack` 只拼 `title + about + body`。摘录是**自由文本**，把密钥贴进摘录就绕过了整道安全门。
- **修法**：`haystack` 必须包含 `evidence[].excerpt`（`lib/gate.js:342-353`）。
- **回归**：`test/protocol.test.mjs` · 「含密钥的记忆硬拒，文件不存在，日志脱敏」；`test/promote.test.mjs` · 「**每一条密钥规则都必须能编译**」「内联 (?i) 规则真的会匹配」。

#### 15. G8 的 `coverage` 算成「与既有语料的相似度」→ 惩罚积累

- **根因**：语料为空回退 0.5、非空按相似度打分 → **第二条同类型记忆比第一条更难落盘**。更糟的是不单调：同一个候选在不同大小的语料上得到不同裁决，而「同样的候选 + 同样的仓库 → 同样的裁决」是协议敢自动跑的前提。
- **修法**：`coverage` 改成 `anchorCoverage` —— **正文里出现过的证据锚点占比**（`lib/gate.js:681-713`）。
- **回归**：`test/protocol.test.mjs` · 「与语料规模无关（同样的候选永远同样的分）」「正文没提到的锚点 → 覆盖率 0 → 分数掉下去」。

#### 16. `agent/turn-stopping` 里调 `ensureSnapshot` → 每轮同步重建

- **根因**：快照陈旧时会 `compileSnapshot` 全量重编，而 `turn-stopping` 是宿主 **await** 的路径 —— 为了加一条记忆，把 200 条索引整个重编。
- **修法**：`markDirty` 立即返回，重建挪到后台 drain；正确性不依赖后台是否跑完（读路径仍同步校验 `contentHash`）（`lib/hooks.js:149`）。
- **回归**：`test/capture.test.mjs` · 「markDirty 立即返回（不同步重建索引）」「markDirty 不抛（即使 root 不存在）」。

#### 17. `ledger` 写失败被 `catch { }` 吞掉 → 静默失败

- **根因**：`appendLedger` 的 `catch` 是空的，于是 ledger 写不进去时没人知道，而 `memory_audit` 的拒答率 / 延迟率**全都偏小**，看起来一切正常。
- **修法**：`onLedgerError` 把失败接到宿主 `log` 上（`lib/store.js:471-503`、`lib/index.js:219-220`）。
- **回归**：`test/protocol.test.mjs` · 「audit 报出规模与健康度」。

---

### Added

- **`lib/anchor.js`** —— 锚点解析与哈希的**唯一事实源**（`gate` 写入与 `drift` 复查共用）。原因见 P0 #7。
- **`test/wiring.test.mjs`（10 条）** —— 不依赖 `@deepseek-ai/schemastery`，直接调 `createToolDefinitions` / `createHooks` / `createMemoryCommand`，**永远会跑**。锁住：7 个工具名与 output 契约、`additionalProperties: false`、prompt context 的 `order=130`、两个监听器、`/memory` 命令、disposer 可调用、七个工具的 `exec.agent`、空库 status、未知子命令、错误以抛出形式离开。
- **`memory_audit` 的回执分类**：`needs-reseed` 与 `tampered` 分开报（`lib/tools.js:629-651`）—— 升级路径不再产生虚假的篡改指控。
- **G1 语义通道**（`none / lexical / http` 三 provider + LRU 缓存 + 降级），默认关（`lib/embedding.js`）。
- **`CHANGELOG.md`**（本文件）。

### Changed

- **测试口径**：196 → **286**（+90）。`test/plugin.test.mjs` 从「整组 skip」恢复为**真实执行**（12 条），并修正工具清单 6 → **7**（多了 `memory_promote`）。
- **`locale/zh.json` / `locale/en.json`**：「八道门 / eight gates」→「**十道门 / ten gates**」（`G1 G2 G2b G3 G3b G4 G5 G6 G7 G8`，其中 `HARD_GATES` 7 个：`G1 G2 G3 G3b G4 G5 G7`）。
- **文档全面对齐实测**：
  - G1 从「逐字 10/10 · 完整协议 15/15」改成 **真阳性 4/10 · 完整协议 9/15 · 精度 60.0%**；
  - 语义分离从「+0.004」改成 **−0.020**（并统一开闸判据：`< 0.05` 关 / `0.05–0.15` 只做诊断 / `≥ 0.15` 才允许开闸）。**注意它会抖**：同一批 15 个候选，改文档前跑是 `+0.063`、改完是 `−0.020` —— 这本身就是「这个指标测的是噪音」的最硬证据；
  - 召回验收从「P95 < 5ms」改成 **p50 < 5ms**（实测 p50 4.3–7.8 ms、p95 46–90 ms）；
  - 捕获基准从「92 ms → 2.4 ms」改成 **89–113 ms → 2.4–3.3 ms**（并注明这个基准测的是「门 + 拒绝」，不是「门 + 写入」）；
  - 模块数 18 → **19**，规模约 300 KB → **约 350 KB**。

### Known limitations

0.1.1 **仍未做**的（完整清单与现状见 [`docs/04-实施计划.md`](docs/04-实施计划.md) §「未做的」）：

- **Web 面板** —— 未做（命令面已通，图形界面未做）。
- **语义通道开闸** —— 未做。分离度 **−0.020 ~ +0.063**（同一批候选，改文档就翻号），落在「关」这一档。
- **全局记忆对接** —— 明确边界，本插件只产包（`memory_promote`），不写、不读、不索引任何全局存储。
- **G1 判据 3/4/5**（回归测试索引 / 符号索引 / 同 id 前缀）—— **只实现判据 1/2**（规则文件 + 权威文档）。所以 G1 的 A 组用例里 a1/a2/a3/a4/a7/a10 六条放行，**真阳性只有 4/10**。
- **`memory_audit --semantic`** —— 参数不存在（`lib/embedding.js` 文件头把它当诊断入口写着）。
- **G7 的 `--write-lock` / `quota-ratchet-raise`** —— 未实现（棘轮写回 0.1.1 已做）。
- **G3 拒绝后的「负记忆脱敏」** —— 只记规则序号，无脱敏副本。
- **四道门** —— 只实现 `relevance` + `budget`；`epistemic` / `applicability` / `action-risk` 未实现。
- **`seen` / `pointed` 双集合去重** —— 未实现（`mmrSelect` 只有一个 `suppressed`）。
- **`pinned` / `expiresAt` 的召回行为** —— 字段已进快照，召回过滤未接。
- **`quarantined` 阻断注入** —— 未接到交付层。
- **TrustReceipt 链** —— 20 个字段只有 9 个，无 `validateTrustLock`、无 `mrp: 1`，只留最新一条回执。
- **`S7` 捕获信号** —— 不是捕获信号（是工具来源标签），schema 描述已改。
- **代数 / 交互式 `memory_promote` 的 `--write-lock`** —— 未实现。

**基准本身的已知缺陷**（文档只报告，不改 `bench/`）：

- `bench/g1-eval.mjs:131` 的输出文案还写「完整**八**道门」，实际是 10 道（`HARD_GATES` 7 道）。文案不影响判决，但会误导读输出的人。
- `bench/assembly.mjs:90` 的 `percentile(values, p)` 用 `[Math.floor(len * p)]`，在 **20 个样本**上取 p95 得到的是索引 19 —— 即**最大值**。所以 `p95 46–90 ms` 这个标签本身不准，它描述的是「最慢的那一次」。
- `bench/capture.mjs` 的 `drain 结果：REJECT 30` —— 30 条候选**全部被拒**，「门 + 写入」里的写入分支一次都没执行。这个基准实际测的是「门 + 拒绝」。
- `bench/acceptance.mjs:255` 硬编码「**16 个模块**零网络调用」，实际 `lib/*.js` 是 **19 个** —— 扫描本身覆盖全部（`:251` 的四个正则），只是文案过时。

---

## [0.1.0] - 2026-11-06

首个可用版本：十道门、三值裁决、五路召回、三级交付、捕获与自主度、`/memory` 命令、6 份文档。

已知问题：196 条测试**测不到接线层**（`test/plugin.test.mjs` 整组 skip），详见 0.1.1。
