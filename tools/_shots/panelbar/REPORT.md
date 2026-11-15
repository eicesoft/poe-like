# QA 验收报告 · ESC 暂停 / 底部面板按钮 / 属性面板（最终版）

> qa-verifier · 最终版 2026-11-14 20:30 · 源码快照（复跑时刻）：`src/ui/{main,ui,pause,panel-bar,stats-ui}.js` + `src/ui/style.css`，测试文件含 lead 对 `tests/pause.test.mjs` 音效用例的加固
>
> **终验数字（最后一次，20:10–20:29）**
> - `node tests/run-all.mjs` ×3（间隔 12s）→ **379 / 379 通过 ×3**（5.94s / 6.11s / 6.43s，0 失败）
> - `node tools/build.mjs` → 51 模块 / **bundle 1032 KB** / **单文件 1144 KB**
> - `node tools/check-standalone.mjs` → **页面错误 0，冒烟通过**
> - `node tools/interaction-check.mjs` → **17 / 17**
> - `_static-qa.mjs` 12/12 · `_count-bars.mjs` 1/1/1/1 · `_keymap-probe.mjs` 5/5 · `_geom-check.mjs` 双视口 PASS
> **一句话结论**：三件事的**逻辑/状态机/DOM 结构/布局几何**均已自动化验证 **PASS**；发现的 1 个 bug + 3 个风险 **已修复并复测通过**；**浏览器真机点按仍 BLOCKED**（DSH 沙箱拦截 Chromium 命名管道），替代证据见第 5 节。

---

## 0. 结论总表（按 lead 要求分三类）

### A. 自动化可验证项 —— 全部 PASS

| # | 验证项 | 证据（命令 / 产物） | 结果 |
|---|---|---|---|
| A1 | ESC 暂停 → 覆盖层显示 + `game.paused===true` | `_static-qa.mjs` S4 · `tools/interaction-check.mjs` | **PASS**（`game.paused=true`、`pauseMenu.isOpen=true`、`#pause-menu.show`） |
| A2 | ESC 再按 → 恢复（`game.paused===false`） | `_static-qa.mjs` S4 · `interaction-check.mjs` | **PASS** |
| A3 | 有面板时 ESC 只关面板、仍暂停 | `_static-qa.mjs` S4 / S5 · `interaction-check.mjs` | **PASS** |
| A4 | 暂停中点击「属性」→ 面板打开且仍暂停（`pauseReason=panel`、卡片让位） | `_static-qa.mjs` S4b · `interaction-check.mjs` | **PASS** |
| A5 | 底部 4 按钮逐个开/关 + `#modal` 可见 + `#modal-title` + `.active` | `_static-qa.mjs` S2/S3 · `interaction-check.mjs` | **PASS**（属性面板 / 天赋树 / 技能 · 天赋分叉 / 背包 · 装备） |
| A6 | 暂停 3 秒：`world.time` / 怪物坐标 / 冷却 逐位不变 | `interaction-check.mjs` ⑥（lead 编写） | **PASS**（`world.time` 保持 `1.000`，2 只怪物逐位一致） |
| A7 | 暂停中游戏键被吞（W/数字/空格）、ESC 仍有通道 | `_static-qa.mjs` S5 · `_keymap-probe.mjs` K2–K4 | **PASS** |
| A8 | 面板打开时 C/P/K/E/Tab 仍有效 | `_keymap-probe.mjs` K1 · `tests/input-session.test.mjs`（`快捷键分流回归`） | **PASS** |
| A9 | 20 轮暂停/面板开关后 `#pause-menu` / `#panel-bar` 各 1 个、无重复 id | `_static-qa.mjs` S6 · `_count-bars.mjs` · `interaction-check.mjs` ⑦ | **PASS** |
| A10 | 重复构造 `GameUI`（4 个实例 / 面板开 / 暂停中）不产生第二列按钮 | `_count-bars.mjs` → `1/1/1/1` | **PASS** |
| A11 | 暂停菜单 8 个动作齐全 | `_static-qa.mjs` S7 | **PASS** |
| A12 | 属性面板有内容 | `_static-qa.mjs` S8（28 节点 / 12129 字） | **PASS** |
| A13 | **布局几何**：1280×720 与 1920×1080 下 6 个 HUD 元素两两 0 重叠、全部在视口内 | `_geom-check.mjs`（直接解析 style.css）→ `geom-1280.json` / `geom-1920.json` | **PASS**（`conflicts: []`、`outOfView: []`） |
| A14 | **暂停态可见性**：`#app.paused #hud` 隐藏，但 `#panel-bar` / `.sfx-toggle` 例外可见（暂停时可点） | `_geom-check.mjs` 新增 `pausedVisibility` | **PASS**（4/4 条规则命中） |
| A15 | 测试 / 构建 / 单文件冒烟 | 见 §4 | **PASS**（378/378 ×2、build、standalone 0 error） |

