// @file src/items/mageSkillTrees.js
// 元素法师 · 5 棵技能分叉树的**纯数据**（不 import 任何东西，避免循环依赖）。
//
// 由 items/skillTree.js 的 buildForkTree() 统一接线，因此这里只写「文案 + 数值 +
// 机制开关」，不要写 id / requires / branch —— 模板会自动补齐：
//
//        ROOT ─┬─ L1 ─ L2 ─ L3 ─ L4（互斥）
//              └─ R1 ─ R2 ─ R3 ─ R4（互斥）
//                                └─ U（ROOT 点满 + 左链或右链全亮）
//
// 每棵树的左右支方向必须明显不同：
//   mageFirebolt 左「爆燃」单体爆发 / 右「流火」连射与自愈
//   mageIceShard 左「碎冰」碎冰爆发 / 右「寒流」分裂与护盾
//   mageArc      左「连锁」跳弧 / 右「过载」额外施法与疾速
//   magePyro     左「陨火」双重引爆与流星 / 右「熔核」岩浆与范围
//   mageUltimate 左「万相」狂潮增伤 / 右「永动」持续时间与冷却
//
// 【机制字段】除标准 effect 类型外，使用 extra.key 传递法师专属机制，
// 由 core/mage.js 的 extraOf(mods, key) 读取（这些键不会进 StatBlock）：
//   emberBurst / emberRadius   余烬爆炸概率 / 半径
//   executeFire / shatterMult  对满层火印记 / 被眩晕目标的增伤
//   healPct / manaOnHit        命中回复生命 / 法力
//   fireEcho                   余火追击：额外飞弹概率
//   phoenix / phoenixEvery     凤凰之焰开关 / 触发间隔
//   iceBurst / iceBurstStun    冰爆概率 / 冻结时长
//   iceShield                  命中时获得的护盾（最大生命百分比）
//   iceSplit                   分裂冰片数量
//   frozenField / frozenFieldEvery  极寒领域开关 / 触发间隔
//   arcJump / arcJumpPower     电弧跳跃次数 / 跳跃伤害
//   staticMark                 静电：额外叠 1 层雷印记
//   arcHaste                   命中后的移速加成
//   arcDouble                  额外电弧概率
//   thunderstorm / thunderEvery    雷暴开关 / 触发间隔
//   doubleDetonate / meteorRain / lavaPool / lavaPower / pyroExecute / cataclysm
//   ultDamage / ultDuration / ultCdr / ultSplashRadius / ultSplashPower
//   ultResonanceKeep / ultEndRadius / ultKillExtend / ultSingularity / ultRadius

/** 5 个技能 id（顺序 = Q W E R T）。 */
export const MAGE_SKILL_TREE_IDS = Object.freeze([
  'mageFirebolt', 'mageIceShard', 'mageArc', 'magePyro', 'mageUltimate',
]);

/**
 * 每棵树的 buildForkTree spec。
 * @type {Record<string, {name:string, icon:string, desc:string,
 *   branches:{left:string,right:string,root:string,ultimate:string},
 *   root:Object, left:Object[], right:Object[], ultimate:Object}>}
 */
