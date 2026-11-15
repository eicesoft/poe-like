# 技能升级 / 天赋分叉 / 战争践踏 —— 共享契约（v1）

> 这是本次功能所有并行工作的**唯一真相来源**。任何一方实现时若与本文件冲突，以本文件为准；
> 若发现契约本身有问题，**先告诉 Lead**，不要单方面改字段名。
> 契约里的字段名一旦落地，其它模块会直接读，改名 = 破坏。

---

## 0. 本次需求 → 设计要点

用户需求（原话）：

> 技能增加功能提醒，增加技能升级机制。每个技能都有分叉的天赋升级路线，其他的你发挥，
> 战士的第一个技能改为战争践踏，眩晕技能。根据影响的用户提高护甲，持续一段时间

落地为 5 件事：

1. **1 号技能是「战争践踏」**（`stomp`）：范围眩晕；按**命中的敌人数**给自己加护甲，持续一段时间。
2. **技能升级机制**：每个技能带「技能等级」（用**技能精炼石**升级，等级 1→5）。等级提升：伤害倍率、冷却、范围、以及关键机制的数值/时长。
   **技能等级 = 天赋节点的投入点数 + 精炼石等级 − 1**（两者叠加，互相放大）。
3. **分叉天赋路线**：每个技能的天赋树改成「起点 → 左支 / 右支（互斥）→ 各一支线 → 分支专精」。
   **互斥组**由数据定义（`group` 字段），一旦在某个互斥组里选了节点，就锁死同组其它节点（可消耗精炼石「遗忘/重置」来改派）。
4. **功能提醒**：① 有可用技能点时技能栏出现**光点角标**；② 升级/精炼成功有**横幅 + 音效 + 光点**；③ 技能面板首次打开的**新手引导**；④ 事件日志里的一行提示（带图标）。
5. **视觉**：践踏冲击波、眩晕星星、护甲辉光、升星闪光。

战士初始 5 技能：`stomp` 战争践踏 / `whirlwind` 旋风斩 / `warcry` 战吼 / `bloodRage` 血性狂暴 / `rally` 坚毅图腾。
原来的「裂地斩 groundSlam」整体被「战争践踏 stomp」取代（id、名称、图标、天赋树、渲染都换）。

---

## 1. 模块分工与文件归属（写作用域，勿越界）

| 代号 | 负责人 | 可写文件 | 任务 |
| --- | --- | --- | --- |
| A | core-dev | `src/core/skills.js` `src/core/combat.js` `src/core/skillsUpgrade.js`(新) `src/core/index.js` `src/core/loot.js` `src/game/inventory.js` | 核心逻辑 |
| B | data-dev | `src/items/skillTree.js` `src/items/skillProgression.js`(新) `src/game/app.js` `src/game/save.js` | 数据 + 应用层动作 |
| C1 | ui-dev | `src/ui/skill-ui.js` `src/ui/ui.js` `src/ui/main.js` `src/ui/style.css` `index.html` | 技能面板 / HUD 提醒 / 音效 |
| C2 | render-dev | `src/render/renderer.js` `src/render/effects.js` `src/render/screenFx.js` `src/render/draw-core.js` | 视觉 |
| D | tools-dev | `tools/playtest.mjs` `tools/sim-ttk.mjs` `README.md` | 工具与文档 |
| E | test-dev | `tests/*.test.mjs` | 测试 |

> 只允许写自己那一列。需要别人改文件时，发消息给 Lead，不要自己去改。

---

## 2. 核心数据结构

### 2.1 玩家 / 技能栏实例（`src/core/skills.js`）

```js
player.skillBar = [ SkillInstance|null × 7 ]
SkillInstance = {
  id, level,            // level = 技能等级 1..5（含天赋+精炼），由 app 同步；核心兜底 1
  name, icon, desc,     // 由 makeSkillInstance 从定义里带出来
  cd, active, holding, tick, elapsed,
}
player.skillMods = {    // 【可选】由 app 写入：技能 id → 天赋聚合结果（见 3.3）
  stomp: { damageMult, radiusMult, cooldownMult, stunDurMult, armorPerEnemyMult, armorDurMult, flags:{...}, stats:{...}, ranks:{...}, nodes:[...] },
  ...
}
player.skills = {       // 【可选】由 app 写入：技能 id → 精炼等级等（见 3.4）
  stomp: { refine: 0, level: 1 },
}
```