### B. 桩局限（已修，**非产品缺陷**）

| 原 FAIL | 根因（我的 DOM 桩） | 修正 | 现状 |
|---|---|---|---|
| S2 `#panel-bar` 建不出来 | `document.querySelector` 只扫 `#body`，而 `#app` 未挂到 body；缺 `document.createElementNS`（SVG） | 同时扫 `body` 与 `app`；补 `createElementNS` | **PASS** |
| S3 点按钮抛异常 | 模块里裸写 `requestAnimationFrame(...)`（`talent-ui.js:222`）而桩只给了 `window.requestAnimationFrame`；假 `inv` 字段名错（应为 `equip/bag/bagSize`，见 `inventory-ui.js:27`） | 补全局 rAF（异步派发）；按真实字段造 `inv` | **PASS** |
| S5 暂停键"没被吞" | 前一用例用"按两次 ESC"收尾，实际没解除暂停 | 收尾改 `togglePause(false)` | **PASS** |
| S8 属性面板 body 为空 | `stats-ui.js` 用真实 DOM（`innerHTML=''` + appendChild），桩里 `innerHTML` 只是字符串、`textContent` 不聚合子节点 | 读聚合 `textContent` + 子节点数 | **PASS** |
| S7 暂停按钮数 0 | 桩 `querySelectorAll` 不支持后代选择器 | 双通道：`ACTIONS` 表 + 可达节点数，并标注"DON 渲染需真机确认" | **PASS** |

> 结论：这 5 项**不是产品缺陷**，已全部转绿；`_static-qa.mjs` 现为 **12/12 PASS（exit 0）**。

### C. 真机 BLOCKED（执行环境限制）

| 项 | 状态 | 证据 |
|---|---|---|
| 浏览器端真机点按/截图 | **BLOCKED** | [ENV-PROBE.md](./ENV-PROBE.md)：Chrome 157 / Edge 157 / WebView2 / Tabbit 全部 `FATAL mojo\public\cpp\platform\platform_channel.cc:112 Check failed: 拒绝访问。(0x5)`，退出码 `0x80000005 / 0xC0000005 / 13`；15 种绕行全部无效 |

未验证项清单见 §6。

---

## 1. 上一轮发现的缺陷：**已修复并复测 PASS**

