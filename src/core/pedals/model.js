// Pedalboard data model: pedal types and their knobs, presets, simple/advanced mode, chain order,
// and persistence. Pure data plus a small store with subscribe(); the DSP side only reads
// snapshots, the drawing side only reads snapshots and sends intents (toggle, setParam, …).
// Knob values are stored normalised (0..1); knobValue() maps them to physical units for the DSP.

const clamp01 = v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

export const STORAGE_KEY = 'airJam.pedalboard.v1';
export const AMP = 'amp';
// Classic order: wah → overdrive → distortion → amp/cabinet → chorus → delay → reverb.
export const STANDARD_ORDER = ['wah', 'overdrive', 'distortion', AMP, 'chorus', 'delay', 'reverb'];
export const PEDAL_IDS = STANDARD_ORDER.filter(id => id !== AMP);
export const MODES = ['simple', 'advanced'];
export const MAX_SIMPLE_KNOBS = 2;

const level = { id: 'level', label: 'pedal.knob.level', min: -12, max: 6, unit: 'dB', default: 0.67, simple: false };

/**
 * Knob: { id, label (i18n key), min, max, unit, curve ('linear' | 'log'), default (0..1),
 *         simple (shown in simple mode), steps? (i18n keys; value snaps to step / (n − 1)),
 *         toggle? (drawn as a button that cycles its steps), hidden? (not drawn as a knob) }
 * Physical ranges are starting points from docs/效果器研究.md 4.3; the tone lab decides the rest.
 */
export const PEDAL_TYPES = {
  wah: {
    label: 'pedal.wah', hue: 285, icon: 'wah',
    knobs: [
      { id: 'position', label: 'pedal.knob.position', min: 0, max: 1, unit: '', default: 0.5, simple: false, hidden: true },
      { id: 'range', label: 'pedal.knob.range', min: 350, max: 500, unit: 'Hz', default: 0.5, simple: true },
      { id: 'mode', label: 'pedal.knob.wahMode', min: 0, max: 1, unit: '', default: 1, simple: true, toggle: true, steps: ['pedal.step.hand', 'pedal.step.auto'] },
      { id: 'resonance', label: 'pedal.knob.resonance', min: 0.5, max: 2, unit: '×', curve: 'log', default: 0.5, simple: false },
      level,
    ],
  },
  overdrive: {
    label: 'pedal.overdrive', hue: 45, icon: 'overdrive',
    knobs: [
      { id: 'drive', label: 'pedal.knob.drive', min: 12, max: 36, unit: 'dB', default: 0.35, simple: true },
      { id: 'tone', label: 'pedal.knob.tone', min: -8, max: 6, unit: 'dB', default: 0.55, simple: true },
      level,
    ],
  },
  distortion: {
    label: 'pedal.distortion', hue: 2, icon: 'distortion',
    knobs: [
      { id: 'drive', label: 'pedal.knob.drive', min: 10, max: 40, unit: 'dB', default: 0.5, simple: true },
      { id: 'tone', label: 'pedal.knob.mids', min: 0, max: 1, unit: '', default: 0.5, simple: true },
      level,
    ],
  },
  chorus: {
    label: 'pedal.chorus', hue: 165, icon: 'chorus',
    knobs: [
      { id: 'depth', label: 'pedal.knob.depth', min: 0, max: 3, unit: 'ms', default: 0.5, simple: true },
      { id: 'mix', label: 'pedal.knob.mix', min: 0, max: 50, unit: '%', default: 0.5, simple: true },
      { id: 'rate', label: 'pedal.knob.rate', min: 0.1, max: 3, unit: 'Hz', curve: 'log', default: 0.4, simple: false },
      level,
    ],
  },
  delay: {
    label: 'pedal.delay', hue: 212, icon: 'delay',
    knobs: [
      { id: 'time', label: 'pedal.knob.time', min: 0, max: 2, unit: '', default: 0.5, simple: true, steps: ['pedal.step.short', 'pedal.step.dotted', 'pedal.step.long'] },
      { id: 'mix', label: 'pedal.knob.mix', min: 0, max: 40, unit: '%', default: 0.5, simple: true },
      { id: 'feedback', label: 'pedal.knob.feedback', min: 0, max: 0.6, unit: '', default: 0.5, simple: false },
      level,
    ],
  },
  reverb: {
    label: 'pedal.reverb', hue: 250, icon: 'reverb',
    knobs: [
      { id: 'size', label: 'pedal.knob.size', min: 0, max: 2, unit: '', default: 0.5, simple: true, steps: ['pedal.step.small', 'pedal.step.medium', 'pedal.step.large'] },
      { id: 'mix', label: 'pedal.knob.mix', min: 0, max: 35, unit: '%', default: 0.4, simple: true },
      { id: 'tone', label: 'pedal.knob.tone', min: 0, max: 1, unit: '', default: 0.5, simple: false },
      level,
    ],
  },
};