export const MAGE_SKILL_TREE_SPECS = {
  // ═══════════════════════════ 灼热飞弹 mageFirebolt ═══════════════════════════
  mageFirebolt: {
    name: '灼热飞弹',
    icon: '🔥',
    desc: '火系填充技：造成火焰伤害并叠加 1 层火印记。',
    branches: { root: '灼心', left: '爆燃', right: '流火', ultimate: '凤凰之焰' },
    root: {
      name: '灼心',
      desc: '每档：火焰伤害 +10%。',
      maxRank: 3,
      effects: [{ type: 'damageMult', value: 0.1 }],
    },
    left: [
      { name: '爆燃', desc: '火焰伤害 +18%。', effects: [{ type: 'damageMult', value: 0.18 }] },
      {
        name: '余烬',
        desc: '命中时 30% 概率引爆余烬，对周围敌人造成火焰伤害。',
        effects: [
          { type: 'damageMult', value: 0.08 },
          { type: 'extra', value: 0.3, key: 'emberBurst' },
        ],
      },
      {
        name: '焚尽',
        desc: '对火印记已满的目标额外造成 25% 伤害。',
        effects: [
          { type: 'damageMult', value: 0.08 },
          { type: 'extra', value: 0.25, key: 'executeFire' },
        ],
      },
      {
        name: '爆燃·核',
        desc: '专精（互斥）：火焰伤害 +30%，余烬必定引爆且范围 +40%。',
        cost: 2,
        effects: [
          { type: 'damageMult', value: 0.3 },
          { type: 'extra', value: 0.7, key: 'emberBurst' },
          { type: 'extra', value: 0.4, key: 'emberRadius' },
          { type: 'extra', value: 1, key: 'focusLeft' },
        ],
      },
    ],
    right: [
      {
        name: '流火',
        desc: '火焰伤害 +15%，冷却 -6%。',
        effects: [{ type: 'damageMult', value: 0.15 }, { type: 'cooldownMult', value: -0.06 }],
      },
      {
        name: '连珠',
        desc: '命中后有 35% 概率追加一枚 50% 伤害的飞弹。',
        effects: [
          { type: 'extra', value: 0.35, key: 'fireEcho' },
          { type: 'damageMult', value: 0.06 },
        ],
      },
      {
        name: '炽焰护体',
        desc: '命中回复 1% 最大生命与 2 点法力。',
        effects: [
          { type: 'extra', value: 0.01, key: 'healPct' },
          { type: 'extra', value: 2, key: 'manaOnHit' },
        ],
      },
      {
        name: '流火·无尽',
        desc: '专精（互斥）：余火追击概率 +50%，火焰伤害 +20%。',
        cost: 2,
        effects: [
          { type: 'extra', value: 0.5, key: 'fireEcho' },
          { type: 'damageMult', value: 0.2 },
          { type: 'extra', value: 1, key: 'focusRight' },
        ],
      },
    ],
    ultimate: {
      name: '凤凰之焰',
      desc: '终极：每 6 次灼热飞弹召唤凤凰冲击波（大范围火焰 + 短暂眩晕），火焰伤害 +25%、范围 +25%。',
      cost: 2,
      effects: [
        { type: 'damageMult', value: 0.25 },
        { type: 'radiusMult', value: 0.25 },
        { type: 'extra', value: 1, key: 'phoenix' },
        { type: 'extra', value: 6, key: 'phoenixEvery' },
      ],
    },
  },

  // ═══════════════════════════ 寒冰箭 mageIceShard ═══════════════════════════
  mageIceShard: {
    name: '寒冰箭',
    icon: '❄️',
    desc: '冰系填充技：造成冰霜伤害并叠加 1 层冰印记。',
    branches: { root: '凝霜', left: '碎冰', right: '寒流', ultimate: '极寒领域' },
    root: {
      name: '凝霜',
      desc: '每档：冰霜伤害 +10%。',
      maxRank: 3,
      effects: [{ type: 'damageMult', value: 0.1 }],
    },
    left: [
      { name: '冰刺', desc: '冰霜伤害 +18%。', effects: [{ type: 'damageMult', value: 0.18 }] },
      {
        name: '冰裂',
        desc: '命中时 25% 概率炸开冰棱，对周围敌人造成冰霜伤害并短暂眩晕。',
        effects: [
          { type: 'damageMult', value: 0.08 },
          { type: 'extra', value: 0.25, key: 'iceBurst' },
        ],
      },
      {
        name: '霜刺',
        desc: '对被眩晕的目标额外造成 30% 伤害。',
        effects: [
          { type: 'damageMult', value: 0.08 },
          { type: 'extra', value: 0.3, key: 'shatterMult' },
        ],
      },
      {
        name: '碎冰·绝',
        desc: '专精（互斥）：冰霜伤害 +30%，冰爆必定触发并冻结 0.6 秒。',
        cost: 2,
        effects: [
          { type: 'damageMult', value: 0.3 },
          { type: 'extra', value: 0.75, key: 'iceBurst' },
          { type: 'extra', value: 0.6, key: 'iceBurstStun' },
          { type: 'extra', value: 1, key: 'focusLeft' },
        ],
      },
    ],
    right: [
      {
        name: '寒流',
        desc: '冰霜伤害 +10%，冷却 -5%。',
        effects: [{ type: 'damageMult', value: 0.1 }, { type: 'cooldownMult', value: -0.05 }],
      },
      {
        name: '冰甲',
        desc: '命中获得相当于 1.5% 最大生命的护盾（最多叠到 15%），持续 6 秒。',
        effects: [{ type: 'extra', value: 0.015, key: 'iceShield' }],
      },
      {
        name: '分裂',
        desc: '命中时向附近 2 个敌人各弹射一枚 45% 伤害的冰片。',
        effects: [
          { type: 'extra', value: 2, key: 'iceSplit' },
          { type: 'damageMult', value: 0.06 },
        ],
      },
      {
        name: '寒流·极',
        desc: '专精（互斥）：冰霜伤害 +25%，分裂额外 +2 枚冰片。',
        cost: 2,
        effects: [
          { type: 'damageMult', value: 0.25 },
          { type: 'extra', value: 2, key: 'iceSplit' },
          { type: 'extra', value: 1, key: 'focusRight' },
        ],
      },
    ],
    ultimate: {
      name: '极寒领域',
      desc: '终极：每 8 次寒冰箭在目标处降下极寒领域（大范围冰伤 + 冻结 1 秒），冰霜伤害 +20%、范围 +20%。',
      cost: 2,
      effects: [
        { type: 'damageMult', value: 0.2 },
        { type: 'radiusMult', value: 0.2 },
        { type: 'extra', value: 1, key: 'frozenField' },
        { type: 'extra', value: 8, key: 'frozenFieldEvery' },
      ],
    },
  },

  // ═══════════════════════════ 电弧 mageArc ═══════════════════════════
  mageArc: {
    name: '电弧',
    icon: '⚡',
    desc: '雷系填充技：造成闪电伤害并叠加 1 层雷印记。',
    branches: { root: '迅电', left: '连锁', right: '过载', ultimate: '雷霆万钧' },
    root: {
      name: '迅电',
      desc: '每档：闪电伤害 +10%，冷却 -3%。',
      maxRank: 3,
      effects: [
        { type: 'damageMult', value: 0.1 },
        { type: 'cooldownMult', value: -0.03 },
      ],
    },
    left: [
      { name: '连锁', desc: '闪电伤害 +15%。', effects: [{ type: 'damageMult', value: 0.15 }] },
      {
        name: '跳弧',
        desc: '命中后向最近的敌人跳跃 1 次（55% 伤害）。',
        effects: [
          { type: 'damageMult', value: 0.06 },
          { type: 'extra', value: 1, key: 'arcJump' },
        ],
      },
      {
        name: '电网',
        desc: '跳跃次数 +1，闪电伤害 +10%。',
        effects: [
          { type: 'extra', value: 1, key: 'arcJump' },
          { type: 'damageMult', value: 0.1 },
        ],
      },
      {
        name: '连锁·雷',
        desc: '专精（互斥）：闪电伤害 +30%，跳跃次数 +2。',
        cost: 2,
        effects: [
          { type: 'damageMult', value: 0.3 },
          { type: 'extra', value: 2, key: 'arcJump' },
          { type: 'extra', value: 1, key: 'focusLeft' },
        ],
      },
    ],
    right: [
      { name: '过载', desc: '闪电伤害 +12%。', effects: [{ type: 'damageMult', value: 0.12 }] },
      {
        name: '静电',
        desc: '命中额外叠加 1 层雷印记。',
        effects: [
          { type: 'extra', value: 1, key: 'staticMark' },
          { type: 'cooldownMult', value: -0.04 },
        ],
      },
      {
        name: '疾电',
        desc: '冷却 -10%；命中获得 8% 移速，持续 3 秒。',
        effects: [
          { type: 'cooldownMult', value: -0.1 },
          { type: 'extra', value: 0.08, key: 'arcHaste' },
        ],
      },
      {
        name: '过载·极',
        desc: '专精（互斥）：闪电伤害 +25%，15% 概率额外释放一次电弧。',
        cost: 2,
        effects: [
          { type: 'damageMult', value: 0.25 },
          { type: 'extra', value: 0.15, key: 'arcDouble' },
          { type: 'extra', value: 1, key: 'focusRight' },
        ],
      },
    ],
    ultimate: {
      name: '雷霆万钧',
      desc: '终极：每 5 次电弧召唤天雷轰击周围所有敌人（70% 伤害），闪电伤害 +25%。',
      cost: 2,
      effects: [
        { type: 'damageMult', value: 0.25 },
        { type: 'extra', value: 1, key: 'thunderstorm' },
        { type: 'extra', value: 5, key: 'thunderEvery' },
      ],
    },
  },

  // ═══════════════════════════ 炎爆术 magePyro ═══════════════════════════
  magePyro: {
    name: '炎爆术',
    icon: '💥',
    desc: '在目标处引爆火焰（半径 3）。目标带满层火印记时强化：伤害、眩晕并消耗印记。',
    branches: { root: '引爆', left: '陨火', right: '熔核', ultimate: '天火焚世' },
    root: {
      name: '引爆',
      desc: '每档：火焰伤害 +10%，范围 +4%。',
      maxRank: 3,
      effects: [
        { type: 'damageMult', value: 0.1 },
        { type: 'radiusMult', value: 0.04 },
      ],
    },
    left: [
      { name: '陨火', desc: '火焰伤害 +20%。', effects: [{ type: 'damageMult', value: 0.2 }] },
      {
        name: '双重引爆',
        desc: '0.35 秒后原地再次爆炸，造成 60% 伤害。',
        effects: [
          { type: 'damageMult', value: 0.06 },
          { type: 'extra', value: 0.6, key: 'doubleDetonate' },
        ],
      },
      {
        name: '流星雨',
        desc: '爆炸时向范围内 3 个敌人各砸下一颗小陨星（50% 伤害）。',
        effects: [
          { type: 'extra', value: 3, key: 'meteorRain' },
          { type: 'damageMult', value: 0.06 },
        ],
      },
      {
        name: '陨火·灭',
        desc: '专精（互斥）：火焰伤害 +35%，双重引爆伤害再 +40%。',
        cost: 2,
        effects: [
          { type: 'damageMult', value: 0.35 },
          { type: 'extra', value: 0.4, key: 'doubleDetonate' },
          { type: 'extra', value: 1, key: 'focusLeft' },
        ],
      },
    ],
    right: [
      {
        name: '熔核',
        desc: '范围 +15%，强化炎爆的眩晕时长 +20%。',
        effects: [
          { type: 'radiusMult', value: 0.15 },
          { type: 'extra', value: 0.2, key: 'pyroStun' },
        ],
      },
      {
        name: '岩浆',
        desc: '爆炸留下持续 3 秒的熔岩池，每秒对其中敌人造成 35% 伤害。',
        effects: [{ type: 'extra', value: 1, key: 'lavaPool' }],
      },
      {
        name: '收束',
        desc: '对火印记已满的目标伤害 +20%，冷却 -8%。',
        effects: [
          { type: 'extra', value: 0.2, key: 'pyroExecute' },
          { type: 'cooldownMult', value: -0.08 },
        ],
      },
      {
        name: '熔核·心',
        desc: '专精（互斥）：范围 +25%，熔岩池伤害翻倍。',
        cost: 2,
        effects: [
          { type: 'radiusMult', value: 0.25 },
          { type: 'extra', value: 1, key: 'lavaPower' },
          { type: 'extra', value: 1, key: 'focusRight' },
        ],
      },
    ],
    ultimate: {
      name: '天火焚世',
      desc: '终极：目标范围内的每个敌人各遭一颗陨星，火焰伤害 +30%。',
      cost: 2,
      effects: [
        { type: 'damageMult', value: 0.3 },
        { type: 'extra', value: 1, key: 'cataclysm' },
      ],
    },
  },

  // ═══════════════════════════ 元素狂潮 mageUltimate ═══════════════════════════
  mageUltimate: {
    name: '元素狂潮',
    icon: '🌌',
    desc: '共鸣 100 时开启：冷却减半、法力免费，每次命中附带元素爆炸。',
    branches: { root: '潮心', left: '万相', right: '永动', ultimate: '元素奇点' },
    root: {
      name: '潮心',
      desc: '每档：狂潮期间伤害 +8%，持续时间 +0.5 秒。',
      maxRank: 3,
      effects: [
        { type: 'damageMult', value: 0.08 },
        { type: 'extra', value: 0.5, key: 'ultDuration' },
      ],
    },
    left: [
      {
        name: '万相',
        desc: '狂潮期间伤害 +12%。',
        effects: [{ type: 'extra', value: 0.12, key: 'ultDamage' }],
      },
      {
        name: '元素洪流',
        desc: '狂潮附带的元素爆炸半径 +35%、伤害 +20%。',
        effects: [
          { type: 'extra', value: 0.35, key: 'ultSplashRadius' },
          { type: 'extra', value: 0.2, key: 'ultSplashPower' },
        ],
      },
      {
        name: '超载共鸣',
        desc: '狂潮结束时保留 30 点共鸣。',
        effects: [
          { type: 'extra', value: 30, key: 'ultResonanceKeep' },
          { type: 'extra', value: 0.05, key: 'ultDamage' },
        ],
      },
      {
        name: '万相·终',
        desc: '专精（互斥）：狂潮伤害 +30%，结束爆发半径 +30%。',
        cost: 2,
        effects: [
          { type: 'extra', value: 0.3, key: 'ultDamage' },
          { type: 'extra', value: 0.3, key: 'ultEndRadius' },
          { type: 'extra', value: 1, key: 'focusLeft' },
        ],
      },
    ],
    right: [
      {
        name: '永动',
        desc: '狂潮持续时间 +1.5 秒。',
        effects: [{ type: 'extra', value: 1.5, key: 'ultDuration' }],
      },
      {
        name: '回响之躯',
        desc: '狂潮期间每次击杀延长 0.5 秒。',
        effects: [{ type: 'extra', value: 0.5, key: 'ultKillExtend' }],
      },
      {
        name: '冷却共鸣',
        desc: '狂潮冷却 -15%。',
        effects: [{ type: 'extra', value: 0.15, key: 'ultCdr' }],
      },
      {
        name: '永动·恒',
        desc: '专精（互斥）：狂潮持续 +3 秒，冷却再 -25%。',
        cost: 2,
        effects: [
          { type: 'extra', value: 3, key: 'ultDuration' },
          { type: 'extra', value: 0.25, key: 'ultCdr' },
          { type: 'extra', value: 1, key: 'focusRight' },
        ],
      },
    ],
    ultimate: {
      name: '元素奇点',
      desc: '终极：开启与结束时生成元素奇点，吸附并眩晕周围敌人；狂潮伤害 +20%、范围 +20%。',
      cost: 2,
      effects: [
        { type: 'extra', value: 1, key: 'ultSingularity' },
        { type: 'extra', value: 0.2, key: 'ultDamage' },
        { type: 'extra', value: 0.2, key: 'ultRadius' },
      ],
    },
  },
};

export default { MAGE_SKILL_TREE_IDS, MAGE_SKILL_TREE_SPECS };