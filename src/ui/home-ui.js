// 庇护所面板：仓库 / 商人 / 赌徒。
//
// 交互流程：
//   在家中按 F 靠近设施 → app.doPickup → ui.showHomePanel(kind) → 这里渲染。
// 所有数值动作都转发给 game.actions（app.js），本文件只负责 DOM 与提示，
// 这样面板在无 DOM 的测试里不会拖累游戏逻辑。
import { el, escapeHTML, rarityColor, itemTooltipHTML } from './dom.js';
import { sellPrice } from '../game/inventory.js';
import { merchantStock, merchantPrice, gambleCost, HOME_STASH_SIZE } from '../game/home.js';

const KIND_TITLE = {
  stash: '仓库 · 庇护所',
  merchant: '商人 · 装备与补给',
  gambler: '赌徒 · 命运的骰子',
};

function itemLabel(item) {
  if (!item) return '未知装备';
  return `${item.icon || '◆'} ${item.name || '未知装备'}`;
}

/** 在物品格上挂悬停详情（与背包一致）。 */
function bindTooltip(ui, node, item) {
  if (!node || !item || typeof itemTooltipHTML !== 'function') return;
  const show = (ev) => ui.showTooltip?.(itemTooltipHTML(item), ev?.clientX ?? 0, ev?.clientY ?? 0);
  node.addEventListener?.('mouseenter', show);
  node.addEventListener?.('mousemove', show);
  node.addEventListener?.('mouseleave', () => ui.hideTooltip?.());
}

/** 一个可点击的物品格：左侧图标 + 名称，右侧可选价格 / 动作。 */
function itemCell(ui, item, { actionText, actionColor, disabled = false, onClick } = {}) {
  const color = rarityColor(item?.rarity);
  const cell = el('div', { class: 'home-item' + (disabled ? ' disabled' : '') });
  const icon = el('div', { class: 'hi-icon', text: item?.icon || '◆' });
  icon.style.color = color;
  const main = el('div', { class: 'hi-main' });
  const name = el('b', { text: item?.name || '未知装备' });
  name.style.color = color;
  const sub = el('span', { text: `${item?.rarityName || item?.rarity || '普通'} · ${item?.typeName || item?.slot || '装备'}` });
  main.appendChild(name);
  main.appendChild(sub);
  cell.appendChild(icon);
  cell.appendChild(main);
  if (actionText) {
    const act = el('span', { class: 'hi-action', text: actionText });
    if (actionColor) act.style.color = actionColor;
    cell.appendChild(act);
  }
  bindTooltip(ui, cell, item);
  if (!disabled && typeof onClick === 'function') {
    cell.addEventListener?.('click', (ev) => {
      ev?.stopPropagation?.();
      onClick(ev);
    });
    cell.classList?.add('clickable');
  }
  return cell;
}

function panelHead(game, extra = '') {
  const inv = game.inv || {};
  const head = el('div', { class: 'home-head' });
  head.innerHTML = `<span class="gold-label">金币 <b>${inv.gold || 0}</b></span>${extra ? `<span class="home-extra">${escapeHTML(extra)}</span>` : ''}`;
  return head;
}

function emptyHint(text) {
  return el('div', { class: 'home-empty', text });
}