核心**必须**在缺省时能跑（`player.skillMods` 不存在 → 全部取中性值）。
`skillLevel(bar, player)` 语义变为：`max(1, bar.level || 1) + floor(stats.skillLevelBonus || 0)`（天赋/装备的技能等级加成仍然叠加）。

### 2.2 技能定义（`SKILLS[id]`）新增字段

```js
{
  ...既有字段,
  armorGain: { flat: 18, per: 5, dur: 4 },   // 仅 stomp：护甲增益 { 基础, 每命中一名敌人, 持续秒 }
  cooldownMultLevel: 0.04,                    // 每技能等级冷却缩减（4%），封顶 0.2
  radiusMultLevel: 0.05,                      // 每技能等级半径 +5%
  damageMultLevel: 0.08,                      // 每技能等级伤害 +8%（沿用旧的 levelDmgScale）
}
```

### 2.3 UI 读取的派生信息（核心导出，纯函数）

```js
// src/core/skills.js
export function skillDisplayInfo(player, skillId) -> {
  id, name, icon, desc, kind,
  level,              // 技能等级（>=1，整数）
  levelCap,           // 5
  refine,             // 精炼等级 0..4
  manaCost, cooldown, // 已套用等级/天赋/冷却缩减后的最终值（秒）
  range, radius,      // 已套用范围的最终值
  damagePct,          // 已套用天赋/等级的伤害倍率（1.0 = 100%）
  focus,              // 'left'|'right'|'' —— 分支专精（从 flags.focusLeft/right 推出）
  refines: [ { key, name, desc, refine, max, cost, ... } ]  // 见 3.4
}
export function skillCooldownTotal(player, skillId) -> number  // UI 冷却环用（已套用 cdr/等级）
export function nextRefineCost(player, skillId) -> number|null // 满级返回 null
```

> `skillDisplayInfo` 必须能在**没有 world**的情况下调用（只读 player 上的字段）。

---

## 3. 数据契约

### 3.1 `src/items/skillTree.js`（B 负责）

结构保持向后兼容，新增字段：

```js
N(skillId, {
  key, name, desc,
  cost, maxRank,
  branch: 'core' | 'left' | 'right' | 'leftDeep' | 'rightDeep' | 'ultimate',
  group,            // 互斥组名（同组只能选一个节点；不给 = 不互斥）
  effects: [ ... ], // 保留旧 type，新增见下
  requires: [短名],
})
```

**新效果类型**（`skillEffectsForSkill` 必须正确汇总）：

| type | 每个 rank 的语义 |
| --- | --- |
| `stunDurMult` | 眩晕时长 ×(1+value·rank) |
| `armorPerEnemyMult` | 每名敌人的护甲 ×(1+value·rank) |
| `armorDurMult` | 护甲持续时长 ×(1+value·rank) |
| `armorFlat` | 额外固定护甲（累加） |
| `extra` + `key` | 机制开关：`shockwave` `aftershock` `armorOnHit` `cdOnStun` `echoStomp` `reflectStun` `groundAftershock` `focusLeft` `focusRight` 等 |

`skillEffectsForSkill(skillId, ranks)` 返回对象**新增**：
```js
{ ...旧字段, multiplierBonuses: { stunDurMult: 1.3, armorPerEnemyMult: 1.5, armorDurMult: 1.2, ... } }
```
（`multiplierBonuses` 里每个键都是「乘法系数」，默认 1；未出现的键视为 1。）

**互斥组规则**（新增导出）：
```js
export function skillNodeConflict(skillTree, ranks, nodeId) -> null | { group, takenNodeId, takenName }
export function skillBranchOf(skillTree, nodeId) -> 'left'|'right'|'core'|...
export function validateSkillRanks(skillId, ranks) -> { ok:boolean, reason:string }  // 互斥/前置/超档 全量校验
```

### 3.2 5 棵技能树（内容由 B 定，约束如下）

每个技能 **9~12 个节点**，拓扑固定为：

