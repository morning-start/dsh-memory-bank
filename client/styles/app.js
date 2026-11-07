/**
 * 组件样式（注入成一个 `<style data-plugin-css>` 标签）。
 *
 * ## 三条规则
 *
 * 1. **只用 `--dsw-alias-*`**。宿主主题换肤时跟着变；写死色值会在浅色档里
 *    变成黑底黑字（`practices.md:34`）。
 * 2. **类名一律 `mb-` 前缀**。这些是照宿主 CSS Modules 抄的数值，前缀是
 *    `practices.md:35` 的硬要求 —— 不撞名，宿主升级也不会互相踩。
 * 3. **不碰 `html` / `body` / `*`**。这个标签是全局的，选择器出了 `mb-`
 *    就是改别人的页面。
 *
 * 数值来源：`design/app.css`（照 `ui-layout` / `ui-plugin-manager` /
 * `ui-settings-plugins` 抄的实测值）。间距与圆角是字面量，**颜色一律走
 * token** —— `test/client.test.mjs` 会正则扫这一段，出现裸色值就红。
 */

const CSS = `
.mb-config,
.mb-panel,
.mb-drawer,
.mb-scrim {
  box-sizing: border-box;
}

.mb-config *,
.mb-panel *,
.mb-drawer * {
  box-sizing: border-box;
}

/* ============================== 配置页 ============================== */

.mb-config {
  display: flex;
  flex-direction: column;
  gap: 24px;
  /* 设计稿：内容最大 960 —— 再宽一行会跑得眼睛跟不上。 */
  max-width: 960px;
  margin: 0;
  padding: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
}

/* 作用域提示条：这一页最该被读的一句话 */
.mb-scope {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 28%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, transparent);
}

.mb-scope__glyph {
  flex: none;
  margin-top: 2px;
  color: var(--dsw-alias-state-business-primary);
}

.mb-scope p {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 19px;
}

.mb-scope b {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}

/* 项目配置读取问题 */
.mb-problems {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.mb-problems__title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--dsw-alias-state-error-secondary);
  font-weight: 500;
}

.mb-problems ul {
  margin: 0;
  padding-left: 18px;
}

.mb-problems code {
  color: var(--dsw-alias-label-secondary);
}

/* 分组 */
.mb-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 4px;
}

.mb-group__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 6px;
}

.mb-group__title {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
}

.mb-group__desc {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.mb-group__rule {
  flex: 1;
  height: 0.5px;
  min-width: 12px;
  background: var(--dsw-alias-border-l1);
}

.mb-group__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 字段行 */
.mb-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 168px;
  align-items: center;
  gap: 24px;
  padding: 12px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.mb-field:last-child {
  border-bottom: 0;
}

.mb-field--wide {
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 10px;
}

.mb-field__main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.mb-field__labelRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.mb-field__label {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
}

.mb-field__hint {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.mb-field__hint--locked {
  color: var(--dsw-alias-state-warn-secondary);
}

.mb-field__control {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

.mb-code {
  color: var(--dsw-alias-label-caption);
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px;
  white-space: nowrap;
}

/* 数值网格（阈值 / 配额这类成组的数字） */
.mb-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px 20px;
  padding: 8px 0;
}

.mb-grid--two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.mb-grid__cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.mb-grid__label {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 18px;
}

/* 输入框 */
.mb-input,
.mb-textarea {
  width: 100%;
  height: 40px;
  padding: 0 14px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 12px;
  outline: none;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.mb-input:hover,
.mb-textarea:hover {
  border-color: var(--dsw-alias-label-caption);
}

.mb-input:focus,
.mb-textarea:focus {
  border-color: var(--dsw-alias-state-business-primary);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-state-business-primary);
}

.mb-input:disabled,
.mb-textarea:disabled {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  cursor: default;
}

.mb-input--number {
  text-align: right;
}

.mb-input--chip {
  width: 160px;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 12px;
}

.mb-textarea {
  min-height: 76px;
  padding: 10px 14px;
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px;
  line-height: 20px;
  resize: vertical;
}

/* 来源徽标 */
.mb-source {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 7px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}

.mb-source::before {
  content: "";
  width: 4px;
  height: 4px;
  border-radius: 999px;
  background: currentColor;
}

.mb-source--default {
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-tertiary);
}

.mb-source--project {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 15%, transparent);
  color: var(--dsw-alias-state-business-primary);
}

.mb-source--env {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 15%, transparent);
  color: var(--dsw-alias-state-warn-secondary);
}

.mb-source--row {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 15%, transparent);
  color: var(--dsw-alias-state-error-secondary);
}

/* 开关 */
.mb-switch {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  width: 40px;
  height: 24px;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3);
  cursor: pointer;
  transition: background 0.2s ease;
}

.mb-switch::after {
  content: "";
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--dsw-alias-label-tertiary);
  transition: transform 0.2s ease, background 0.2s ease;
}

.mb-switch[aria-checked="true"] {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent);
}

.mb-switch[aria-checked="true"]::after {
  transform: translateX(16px);
  background: var(--dsw-alias-label-primary-inverted);
}

.mb-switch:disabled {
  opacity: 0.45;
  cursor: default;
}

/* 分段控件 */
.mb-segmented {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
}

.mb-segmented__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 14px;
  border: 0;
  border-radius: 9px;
  background: none;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
  white-space: nowrap;
}

.mb-segmented__item:hover {
  color: var(--dsw-alias-label-primary);
}

.mb-segmented__item[aria-selected="true"] {
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}

.mb-segmented__item:disabled {
  opacity: 0.45;
  cursor: default;
}

/* 三选一卡片 */
.mb-choiceRow {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.mb-choice {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.1s ease, background 0.1s ease;
}

.mb-choice:hover {
  border-color: var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-2);
}

.mb-choice[aria-checked="true"] {
  border-color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent);
}

.mb-choice:disabled {
  opacity: 0.55;
  cursor: default;
}

.mb-choice__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mb-choice__radio {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: 1px solid var(--dsw-alias-label-caption);
  border-radius: 999px;
}

.mb-choice[aria-checked="true"] .mb-choice__radio {
  border-color: var(--dsw-alias-state-business-primary);
}

.mb-choice[aria-checked="true"] .mb-choice__radio::after {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--dsw-alias-state-business-primary);
}

.mb-choice__title {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}

.mb-choice__desc {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

/* chips（字符串数组编辑） */
.mb-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.mb-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 4px 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.mb-chip__remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 999px;
  background: none;
  color: var(--dsw-alias-label-caption);
  cursor: pointer;
}

.mb-chip__remove:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.mb-chip--add {
  padding: 0 10px;
  border-style: dashed;
  background: none;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}

.mb-chip--add:hover {
  border-color: var(--dsw-alias-border-l4);
  color: var(--dsw-alias-label-primary);
}

.mb-chip--add:disabled {
  opacity: 0.45;
  cursor: default;
}

/* 可折叠的「高级」子块 */
.mb-details {
  margin: 6px 0 0;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
}

.mb-details__summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
  list-style: none;
}

.mb-details__summary::-webkit-details-marker {
  display: none;
}

.mb-details__summary:hover {
  color: var(--dsw-alias-label-primary);
}

.mb-details__count {
  margin-left: auto;
}

.mb-details__body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 16px 16px;
}

/* 只读能力块（语义通道） */
.mb-readonly {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}

/**
 * 只读整页（「行配置」页）。
 *
 * fieldset[disabled] 会自动禁掉里面所有原生控件 —— 比逐个字段传 disabled
 * 可靠（漏一个就是一个「看起来能改、保存后静默丢弃」的入口）。
 * 代价是浏览器给 fieldset 的默认样式，这里全部归零。
 */
.mb-readonlyFieldset {
  display: contents;
  min-inline-size: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.mb-readonly__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}

.mb-readonly__glyph {
  flex: none;
  color: var(--dsw-alias-label-caption);
}

.mb-readonly__desc {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.mb-readonly__values {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 20px;
  margin: 0;
}

.mb-readonly__pair {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding-top: 6px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}

.mb-readonly__key {
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mb-readonly__value {
  flex: none;
  color: var(--dsw-alias-label-secondary);
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px;
}

/* 保存条 */
.mb-saveBar {
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
  padding: 14px 0 16px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
}

.mb-saveBar__note {
  flex: 1;
  min-width: 180px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.mb-saveBar__note b {
  color: var(--dsw-alias-label-secondary);
  font-weight: 500;
}

.mb-saveBar__note--bad b {
  color: var(--dsw-alias-state-error-secondary);
}

/* =============================== 按钮 =============================== */

.mb-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: 12px;
  background: none;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.1s ease;
}

.mb-btn--primary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-inverted);
  font-weight: 500;
}

.mb-btn--primary:hover {
  background: var(--dsw-alias-button-primary-hover);
}

.mb-btn--secondary {
  border: 0.5px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}

.mb-btn--secondary:hover {
  background: var(--dsw-alias-bg-layer-3);
}

.mb-btn--ghost {
  color: var(--dsw-alias-label-secondary);
}

.mb-btn--ghost:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.mb-btn--danger {
  color: var(--dsw-alias-state-error-secondary);
}

.mb-btn--danger:hover {
  background: var(--dsw-alias-interactive-bg-hover-danger);
}

.mb-btn--sm {
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  font-size: 12.5px;
}

.mb-btn--icon {
  width: 28px;
  padding: 0;
}

.mb-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

/* =========================== 徽标 / 状态点 =========================== */

.mb-badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}

.mb-badge--ok {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);
  color: var(--dsw-alias-state-success-secondary);
}

.mb-badge--warn {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);
  color: var(--dsw-alias-state-warn-secondary);
}

.mb-badge--error {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);
  color: var(--dsw-alias-state-error-secondary);
}

.mb-badge--info {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);
  color: var(--dsw-alias-state-business-primary);
}

.mb-badge--mono {
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
}

.mb-dot {
  display: inline-block;
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--dsw-alias-label-caption);
}

.mb-dot--ok {
  background: var(--dsw-alias-state-success-primary);
}

.mb-dot--warn {
  background: var(--dsw-alias-state-warn-primary);
}

.mb-dot--error {
  background: var(--dsw-alias-state-error-primary);
}

/* ============================== 记忆面板 ============================== */

.mb-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
}

/*
 * 作为对话区 View 标签里的一栏时。
 *
 * 设置页里内边距由 section 容器给，对话视图没有那一层 —— 而且它必须
 * **自己吃掉整个面板高度**：短内容时下面留一片空白，长内容时被裁掉，
 * 两种都不对。
 *
 * 用 flex:1 + min-height:0 而不是 height:100%：宿主的 viewArea 本身
 * 就是 flex:1 / min-height:0 的列 flex 容器，跟着它的语言写才不会在
 * 某次布局改动后失配。
 *
 * 左右 28px 对齐 viewArea 同级的头部内边距，让标题和标签落在同一条竖线上。
 */
.mb-panel--view {
  box-sizing: border-box;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 28px 40px;
}

/*
 * 滚动容器里的 flex 子项默认会「压缩到 min-content」而不是「溢出」——
 * 列表和卡片被压扁比出现滚动条更糟。flex:none 让它们保持自然高度，
 * 由容器负责滚动。
 */
.mb-panel--view > * {
  flex: none;
}

.mb-panel__head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.mb-panel__headMain {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.mb-panel__title {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  font-weight: 500;
  line-height: 22px;
}

.mb-panel__sub {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

/* 面板读的是哪个目录 —— 0 到底是「没记忆」还是「读错了地方」。 */
.mb-panel__root {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 2px 0 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 16px;
}

.mb-panel__rootPath {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-secondary);
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px;
}

.mb-panel__error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
}

/* 健康概览 */
.mb-health {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-border-l1);
}

.mb-health__cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-1);
}

.mb-health__num {
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  font-weight: 500;
  line-height: 22px;
  font-variant-numeric: tabular-nums;
}

.mb-health__num small {
  margin-left: 2px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  font-weight: 400;
}

.mb-health__label {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 16px;
}

.mb-health__cell[data-tone="warn"] .mb-health__num {
  color: var(--dsw-alias-state-warn-secondary);
}

.mb-health__cell[data-tone="error"] .mb-health__num {
  color: var(--dsw-alias-state-error-secondary);
}

.mb-healthFoot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: -8px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 16px;
}

.mb-healthFoot b {
  color: var(--dsw-alias-label-secondary);
  font-weight: 500;
}

.mb-healthFoot i {
  color: var(--dsw-alias-border-l4);
  font-style: normal;
}

/* tab */
.mb-tabs {
  display: flex;
  align-items: flex-end;
  gap: 22px;
  margin-top: 2px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}

.mb-tab {
  position: relative;
  padding: 7px 1px 9px;
  border: 0;
  background: none;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}

.mb-tab:hover,
.mb-tab[aria-selected="true"] {
  color: var(--dsw-alias-label-primary);
}

.mb-tab[aria-selected="true"]::after {
  content: "";
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--dsw-alias-label-primary);
}

.mb-tab__count {
  margin-left: 5px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* 待决提案 */
.mb-proposals {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mb-proposal {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}

.mb-proposal:hover {
  border-color: var(--dsw-alias-border-l3);
}

.mb-proposal[data-open="true"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 30%, transparent);
}

.mb-proposal__top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.mb-proposal__title {
  flex: 1;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}

.mb-proposal__conf {
  flex: none;
  color: var(--dsw-alias-label-secondary);
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.mb-proposal__reason {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.mb-proposal__reason code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--dsw-alias-markdown-code-block);
  color: var(--dsw-alias-label-secondary);
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px;
}

.mb-proposal__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.mb-proposal__meta {
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}

.mb-proposal__editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 空态 */
.mb-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 36px 16px;
  border: 0.5px dashed var(--dsw-alias-border-l3);
  border-radius: 12px;
  text-align: center;
}

.mb-empty__title {
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}

.mb-empty__desc {
  max-width: 380px;
  margin: 0;
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  line-height: 18px;
}

/* 提示条 */
.mb-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.mb-note__glyph {
  flex: none;
  margin-top: 1px;
  color: var(--dsw-alias-state-warn-secondary);
}

.mb-note--error {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
}

.mb-note--error .mb-note__glyph {
  color: var(--dsw-alias-state-error-secondary);
}

.mb-caption {
  margin: 0;
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  line-height: 18px;
}

.mb-link {
  border: 0;
  background: none;
  color: var(--dsw-alias-state-business-primary);
  font: inherit;
  cursor: pointer;
}

.mb-link:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}

/* 记忆列表 */
.mb-search {
  display: flex;
  gap: 8px;
}

.mb-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.mb-list__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}

.mb-list__main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.mb-list__title {
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mb-list__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 16px;
}

.mb-list__end {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
}

/* ============================ 项目配置抽屉 ============================ */

.mb-scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: var(--dsw-alias-bg-mask-2);
}

.mb-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 61;
  display: flex;
  flex-direction: column;
  width: 440px;
  max-width: calc(100vw - 24px);
  border-left: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
  box-shadow: -18px 0 48px -18px var(--dsw-alias-bg-mask-2);
}

.mb-drawer__head {
  display: flex;
  flex: none;
  align-items: flex-start;
  gap: 12px;
  padding: 22px 20px 16px 22px;
}

.mb-drawer__headMain {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.mb-drawer__title {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
  line-height: 22px;
}

.mb-drawer__sub {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.mb-drawer__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  padding: 0 22px 18px;
  overflow-y: auto;
}

.mb-drawer__foot {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 14px 22px 18px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
}

.mb-drawer__footNote {
  flex: 1;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.mb-inherit {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}

.mb-inherit__title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
}

.mb-inherit__list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.mb-inherit__list li {
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-tertiary);
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px;
}

/* ============================== 工具类 ============================== */

.mb-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.mb-mono {
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px;
}

.mb-muted {
  color: var(--dsw-alias-label-tertiary);
}
`
