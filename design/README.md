# 配置面 UI · 视觉稿

> 这是 `docs/07-配置面UI设计.md` 的**视觉实现**，不是能直接跑的插件代码。
> 目标：在 DSH 真实的界面语言里，把「记忆库」的配置面画出来，先看效果、再决定怎么落地。

---

## 1 · 四屏

| 屏 | 文件 | 对应插槽 | 看什么 |
|---|---|---|---|
| 插件页 | `plugins.html` | `plugins.item` | 「已安装插件」里的记忆库卡片：版本、状态、42 条记忆 / 3 待决 / 2 漂移，入口是这张卡 |
| 配置页 | `plugin-config.html` | `plugins.row.config` | 六个分组（自主度 / 阈值 / 捕获 / 召回 / 配额 / 高级）+ 每个字段的**来源徽标** + 底部保存条 |
| 记忆面板 | `memory.html` | `settings.section` | 设置弹窗里的「记忆」页：健康概览 + 待决 / 记忆 / 漂移 / 审计 四个 tab |
| 项目配置 | `project-config.html` | 记忆页里的抽屉 | 仓库级 `config.json`：只对这个仓库生效的四个字段 + 边界说明 |

四屏之间是真的链接：插件页 →「配置」→ 配置页 →「打开记忆面板」→ 记忆页。

---

## 2 · 设计系统从哪来

**不是**凭感觉画的：token 全部取自宿主包
`@deepseek-ai/dsh-client-ui-theme` 的 `design_platform_css`（深色档），
组件数值取自 `ui-layout` / `ui-sidebar` / `ui-plugin-manager` / `ui-settings-plugins`
的 CSS Modules，并用无头浏览器在运行中的 DSH 上量过。

| 项 | 值 | 来源 |
|---|---|---|
| 侧栏 | 256px，`--sidebar-fill #1b1b1c`，右描边 `.5px #ffffff29` | `SidebarRoot.module.css` |
| 内容 | 最大 960px，左右 `clamp(24px,4vw,48px)`，页头 `padding-top: 28px` | `PluginManagerPage.module.css` |
| 页面标题 | 20px / 500 / 28 | 同上 |
| 卡片 | 圆角 20，图标 48×48 圆角 16，行高 14/500 | 同上 |
| 输入框 | 高 40，圆角 12，描边 `.5px --border-l4`，底色 `--bg-layer-3` | 同上 |
| 按钮 | 高 32，圆角 12，字号 13 | 同上 |
| 开关 | 40×24 轨道（宿主是 36×20，这里为了 24px 点击区放大） | `ui-settings-*` |
| 设置弹窗 | 800×800，圆角 28，左导航 188（单元格 164 / 高 40 / 圆角 12），内容 612 | 实测 |

所有颜色都走 `tokens.css` 的 `--dsw-alias-*` 语义变量，**没有裸色值**
（唯一例外是 `--state-error-secondary #ff7b7b` 与提亮的 `--label-caption`，
两者都是为了过 4.5:1 对比度）。

---

## 3 · 这一版在视觉上想说的三件事

### ① 作用域必须画出来

0.1.1 修的三个配置缺陷（环境变量全死、默认值遮蔽、`config.json` 不读）
本质是同一件事：**用户不知道这个值是从哪一层来的**。

所以每个字段右侧都有一个来源徽标：

```
默认值（灰）  项目配置（蓝）  环境变量（黄）  部署配置（红）
```

从「项目配置」之外的层来的字段，输入框变灰、只读 —— 改这里不生效。
配置页顶部那条蓝框把四层顺序写全了，这是整页最该被读的一句话。

### ② 待决队列是「协议判不了」的结果，不是错误

记忆面板默认落在「待决」tab，每条提案都写清**是哪道门没判过去**：

> `G1` 归属门未过：正文提到了锚点，但 `scope` 为空，判据 3–5 全部落空。

这比「审核中」有用得多 —— 用户知道改哪里能让它过去。

### ③ 未开闸要说「为什么」

语义通道那块是**只读**的，并且明确写了：

> 不是漏了开关，是闸没开：本地实测的通道分离度只有 +0.063，够不到 0.15 的开工判据。

「文档承诺、代码空壳」是这个项目最贵的债。界面上不许再出现一个看起来能开、
其实没实现的开关。

---

## 4 · 四条硬约束（照抄 `docs/07`）

落地时**不能**违反，否则静默失败：

1. **不要用 `main` 槽** —— `replaceRisk: shadows-shipped-ui`，会替换宿主中央面板；
2. **不要 `require` 任何 `@deepseek-ai/*` Client 包** —— 版本升级后静默崩；
3. **`Config` 字段必须标 `.volatile()`** —— 否则整张表单只读，且宿主不告诉你为什么；
4. **Loader 行的 `name` 必须是裸包名** —— 子路径静默不进客户端图。

---

## 5 · 怎么转成代码

```
handoff_design(framework: "same", dest: "E:/Workplace/extension/dsh-memory-bank")
```

会生成 `handoff/HANDOFF.md`（每屏对应哪个组件、哪些抽成公共件、状态与交互）。

对应关系：

| 视觉稿 | 落地 |
|---|---|
| `plugins.html` 的记忆库卡片 | `plugins.item` 注册的 `MemoryCard` |
| `plugin-config.html` | `plugins.row.config` 注册的 `ConfigPage` |
| `memory.html` | `settings.section` 注册的 `MemorySection` |
| `project-config.html` 的抽屉 | `MemorySection` 内的 `ProjectConfigDrawer` |

`app.css` 里的组件（`.card` / `.switch` / `.field` / `.source` / `.settingsPanel`）
在真实实现里应该变成 **CSS Modules**，类名加 `mb-` 前缀
（`practices.md:35` 要求复制来的类名必须改前缀，避免与宿主撞名）。

---

## 6 · 已知取舍

- **深色优先**。`tokens.css` 只写了深色档；浅色档的 alias 值在
  `ui-theme` 的 `body{}` 里，落地时用 `[data-ds-dark-theme]` 切换即可。
- **小字号统一提了一档**：宿主里 10–11px 的徽标 / 时间，这里都是 12px，
  为了过对比度与可读性检查。落地时可以按宿主的实际值回退，但要知道会牺牲什么。
- **设置弹窗内容宽 612**，所以记忆面板是纵向列表而不是表格 —— 表格在这个宽度里会挤。
- 品牌 logo 用的是宿主真实的 SVG（`brand.svg`，深色档反白），不是重画的。
