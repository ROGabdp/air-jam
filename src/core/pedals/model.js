// Pedalboard data model: pedal types and their knobs, presets, simple/advanced mode, chain order,
// and persistence. Pure data plus a small store with subscribe(); the DSP side only reads
// snapshots, the drawing side only reads snapshots and sends intents (toggle, setParam, …).
// Knob values are stored normalised (0..1); knobValue() maps them to physical units for the DSP.

import { WAH_RANGES, WAH_DEFAULT_KNOBS } from '../audio/wah.js';
import { CHORUS_RANGES, CHORUS_DEFAULT_KNOBS } from '../audio/post-fx/chorus.js';
import { DELAY_RANGES, DELAY_DEFAULT_KNOBS } from '../audio/post-fx/delay.js';
import { REVERB_SIZES, REVERB_RANGES, REVERB_DEFAULT_KNOBS } from '../audio/post-fx/reverb.js';

const clamp01 = v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

export const STORAGE_KEY = 'airJam.pedalboard.v1';
export const AMP = 'amp';
// Classic order: wah → overdrive → distortion → amp/cabinet → chorus → delay → reverb.
export const STANDARD_ORDER = ['wah', 'overdrive', 'distortion', AMP, 'chorus', 'delay', 'reverb'];
export const PEDAL_IDS = STANDARD_ORDER.filter(id => id !== AMP);
export const MODES = ['simple', 'advanced'];
export const MAX_SIMPLE_KNOBS = 2;
// Pedals whose sound (DSP) exists: all six now. A pedal added later without DSP stays in the model and
// is drawn but silent; snapshots carry `sound: false` for it so a view can say so.
export const PEDALS_WITH_SOUND = ['wah', 'overdrive', 'distortion', 'chorus', 'delay', 'reverb'];

const level = { id: 'level', label: 'pedal.knob.level', min: -12, max: 6, unit: 'dB', default: 0.67, simple: false };

/**
 * Knob: { id, label (i18n key), min, max, unit, curve ('linear' | 'log'), default (0..1),
 *         simple (shown in simple mode), advanced? (false: hidden in advanced mode, which has finer
 *         knobs for it), steps? (i18n keys; value snaps to step / (n − 1)),
 *         toggle? (drawn as a button that cycles its steps), hidden? (not drawn as a knob) }
 * mainKnob: the knob the pedal's big disc (footswitch) turns when dragged (owner 2026-11-25), a
 * knob id or a function of the pedal's params; the disc and the small knob share that one value.
 * Physical ranges are starting points from docs/效果器研究.md 4.3; the tone lab decides the rest.
 */
