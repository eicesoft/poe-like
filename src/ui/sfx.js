// @file src/ui/sfx.js
// UI 音效：用 WebAudio **现场合成**（零外部素材，避免打包体积与版权问题）。
//
// 【为什么这么做】
//   1. 项目是纯前端原生 ES Module，没有资源加载管线；用振荡器 + 噪声 buffer 合成几百毫秒的短音
//      是最轻的方案，也不需要等网络。
//   2. 测试在 Node + 极简 DOM 桩下跑 UI 层（tests/ui-dom.test.mjs），那里既没有 AudioContext
//      也没有真 document；所以本模块的每一层都必须「特性检测 + try/catch」，任何环境下调用都是 no-op。
//   3. AudioContext 在浏览器里必须由用户手势触发才能出声（自动播放策略），所以 ctx 采用惰性创建：
//      第一次真正播放时才 new，且失败就永久标记为不可用，不反复重试（避免控制台刷屏）。
//
// 【静音开关】
//   状态写 localStorage（键 sfx-muted），读不到（隐私模式/Node/桩环境）时按「未静音」处理。

/** localStorage 键：静音状态 */
const MUTE_KEY = 'ember_sfx_muted';

/** @type {AudioContext|null} 惰性创建的音频上下文 */
let ctx = null;
/** @type {boolean} 上下文创建失败（或环境不支持）后永久置位，后续全部短路 */
let disabled = false;
/** @type {boolean} 是否静音（可从 localStorage 恢复） */
let muted = false;
/** @type {AudioNode|null} 总输出（静音时把 gain 拉到 0，比逐个节点判断更省事） */
let master = null;

// ---------------------------------------------------------------------------
// 安全的存储访问（Node / 隐私模式下 localStorage 可能不存在或抛异常）
// ---------------------------------------------------------------------------
function readStoredMute() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return false;
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStoredMute(v) {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return;
    localStorage.setItem(MUTE_KEY, v ? '1' : '0');
  } catch {
    /* 存储不可用：只在内存里记状态即可 */
  }
}

muted = readStoredMute();

/**
 * 惰性创建 AudioContext；失败则禁用整个模块。
 * @returns {AudioContext|null}
 */
function ensureContext() {
  if (disabled) return null;
  if (ctx) return ctx;
  try {
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) { disabled = true; return null; }
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.32; // 32% 总音量：UI 音效不能盖过游戏本体
    master.connect(ctx.destination);
    return ctx;
  } catch {
    disabled = true;
    ctx = null;
    master = null;
    return null;
  }
}

/**
 * 播一个合成音符（振荡器 + 指数衰减包络）。
 * @param {number} freq 起始频率（Hz）
 * @param {number} dur 时长（秒）
 * @param {Object} [opts]
 * @param {OscillatorType} [opts.type='sine'] 波形
 * @param {number} [opts.gain=0.3] 峰值音量
 * @param {number} [opts.delay=0] 相对当前时间的延迟（秒），用于琶音
 * @param {number} [opts.slideTo] 结束频率（做「叮」的上滑/下滑）
 */
function tone(freq, dur, opts = {}) {
  const c = ensureContext();
  if (!c || !master) return;
  try {
    const t0 = c.currentTime + (opts.delay || 0);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.slideTo && Number.isFinite(opts.slideTo)) {
      // 指数斜坡比线性更接近自然泛音；目标频率必须 > 0
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slideTo), t0 + dur);
    }
    const peak = Math.max(0.0001, opts.gain == null ? 0.3 : opts.gain);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.02, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch {
    /* 单个音符失败无所谓，不影响游戏 */
  }
}

/**
 * 播一小段滤波噪声（金属"叮"的质感靠它，纯正弦听起来太电子）。
 * @param {number} dur 秒
 * @param {number} [freq=3200] 带通中心频率
 * @param {number} [gain=0.12]
 */
function noiseBurst(dur, freq = 3200, gain = 0.12) {
  const c = ensureContext();
  if (!c || !master) return;
  try {
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      // 白噪声 × 线性衰减包络（越往后的样本越轻，天然就是打击感）
      data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 6;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(bp);
    bp.connect(g);
    g.connect(master);
    src.start(c.currentTime);
  } catch {
    /* ignore */
  }
}

/**
 * 播放一个具名音效。
 * @param {'levelUp'|'refine'|'rankUp'|'orb'|'respec'|'deny'} name
 */
export function playSfx(name) {
  if (muted) return;
  if (!ensureContext()) return;
  // 浏览器会把"非用户手势"期间创建/恢复的上下文挂起，这里顺便尝试恢复
  try { if (ctx.state === 'suspended' && ctx.resume) ctx.resume(); } catch { /* ignore */ }
  try {
    switch (name) {
      case 'levelUp':
        // 升级：上行三音（大三和弦琶音 C5-E5-G5），明亮但短
        tone(523.25, 0.16, { type: 'triangle', gain: 0.26 });
        tone(659.25, 0.16, { type: 'triangle', gain: 0.24, delay: 0.07 });
        tone(783.99, 0.3, { type: 'triangle', gain: 0.22, delay: 0.14 });
        tone(1046.5, 0.34, { type: 'sine', gain: 0.12, delay: 0.14 });
        break;
      case 'refine':
        // 精炼：金属叮（高频正弦上滑 + 窄带噪声），像铁匠敲到炉火正好的那一刻
        tone(1760, 0.22, { type: 'sine', gain: 0.22, slideTo: 2640 });
        tone(2640, 0.5, { type: 'sine', gain: 0.1, delay: 0.03 });
        noiseBurst(0.14, 4200, 0.1);
        break;
      case 'rankUp':
        // 点技能：短促的「咔」，低频方波极短 + 一点点噪声
        tone(220, 0.055, { type: 'square', gain: 0.12, slideTo: 320 });
        noiseBurst(0.035, 1800, 0.05);
        break;
      case 'orb':
        // 拾取精炼石：轻叮（两个高音，第二个更轻）
        tone(1318.5, 0.1, { type: 'sine', gain: 0.16 });
        tone(1975.5, 0.16, { type: 'sine', gain: 0.1, delay: 0.05 });
        break;
      case 'respec':
        // 重置：下行两音，提示"收回了"
        tone(660, 0.12, { type: 'triangle', gain: 0.18, slideTo: 440 });
        tone(440, 0.22, { type: 'triangle', gain: 0.14, delay: 0.1 });
        break;
      case 'deny':
        // 操作被拒绝：低沉的钝音，不要刺耳（这是高频反馈，音量一定要小）
        tone(150, 0.12, { type: 'sawtooth', gain: 0.07, slideTo: 110 });
        break;
      default:
        break;
    }
  } catch {
    /* 合成失败绝不影响游戏逻辑 */
  }
}

/** 当前是否静音 */
export function isMuted() {
  return muted;
}

/**
 * 切换静音，返回切换后的状态。
 * @returns {boolean} 切换后是否静音
 */
export function toggleMute() {
  muted = !muted;
  writeStoredMute(muted);
  try {
    if (master) master.gain.value = muted ? 0 : 0.32;
  } catch { /* ignore */ }
  return muted;
}

/**
 * 显式设置静音（供 HUD 按钮/初始化使用）。
 * @param {boolean} v
 * @returns {boolean} 设置后是否静音
 */
export function setMuted(v) {
  const next = !!v;
  if (next === muted) return muted;
  return toggleMute();
}

export default { playSfx, isMuted, toggleMute, setMuted };