```
          ┌─ L1 ── L2 ── L3(支线小) ── L4(分支专精)
  ROOT ───┤                                  (互斥：L4 / R4)
          └─ R1 ── R2 ── R3(支线小) ── R4(分支专精)
                                      └─ U (终极, 需要 L4 或 R4 + ROOT 点满)
```
- `ROOT` 是核心节点（maxRank 3），`L1/R1` 需要 ROOT，`L1` 与 `R1` **同属互斥组 `fork`**（选了就锁另一条）。
- `L2/R2` 同上互斥组 `tier2`；`L3/R3` 同上 `tier3`；`L4/R4` 同上 `forkFinal`。
- `U` 是**不互斥**的终极节点，requires `[L4]`（或 R4）+ ROOT。
- 每个分支给的东西方向要**明显不同**（例：战争践踏左支=「震怒」（伤害/范围），右支=「壁垒」（护甲/控制）；旋风斩左=速度流血，右=范围吸怪）。
- 节点 id 仍然 = `${skillId}.${key}`。

#### 3.2.1 【Lead 拍板】分支专精（focus）口径 —— 以此为准

| 字段 | 写法 | 语义 |
| --- | --- | --- |
| `player.skillMods[id].focus` | `'' \| 'left' \| 'right'` | 当前分支：**首次选支（L1/R1）就有值** |
| `player.skillMods[id].flags.focusLeft` | `true \| undefined` | 同上，由 `focus` 推出（首次选支即置位） |
| `player.skillMods[id].flags.focusRight` | `true \| undefined` | 同上 |
| `player.skills[id]` | `{ level, refine, talentPoints, focus }` | `level` 是**完整技能等级**（1 + 天赋节点数 + 精炼），不要再扣精炼 |

> 为什么 flags 跟 focus 同步：UI 用它渲染「选中侧高亮 / 另一侧锁定」，core 的 `skillFocus()` 也只读 flags。
> 两边必须读同一份数据，不允许各推一套。

#### 3.2.2 【Lead 拍板】技能等级与重置口径

- `respecCost(skillId)` 返回 **2**（UI 按钮显示用）；`respecCost(skillId, ranks)` / `respecCost(skillId, inv)` 返回 **2 + 已点节点数**（纯函数，不读全局状态）。
- 「天赋节点数」按**节点数**计，不按档位总和（ROOT 点 3 档仍算 1 个节点），与 `skillLevelFrom` 一致。
- 有效技能等级 = `min(5, 1 + 天赋节点数 + 精炼等级)`。
- **技能点曲线 = `等级`（每升 1 级 +1 点）**，同时**每升 1 级 +2 天赋点**（`TALENT_POINTS_PER_LEVEL`）。（Lead 最新裁决：原 `floor(等级/2)` / `1 + floor(等级/2)` 在 10 分钟 Lv.10 时只有 5~6 点，点不出第二条分叉；现在 Lv.10 = 10 技能点 + 20 天赋点，短局也能体验「分叉」这个核心玩法。）
- ⚠️ 冷却/半径/伤害的有效值计算**必须**统一走 `skillLevelOf(player, skillId)`（优先 `player.skills[id].level`，缺省回退 `bar.level`），禁止只读 `skillBar[i].level`——否则会出现「显示 Lv5、冷却还是 Lv1」。

### 3.3 战争践踏 `stomp`（A + B）

- `SKILLS.stomp`：manaCost 14，cooldown 7，castTime 0.3，kind `'attack'`，radius 3.6（受 aoe/天赋缩放），`damagePct 0.9`（低于裂地斩，因为是控制技能）。
- 施法：以玩家为圆心圆形范围 `queryEnemies`，对每个敌人：
  - `playerHit(..., { dmgPct, area:true, sourceSkill:'stomp', knockback: 3, tags:['attack','melee','aoe','stomp','stun'] })`
  - `applyStun(world, t, stunDur, 'stomp')`
- 依据命中数 `hits` 给自己上护甲 buff（`applyBuff`）：
  - id `'warStompArmor'`，name `'踏地战甲'`，icon `'🛡'`，
  - `stats: { armor: 18 + 5*hits }`（再乘天赋 `armorPerEnemyMult`/`armorFlat`：`armor = (base + per*hits) * perEnemyMult + armorFlat`）
  - `dur = 4 * armorDurMult`
  - **刷新而不叠层**：再次施放会覆盖并刷新时长（见 3.5 buff 刷新语义，A 负责实现）。
