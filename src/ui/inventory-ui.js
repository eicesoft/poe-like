// 背包 / 装备界面
import { $, el, escapeHTML, rarityColor, itemTooltipHTML } from './dom.js';
import { EQUIP_SLOTS, SLOT_ACCEPTS, selectEquipSlot, sellPrice } from '../game/inventory.js';

let inventoryUIState = { filter: 'all' };

/**
 * 背包物品对比的「当前装备」：优先取它实际会替换的槽位；目标槽为空时，
 * 退而比较同类槽位上已经穿着的装备（例如只戴了一枚戒指时，另一枚也有对比价值）。
 * @param {Object} inv
 * @param {any} item
 * @returns {any|null}
 */
function equippedForCompare(inv, item) {
  if (!inv || !item) return null;
  const target = selectEquipSlot(inv, item);
  if (target && inv.equip && inv.equip[target]) return inv.equip[target];
  for (const s of EQUIP_SLOTS) {
    const accepts = SLOT_ACCEPTS[s.id];
    if (accepts && accepts.includes(item.slot) && inv.equip && inv.equip[s.id]) return inv.equip[s.id];
  }
  return null;
}

export function isInventoryOpen(ui) {
  return ui.modalOpen === 'inventory';
}

/** 橙色装备（unique / legendary）：出售前必须二次确认，防止手滑卖掉高价值掉落 */
const ORANGE_RARITIES = new Set(['unique', 'legendary']);

export function needsSellConfirm(item) {
  return !!item && ORANGE_RARITIES.has(item.rarity);
}

/**
 * 当前等待确认出售的橙装（物品对象，不是下标）。
 * 背包打开时游戏仍在运行：自动拾取/自动换装会增删 bag，导致下标漂移；
 * 用对象引用确认时重新 indexOf，才能保证卖掉的确实是玩家点的那件。
 */
let pendingSellItem = null;

/** 关闭面板时清掉待确认状态（DOM 随面板隐藏，不需要手动删） */
export function resetSellConfirm() {
  pendingSellItem = null;
}

/** 只移除确认框 DOM，不清 pending（重绘时用于重挂） */
function removeSellConfirmNode(ui) {
  const body = ui && ui.el && ui.el.modalBody;
  if (!body || typeof body.querySelector !== 'function') return;
  const node = body.querySelector('.sell-confirm-mask');
  if (node && typeof node.remove === 'function') node.remove();
}

/** 关闭出售确认框（取消 / 确认后调用） */
export function closeSellConfirm(ui) {
  pendingSellItem = null;
  removeSellConfirmNode(ui);
}

/**
 * 请求出售背包物品。橙色（传奇/传说）装备先弹确认框；普通/魔法/稀有直接卖。
 * @returns {'sold'|'confirm'|'none'}
 */
export function requestSell(ui, idx) {
  const game = ui && ui.game;
  const item = game && game.inv && Array.isArray(game.inv.bag) ? game.inv.bag[idx] : null;
  if (!item) return 'none';
  if (needsSellConfirm(item)) {
    pendingSellItem = item;
    removeSellConfirmNode(ui);
    renderSellConfirm(ui, item);
    return 'confirm';
  }
  game.actions.sell(idx);
  openInventory(ui);
  return 'sold';
}

/** 确认框里点「确认出售」：按物品引用重新找下标，真正卖出并重绘背包 */
export function confirmSell(ui, item) {
  pendingSellItem = null;
  removeSellConfirmNode(ui);
  const game = ui && ui.game;
  if (!game || !item) return false;
  const idx = game.inv.bag.indexOf(item);
  if (idx < 0) {
    // 等待确认期间已经被换装/卖掉/丢弃：不卖别的东西，只重绘
    openInventory(ui);
    return false;
  }
  game.actions.sell(idx);
  openInventory(ui);
  return true;
}

