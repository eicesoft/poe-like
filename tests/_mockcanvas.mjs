// 极简 Canvas2D 上下文 Mock：记录所有调用，用于在 Node 中跑通渲染代码路径。
// 只实现 renderer/sprites 用到的 API；不追求像素正确，只保证不抛异常并能统计"画了多少东西"。

export function createMockCtx(report) {
  const state = { alpha: 1, gco: 'source-over', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', lineCap: 'butt', lineJoin: 'miter', imageSmoothingEnabled: true };
  const stack = [];
  const grad = () => ({
    addColorStop(pos, color) {
      if (typeof pos !== 'number' || Number.isNaN(pos)) throw new Error('gradient stop pos not number: ' + pos);
      if (typeof color !== 'string' || !color) throw new Error('gradient stop color invalid: ' + color);
      if (state.gco !== undefined) report && (report.stops = (report.stops || 0) + 1);
    },
  });
  const count = (name) => { if (report) report[name] = (report[name] || 0) + 1; };
  const num = (...args) => {
    for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) throw new Error('non-finite coord in call');
  };
  const ctx = {
    get canvas() { return mockCanvas; },
    save() { count('save'); stack.push({ ...state }); },
    restore() { count('restore'); const s = stack.pop(); if (s) Object.assign(state, s); },
    setTransform(...a) { num(...a); count('setTransform'); },
    resetTransform() {},
    scale(...a) { num(...a); },
    translate(...a) { num(...a); },
    rotate(a) { num(a); },
    beginPath() { count('beginPath'); },
    closePath() {},
    moveTo(...a) { num(...a); count('moveTo'); },
    lineTo(...a) { num(...a); count('lineTo'); },
    quadraticCurveTo(...a) { num(...a); },
    bezierCurveTo(...a) { num(...a); },
    arc(...a) { num(...a); count('arc'); if (a[2] < 0) throw new Error('negative arc radius'); },
    ellipse(...a) { num(...a); count('ellipse'); if (a[2] < 0 || a[3] < 0) throw new Error('negative ellipse radius'); },
    rect(...a) { num(...a); },
    fill() { count('fill'); },
    stroke() { count('stroke'); },
    fillRect(...a) { num(...a); count('fillRect'); },
    strokeRect(...a) { num(...a); count('strokeRect'); },
    clearRect(...a) { num(...a); count('clearRect'); },
    fillText(t, x, y) { num(x, y); if (typeof t !== 'string') throw new Error('fillText non-string'); count('fillText'); },
    strokeText(t, x, y) { num(x, y); if (typeof t !== 'string') throw new Error('strokeText non-string'); count('strokeText'); },
    measureText(t) { return { width: String(t).length * 8 }; },
    createLinearGradient(...a) { num(...a); count('linearGradient'); return grad(); },
    createRadialGradient(...a) { num(...a); count('radialGradient'); if (a[2] < 0 || a[5] < 0) throw new Error('negative radial radius'); return grad(); },
    createPattern() { return null; },
    drawImage(img, ...a) { if (!img) throw new Error('drawImage null image'); num(...a); count('drawImage'); },
    clip() {},
    setLineDash() {},
    putImageData() {},
    getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }; },
  };
  for (const k of ['globalAlpha', 'globalCompositeOperation', 'fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textAlign', 'textBaseline', 'lineCap', 'lineJoin', 'imageSmoothingEnabled', 'shadowBlur', 'shadowColor', 'filter']) {
    Object.defineProperty(ctx, k, {
      get() { return state[k]; },
      set(v) {
        if (k === 'fillStyle' || k === 'strokeStyle') {
          if (typeof v === 'string' && /NaN|undefined/.test(v)) throw new Error('invalid color string: ' + v);
        }
        if (k === 'lineWidth' && !(v >= 0)) throw new Error('invalid lineWidth: ' + v);
        state[k] = v;
      },
    });
  }
  let mockCanvas = { width: 800, height: 600 };
  ctx.__setCanvas = (c) => { mockCanvas = c; };
  return ctx;
}

export function createMockCanvas(w = 800, h = 600) {
  const ctx = createMockCtx(null);
  const canvas = {
    width: w,
    height: h,
    clientWidth: w,
    clientHeight: h,
    style: {},
    getContext() { return ctx; },
    getBoundingClientRect() { return { left: 0, top: 0, width: w, height: h }; },
  };
  ctx.__setCanvas(canvas);
  return canvas;
}

/**
 * 安装一个最小 DOM 垫片（document.createElement('canvas') 返回 mock canvas）。
 * 用于测试 renderer.js 在"有 canvas"环境下的完整路径。
 */
export function installMockDom() {
  const prev = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createMockCanvas(400, 300);
      return { style: {}, appendChild() {}, setAttribute() {} };
    },
    getElementById() { return null; },
    body: { appendChild() {} },
  };
  return () => { globalThis.document = prev; };
}