// ---------------------------------------------------------------------------
// 仓库
// ---------------------------------------------------------------------------
function renderStash(ui) {
  const game = ui.game;
  const inv = game.inv;
  const stash = Array.isArray(inv.stash) ? inv.stash : [];
  const body = ui.el.modalBody;
  body.innerHTML = '';

  const wrap = el('div', { class: 'home-panel' });
  wrap.appendChild(panelHead(game, `仓库 ${stash.length}/${inv.stashSize || HOME_STASH_SIZE}`));

  const columns = el('div', { class: 'home-columns' });

  // 背包
  const left = el('section', { class: 'home-section' });
  left.appendChild(el('h4', { text: `背包 ${inv.bag.length}/${inv.bagSize}` }));
  const bagList = el('div', { class: 'home-list' });
  if (!inv.bag.length) bagList.appendChild(emptyHint('背包是空的'));
  inv.bag.forEach((item, idx) => {
    bagList.appendChild(itemCell(ui, item, {
      actionText: '存入 →',
      actionColor: '#d8b56a',
      onClick: () => {
        game.actions?.stashDeposit?.(idx);
        renderStash(ui);
      },
    }));
  });
  left.appendChild(bagList);

  // 仓库
  const right = el('section', { class: 'home-section' });
  right.appendChild(el('h4', { text: `仓库 ${stash.length}/${inv.stashSize || HOME_STASH_SIZE}` }));
  const stashList = el('div', { class: 'home-list' });
  if (!stash.length) stashList.appendChild(emptyHint('仓库是空的'));
  stash.forEach((item, idx) => {
    stashList.appendChild(itemCell(ui, item, {
      actionText: '← 取出',
      actionColor: '#7fd4ff',
      onClick: () => {
        game.actions?.stashWithdraw?.(idx);
        renderStash(ui);
      },
    }));
  });
  right.appendChild(stashList);

  columns.appendChild(left);
  columns.appendChild(right);
  wrap.appendChild(columns);
  body.appendChild(wrap);

  ui.el.modalFoot.innerHTML = '';
  const close = el('button', { class: 'btn-mini', type: 'button', text: '关闭（ESC）' });
  close.addEventListener?.('click', () => ui.closeModals?.());
  ui.el.modalFoot.appendChild(close);
}

// ---------------------------------------------------------------------------
// 商人
// ---------------------------------------------------------------------------
function renderMerchant(ui) {
  const game = ui.game;
  const inv = game.inv;
  const stock = merchantStock(game.world);
  const body = ui.el.modalBody;
  body.innerHTML = '';

  const wrap = el('div', { class: 'home-panel' });
  wrap.appendChild(panelHead(game, '买来的装备会直接进入背包'));

  const columns = el('div', { class: 'home-columns' });

  // 货架
  const left = el('section', { class: 'home-section' });
  left.appendChild(el('h4', { text: `商人货架 ${stock.length}` }));
  const shop = el('div', { class: 'home-list' });
  if (!stock.length) shop.appendChild(emptyHint('今天的货卖完了，回城后会补货'));
  stock.forEach((item, idx) => {
    const price = merchantPrice(item);
    const affordable = (inv.gold || 0) >= price;
    shop.appendChild(itemCell(ui, item, {
      actionText: `${price} 金币`,
      actionColor: affordable ? '#ffd34d' : '#ff6a5a',
      disabled: !affordable,
      onClick: () => {
        game.actions?.buyItem?.(idx);
        renderMerchant(ui);
      },
    }));
  });
  left.appendChild(shop);

  // 出售
  const right = el('section', { class: 'home-section' });
  right.appendChild(el('h4', { text: '出售背包物品' }));
  const junk = el('button', { class: 'btn-mini', type: 'button', text: '出售全部普通 / 魔法' });
  junk.addEventListener?.('click', () => {
    game.actions?.sellJunk?.();
    renderMerchant(ui);
  });
  right.appendChild(junk);
  const sellList = el('div', { class: 'home-list' });
  let sellable = 0;
  inv.bag.forEach((item, idx) => {
    if (!item) return;
    const precious = item.rarity === 'unique' || item.rarity === 'legendary';
    if (precious) {
      sellable++;
      sellList.appendChild(itemCell(ui, item, {
        actionText: '贵重 · 去背包出售',
        actionColor: '#ff9a3c',
        disabled: true,
      }));
      return;
    }
    sellable++;
    sellList.appendChild(itemCell(ui, item, {
      actionText: `卖出 ${sellPrice(item)}`,
      actionColor: '#9ad8ff',
      onClick: () => {
        game.actions?.sell?.(idx);
        renderMerchant(ui);
      },
    }));
  });
  if (!sellable) sellList.appendChild(emptyHint('背包里没有可出售的装备'));
  right.appendChild(sellList);

  columns.appendChild(left);
  columns.appendChild(right);
  wrap.appendChild(columns);
  body.appendChild(wrap);

  ui.el.modalFoot.innerHTML = '';
  const close = el('button', { class: 'btn-mini', type: 'button', text: '关闭（ESC）' });
  close.addEventListener?.('click', () => ui.closeModals?.());
  ui.el.modalFoot.appendChild(close);
}