- 事件：`pushWorldEvent(world, 'stomp', { x, z, r, radius, hits, stunned, armor, dur, level, color })`
  以及既有 `skillCast`（`skillId:'stomp'`）+ `shake`。
- `hits === 0` 时也给自己一层最小护甲（`base` 值），保证技能永远有正向反馈。
- 名称 `战争践踏`，图标 `'💥'`（与旧 groundSlam 的 🪓 区分）。

### 3.4 技能升级（精炼石）—— `src/items/skillProgression.js`（B 负责）

```js
export const SKILL_LEVEL_CAP = 5;          // 技能等级上限（含天赋）
export const REFINE_MAX = 4;               // 精炼 0..4（总技能等级 = min(cap, 天赋点 + refine + 1)）
export function refineCost(level, refine) -> number   // 1→2:3, 2→3:4, 3→4:6, 4→5:8（件精炼石）
export function skillLevelFrom(ranks, refine, cap = SKILL_LEVEL_CAP) -> number
export function canRefineSkill(inv, player, skillId) -> { ok, reason, cost, have }
export function refineSkill(inv, player, skillId) -> boolean    // 消耗精炼石 → 记录到 inv.skillRefine
export function respecCost(skillId) -> number                   // 重置单技能树的精炼石花费：2 + 已点节点数
export function respecSkill(inv, player, skillId) -> boolean    // 退还该技能天赋点、清互斥状态
export function syncSkillInstances(inv, player) -> void         // 把等级写回 player.skillBar[i].level / .refine
```

`inv` 新增字段：
```js
inv.skillRefine = { stomp: 1, whirlwind: 0, ... }   // 技能 id → 精炼等级
inv.skillOrbs = 0                                    // 技能精炼石数量
```

### 3.5 掉落：技能精炼石（A 负责）

- `src/core/loot.js` 的 `rollLoot` / `killEntity` 路径里，击杀有几率掉 `{ type:'skillOrb', x, z, amount }` 到 `world.items`（与装备掉落同数组，带 `kind:'skillOrb'`），
  或者直接推事件 + 由 app 收集——**采用**：`world.items.push({ kind:'skillOrb', amount, x, z, uid })`，
  掉落率：普通怪 6%、魔法 12%、稀有 35%、Boss 100%（一次给 3 个）。**只改 loot.js 内部，不要动其它文件。**
- `src/game/app.js`（B）：`updateAutoPickup` 里遇到 `kind==='skillOrb'` 时 `inv.skillOrbs += amount` 并从 `world.items` 移除（靠近 1.6 半径自动吸附拾取）。

### 3.6 眩晕（A 负责，`src/core/combat.js` + `monsters.js` 语义）

```js
export function applyStun(world, entity, dur, sourceSkill) -> boolean
// entity.stunTime = max(entity.stunTime||0, dur)；被控期间不动、不攻击、不冲锋、不爆炸；
// 对 Boss 有抗性：dur *= (1 - clamp(entity.stunResist||0.6, 0, 0.9))；对 elite stunResist 0.25。
// 推事件 'stun' { x, z, target, dur, sourceSkill }，target.stunTime / target.stunMax 供渲染。
// 每帧递减（updateStun 或在 updateBuffs 里），stunTime 变 0 时推 'stunEnd'。
// 不新增文件，写在 combat.js 里；monsters.js 里在 updateMonsterAI 开头检查 m.stunTime > 0 → return false。
```
> **注意**：契约里允许 A 改 `src/core/monsters.js`（执行层需要），上面写作用域表里漏了，A 可以改它。

### 3.7 buff 刷新语义（A，可选但推荐）

`applyBuff` 对**同名 buff** 采用「替换 + 刷新时长」；新增可选字段 `stackMode: 'refresh' | 'stack' | 'ignore'`（默认 `'refresh'`，与现状一致）。
护甲 buff 用 `'refresh'` 即可。

---

## 4. 应用层动作（B，`src/game/app.js`）

