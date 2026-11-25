// node tests/menu.test.mjs
// On-page controls without a browser: remembered preferences and how they merge with the developer
// URL flags, the pedal availability flag (pedals without sound cannot be switched or turned), and
// page buttons pressed by camera hands (pinch-tap; a hand over a button never reaches the strings).
import assert from 'node:assert/strict';
import { createPrefs, prefSpec, loadPrefs, sanitizePrefs, urlOverrides, resolvePrefs, PREFS_KEY } from '../src/app/prefs.js';
import { createHandButtons } from '../src/app/hand-buttons.js';
import { PEDAL_AVAILABLE, isPedalAvailable, setPedalAvailability } from '../src/core/pedals/availability.js';
import { createPedalboard } from '../src/core/pedals/pedalboard.js';
import { wahStripSide, wahStripRect } from '../src/core/pedals/layout.js';
import { createAirStrings } from '../src/instruments/air-strings/index.js';
import { createPitchSnapper } from '../src/core/music/pitch-snap.js';
import { SETTINGS, SNAP_MODES } from '../src/settings.js';

const results = [];
function test(name, fn) {
  try { const note = fn(); results.push({ test: name, result: 'PASS', detail: note ?? '' }); }
  catch (error) { results.push({ test: name, result: 'FAIL', detail: error.message.split('\n')[0] }); }
}
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}
const brokenStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };

// ---------- preferences ----------
const TONES = ['steel', 'nylon', 'electric'];
const ALL_TONES = [...TONES, 'labA', 'labB', 'labC', 'labD'];
const spec = prefSpec({ tones: TONES, snapModes: SNAP_MODES });
const DEFAULTS = { tone: 'steel', snapMode: 'chord', metronome: false, showHand: true, keyGuard: true, pedals: true, mouse: false };
const make = (storage, search = '') => createPrefs({ storage, spec, defaults: DEFAULTS, query: new URLSearchParams(search), allTones: ALL_TONES });

test('prefs: defaults without storage; a choice is remembered across a reload', () => {
  const storage = memoryStorage();
  const first = make(storage);
  assert.deepEqual(first.values, DEFAULTS);
  assert.equal(first.remember('tone', 'electric'), true);
  assert.equal(first.remember('mouse', true), true);
  assert.equal(first.remember('pedals', false), true);
  const second = make(storage);
  assert.equal(second.values.tone, 'electric');
  assert.equal(second.values.mouse, true);
  assert.equal(second.values.pedals, false);
  assert.equal(second.values.snapMode, 'chord', 'untouched settings keep their defaults');
});

test('prefs: handedness (慣用手) is remembered; it puts the wah strip on the other hand’s side', () => {
  const storage = memoryStorage();
  const prefs = createPrefs({ storage, spec, defaults: { ...DEFAULTS, handedness: 'right' }, query: new URLSearchParams(''), allTones: ALL_TONES });
  assert.equal(prefs.values.handedness, 'right');
  assert.equal(prefs.remember('handedness', 'both'), false, 'only right or left');
  assert.equal(prefs.remember('handedness', 'left'), true);
  const again = createPrefs({ storage, spec, defaults: { ...DEFAULTS, handedness: 'right' }, query: new URLSearchParams(''), allTones: ALL_TONES });
  assert.equal(again.values.handedness, 'left');
  assert.equal(SETTINGS.handedness, 'right', 'right-handed by default');
  assert.equal(wahStripSide({ handedness: 'right' }), 'left', 'right-handed: strip on the left edge (the mirrored left hand)');
  assert.equal(wahStripSide({ handedness: 'left' }), 'right');
  const stage = { width: 1280, height: 720 };
  const left = wahStripRect(stage, { ...SETTINGS, handedness: 'right' }), right = wahStripRect(stage, { ...SETTINGS, handedness: 'left' });
  assert.equal(left.x, 0);
  assert.equal(right.x + right.w, stage.width);
});

test('prefs: invalid, unknown and garbage stored values are ignored; broken storage never throws', () => {
  const stored = { tone: 'labA', snapMode: 'jazz', metronome: 'yes', showHand: false, bogus: 1 };
  assert.deepEqual(sanitizePrefs(stored, spec), { showHand: false });
  for (const junk of ['{', '42', '"x"', '[1,2]', 'null']) {
    assert.deepEqual(loadPrefs(memoryStorage({ [PREFS_KEY]: junk }), spec), {}, junk);
  }
  const prefs = make(brokenStorage);
  assert.deepEqual(prefs.values, DEFAULTS);
  assert.equal(prefs.remember('tone', 'nylon'), false, 'write fails quietly');
  assert.equal(make(null).values.tone, 'steel');
});