export const PEDAL_TYPES = {
  // Wah (src/core/audio/wah.js): position from the edge strip (hand) or from strums / the beat
  // (auto). Simple: 手控／自動 and 範圍 (sweep width around ~1 kHz, 0.5 = the classic 450 Hz–2.2 kHz);
  // advanced: heel and toe frequencies, resonance, auto source, sensitivity, attack, decay, level.
  wah: {
    label: 'pedal.wah', hue: 285, icon: 'wah',
    // Hand mode: the pedal itself (what the strip and the wheel move); auto: how far strums open it.
    mainKnob: params => (params.mode >= 0.5 ? 'sensitivity' : 'position'),
    knobs: [
      { id: 'position', label: 'pedal.knob.position', min: 0, max: 1, unit: '', default: 0.5, simple: false, hidden: true },
      { id: 'mode', label: 'pedal.knob.wahMode', min: 0, max: 1, unit: '', default: 1, simple: true, toggle: true, steps: ['pedal.step.hand', 'pedal.step.auto'] },
      { id: 'range', label: 'pedal.knob.range', min: WAH_RANGES.octaves[0], max: WAH_RANGES.octaves[1], unit: 'oct', default: WAH_DEFAULT_KNOBS.range, simple: true, advanced: false },
      { id: 'source', label: 'pedal.knob.wahSource', min: 0, max: 1, unit: '', default: 0, simple: false, toggle: true, steps: ['pedal.step.strum', 'pedal.step.beat'] },
      { id: 'low', label: 'pedal.knob.low', min: WAH_RANGES.lowHz[0], max: WAH_RANGES.lowHz[1], unit: 'Hz', curve: 'log', default: WAH_DEFAULT_KNOBS.low, simple: false },
      { id: 'high', label: 'pedal.knob.high', min: WAH_RANGES.highHz[0], max: WAH_RANGES.highHz[1], unit: 'Hz', curve: 'log', default: WAH_DEFAULT_KNOBS.high, simple: false },
      { id: 'resonance', label: 'pedal.knob.resonance', min: WAH_RANGES.resonance[0], max: WAH_RANGES.resonance[1], unit: '×', curve: 'log', default: WAH_DEFAULT_KNOBS.resonance, simple: false },
      { id: 'sensitivity', label: 'pedal.knob.sensitivity', min: 0, max: 100, unit: '%', default: WAH_DEFAULT_KNOBS.sensitivity, simple: false },
      { id: 'attack', label: 'pedal.knob.attack', min: WAH_RANGES.attackMs[0], max: WAH_RANGES.attackMs[1], unit: 'ms', curve: 'log', default: WAH_DEFAULT_KNOBS.attack, simple: false },
      { id: 'decay', label: 'pedal.knob.decay', min: WAH_RANGES.decayMs[0], max: WAH_RANGES.decayMs[1], unit: 'ms', curve: 'log', default: WAH_DEFAULT_KNOBS.decay, simple: false },
      level,
    ],
  },
  overdrive: {
    label: 'pedal.overdrive', hue: 45, icon: 'overdrive',
    mainKnob: 'drive',
    knobs: [
      { id: 'drive', label: 'pedal.knob.drive', min: 12, max: 36, unit: 'dB', default: 0.35, simple: true },
      { id: 'tone', label: 'pedal.knob.tone', min: -8, max: 6, unit: 'dB', default: 0.55, simple: true },
      level,
    ],
  },
  distortion: {
    label: 'pedal.distortion', hue: 2, icon: 'distortion',
    mainKnob: 'drive',
    knobs: [
      { id: 'drive', label: 'pedal.knob.drive', min: 10, max: 46, unit: 'dB', default: 0.5, simple: true },
      { id: 'tone', label: 'pedal.knob.tone', min: 0, max: 1, unit: '', default: 0.5, simple: true },
      level,
    ],
  },
  // Chorus (src/core/audio/post-fx/chorus.js): simple 速度 and 深度 (the CE-2's two knobs; mix fixed at
  // 40 %); advanced adds 混合, 音色 (wet low-pass), 寬度 (stereo spread) and 音量.
  chorus: {
    label: 'pedal.chorus', hue: 165, icon: 'chorus',
    mainKnob: 'depth',
    knobs: [
      { id: 'rate', label: 'pedal.knob.rate', min: CHORUS_RANGES.rateHz[0], max: CHORUS_RANGES.rateHz[1], unit: 'Hz', curve: 'log', default: CHORUS_DEFAULT_KNOBS.rate, simple: true },
      { id: 'depth', label: 'pedal.knob.depth', min: CHORUS_RANGES.depthMs[0], max: CHORUS_RANGES.depthMs[1], unit: 'ms', default: CHORUS_DEFAULT_KNOBS.depth, simple: true },
      { id: 'mix', label: 'pedal.knob.mix', min: CHORUS_RANGES.mixPercent[0], max: CHORUS_RANGES.mixPercent[1], unit: '%', default: CHORUS_DEFAULT_KNOBS.mix, simple: false },
      { id: 'tone', label: 'pedal.knob.tone', min: CHORUS_RANGES.toneHz[0], max: CHORUS_RANGES.toneHz[1], unit: 'Hz', curve: 'log', default: CHORUS_DEFAULT_KNOBS.tone, simple: false },
      { id: 'width', label: 'pedal.knob.width', min: CHORUS_RANGES.widthPercent[0], max: CHORUS_RANGES.widthPercent[1], unit: '%', default: CHORUS_DEFAULT_KNOBS.width, simple: false },
      { ...level, default: CHORUS_DEFAULT_KNOBS.level },
    ],
  },
  // Delay (src/core/audio/post-fx/delay.js): the time follows the song's pulse by itself. Simple:
  // 回音量 (wet mix) and 重複 (feedback); advanced adds 跟拍子／自由, 拍長 (短 ×½ / 中 / 長 ×2 of the
  // synced time), 自由 time, 音色 (loop low-pass), 來回 (ping-pong), 換和弦收 and level.
  delay: {
    label: 'pedal.delay', hue: 212, icon: 'delay',
    mainKnob: 'mix',
    knobs: [
      { id: 'mix', label: 'pedal.knob.echoLevel', min: DELAY_RANGES.mix[0], max: DELAY_RANGES.mix[1], unit: '%', default: DELAY_DEFAULT_KNOBS.mix, simple: true },
      { id: 'feedback', label: 'pedal.knob.feedback', min: DELAY_RANGES.feedback[0], max: DELAY_RANGES.feedback[1], unit: '%', default: DELAY_DEFAULT_KNOBS.feedback, simple: true },
      { id: 'sync', label: 'pedal.knob.delaySync', min: 0, max: 1, unit: '', default: DELAY_DEFAULT_KNOBS.sync, simple: false, toggle: true, steps: ['pedal.step.followBeat', 'pedal.step.freeTime'] },
      { id: 'time', label: 'pedal.knob.delayTime', min: 0, max: 2, unit: '', default: DELAY_DEFAULT_KNOBS.time, simple: false, steps: ['pedal.step.short', 'pedal.step.medium', 'pedal.step.long'] },
      { id: 'free', label: 'pedal.knob.freeTime', min: DELAY_RANGES.freeMs[0], max: DELAY_RANGES.freeMs[1], unit: 'ms', curve: 'log', default: DELAY_DEFAULT_KNOBS.free, simple: false },
      { id: 'tone', label: 'pedal.knob.tone', min: DELAY_RANGES.toneHz[0], max: DELAY_RANGES.toneHz[1], unit: 'Hz', curve: 'log', default: DELAY_DEFAULT_KNOBS.tone, simple: false },
      { id: 'pingpong', label: 'pedal.knob.pingpong', min: 0, max: 1, unit: '', default: DELAY_DEFAULT_KNOBS.pingpong, simple: false, toggle: true, steps: ['pedal.step.centre', 'pedal.step.pingpong'] },
      { id: 'duck', label: 'pedal.knob.duck', min: DELAY_RANGES.duck[0], max: DELAY_RANGES.duck[1], unit: '%', default: DELAY_DEFAULT_KNOBS.duck, simple: false },
      level,
    ],
  },
  // Reverb (src/core/audio/post-fx/reverb.js): simple = 大小 (four rooms, 0.5–3.6 s) and 混合;
  // advanced adds 音色 (wet low-pass), 預延遲, 低頻切除 (wet high-pass) and 音量 (wet level).
  reverb: {
    label: 'pedal.reverb', hue: 250, icon: 'reverb',
    mainKnob: 'mix',
    knobs: [
      { id: 'size', label: 'pedal.knob.size', min: 0, max: REVERB_SIZES.length - 1, unit: '', default: REVERB_DEFAULT_KNOBS.size, simple: true, steps: REVERB_SIZES.map(s => s.label) },
      { id: 'mix', label: 'pedal.knob.mix', min: REVERB_RANGES.mix[0], max: REVERB_RANGES.mix[1], unit: '%', default: REVERB_DEFAULT_KNOBS.mix, simple: true },
      { id: 'tone', label: 'pedal.knob.tone', min: REVERB_RANGES.toneHz[0], max: REVERB_RANGES.toneHz[1], unit: 'Hz', curve: 'log', default: REVERB_DEFAULT_KNOBS.tone, simple: false },
      { id: 'preDelay', label: 'pedal.knob.preDelay', min: REVERB_RANGES.preDelayMs[0], max: REVERB_RANGES.preDelayMs[1], unit: 'ms', default: REVERB_DEFAULT_KNOBS.preDelay, simple: false },
      { id: 'lowCut', label: 'pedal.knob.lowCut', min: REVERB_RANGES.lowCutHz[0], max: REVERB_RANGES.lowCutHz[1], unit: 'Hz', curve: 'log', default: REVERB_DEFAULT_KNOBS.lowCut, simple: false },
      level,
    ],
  },
};