/** 在背包面板内叠一层确认框（不打断暂停 / 面板状态） */
function renderSellConfirm(ui, item) {
  const body = ui && ui.el && ui.el.modalBody;
  if (!body) return null;
  ui.hideTooltip?.();

  const mask = el('div', { class: 'sell-confirm-mask' });
  try {
    mask.setAttribute('role', 'dialog');
    mask.setAttribute('aria-modal', 'true');
  } catch { /* 极简 DOM 桩 */ }

  const box = el('div', { class: 'sell-confirm' });
  const title = el('div', { class: 'sc-title', text: '确认出售橙色装备？' });
  const name = el('div', { class: 'sc-item', text: `${item.icon || '◆'} ${item.name || '未知装备'}` });
  name.style.color = rarityColor(item.rarity);
  const warn = el('div', {
    class: 'sc-warn',
    text: `出售后可获得 ${sellPrice(item)} 金币。卖出后无法找回，确定要卖掉它吗？`,
  });
  const actions = el('div', { class: 'sc-actions' });
  const cancel = el('button', { class: 'btn-mini', type: 'button', text: '取消' });
  const ok = el('button', { class: 'btn-mini danger', type: 'button', text: '确认出售' });
  // 默认焦点放在「取消」，避免误按 Enter 直接把橙装卖掉
  cancel.addEventListener('click', (ev) => { ev?.preventDefault?.(); closeSellConfirm(ui); });
  ok.addEventListener('click', (ev) => { ev?.preventDefault?.(); confirmSell(ui, item); });

  actions.appendChild(cancel);
  actions.appendChild(ok);
  box.appendChild(title);
  box.appendChild(name);
  box.appendChild(warn);
  box.appendChild(actions);
  mask.appendChild(box);
  // 点遮罩空白处 = 取消
  mask.addEventListener('click', (ev) => { if (ev.target === mask) closeSellConfirm(ui); });
  body.appendChild(mask);
  try { cancel.focus?.(); } catch { /* 极简 DOM 桩 */ }
  return mask;
}