test('prefs: only button choices can be remembered (no lab tones, no unknown keys)', () => {
  const storage = memoryStorage();
  const prefs = make(storage);
  assert.equal(prefs.remember('tone', 'labA'), false);
  assert.equal(prefs.remember('snapMode', 'jazz'), false);
  assert.equal(prefs.remember('volume', 3), false);
  assert.equal(storage.getItem(PREFS_KEY), null);
});

test('prefs: URL flags win for this visit but are not written back', () => {
  const storage = memoryStorage();
  make(storage).remember('tone', 'nylon');
  make(storage).remember('pedals', true);
  const visit = make(storage, '?tone=labC&mouse=1&keyguard=off&pedals=0');
  assert.equal(visit.values.tone, 'labC');
  assert.equal(visit.values.mouse, true);
  assert.equal(visit.values.keyGuard, false);
  assert.equal(visit.values.pedals, false);
  assert.deepEqual([...visit.fromUrl].sort(), ['keyGuard', 'mouse', 'pedals', 'tone']);
  visit.remember('metronome', true);              // another choice during the URL visit
  const saved = JSON.parse(storage.getItem(PREFS_KEY));
  assert.deepEqual(saved, { tone: 'nylon', pedals: true, metronome: true });
  const plain = make(storage);
  assert.equal(plain.values.tone, 'nylon');
  assert.equal(plain.values.pedals, true);
  assert.equal(plain.values.mouse, false);
});

test('prefs: old flags keep working (?pedals=1, ?mouse=1, ?keyguard=off), unknown values are ignored', () => {
  assert.deepEqual(urlOverrides(new URLSearchParams('?pedals=1'), ALL_TONES), { pedals: true });
  assert.deepEqual(urlOverrides(new URLSearchParams('?mouse=1&keyguard=off'), ALL_TONES), { mouse: true, keyGuard: false });
  assert.deepEqual(urlOverrides(new URLSearchParams('?tone=banjo&mouse=yes&pedals=2'), ALL_TONES), {});
  const { values } = resolvePrefs(DEFAULTS, { tone: 'nylon' }, { tone: 'labD' });
  assert.equal(values.tone, 'labD');
});

// ---------- pedal availability ----------
const STAGE = { width: 1280, height: 720 };
const mouseHover = p => ({ id: 'mouse', source: 'mouse', palm: 90, points: null, fist: false, pinching: false, fresh: false,
  tip: { ...p }, pinchPoint: { ...p }, center: { ...p }, tipSpeed: 600 });
const mouseDrag = (a, b) => [
  { ...mouseHover(a), id: 'mouse-anchor', pinching: true },
  { ...mouseHover(b), id: 'mouse-drag', pinching: true },
];
const camHand = (id, p, extra = {}) => ({ ...mouseHover(p), id, source: 'camera', ...extra });

function boardRig(options = {}) {
  const toasts = [];
  const board = createPedalboard({ settings: { ...SETTINGS }, t: (k, p) => (p ? `${k}:${p.name}` : k), stage: STAGE, storage: memoryStorage(), toast: x => toasts.push(x), ...options });
  let time = 0;
  const frame = (hands, state = 'playing') => { time += 1 / 60; return board.route(hands, time, state); };
  const wait = (s, state) => { for (let i = 0; i < s * 60; i++) frame([], state); };
  const click = (p, state) => { frame([mouseHover(p)], state); for (let i = 0; i < 5; i++) frame(mouseDrag(p, p), state); frame([mouseHover(p)], state); wait(0.5, state); };
  const drag = (a, b) => { frame([mouseHover(a)]); for (let i = 0; i <= 6; i++) frame(mouseDrag(a, { x: a.x + (b.x - a.x) * i / 6, y: a.y + (b.y - a.y) * i / 6 })); frame([mouseHover(b)]); };
  const find = pred => board.targets().find(pred);
  return { board, toasts, frame, wait, click, drag, find };
}

test('availability: wah, overdrive, distortion and delay are usable; the others wait for their sound', () => {
  assert.deepEqual(Object.keys(PEDAL_AVAILABLE).filter(isPedalAvailable).sort(), ['delay', 'distortion', 'overdrive', 'wah']);
});