// The amp is always on and has no footswitch; its knobs live on the board, not in a pedal.
// 延音 (sustain, src/core/audio/karplus.js SUSTAINER): 0 = off, today's sound; it is a playing
// preference like the wah position, so presets keep it and changing it does not make the preset
// 自訂. In simple mode it is the third big knob of the tuning screen (MACROS.sustain); in advanced
// mode it is on the amp's panel.
export const AMP_TYPE = {
  label: 'pedal.amp', icon: 'amp',
  knobs: [
    { id: 'sustain', label: 'pedal.knob.sustain', min: 0, max: 100, unit: '%', default: 0, simple: true },
  ],
};

// Presets (names from the owner). Each lists the pedals that are on and the knobs that differ from
// their defaults. Values: src/core/audio/electric-rig.js (搖滾 is the tone lab's 丁; 重金屬 goes past
// it into the fuzz end of the distortion), measured with tools/tone-lab/measure.mjs. Pedals without
// sound yet (PEDALS_WITH_SOUND) stay off in every preset.
export const PRESETS = [
  { id: 'clean', label: 'preset.clean', on: {} },
  { id: 'crunch', label: 'preset.crunch', on: { overdrive: { drive: 0.65, tone: 0.6 } } },
  { id: 'rock', label: 'preset.rock', on: { overdrive: { drive: 0.266, tone: 0.571 }, distortion: { drive: 0.491, tone: 0.5 } } },
  { id: 'metal', label: 'preset.metal', on: { overdrive: { drive: 0.45, tone: 0.62 }, distortion: { drive: 0.9, tone: 0.58 } } },
];
export const DEFAULT_PRESET = 'rock';