| 编号 | 问题 | 修复位置 | 我的复测证据 |
|---|---|---|---|
| **G1** | 第二个 `GameUI` 实例会再造 `#panel-bar`（页面 2 个重复 id、两列按钮叠加） | `panel-bar.js` `ensure()` 改为「先查 DOM → 接管已有节点」（`_findExisting()` / `_adopt()`） | `_count-bars.mjs`：**修复前** `afterSecondUI: 2`；**修复后** `afterFirstUI/SecondUI/ThirdWithPanelOpen/FourthWhilePaused = 1/1/1/1`，`pause-menu=1`，exit 0 |
| **风险 A** | `runHotkey` 里 `isInputBlocked()` 排在 `spec.panel` 之前 → 面板打开时 C/P/K/E/Tab 被吞 | `main.js`：`spec.panel` 提前到 `isInputBlocked()` 之前 | `_keymap-probe.mjs` K1 PASS（`spec.panel` 第 690 行 < `isInputBlocked` 第 692 行）；`tests/input-session.test.mjs` 的 `快捷键分流回归` BUG1 用例 |
| **风险 B** | 暂停分支不调用 `readInput`，ESC 只进 `_pendingHotkeys` → 暂停后出不来 | `main.js`：新增 `handlePausedKey()`（ESC→`escapeRoute()`，其余→`ui.handlePauseKey`），捕获层暂停时同步执行 | `_keymap-probe.mjs` K2/K3/K4 PASS（`handlePausedKey` 第 720 行、调用点第 764 行）；`interaction-check.mjs` ESC 两级退出用例 |
| **设计点** | 按钮列原本是右侧竖排，需求是"屏幕底部一排" | `style.css` 改为 `left:14; bottom:19; flex-row; 44×44; gap 8; padding 4` | `_geom-check.mjs`：`#panel-bar` x[14,224] y[647,701]（1280）/ y[1007,1061]（1920），与技能栏/日志/掉落/静音键 0 重叠 |
| **暂停时看不见按钮列**（我上一轮提出的） | `#app.paused #hud{opacity:0}` 会连带隐藏按钮列 | Lead 新增 `#app.paused #panel-bar, #app.paused .sfx-toggle { opacity:1; visibility:visible }` | `_geom-check.mjs` `pausedVisibility` 4/4 命中 → **暂停时按钮列可见可点**（"暂停中点击属性"现在是真实可达路径） |
| **`#help-hint` 压技能栏 2px**（我上一轮提出的） | `bottom:6` + nowrap，文字宽 ~911px 横跨技能栏下沿 | Lead 改为 `bottom:2px; max-width:min(720px,46vw); ellipsis; 10.5px` | `_geom-check.mjs`：hint y[704,718] vs 技能栏 y[634,702] → **0 重叠**（修复前 `overlap=852px²`） |

---

## 2. 布局几何（直接解析 `src/ui/style.css`，双视口）

命令：`node tools/_shots/panelbar/_geom-check.mjs 1280 720`（1920 同）→ `geom-1280.json` / `geom-1920.json`，exit 0。

### 1280×720

| 元素 | CSS 规则 | 包围盒 |
|---|---|---|
| `#panel-bar` | `left:14; bottom:19; flex-row; gap 8; pad 4; 44×44; border 1` | **x[14,224] y[647,701]**（210×54） |
| `#skillbar` | `bottom:18; left:50%; pad 7/9; gap 7; 7×52` | x[427,853] y[634,702] |
| `#log`（7 行满） | `left:14; bottom:92; width:300` | x[14,314] y[466,628] |
| `#loot-bar`（6 条满） | `right:14; bottom:96; max-width:340` | x[926,1266] y[483,624] |
| `.sfx-toggle` | `right:14; bottom:20; 34×34` | x[1232,1266] y[666,700] |
| `#help-hint` | `bottom:2; max-width:min(720,46vw)` | x[405,875] y[704,718] |

### 1920×1080

`#panel-bar` x[14,224] y[**1007**,1061] · `#skillbar` x[747,1173] y[994,1062] · `#log` x[14,314] y[826,988] · `#loot-bar` x[1566,1906] y[843,984] · `.sfx-toggle` x[1872,1906] y[1026,1060]

**结论**：两档视口下 6 个元素两两 `conflicts: []`、`outOfView: []`；按钮列与技能栏水平最近 -203px（1280）/ -523px（1920），与日志竖向留 19px。

---

## 3. 合成图视觉核对（⚠ **合成图，非真机截图**）

| 来源 | 文件 | 说明 |
|---|---|---|
| Lead 已重画的最终版 | [tools/_shots/hud/panelbar.png](../hud/panelbar.png) · [tools/_shots/hud/pause.png](../hud/pause.png)（1280×720） | `node tools/hud-preview.mjs`：真实 Renderer 地牢 + 按 CSS 手绘 HUD |
| 我按 CSS 换算的双视口副本（未改原脚本） | [hud-1280/panelbar.png](./hud-1280/panelbar.png) · [hud-1280/pause.png](./hud-1280/pause.png) · [hud-1920/panelbar.png](./hud-1920/panelbar.png) · [hud-1920/pause.png](./hud-1920/pause.png) | `node tools/_shots/panelbar/_make-hud.mjs` 生成 |