test('availability: a dimmed pedal cannot be switched or turned; it says "coming soon"', () => {
  const { board, toasts, click, drag, find } = boardRig();
  const reverbOn = board.model.isOn('reverb');      // on in the default preset
  const reverb = find(t => t.kind === 'switch' && t.pedal === 'reverb');
  click({ x: reverb.cx, y: reverb.cy });
  assert.equal(board.model.isOn('reverb'), reverbOn, 'reverb switch locked');
  assert.ok(toasts.at(-1).includes('pedal.comingSoon'), toasts.at(-1));
  const mix = find(t => t.kind === 'knob' && t.pedal === 'reverb' && t.knob === 'mix');
  const before = board.model.param('reverb', 'mix');
  drag({ x: mix.cx, y: mix.cy }, { x: mix.cx, y: mix.cy - 120 });
  assert.equal(board.model.param('reverb', 'mix'), before, 'reverb knob locked');
  const od = find(t => t.kind === 'switch' && t.pedal === 'overdrive');
  click({ x: od.cx, y: od.cy });
  assert.equal(board.model.isOn('overdrive'), false, 'overdrive still switches');
  const drive = find(t => t.kind === 'knob' && t.pedal === 'distortion' && t.knob === 'drive');
  const d0 = board.model.param('distortion', 'drive');
  drag({ x: drive.cx, y: drive.cy }, { x: drive.cx, y: drive.cy - 120 });
  assert.ok(board.model.param('distortion', 'drive') > d0 + 0.2, 'distortion knob still turns');
});

test('availability: keys 4–9 and W skip dimmed pedals; W switches the wah, whose strip shows in hand mode', () => {
  const { board, toasts, frame } = boardRig();
  const order = board.model.pedalOrder();
  for (let i = 0; i < order.length; i++) {
    const before = board.model.isOn(order[i]);
    assert.equal(board.handleKey(String(4 + i), 'playing'), true);
    assert.equal(board.model.isOn(order[i]), isPedalAvailable(order[i]) ? !before : before, order[i]);
  }
  // The wah is available: W switches it between hand and auto (and the strip follows).
  board.model.toggle('wah', true);
  board.model.setParam('wah', 'mode', 1);
  assert.equal(board.handleKey('w', 'playing'), true);
  assert.equal(board.model.param('wah', 'mode'), 0);
  assert.ok(toasts.at(-1).includes('pedal.wahHand'), toasts.at(-1));
  frame([]);
  assert.equal(board.targets().some(t => t.kind === 'strip'), true, 'hand mode shows the strip');
  board.handleKey('w', 'playing');
  frame([]);
  assert.equal(board.targets().some(t => t.kind === 'strip'), false, 'auto mode hides it');
  // A pedal without sound: W only says "coming soon", and no strip appears.
  const locked = boardRig({ isAvailable: id => id === 'overdrive' || id === 'distortion' });
  const mode = locked.board.model.param('wah', 'mode');
  assert.equal(locked.board.handleKey('w', 'playing'), true);
  assert.equal(locked.board.model.param('wah', 'mode'), mode);
  assert.ok(locked.toasts.some(x => x.includes('pedal.wah')));
  locked.board.model.toggle('wah', true);
  locked.board.model.setParam('wah', 'mode', 0);
  locked.frame([]);
  assert.equal(locked.board.targets().some(t => t.kind === 'strip'), false);
});

test('availability: the tuning screen locks dimmed pedals too; flipping the flag unlocks them', () => {
  const { board, click, find } = boardRig();
  board.route([], 0, 'ready');
  board.openTuning();
  const chorus = find(t => t.kind === 'switch' && t.pedal === 'chorus');
  click({ x: chorus.cx, y: chorus.cy }, 'ready');
  assert.equal(board.model.isOn('chorus'), false);
  const saved = { ...PEDAL_AVAILABLE };
  try {
    setPedalAvailability({ chorus: true, nonsense: true });
    assert.equal('nonsense' in PEDAL_AVAILABLE, false);
    click({ x: chorus.cx, y: chorus.cy }, 'ready');
    assert.equal(board.model.isOn('chorus'), true);
  } finally {
    setPedalAvailability(saved);
  }
  assert.equal(isPedalAvailable('chorus'), false);
});

// ---------- page buttons pressed by hands ----------
const BUTTON = { kind: 'button', id: 'gear', rect: { x: 1000, y: 20, w: 120, h: 52 } };
const ON_BUTTON = { x: 1060, y: 46 };