// Macro knobs in the simple tuning screen: each moves a knob of several pedals together.
export const MACROS = {
  drive: { label: 'pedal.macro.drive', targets: [['overdrive', 'drive'], ['distortion', 'drive']] },
  tone: { label: 'pedal.macro.tone', targets: [['overdrive', 'tone'], ['distortion', 'tone']] },
  sustain: { label: 'pedal.macro.sustain', targets: [[AMP, 'sustain']] },
};

// The knob a pedal's big disc turns (null: none), for the pedal's current params.
export function mainKnobOf(pedalId, params = {}) {
  const main = PEDAL_TYPES[pedalId]?.mainKnob;
  return (typeof main === 'function' ? main(params) : main) ?? null;
}

const typeOf = id => (id === AMP ? AMP_TYPE : PEDAL_TYPES[id]);
export const knobOf = (pedalId, knobId) => typeOf(pedalId)?.knobs.find(k => k.id === knobId) ?? null;

// Knobs drawn as knobs for a mode (the wah position lives on the edge strip, not on a knob).
export function visibleKnobs(pedalId, mode) {
  return typeOf(pedalId).knobs.filter(k => !k.hidden && (mode === 'advanced' ? k.advanced !== false : k.simple));
}

export function snapKnob(knob, value) {
  const v = clamp01(value);
  if (!knob?.steps) return v;
  const n = knob.steps.length - 1;
  return Math.round(v * n) / n;
}

export const stepIndex = (knob, value) => Math.round(snapKnob(knob, value) * (knob.steps.length - 1));

// Normalised 0..1 → physical value (dB, Hz, ms, %, or the step index for stepped knobs).
export function knobValue(knob, value) {
  const v = snapKnob(knob, value);
  if (knob.steps) return stepIndex(knob, v);
  if (knob.curve === 'log') return knob.min * Math.pow(knob.max / knob.min, v);
  return knob.min + (knob.max - knob.min) * v;
}

function defaultPedal(id) {
  const params = {};
  for (const knob of PEDAL_TYPES[id].knobs) params[knob.id] = knob.default;
  return { on: false, params };
}

function defaultAmp() {
  const params = {};
  for (const knob of AMP_TYPE.knobs) params[knob.id] = knob.default;
  return { params };
}