我做过的一致性改写（仅副本）：地图卡居中（`#topbar` flex）、属性卡贴右（`margin-left:auto`）、掉落条 `right14/bottom96`、静音键 `right14/bottom20`、面板按钮列按 CSS 最终形态（左下横排 44×44）、**暂停卡片按钮文案取自 `src/ui/pause.js` 的 `ACTIONS`（8 个：继续游戏/属性/天赋/技能/装备/音效/保存游戏/返回主菜单，最后一个 danger 红）**。

合成图能说明的：元素之间的**相对位置与包围盒**与 `_geom-check` 数值一致；按钮列不与技能栏/日志/掉落/静音键相撞；暂停卡片居中且四周无遮挡。
合成图**不能**说明的（必须真机）：字体渲染、阴影/发光、SVG 图标、badge 外溢、`#stats-panel` 的真实高度（由 JS 内容决定，预览里写死 314px）、动画过渡。

---

## 4. 回归记录（复跑时刻）

| 命令 | 结果 |
|---|---|
| `node tests/run-all.mjs` 历史：19:59–20:04 连跑 8 次 → 早先的波动（见下） | 7 绿 / 1 次间歇 → **已修复** |
| `node tests/run-all.mjs` **终验 ×3**（20:10–20:29，间隔 12s） | **379 / 379 · 379 / 379 · 379 / 379**（5.94s / 6.11s / 6.43s）✅ |
| `node tools/build.mjs` | 51 模块 / **bundle 1032 KB** / 单文件 **1144 KB** ✅ |
| `node tools/check-standalone.mjs` | 页面错误数 **0**，冒烟通过 ✅ |
| `node tools/interaction-check.mjs`（Lead 编写，更真实 DOM 桩） | **17 / 17 通过** ✅ |
| `node tools/_shots/panelbar/_static-qa.mjs` | **12 / 12 PASS**（exit 0）→ [static-qa.json](./static-qa.json) / [_static-qa.log](./_static-qa.log) |
| `node tools/_shots/panelbar/_count-bars.mjs` | `1/1/1/1`、`pause-menu=1`（exit 0） |
| `node tools/_shots/panelbar/_keymap-probe.mjs` | **5 / 5 PASS** |
| `node tools/_shots/panelbar/_geom-check.mjs 1280 720` / `1920 1080` | 两者 **PASS**（exit 0） |
| `node tools/hud-preview.mjs` | 生成 1280×720 合成图 OK |

> 期间的历史噪声（已收口，不再出现）：19:24 与 19:41–19:47 的红色来自队友并发写 `main.js` / `talentTree.js`（含 `TRUNC_NAMES is not defined` 中间态），均由 Lead 还原；本次 8 连跑中 7 次全绿。
>
> **曾经的 1 次间歇失败 —— 已修复并复测通过**：早先 run3（19:59–20:04 那一轮）出现过
> `[暂停菜单] 音效按钮：静音后 .off / 🔇 / 文案切换，再点恢复（回归：曾读不存在的 ui._muted）`。
> 根因：`src/ui/pause.js:546` 在 `GameUI.isSfxMuted` 缺席时回退到**模块级静态 `isMuted()`**（`src/ui/sfx.js` 的全局静音状态），被前面用例翻转后未复位 → 用例间共享全局状态。
> **修复**（lead，只改测试文件）：`tests/pause.test.mjs` 的该用例改为**注入钩子 + 收尾还原** —— 用例内 `ui.isSfxMuted = () => muted`、`ui.toggleSfx = () => (muted = !muted)` 把起点钉在"未静音"，`finally` 里比对进入前真实的 `sfxMod.isMuted()`，被别的用例翻转就 `toggleMute()` 还原。
> **证据**：lead 本地 6 连跑全绿；**我的终验 3 连跑（20:10–20:29，间隔 12s）全部 379/379 0 失败**；`src/` 未因此改动（`pause.js:546` 的回退链保持不变，仍兼容真实浏览器里"静态 `isMuted()` 是唯一真相"的语义）。
> 日志：[_final-run1.log](./_final-run1.log) · [_final-run2.log](./_final-run2.log) · [_final-run3.log](./_final-run3.log)；更早的 8 连跑日志：[_tests-run1.log](./_tests-run1.log) … [_tests-run8.log](./_tests-run8.log)。