function buttonRig({ targets = [BUTTON], withButtons = true } = {}) {
  const settings = { ...SETTINGS };
  const buttons = createHandButtons(settings);
  const instrument = createAirStrings();
  const played = [];
  const noop = () => {};
  instrument.init({
    settings, t: k => k, stage: STAGE, pitch: createPitchSnapper(settings),
    fx: { burst: noop, shatter: noop, popText: noop }, judge: () => ({ grade: null, points: 0, combo: 0 }), combo: () => 0,
    audio: { pluck: o => played.push(o), ringTime: () => 0.5 },
  });
  const taps = [];
  let time = 0;
  const frame = hands => {
    time += 1 / 60;
    let free = hands;
    if (withButtons) {
      const result = buttons.route(hands, time, targets);
      taps.push(...result.taps.map(target => ({ id: target.id, time })));
      free = result.hands;
    }
    instrument.onHands(free, time);
    instrument.update(1 / 60);
  };
  const hold = (hands, seconds) => { for (let i = 0; i < seconds * 60; i++) frame(hands); };
  return { buttons, instrument, played, taps, frame, hold };
}

test('hand buttons: an open, settled hand that pinches and lets go on a button taps it once', () => {
  const { taps, hold } = buttonRig();
  hold([camHand('R', ON_BUTTON)], 0.3);
  hold([camHand('R', ON_BUTTON, { pinching: true })], 0.15);
  hold([camHand('R', ON_BUTTON)], 0.2);
  assert.equal(taps.length, 1);
  assert.equal(taps[0].id, 'gear');
});

test('hand buttons: a long pinch, a hand that arrives pinched, a mouse, and a second tap within 0.4 s do not press', () => {
  const long = buttonRig();
  long.hold([camHand('R', ON_BUTTON)], 0.3);
  long.hold([camHand('R', ON_BUTTON, { pinching: true })], 0.8);
  long.hold([camHand('R', ON_BUTTON)], 0.2);
  assert.equal(long.taps.length, 0, 'hold');

  const arrives = buttonRig();
  arrives.hold([camHand('R', ON_BUTTON, { pinching: true })], 0.15);
  arrives.hold([camHand('R', ON_BUTTON)], 0.2);
  assert.equal(arrives.taps.length, 0, 'appeared pinched');

  const mouse = buttonRig();
  mouse.hold([mouseHover(ON_BUTTON)], 0.2);
  mouse.hold(mouseDrag(ON_BUTTON, ON_BUTTON), 0.1);
  mouse.hold([mouseHover(ON_BUTTON)], 0.2);
  assert.equal(mouse.taps.length, 0, 'the mouse clicks the real button instead');

  const twice = buttonRig();
  twice.hold([camHand('R', ON_BUTTON), camHand('L', { x: 1040, y: 40 })], 0.3);
  twice.hold([camHand('R', ON_BUTTON, { pinching: true }), camHand('L', { x: 1040, y: 40 })], 0.1);
  twice.hold([camHand('R', ON_BUTTON), camHand('L', { x: 1040, y: 40 }, { pinching: true })], 0.1);
  twice.hold([camHand('R', ON_BUTTON), camHand('L', { x: 1040, y: 40 })], 0.1);
  assert.equal(twice.taps.length, 1, 'lockout');
});

test('hand buttons: a finger sweeping over a button across a string does not pluck it (control: it does without the button)', () => {
  const y = 46;
  const report = [];
  for (const withButtons of [true, false]) {
    const rig = buttonRig({ withButtons });
    // A string lying right across the button, made directly on the instrument.
    rig.instrument.onHands(mouseDrag({ x: 700, y }, { x: 1250, y }), 0.002);
    rig.instrument.onHands([mouseHover({ x: 1250, y })], 0.003);
    assert.equal(rig.instrument.strings.length, 1);
    rig.hold([], 0.5);
    const before = rig.played.length;
    for (let i = 0; i <= 12; i++) rig.frame([camHand('R', { x: 1060, y: y - 30 + i * 5 })]);
    for (let i = 0; i <= 12; i++) rig.frame([camHand('R', { x: 1070, y: y + 30 - i * 5 })]);
    const plucks = rig.played.length - before;
    report.push(`${withButtons ? 'with' : 'without'} button: ${plucks} pluck(s)`);
    if (withButtons) assert.equal(plucks, 0);
    else assert.ok(plucks > 0, 'control plucks');
  }
  return report.join(', ');
});