function presetPedals(presetId) {
  const preset = PRESETS.find(p => p.id === presetId) ?? PRESETS.find(p => p.id === DEFAULT_PRESET);
  const pedals = {};
  for (const id of PEDAL_IDS) {
    pedals[id] = defaultPedal(id);
    const overrides = preset.on[id];
    if (!overrides) continue;
    pedals[id].on = true;
    for (const [knobId, value] of Object.entries(overrides)) pedals[id].params[knobId] = snapKnob(knobOf(id, knobId), value);
  }
  return pedals;
}

export function defaultBoard() {
  return { mode: 'simple', preset: DEFAULT_PRESET, order: [...STANDARD_ORDER], pedals: presetPedals(DEFAULT_PRESET), amp: defaultAmp() };
}

const isPermutation = order => Array.isArray(order) && order.length === STANDARD_ORDER.length
  && STANDARD_ORDER.every(id => order.includes(id));

export function serializeBoard(board) {
  const pedals = {};
  for (const id of PEDAL_IDS) pedals[id] = { on: board.pedals[id].on, params: { ...board.pedals[id].params } };
  return { v: 1, mode: board.mode, preset: board.preset, order: [...board.order], pedals, amp: { params: { ...board.amp.params } } };
}

// Accepts anything (old versions, hand-edited storage, garbage) and returns a valid board.
export function deserializeBoard(data) {
  const board = defaultBoard();
  if (!data || typeof data !== 'object' || data.v !== 1) return board;
  if (MODES.includes(data.mode)) board.mode = data.mode;
  board.preset = PRESETS.some(p => p.id === data.preset) ? data.preset : null;
  if (isPermutation(data.order)) board.order = [...data.order];
  for (const id of PEDAL_IDS) {
    const saved = data.pedals?.[id];
    if (!saved || typeof saved !== 'object') continue;
    board.pedals[id].on = saved.on === true;
    for (const knob of PEDAL_TYPES[id].knobs) {
      const value = saved.params?.[knob.id];
      if (typeof value === 'number' && Number.isFinite(value)) board.pedals[id].params[knob.id] = snapKnob(knob, value);
    }
  }
  // Boards saved before the amp had knobs have no `amp`: defaults (延音 off).
  for (const knob of AMP_TYPE.knobs) {
    const value = data.amp?.params?.[knob.id];
    if (typeof value === 'number' && Number.isFinite(value)) board.amp.params[knob.id] = snapKnob(knob, value);
  }
  return board;
}

export function loadBoard(storage, key = STORAGE_KEY) {
  try {
    const text = storage?.getItem(key);
    return text ? deserializeBoard(JSON.parse(text)) : defaultBoard();
  } catch {
    return defaultBoard();
  }
}

export function saveBoard(storage, board, key = STORAGE_KEY) {
  try {
    storage?.setItem(key, JSON.stringify(serializeBoard(board)));
    return true;
  } catch {
    return false;
  }
}

// What the DSP needs: effective chain order (simple mode always uses the classic order), whether
// levels are automatic, and every pedal's on/off with normalised and physical knob values. `sound`
// says whether the pedal has DSP yet (the others are silent: a view can show them as coming soon).
export function boardSnapshot(board) {
  const pedals = {};
  for (const id of PEDAL_IDS) {
    const { on, params } = board.pedals[id];
    const values = {};
    for (const knob of PEDAL_TYPES[id].knobs) values[knob.id] = knobValue(knob, params[knob.id]);
    pedals[id] = { on, sound: PEDALS_WITH_SOUND.includes(id), params: { ...params }, values };
  }
  const simple = board.mode === 'simple';
  const ampValues = {};
  for (const knob of AMP_TYPE.knobs) ampValues[knob.id] = knobValue(knob, board.amp.params[knob.id]);
  return {
    mode: board.mode,
    autoLevel: simple,
    preset: board.preset,
    order: simple ? [...STANDARD_ORDER] : [...board.order],
    pedals,
    amp: { params: { ...board.amp.params }, values: ampValues },
  };
}

/**
 * The store. Listeners get (snapshot, change), change being one of
 *   { type: 'toggle', id, on } · { type: 'param', id, knob, value, commit } · { type: 'order', order }
 *   { type: 'preset', id } · { type: 'mode', mode } · { type: 'load' }
 * Params set with commit = false (a knob being dragged, the wah strip) are not saved until a
 * committing change arrives, so storage is not written 30 times a second.
 */