// Placeholder presets (names from the owner, contents to be replaced by what the tone lab picks).
// Each lists the pedals that are on and the knobs that differ from their defaults.
export const PRESETS = [
  { id: 'clean', label: 'preset.clean', on: { reverb: { mix: 0.45 } } },
  { id: 'crunch', label: 'preset.crunch', on: { overdrive: { drive: 0.45, tone: 0.55 }, reverb: { mix: 0.3 } } },
  { id: 'rock', label: 'preset.rock', on: { overdrive: { drive: 0.3, tone: 0.5 }, distortion: { drive: 0.5, tone: 0.6 }, reverb: { mix: 0.25, size: 0 } } },
  { id: 'metal', label: 'preset.metal', on: { overdrive: { drive: 0.15, tone: 0.6 }, distortion: { drive: 0.85, tone: 0.2 }, reverb: { mix: 0.15, size: 0 } } },
];
export const DEFAULT_PRESET = 'rock';

// Macro knobs in the simple tuning screen: each moves a knob of several pedals together.
export const MACROS = {
  drive: { label: 'pedal.macro.drive', targets: [['overdrive', 'drive'], ['distortion', 'drive']] },
  tone: { label: 'pedal.macro.tone', targets: [['overdrive', 'tone'], ['distortion', 'tone']] },
};

export const knobOf = (pedalId, knobId) => PEDAL_TYPES[pedalId]?.knobs.find(k => k.id === knobId) ?? null;

// Knobs drawn as knobs for a mode (the wah position lives on the edge strip, not on a knob).
export function visibleKnobs(pedalId, mode) {
  return PEDAL_TYPES[pedalId].knobs.filter(k => !k.hidden && (mode === 'advanced' || k.simple));
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
  return { mode: 'simple', preset: DEFAULT_PRESET, order: [...STANDARD_ORDER], pedals: presetPedals(DEFAULT_PRESET) };
}

const isPermutation = order => Array.isArray(order) && order.length === STANDARD_ORDER.length
  && STANDARD_ORDER.every(id => order.includes(id));

export function serializeBoard(board) {
  const pedals = {};
  for (const id of PEDAL_IDS) pedals[id] = { on: board.pedals[id].on, params: { ...board.pedals[id].params } };
  return { v: 1, mode: board.mode, preset: board.preset, order: [...board.order], pedals };
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
// levels are automatic, and every pedal's on/off with normalised and physical knob values.
export function boardSnapshot(board) {
  const pedals = {};
  for (const id of PEDAL_IDS) {
    const { on, params } = board.pedals[id];
    const values = {};
    for (const knob of PEDAL_TYPES[id].knobs) values[knob.id] = knobValue(knob, params[knob.id]);
    pedals[id] = { on, params: { ...params }, values };
  }
  const simple = board.mode === 'simple';
  return {
    mode: board.mode,
    autoLevel: simple,
    preset: board.preset,
    order: simple ? [...STANDARD_ORDER] : [...board.order],
    pedals,
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

  const macroValue = name => {
    const targets = MACROS[name].targets;
    return targets.reduce((sum, [id, knob]) => sum + board.pedals[id].params[knob], 0) / targets.length;
  };

  const api = {
    get board() { return board; },
    get mode() { return board.mode; },
    get preset() { return board.preset; },
    snapshot: () => boardSnapshot(board),
    // Pedals in chain order, without the amp (the footswitch row).
    pedalOrder: () => boardSnapshot(board).order.filter(id => id !== AMP),
    isOn: id => board.pedals[id]?.on === true,
    param: (id, knob) => board.pedals[id]?.params[knob],

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
      const next = snapKnob(knob, value);
      const changed = next !== board.pedals[id].params[knobId];
      board.pedals[id].params[knobId] = next;
      // The wah position is a performance control, not part of the sound a preset describes.
      if (changed && knobId !== 'position') board.preset = null;
      if (changed || commit) emit({ type: 'param', id, knob: knobId, value: next, commit }, commit);
      return next;
    },

    // Stepped knobs: next step, wrapping (tap on a stepped knob or a toggle button).
    cycle(id, knobId) {
      const knob = knobOf(id, knobId);
      if (!knob?.steps) return null;
      const n = knob.steps.length - 1;
      return api.setParam(id, knobId, ((stepIndex(knob, board.pedals[id].params[knobId]) + 1) % (n + 1)) / n);
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
      return { mean: macroValue(name), values: MACROS[name].targets.map(([id, knob]) => board.pedals[id].params[knob]) };
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