---

## 5. 给最终汇报的"三重替代"证据对照

Lead 拟用的表述：**"浏览器端真机点按未验证（沙箱拦截 Chromium），已用 CDP 直连脚本 + 更真实 DOM 桩 + 合成预览三重替代"** —— 对应证据：

1. **CDP 直连脚本**：[tools/qa-shots.mjs](../../qa-shots.mjs) —— 真实 Chrome 通过 DevTools 协议驱动（`Runtime.evaluate` / `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent` / `Page.captureScreenshot`），覆盖 A↔I 全清单 + 双视口；**连不上 DevTools 时 ENV 项记 BLOCKED、退出码 5，不假绿**。沙箱外补跑命令见 [ENV-PROBE.md](./ENV-PROBE.md) §补跑。
2. **更真实 DOM 桩**：
   - Lead 的 [tools/interaction-check.mjs](../../interaction-check.mjs)（appendChild 真挂父节点、querySelector 真查子树、classList 真生效、click 真派发）→ **17/17**
   - 我的 `_static-qa.mjs`（真实 `src` 模块 + 可查询 DOM 桩）→ **12/12**
   - `_keymap-probe.mjs` → **5/5**；`_count-bars.mjs` → 唯一性 1/1
3. **合成预览**：`tools/_shots/hud/{panelbar,pause}.png`（Lead）+ `tools/_shots/panelbar/hud-{1280,1920}/{panelbar,pause}.png`（QA 双视口副本）+ `_geom-check.mjs` 的包围盒数值（**直接解析 style.css**，不靠目测）。

---

## 6. 仍未验证（只有真机才能给定论）

1. 真机**鼠标点击**底部 4 按钮（A5 是 DOM 事件派发，不是真实指针命中）
2. 键盘真实事件链路：K/P/C/E/Tab 的 `defaultPrevented`、焦点不跳走
3. 暂停 3 秒的**画面**静止（逻辑已逐位验证，渲染层效果未验）
4. 暂停覆盖层的视觉品质（去饱和、暗角、金边）
5. WASD 移动回归（暂停恢复后）
6. `pageerror / console.error = 0`（真机运行时）
7. 字体渲染 / 文字截断 / `#stats-panel` 真实高度 / badge 外溢的像素级观感

---

## 7. 产物索引

| 文件 | 说明 |
|---|---|
| [tools/qa-shots.mjs](../../qa-shots.mjs) | 真机验收主脚本（CDP 直连，连不上即 BLOCKED） |
| [ENV-PROBE.md](./ENV-PROBE.md) | 浏览器启动阻塞证据 + 15 种绕行 + 沙箱外补跑命令 |
| [static-qa.json](./static-qa.json) · [_static-qa.log](./_static-qa.log) · [_static-qa.mjs](./_static-qa.mjs) | 状态机复核 12 项 |
| [_keymap-probe.mjs](./_keymap-probe.mjs) | 键盘路由复核 5 项 |
| [_count-bars.mjs](./_count-bars.mjs) | 重复 DOM 复核（4 实例） |
| [_geom-check.mjs](./_geom-check.mjs) · [geom-1280.json](./geom-1280.json) · [geom-1920.json](./geom-1920.json) | 布局几何 + 暂停态可见性 |
| [_make-hud.mjs](./_make-hud.mjs) · [_hud-1280.mjs](./_hud-1280.mjs) · [_hud-1920.mjs](./_hud-1920.mjs) | 双视口合成图生成器（不改 `tools/hud-preview.mjs`） |
| [hud-1280/](./hud-1280) · [hud-1920/](./hud-1920) | 合成图（**非真机**） |
| [_hint-width.mjs](./_hint-width.mjs) | `#help-hint` 宽度估算（用于复测"压技能栏"问题） |
| [_attempt.mjs](./_attempt.mjs) · [_browser-probe.mjs](./_browser-probe.mjs) · [launch-plan.json](./launch-plan.json) | 浏览器启动能力探针 |