export function openInventory(ui) {
  const game = ui.game;
  const inv = game.inv;
  const p = game.world.player;
  ui.el.modalTitle.textContent = '背包 · 装备';
  const body = ui.el.modalBody;
  body.innerHTML = '';

  const wrap = el('div', { class: 'inv-wrap' });

  // ---- 左侧：装备栏 ----
  const left = el('div', { class: 'inv-left' });
  const doll = el('div', { class: 'equip-doll' });
  const slotOrder = ['helmet', 'amulet', 'body', 'weapon', 'offhand', 'gloves', 'belt', 'ring1', 'ring2', 'boots'];
  for (const slotId of slotOrder) {
    const def = EQUIP_SLOTS.find((s) => s.id === slotId);
    const item = inv.equip[slotId];
    const cell = el('div', { class: 'equip-slot' + (item ? ' filled' : ''), 'data-slot': slotId });
    if (item) {
      cell.style.borderColor = rarityColor(item.rarity);
      cell.innerHTML = `<div class="eq-icon" style="color:${rarityColor(item.rarity)}">${escapeHTML(item.icon || '◆')}</div><div class="eq-name" style="color:${rarityColor(item.rarity)}">${escapeHTML(item.name)}</div>`;
      cell.addEventListener('mouseenter', (ev) => ui.showTooltip(itemTooltipHTML(item), ev.clientX, ev.clientY));
      cell.addEventListener('mousemove', (ev) => ui.showTooltip(itemTooltipHTML(item), ev.clientX, ev.clientY));
      cell.addEventListener('mouseleave', () => ui.hideTooltip());
      cell.addEventListener('click', () => {
        game.actions.unequip(slotId);
        openInventory(ui);
      });
    } else {
      cell.innerHTML = `<div class="eq-empty">${def ? def.name : slotId}</div>`;
    }
    doll.appendChild(cell);
  }
  left.appendChild(doll);
  left.appendChild(renderStatSummary(game));

  // ---- 右侧：背包格子 ----
  const right = el('div', { class: 'inv-right' });
  const toolbar = el('div', { class: 'inv-toolbar' }, [
    el('button', { class: 'btn-mini', text: '出售全部垃圾', onclick: () => { game.actions.sellJunk(); openInventory(ui); } }),
    el('button', { class: 'btn-mini', text: '整理', onclick: () => { game.actions.sortBag(); openInventory(ui); } }),
    el('span', { class: 'gold-label', html: `金币 <b>${inv.gold}</b>` }),
    el('span', { class: 'bag-label', html: `背包 <b>${inv.bag.length}/${inv.bagSize}</b>` }),
  ]);
  right.appendChild(toolbar);
  const grid = el('div', { class: 'bag-grid' });
  const bag = inv.bag;
  for (let i = 0; i < inv.bagSize; i++) {
    const item = bag[i];
    const cell = el('div', { class: 'bag-cell' + (item ? ' filled' : '') });
    if (item) {
      const rc = rarityColor(item.rarity);
      // 稀有度色不能只靠 `color` 染 emoji：彩色 emoji 是位图字形，CSS color 对它无效，
      // 所以背包格里的图标永远保持 emoji 自带的颜色（比如 🗡️ 就是蓝色），玩家会误以为
      // 黄/橙装也显示成蓝色。这里把稀有度色同时写进边框、底部色条和物品名文字，
      // 图标本身只负责发光，稀有度以文字/边框为准。
      cell.style.borderColor = rc;
      // 测试里的极简 DOM 桩没有 CSSStyleDeclaration.setProperty，做一个安全退化
      if (typeof cell.style.setProperty === 'function') cell.style.setProperty('--rarity-color', rc);
      else cell.style['--rarity-color'] = rc;
      cell.innerHTML =
        `<span class="bag-icon" style="color:${rc}">${escapeHTML(item.icon || '◆')}</span>` +
        `<span class="bag-name" style="color:${rc}">${escapeHTML(item.name || '')}</span>`;
      cell.addEventListener('keydown', () => {});
      // 悬停属性时，与当前穿在对应槽位的装备做对比（战力 / DPS / 逐条属性差值）
      cell.addEventListener('mousemove', (ev) => {
        const cmp = equippedForCompare(game.inv, item);
        ui.showTooltip(itemTooltipHTML(item, cmp, { compare: true }), ev.clientX, ev.clientY);
      });
      cell.addEventListener('mouseleave', () => ui.hideTooltip());
      cell.addEventListener('click', (ev) => {
        if (ev.shiftKey) {
          // Shift+左键 = 出售（橙色仍会先弹确认）
          requestSell(ui, i);
        } else {
          game.actions.equipFromBag(i);
          openInventory(ui);
        }
      });
      cell.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        // 右键 = 出售；橙色装备先弹确认框，不直接扣物品
        requestSell(ui, i);
      });
    }
    grid.appendChild(cell);
  }
  right.appendChild(grid);
  right.appendChild(el('div', { class: 'inv-hint', html: '左键装备 · 右键出售（橙色装备需确认） · 悬停查看属性 · E 打开/关闭' }));

  wrap.appendChild(left);
  wrap.appendChild(right);
  body.appendChild(wrap);

  ui.el.modalFoot.innerHTML = '';

  // 面板重绘（自动拾取 / 自动换装 / 其他动作）会清空 body：待确认的橙装要重新挂回来，
  // 否则确认框会「凭空消失」，玩家以为已经取消。物品若已不在背包则自动取消确认。
  if (pendingSellItem) {
    if (inv.bag.includes(pendingSellItem)) renderSellConfirm(ui, pendingSellItem);
    else pendingSellItem = null;
  }
}

function renderStatSummary(game) {
  const s = game.stats || {};
  const rows = [
    ['生命', Math.round(s.life || 0)],
    ['护甲', Math.round(s.armor || 0)],
    ['闪避率', ((s.evasion || 0) * 100).toFixed(0) + '%'],
    ['格挡', ((s.blockChance || 0) * 100).toFixed(0) + '%'],
    ['武器伤害', s.dmg || '-'],
    ['暴击率', ((s.crit || 0) * 100).toFixed(1) + '%'],
    ['攻击速度', (s.aps || 0).toFixed(2)],
    ['生命偷取', ((s.lifeLeech || 0) * 100).toFixed(1) + '%'],
    ['火抗', ((s.fire || 0) * 100).toFixed(0) + '%'],
    ['冰抗', ((s.cold || 0) * 100).toFixed(0) + '%'],
    ['雷抗', ((s.lightning || 0) * 100).toFixed(0) + '%'],
    ['混沌抗', ((s.chaos || 0) * 100).toFixed(0) + '%'],
  ];
  const box = el('div', { class: 'stat-summary' });
  box.innerHTML = '<h4>角色面板</h4>' + rows.map(([k, v]) => `<div class="ss-row"><span>${k}</span><b>${escapeHTML(String(v))}</b></div>`).join('');
  return box;
}