export function createPedalModel({ storage = null, key = STORAGE_KEY } = {}) {
  let board = loadBoard(storage, key);
  const listeners = new Set();

  function emit(change, save = true) {
    if (save) saveBoard(storage, board, key);
    if (!listeners.size) return;
    const snapshot = boardSnapshot(board);
    for (const listener of listeners) {
      try { listener(snapshot, change); } catch (error) { console.warn('[Air Jam] pedal listener failed:', error); }
    }
  }

  const paramsOf = id => (id === AMP ? board.amp.params : board.pedals[id]?.params);
  const macroValue = name => {
    const targets = MACROS[name].targets;
    return targets.reduce((sum, [id, knob]) => sum + paramsOf(id)[knob], 0) / targets.length;
  };

  const api = {
    get board() { return board; },
    get mode() { return board.mode; },
    get preset() { return board.preset; },
    snapshot: () => boardSnapshot(board),
    // Pedals in chain order, without the amp (the footswitch row).
    pedalOrder: () => boardSnapshot(board).order.filter(id => id !== AMP),
    isOn: id => board.pedals[id]?.on === true,
    param: (id, knob) => paramsOf(id)?.[knob],
    mainKnob: id => mainKnobOf(id, board.pedals[id]?.params),

    toggle(id, on) {
      if (!board.pedals[id]) return false;
      const next = on === undefined ? !board.pedals[id].on : !!on;
      if (next === board.pedals[id].on) return next;
      board.pedals[id].on = next;
      board.preset = null;
      emit({ type: 'toggle', id, on: next });
      return next;
    },

    setParam(id, knobId, value, { commit = true } = {}) {
      const knob = knobOf(id, knobId);
      if (!knob) return null;
      const params = paramsOf(id);
      const next = snapKnob(knob, value);
      const changed = next !== params[knobId];
      params[knobId] = next;
      // The wah position and the amp's 延音 are playing controls, not part of the sound a preset
      // describes.
      if (changed && knobId !== 'position' && id !== AMP) board.preset = null;
      if (changed || commit) emit({ type: 'param', id, knob: knobId, value: next, commit }, commit);
      return next;
    },

    // Stepped knobs: next step, wrapping (tap on a stepped knob or a toggle button).
    cycle(id, knobId) {
      const knob = knobOf(id, knobId);
      if (!knob?.steps) return null;
      const n = knob.steps.length - 1;
      return api.setParam(id, knobId, ((stepIndex(knob, paramsOf(id)[knobId]) + 1) % (n + 1)) / n);
    },

    applyPreset(presetId) {
      if (!PRESETS.some(p => p.id === presetId)) return false;
      const position = board.pedals.wah.params.position;
      board.pedals = presetPedals(presetId);
      board.pedals.wah.params.position = position;
      board.preset = presetId;
      emit({ type: 'preset', id: presetId });
      return true;
    },

    setMode(mode) {
      if (!MODES.includes(mode) || mode === board.mode) return;
      board.mode = mode;
      emit({ type: 'mode', mode });
    },

    // Advanced mode: move a chain item (pedal or amp) one place left (−1) or right (+1).
    move(id, delta) {
      const from = board.order.indexOf(id);
      const to = from + Math.sign(delta);
      if (from < 0 || to < 0 || to >= board.order.length) return false;
      [board.order[from], board.order[to]] = [board.order[to], board.order[from]];
      board.preset = null;
      emit({ type: 'order', order: [...board.order] });
      return true;
    },

    macro: macroValue,
    macroBase(name) {
      return { mean: macroValue(name), values: MACROS[name].targets.map(([id, knob]) => paramsOf(id)[knob]) };
    },
    // Moves every target by the same amount from where they were when the drag started (base), so
    // the knobs keep their offsets and clamping at one end never makes the others drift.
    setMacro(name, value, base = api.macroBase(name), options) {
      const delta = clamp01(value) - base.mean;
      MACROS[name].targets.forEach(([id, knob], i) => api.setParam(id, knob, base.values[i] + delta, options));
    },

    reset() {
      board = defaultBoard();
      emit({ type: 'load' });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return api;
}