```js
export function doSkillRankUp(game, skillId, nodeId) -> boolean   // 加 1 点（互斥/前置/点数 校验），成功后 push 'skillRankUp' 事件提示
export function doSkillRefine(game, skillId) -> boolean           // 消耗精炼石升技能等级，push 'skillRefine'
export function doSkillRespec(game, skillId) -> boolean           // 重置该技能天赋，push 'skillRespec'
export function syncSkillSystems(game) -> void                    // 重算 player.skillMods + 技能实例 level/refine（recalcPlayer 里调用）
export function skillPointsTotal(game) -> number
export function skillPointsFor(game, skillId) -> number           // 存量 API，保留签名
```
- 每次技能点/精炼变化后调用 `recalcPlayer()`，`recalcPlayer` 里调 `syncSkillSystems`。
- 事件（供 UI 提醒）：
  ```
  { type:'skillRankUp',  skillId, name, nodeName, rank, maxRank }
  { type:'skillRefine',  skillId, name, level, refine }
  { type:'skillRespec',  skillId, name, refunded }
  { type:'skillOrbGain', amount, total }
  ```

---

## 5. UI（C1）

- **技能面板**（K 键 / Tab 键）：每个技能一个标签页（带图标 + `Lv.X` + 光点），面板内容：
  1. 顶部技能卡：图标、名称、等级、精炼条（4 格）、数值摘要（伤害/冷却/范围/眩晕/护甲…）、`精炼` 按钮（消耗石头的数量 + 是否可点）、`重置天赋` 按钮。
  2. 天赋树：左右分叉布局（左支在左、右支在右、终点在中间），互斥节点用 `locked` 样式并给出原因 tooltip。
  3. 底部提示：可用技能点、精炼石数量、互斥说明。
- **HUD 提醒**：技能栏上方小光点（有未分配技能点或可精炼时）；`ui.onEvents` 里处理上面 4 个事件 → `addLog` + `banner` + 音效 + `flashSide('skill')`。
- **音效**：用 WebAudio 现场合成（无外部素材），包在 try/catch 里，Node/DOM 桩下必须是 no-op 不报错。
- **新手引导**：首次打开技能面板（`localStorage` 标记，取不到就当首次）显示 1 条引导条。

## 6. 渲染（C2）

- 事件 `'stomp'`：地面冲击环 + 裂纹 + 尘土 + 震动（复用 effects.crack / ring / shockwave + particles）。
- `'stun'` / `'stunEnd'`：命中目标头顶的星星/漩涡标记（用实体 `stunTime` 决定是否绘制）；`'stunEnd'` 撒一点碎星。
- 护甲增益：玩家身上的临时金色护甲辉光（读 `player.buffs` 里 `id === 'warStompArmor'` 的 `remaining/dur`）。
- `'skillRankUp'` / `'skillRefine'`：金色升星冲击波 + 星光（`levelUp` 的缩小版）。
- **硬约束**（踩过的坑）：旋风/践踏**不要**用细环描边整圈填白——bloom 后处理会糊成白环；用实心非环形图形。

## 7. 测试（E）

新增 `tests/skill-upgrade.test.mjs`，至少覆盖：
- 战争践踏：命中范围/眩晕施加/护甲随命中数增长/持续时长/无命中也有保底护甲/刷新不叠层。
- 眩晕：被眩晕的怪不动不攻击；Boss 抗性打折。
- 技能等级：天赋点 + 精炼叠加、上限 5、冷却与半径随等级变化。
- 互斥：`skillEffectsForSkill` 只认第一分支；`skillNodeConflict` 返回冲突。
- app 动作：`doSkillRankUp` 校验（点数/前置/互斥）、`doSkillRefine` 消耗与余额、`doSkillRespec` 退还。
- UI（DOM 桩）：技能面板渲染 5 个标签、精炼按钮存在、事件提醒不抛异常。
- 渲染：stomp/stun 事件不抛异常。

---

## 8. 验收口径（Lead 最终检查）

1. `node tests/run-all.mjs`：全绿（含新增测试）。
2. `node tools/build.mjs && node tools/check-standalone.mjs`：通过。
3. `node tools/playtest.mjs --minutes 10 --seed 42`：通过，且 10 分钟等级 / 层数 / 掉落速率仍在 README 的目标区间。
4. 游戏里 1 号技能是「战争践踏」，按 1 能眩晕并给自己加护甲，buff 条出现「踏地战甲」。
5. 技能面板能看到分叉树、能精炼、互斥切换正确。