// ---------------------------------------------------------------------------
// 赌徒
// ---------------------------------------------------------------------------
function renderGambler(ui) {
  const game = ui.game;
  const inv = game.inv;
  const p = game.world.player;
  const cost = gambleCost(p);
  const body = ui.el.modalBody;
  body.innerHTML = '';

  const wrap = el('div', { class: 'home-panel gambler-panel' });
  wrap.appendChild(panelHead(game, `赌注 ${cost} 金币 · 等级越高赌注越大`));

  const stage = el('div', { class: 'gambler-stage' });
  const dice = el('div', { class: 'gambler-dice', text: '🎲' });
  stage.appendChild(dice);
  stage.appendChild(el('p', {
    class: 'gambler-text',
    text: '“金币会说话。把它交给我，命运会替你翻一张牌。”',
  }));
  stage.appendChild(el('p', {
    class: 'gambler-odds',
    text: '45% 空手而归 · 33% 魔法 · 16% 稀有 · 6% 传奇',
  }));

  const last = ui._gambleLast;
  if (last && last.ok) {
    const line = el('div', { class: 'gambler-result' });
    if (last.item) {
      line.innerHTML = `你赢得了 <b style="color:${rarityColor(last.item.rarity)}">${escapeHTML(itemLabel(last.item))}</b>`;
    } else {
      line.textContent = '什么也没有。赌徒笑着收走了金币。';
    }
    stage.appendChild(line);
  }

  const canBet = (inv.gold || 0) >= cost && !(inv.bag.length >= inv.bagSize);
  const bet = el('button', {
    class: 'btn-primary gambler-bet', type: 'button',
    text: canBet ? `下注 ${cost} 金币` : ((inv.gold || 0) < cost ? `金币不足（${cost}）` : '背包已满'),
  });
  if (!canBet) bet.setAttribute?.('disabled', 'disabled');
  else bet.addEventListener?.('click', () => {
    ui._gambleLast = game.actions?.gamble?.() || null;
    renderGambler(ui);
  });
  stage.appendChild(bet);
  wrap.appendChild(stage);
  body.appendChild(wrap);

  ui.el.modalFoot.innerHTML = '';
  const close = el('button', { class: 'btn-mini', type: 'button', text: '离开赌桌（ESC）' });
  close.addEventListener?.('click', () => ui.closeModals?.());
  ui.el.modalFoot.appendChild(close);
}

/**
 * 打开庇护所面板。
 * @param {import('./ui.js').GameUI} ui
 * @param {'stash'|'merchant'|'gambler'} kind
 */
export function openHomePanel(ui, kind) {
  if (!ui || !ui.game || !ui.game.world) return;
  const title = KIND_TITLE[kind];
  if (!title) return;
  if (ui.el.modalTitle) ui.el.modalTitle.textContent = title;
  if (ui.el.modalFoot) ui.el.modalFoot.innerHTML = '';
  if (kind === 'stash') renderStash(ui);
  else if (kind === 'merchant') renderMerchant(ui);
  else if (kind === 'gambler') renderGambler(ui);
}

/** 背包 / 金币变化后，如果当前正打开某个庇护所面板就原地重绘。 */
export function refreshHomePanel(ui) {
  if (!ui || !ui.modalOpen || !ui.modalOpen.startsWith('home-')) return false;
  openHomePanel(ui, ui.modalOpen.slice(5));
  return true;
}