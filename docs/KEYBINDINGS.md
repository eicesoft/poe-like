# 键位调整：方向键移动 · Q W E R T 放技能

> 需求：**方向键上下左右移动，Q/W/E/R 等键释放技能。**

## 1. 新的键位表

| 格子 | 键 | 技能 |
| --- | --- | --- |
| 1 | **Q** | 战争践踏（范围眩晕 + 按命中数加护甲） |
| 2 | **W** | 旋风斩（按住持续旋转） |
| 3 | **E** | 战吼 |
| 4 | **R** | 血性狂暴 |
| 5 | **T** | 坚毅图腾 |
| 翻滚 | **空格** | 翻滚（0.18 秒无敌） |
| 回城 | 点 **🏕** 格子 | 下一层 |

移动：**↑ ↓ ← →** 为主。A / S / D 仍然可以移动；**W 让给了 2 号技能**。

## 2. 键位表的唯一真相

`src/game/input.js`：

```js
export const SKILL_KEYS = Object.freeze([
  Object.freeze({ idx: 0, code: 'KeyQ', key: 'q', label: 'Q' }),
  Object.freeze({ idx: 1, code: 'KeyW', key: 'w', label: 'W' }),
  Object.freeze({ idx: 2, code: 'KeyE', key: 'e', label: 'E' }),
  Object.freeze({ idx: 3, code: 'KeyR', key: 'r', label: 'R' }),
  Object.freeze({ idx: 4, code: 'KeyT', key: 't', label: 'T' }),
]);
```

- `src/ui/ui.js` 的 `syncSkillSlotLabels()`（实现在 `src/ui/dom.js`）把 HUD 技能栏角标**按这张表**写成 Q/W/E/R/T；
- `src/ui/main.js` 的 `readInput()` 按这张表读 `input.keys` 施法；
- `tests/input-chain.test.mjs` 有一条守护测试，逐个字段比对 `main.js` 里的那份常量与 `input.js` 的导出一致
  （`main.js` 会被 pause / input-session 测试剥掉 import 后在 vm 沙箱里直跑，所以键表在文件内也留了一份）。

改键位 = 改这张表（两处常量与 `index.html` 的角标初值），测试会告诉你有没有漏改。

## 3. 「一个键两种身份」的仲裁规则

`src/ui/main.js` 里三条规则，按顺序判定：

| 函数 | 规则 |
| --- | --- |
| `isSkillSlotKey(code)` | Q/W/E/R/T 中，**该格有技能**就是技能键；空格永远是技能键（翻滚） |
| `isMoveKey(code)` | 方向键永远是移动键；W/A/S/D **只有在该键不是技能槽时**才是移动键 |
| `legacyHotkey(code)` | E 背包 / R 拾取 / T 回城：**仅当该键不是技能槽**时才退回老快捷键 |

所以：

- 默认满技能栏 → Q W E R T 全是技能键，E/R/T 不会误开背包 / 误拾取 / 误换图；
- 若把 2 号格子清空 → **W 自动退回"向上移动"**，不用改代码；
- 清空 3 号格子 → E 退回背包；清空 4 号 → R 退回拾取；清空 5 号 → T 退回回城；
- **F** 是新增的拾取键，永远不占技能键。

`playerMoveDir()` 是 `readInput` 实际用的移动向量（方向键 + 非技能槽的 WASD，已归一化）。
`Input.moveDir()` 保留原语义（WASD/方向键都算移动），不参与仲裁——仲裁只发生在入口层，
这样 core 与测试工具不会被 UI 的键位策略污染。

## 4. 事件路由（为什么不会双触发）

`window` 捕获阶段的 `handleKeydown()` 现在分四路：

1. **暂停中** → `handlePausedKey()`（ESC 同步走 `escapeRoute()`，其余交给暂停菜单/面板）；
2. **ESC** → 入队，由 `readInput` 统一消费（正常游戏时）；
3. **技能键 / 移动键** → 只 `preventDefault`（防方向键滚动页面），**不入队**；
   技能由 `readInput` 每帧读 `input.keys` 施放，按住即持续（与右键旋风斩同一条 tryCast 链路）；