test('hand buttons: two pinching hands, one on a button, stretch no string; a press stays the button\'s until released', () => {
  const { instrument, hold, frame } = buttonRig();
  hold([camHand('R', ON_BUTTON), camHand('L', { x: 300, y: 300 })], 0.3);
  hold([camHand('R', ON_BUTTON, { pinching: true }), camHand('L', { x: 300, y: 300 }, { pinching: true })], 0.3);
  // The button hand drags away from the button while still pinched.
  for (let i = 0; i < 30; i++) frame([camHand('R', { x: 1060 - i * 20, y: 46 + i * 10 }, { pinching: true }), camHand('L', { x: 300, y: 300 }, { pinching: true })]);
  hold([camHand('R', { x: 460, y: 346 }), camHand('L', { x: 300, y: 300 })], 0.3);
  assert.equal(instrument.strings.length, 0);
  assert.equal(instrument.drafting, false);
});

test('hand buttons: with no buttons on screen every hand goes to the strings', () => {
  const { buttons } = buttonRig();
  const hands = [camHand('R', ON_BUTTON), camHand('L', { x: 300, y: 300 })];
  const result = buttons.route(hands, 1, []);
  assert.equal(result.hands.length, 2);
});

// ---------- 延音 (the amp's sustain knob) on the tuning screen ----------
test('延音: the third big knob in simple mode and the amp knob in advanced; mouse drag, pinch-drag and wheel turn it', () => {
  const { board, find } = boardRig();
  let time = 0;
  const frame = hands => { time += 1 / 60; board.route(hands, time, 'ready'); };
  const hold = (hands, seconds) => { for (let i = 0; i < seconds * 60; i++) frame(hands); };
  const mouseDragReady = (a, b) => { frame([mouseHover(a)]); for (let i = 0; i <= 8; i++) frame(mouseDrag(a, { x: a.x, y: a.y + (b.y - a.y) * i / 8 })); frame([mouseHover(b)]); hold([], 0.5); };
  frame([]);
  board.openTuning();
  const macros = board.targets().filter(t => t.kind === 'knob' && t.macro);
  assert.deepEqual(macros.map(t => t.macro), ['drive', 'tone', 'sustain']);
  for (let i = 1; i < macros.length; i++) assert.ok(macros[i - 1].rect.x + macros[i - 1].rect.w <= macros[i].rect.x + 1e-9, 'big knobs do not overlap');
  const sustain = find(t => t.kind === 'knob' && t.macro === 'sustain');
  assert.equal(board.model.param('amp', 'sustain'), 0);
  mouseDragReady({ x: sustain.cx, y: sustain.cy }, { x: sustain.cx, y: sustain.cy - 150 });
  const byMouse = board.model.param('amp', 'sustain');
  assert.ok(byMouse > 0.2, `mouse drag: ${byMouse}`);
  assert.equal(board.model.preset, 'rock', '延音 does not make the preset 自訂');
  // Camera: open hand, pinch, drag up, let go.
  const at = (dy, extra = {}) => [camHand('R', { x: sustain.cx, y: sustain.cy + dy }, extra)];
  hold(at(0), 0.3);
  for (let i = 0; i <= 20; i++) frame(at(-i * 8, { pinching: true }));
  hold(at(-160), 0.2);
  hold([], 0.5);
  const byHand = board.model.param('amp', 'sustain');
  assert.ok(byHand > byMouse + 0.2, `pinch-drag: ${byMouse} → ${byHand}`);
  // Wheel over the knob.
  board.wheel({ clientX: sustain.cx, clientY: sustain.cy, deltaX: 0, deltaY: 100, deltaMode: 0, preventDefault() {} });
  assert.ok(board.model.param('amp', 'sustain') < byHand, 'wheel down turns it down');
  // Advanced: the amp's panel has it.
  board.model.setMode('advanced');
  board.select('amp');
  const ampKnob = find(t => t.kind === 'knob' && t.pedal === 'amp' && t.knob === 'sustain');
  assert.ok(ampKnob, 'amp panel shows 延音');
  const before = board.model.param('amp', 'sustain');
  mouseDragReady({ x: ampKnob.cx, y: ampKnob.cy }, { x: ampKnob.cx, y: ampKnob.cy + 150 });
  assert.ok(board.model.param('amp', 'sustain') < before - 0.2, 'advanced knob turns it');
  return `mouse ${byMouse.toFixed(2)}, pinch ${byHand.toFixed(2)}`;
});

console.table(results);
const failed = results.filter(r => r.result === 'FAIL').length;
if (failed) { console.error(`${failed} test(s) failed`); process.exit(1); }
console.log('menu tests passed');
