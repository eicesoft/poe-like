# 修复：技能释放按钮 / 移动按钮不能工作

## 一、真正的原因（第二次修复）

上一轮我改的是「按钮没绑 click」，那确实是个缺陷，但**不是**你遇到的"没法操作游戏"的原因。

这一轮我把单文件版真正跑起来（补了一个能派发键盘/鼠标事件的 DOM 桩），复现出的现象是：

```
按 D 30 帧后位移 = 0.000 | keys = KeyD      ← 按键被记录了
world.time = 0.42                            ← 世界在正常推进
player.moveX = 0 | vx = 0                    ← 但输入没有传到玩家身上
```

继续往里打点，定位到 `readInput()` 内部：

```
{ same: false,                                    ← 局部 input 不是 window.input
  localIsNull: true,                              ← ★ 局部 input 是 null
  winKeys: "KeyD",                                ← 全局那份才是真的 Input
  winCtor: "Input" }
```

**根因：`src/ui/main.js` 里 `input` 这个局部变量从来没有被赋值。**

```js
var input = null;                                // 第 40 行：声明
...
setState('input', new Input(canvas));            // 只写进 globalThis，没有写局部变量
```

而 `readInput()` 读的是**局部**变量：

```js
if (!input || typeof input.moveDir !== 'function') {
  return { move: { x: 0, z: 0 }, ... };          // ← 每一帧都走这里
}
```

于是每一帧都返回"没有任何输入"：**移动、普攻、技能、翻滚全部失效**，
但因为这是刻意写的防御性降级分支，**不报任何错、控制台干干净净**。
冷却条照样在走（那是 `tickSkills` 在推进），所以看起来像"游戏活着但不听话"。

单文件版和 `npm run dev` 的浏览器版**都会中招**。

### 为什么之前 397 个测试没抓到

`tools/check-standalone.mjs` 的 DOM 桩是 `addEventListener() {}` —— **空实现**，
它验证的只是"能启动不报错"，从来没有真的按下过一个键。
而所有 UI 测试都直接 `new GameUI(game)`，绕过了 `startGame()` 里这段接线。

## 二、这一轮改了什么

### 1) 根因修复（`src/ui/main.js`）

```js
setState('input', new Input(canvas));
input = getState('input');   // ← 回写到局部变量（readInput/frame 真正读的那份）
```

同时把 `setState` 改成**先写模块内、再写全局**，`getState` 改成局部优先，
让"写进去一定能读回来"这件事不再依赖调用方记得手动回写。

### 2) 修正一条错误的守护测试

`tests/input-session.test.mjs` 原本禁止对 `input` 裸赋值，理由是
"单文件包里会 ReferenceError"。实测**不成立**（`var input` 已声明，vm 里赋值正常），
而且正是这条限制逼出了上面那个 bug。现在改成断言真正的不变量：

```js
assert.ok(/^\s*input\s*=\s*getState\('input'\)/m.test(src),
  'input 必须显式回写，否则 readInput 永远读到 null');
```

### 3) 新增 `tools/standalone-input-check.mjs`（18 项）

在真正的单文件 bundle 上**真的派发**键盘/鼠标事件，验证：

| 检查 | 结果 |
| --- | --- |
| 点「进入神庙」后游戏启动 | ✓ |
| 按 D → moveDir (1,0) → 位移 2.48 | ✓ |
| 松开 D → 停下 | ✓ |
| 按 1 → stomp 进冷却 6.78s | ✓ |
| 7 个技能格都绑定了 click（1,1,1,1,1,1,1） | ✓ |
| 点第 3 格 → warcry 进冷却 7.75s | ✓ |
| 点「空格」格 → 翻滚冷却 0.97s | ✓ |
| mousemove / 左键按下松开 | ✓ |
| 按 I 开背包、ESC 关、仍可移动 | ✓ |
| 页面错误数 0 | ✓ |

这个脚本已接进 `npm run verify`。

## 三、验证结果

```
tests/run-all.mjs                  397 项，通过 397，失败 0
tools/standalone-input-check.mjs   通过 18，失败 0     ← 新增，跑的是真 bundle + 真事件
tools/input-check.mjs              通过 17，失败 0
tools/skill-slot-check.mjs         通过 12，失败 0
tools/check-standalone.mjs         页面错误数 0 · 冒烟通过
```

`index-standalone.html` 已重新构建。

## 四、上一轮改动仍然有效（保留）

这些是真实缺陷，只是不是"没法操作"的主因：

1. 技能栏 7 个格子补上了 click（点技能图标 = 按对应数字键，走同一条 `tryCast` 链路）
2. `#modal` 全屏遮罩加了 `pointer-events` 防护，避免将来盖住 HUD
3. `Input` 的 `keyup` 不再被焦点守卫拦截（防止幽灵按键让角色"自己一直走"）

## 五、你需要做的

**请刷新页面 / 重新打开 `index-standalone.html`**（旧文件已被覆盖，浏览器可能拿的是缓存，
建议按 `Ctrl+F5` 强制刷新）。

然后在浏览器控制台（F12）跑这一行，可以立刻确认输入是否真的接通：

```js
window.__dbg.stats()
```

看两个字段：
- `player.walking` —— 按住 WASD 时应该是 `true`
- `gameKeys` —— 正常游戏时应该是 `true`

如果还是不行，跑一下这个并把输出贴给我：

```js
const g = window.__poeMain;
({ game: !!g.game, ui: !!g.ui, input: !!g.input,
   sameInput: g.input === window.input,
   keys: g.input ? [...g.input.keys] : null,
   paused: g.ui && g.ui.isPaused(), modal: g.ui && g.ui.modalOpen })
```

—— 上一轮我因为本机沙箱起不了浏览器，只能靠推断，结果漏掉了真正的根因。
这次只要有这个输出，就能直接定位到底哪一环断了。