4. **其它快捷键**（C/P/K/I/M/F/Tab/老快捷键）→ 入队，`readInput` 每帧执行一次。

老版本的一个隐患：如果把 Q/W/E/R/T 也写成普通快捷键，一次按键会由「捕获层执行」和「readInput 读 keys」
各放一次（技能进冷却又立刻被按住重放），所以技能键**刻意不进** `HOTKEYS` 队列。

## 5. 改动的文件

| 文件 | 改动 |
| --- | --- |
| `src/game/input.js` | 新增 `SKILL_KEYS` / `SKILL_KEY_TO_INDEX` / `DIGIT_ALIAS` / `skillKeyCode()`；`moveDir()` 注释更新 |
| `src/ui/main.js` | `isSkillSlotKey` / `isMoveKey` / `keyRole` / `legacyHotkey` / `playerMoveDir`；`readInput` 按 QWERT 读技能；`handleKeydown` 四路分流；`__dbg.keyRole()` / `__dbg.skillKeys()` / `__dbg.moveDir()`；开场日志与新提示 |
| `src/ui/ui.js` | 技能栏角标 = 键位表（`syncSkillSlotLabels`），暂停态按键吞并规则加入 Q/R/T/F |
| `src/ui/dom.js` | 新增 `syncSkillSlotLabels()`（浏览器 + 简化 DOM 桩都能写对 .key） |
| `index.html` | 技能栏角标改成 Q W E R T / 空格 / 🏕；`#help-hint` 与开始界面说明按新键位 |
| `tools/hud-preview.mjs` | 预览图技能栏改成 Q W E R T / SPC；顺手修好了预览器的 3 个渲染 bug（见下） |
| `tools/input-check.mjs` | 增加方向键四向、W 不移动、Q~T 逐个施法、数字键别名、面板守卫时 Q 不放技能 |
| `tools/skill-slot-check.mjs` | 增加角标断言：Q W E R T / 空格，且与 `SKILL_KEYS` 一致、键表已冻结 |
| `tests/input-chain.test.mjs` | `buildInput` 镜像新键位；新增 QWERT / 方向键 / W 仲裁用例；新增「两份键表必须一致」守护 |
| `tests/input-session.test.mjs` | 面板快捷键回归里 E 改成 F（E 现在是技能键）；新增 `keyRole` 仲裁与「方向键 → move 向量」用例 |

## 6. 验证

```
node tests/run-all.mjs              # 406 / 406
node tools/input-check.mjs          # 29 / 29（含方向键移动、Q~T 施法）
node tools/skill-slot-check.mjs     # 18 / 18（含 HUD 角标 Q W E R T）
node tools/build.mjs                # 重新打包 index-standalone.html
node tools/standalone-input-check.mjs   # 18 / 18（单文件版真键盘）
node tools/check-standalone.mjs     # 单文件版冒烟通过
node tools/interaction-check.mjs    # 17 / 17（ESC / 面板状态机）
```

`tools/_shots/hud/panelbar.png` 是按 `style.css` 尺寸合成的 HUD 预览，技能栏现在显示 **Q W E R T · SPC**。

> 预览器（`tools/hud-preview.mjs`）顺带修好的 3 个 bug（之前一直存在，只是没人细看预览图里的文字）：
> 1. 字形判断写成了 `'#'`，而 `FONT` 用 `'0'/'1'` 表示像素 → **所有 HUD 文字都没画出来**；
> 2. `_blend` 里 `Uint8Array` 按 ToUint8 取模：亮色叠算得 255.8 → 变成 0，亮字直接消失；
> 3. `alpha=0` 时浮点运算得到 NaN，写进 `Uint8Array` 变成 0，会把已画好的像素抹黑。

## 7. 已知取舍

- **W 不再用于向上移动**（它是 2 号技能）。这是"QWER 放技能"与"WASD 移动"争夺 W 的必然结果；
  方向键（↑）是主要的上行操作。若某个技能格被清空，W 会自动恢复成移动键。
- 手机/触屏没有键盘：技能栏按钮点击、点方向？——本次未做虚拟摇杆，仍以键鼠为准。