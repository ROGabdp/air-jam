// node tests/disc-drag.test.mjs
// The big disc (footswitch) of each pedal: a pinch-tap / click toggles it, a pinch-drag / mouse drag
// / wheel turns the pedal's main amount (model.mainKnob, the same value the small knob shows).
// Synthetic camera hands through the real recognizer, and the controller with mouse and camera hands.
import assert from 'node:assert/strict';
import { PEDAL_IDS, STORAGE_KEY, mainKnobOf, knobOf } from '../src/core/pedals/model.js';
import { createPedalGestures, toPointers } from '../src/core/pedals/gestures.js';
import { createPedalboard } from '../src/core/pedals/pedalboard.js';
import { createGestureRecognizer } from '../src/core/hands/gestures.js';
import { sameTarget } from '../src/core/pedals/draw.js';
import { SETTINGS } from '../src/settings.js';

const results = [];
function test(name, fn) {
  try { const note = fn(); results.push({ test: name, result: 'PASS', detail: note ?? '' }); }
  catch (error) { results.push({ test: name, result: 'FAIL', detail: error.message.split('\n')[0] }); }
}
function seeded(seed) {
  let a = seed;
  return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
}
function memoryStorage() {
  const data = new Map();
  return { data, getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const MAPPING = { overdrive: 'drive', distortion: 'drive', chorus: 'depth', delay: 'mix', reverb: 'mix' };

// ---------- mapping ----------
test('mapping: each pedal\'s disc turns the owner-approved knob; wah: hand = pedal position, auto = sensitivity', () => {
  for (const [id, knob] of Object.entries(MAPPING)) {
    assert.equal(mainKnobOf(id), knob, id);
    assert.ok(knobOf(id, knob), `${id}.${knob} exists`);
  }
  assert.equal(mainKnobOf('wah', { mode: 0 }), 'position');
  assert.equal(mainKnobOf('wah', { mode: 1 }), 'sensitivity');
  assert.equal(mainKnobOf('amp'), null);
  for (const id of PEDAL_IDS) assert.ok(knobOf(id, mainKnobOf(id, { mode: 0 })), id);
});

test('drawing: a pressed disc (carrying its knob) is the same target as the drawn disc', () => {
  const drawn = { kind: 'switch', pedal: 'delay' };
  assert.ok(sameTarget({ ...drawn, knob: 'mix', value: 0.5 }, drawn));
  assert.ok(!sameTarget({ ...drawn, knob: 'mix' }, { kind: 'switch', pedal: 'reverb' }));
  assert.ok(!sameTarget({ kind: 'knob', pedal: 'delay', knob: 'mix' }, drawn));
});

// ---------- gestures on synthetic camera hands ----------
// Schematic hand (tests/pedalboard.test.mjs): palm 100 px, pinch point at (x − 30 − gap / 2, y − 187).
function makeHand({ x = 300, y = 300, pinchGap = 80, jitter = 0, random = Math.random }) {
  const points = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  const put = (i, px, py) => { points[i] = { x: x + px + (random() - 0.5) * jitter, y: y + py + (random() - 0.5) * jitter, z: 0 }; };
  put(0, 0, 0);
  [[5, -30], [9, 0], [13, 25], [17, 45]].forEach(([base, dx]) => {
    [-100, -140, -170, -195].forEach((dy, k) => put(base + k, dx, dy + (base === 9 ? 0 : 8)));
  });
  put(1, -35, -25); put(2, -55, -55); put(3, -60, -85);
  points[4] = { x: points[8].x - pinchGap, y: points[8].y + (random() - 0.5) * jitter, z: 0 };
  return points;
}
const disc = { kind: 'switch', pedal: 'delay', knob: 'mix', value: 0.5, rect: { x: 0, y: 0, w: 1000, h: 1000 } };
const knob = { kind: 'knob', pedal: 'delay', knob: 'mix', value: 0.5, rect: { x: 0, y: 0, w: 1000, h: 1000 } };

function perform(target, script, { seed = 7, settle = 10 } = {}) {
  const recognizer = createGestureRecognizer(SETTINGS);
  const pedal = createPedalGestures(SETTINGS);
  const random = seeded(seed);
  const events = [];
  let time = 0, y = 500;
  const step = (gap, jitter) => {
    const hands = recognizer.update([makeHand({ x: 400, y, pinchGap: gap, jitter, random })], time);
    events.push(...pedal.update(toPointers(hands), time, () => ({ ...target })).map(e => ({ ...e, time })));
    time += 1 / 30;
  };
  for (let i = 0; i < settle; i++) step(80, 0);
  for (const { frames, gap, dy = 0, jitter = 0 } of script) {
    for (let i = 0; i < frames; i++) { y += dy / frames; step(gap, jitter); }
  }
  return events;
}
const count = (events, type) => events.filter(e => e.type === type).length;
const kinds = events => events.filter(e => e.type === 'release').map(e => e.kind);
const finalValue = events => events.filter(e => e.type === 'knob' || e.type === 'knobEnd').at(-1)?.value ?? null;

test('gestures: a disc pinch-tap (±6 px jitter) toggles and never changes the value', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const events = perform(disc, [{ frames: 6, gap: 20, jitter: 12 }, { frames: 6, gap: 80, jitter: 12 }], { seed });
    assert.deepEqual(kinds(events), ['tap'], `seed ${seed}`);
    assert.equal(count(events, 'tap'), 1);
    const v = finalValue(events);
    assert.ok(v === null || v === disc.value, `value ${v}`);
  }
});

test('gestures: a disc pinch-drag turns the amount and never toggles (relative, 0.25-palm dead band)', () => {
  const report = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    const events = perform(disc, [{ frames: 15, gap: 20, dy: -100, jitter: 12 }, { frames: 10, gap: 20, jitter: 12 }, { frames: 6, gap: 80 }], { seed });
    assert.deepEqual(kinds(events), ['drag'], `seed ${seed}`);
    assert.equal(count(events, 'tap'), 0, 'no toggle');
    const end = events.find(e => e.type === 'knobEnd').value;
    report.push(end.toFixed(3));
    // 1 palm up, minus the 0.25-palm dead band, 2.5 palms = full range: ≈ 0.5 + 0.30 (+ the press frame's step).
    assert.ok(Math.abs(end - 0.8) < 0.05, `value ${end}`);
  }
  return `1 palm up from 0.5 → ${report.join(', ')}`;
});

test('gestures: drift below the disc dead band does nothing (it would already turn a small knob)', () => {
  // The pinch point creeps 18 px (0.18 palm) down while the fingers close, then the pinch opens.
  const script = [{ frames: 3, gap: 20, dy: 18 }, { frames: 4, gap: 20, jitter: 8 }, { frames: 5, gap: 80 }];
  const onDisc = perform(disc, script);
  assert.equal(count(onDisc, 'knob'), 0, 'disc not turned');
  assert.deepEqual(kinds(onDisc), ['tap'], 'still a toggle');
  const onKnob = perform(knob, script);
  assert.ok(count(onKnob, 'knob') > 0, 'a small knob does turn (0.12-palm dead band)');
  const still = perform(disc, [{ frames: 45, gap: 20, jitter: 12 }, { frames: 6, gap: 80 }]);
  assert.equal(count(still, 'knob'), 0, 'a long jittery hold does not turn it');
  assert.deepEqual(kinds(still), ['hold']);
});

test('gestures: the release jump of a quick tap is not a drag (tap, value restored by the latch)', () => {
  for (const seed of [21, 22, 23]) {
    // Pinch 0.2 s, then the point drops 40 px in the 2 frames before the pinch opens.
    const events = perform(disc, [{ frames: 6, gap: 20, jitter: 4 }, { frames: 2, gap: 30, dy: 40 }, { frames: 5, gap: 90 }], { seed });
    assert.ok(count(events, 'knob') > 0, 'the jump did move the value for a moment');
    assert.deepEqual(kinds(events), ['tap'], `seed ${seed}`);
    assert.equal(events.find(e => e.type === 'knobEnd').value, disc.value, 'latched back to the start');
  }
});

test('gestures: disc drag latch on release keeps the value from before the jump', () => {
  const events = perform(disc, [
    { frames: 12, gap: 20, dy: -100 }, { frames: 9, gap: 20, jitter: 4 }, { frames: 2, gap: 30, dy: 40 }, { frames: 5, gap: 90 },
  ], { seed: 11 });
  const end = events.find(e => e.type === 'knobEnd');
  const rest = events.filter(e => e.type === 'knob' && e.time < end.time - 0.15).at(-1).value;
  assert.ok(Math.abs(end.value - rest) < 0.025, `latched ${end.value} vs resting ${rest}`);
  assert.deepEqual(kinds(events), ['drag']);
  assert.equal(count(events, 'tap'), 0);
});

// ---------- the controller ----------
const STAGE = { width: 1280, height: 720 };
const hover = p => ({ id: 'mouse', source: 'mouse', palm: 90, points: null, fist: false, pinching: false, fresh: false,
  tip: { ...p }, pinchPoint: { ...p }, center: { ...p }, tipSpeed: 0 });
const mouseDrag = (a, b) => [{ ...hover(a), id: 'mouse-anchor', pinching: true }, { ...hover(b), id: 'mouse-drag', pinching: true }];
const cam = (p, pinching) => ({ ...hover(p), id: 'cam-0', source: 'camera', pinching });

function rig({ mouse = true } = {}) {
  const storage = memoryStorage();
  const board = createPedalboard({ settings: { ...SETTINGS }, t: k => k, stage: STAGE, storage, mouseMode: () => mouse, isAvailable: () => true });
  let time = 0;
  const frame = (hands = [], state = 'ready') => { time += 1 / 60; return board.route(hands, time, state); };
  const wait = s => { for (let i = 0; i < s * 60; i++) frame(); };
  const click = p => { frame([hover(p)]); for (let i = 0; i < 5; i++) frame(mouseDrag(p, p)); frame([hover(p)]); };
  const drag = (a, dy, steps = 8) => {
    frame([hover(a)]);
    for (let i = 0; i <= steps; i++) frame(mouseDrag(a, { x: a.x + 3, y: a.y + dy * i / steps }));
    frame([hover({ x: a.x + 3, y: a.y + dy })]);
  };
  const spin = (deltaY, p) => {
    const event = { clientX: p.x, clientY: p.y, deltaX: 0, deltaY, deltaMode: 0, prevented: false, preventDefault() { this.prevented = true; } };
    board.wheel(event);
    return event;
  };
  frame();
  return { board, storage, frame, wait, click, drag, spin };
}
const sw = (board, pedal) => board.targets().find(t => t.kind === 'switch' && t.pedal === pedal);
const centre = t => ({ x: t.cx, y: t.cy });
const saved = (storage, pedal, knob) => JSON.parse(storage.getItem(STORAGE_KEY)).pedals[pedal].params[knob];
// Mouse: 90 px palm; up 90 px = (90 − 0.25 · 90) / (2.5 · 90) = 0.30 of the range.
const MOUSE_UP_90 = (1 - SETTINGS.pedalDiscDeadband) / SETTINGS.pedalKnobTravel;

test('controller (mouse): a click on a disc toggles it and leaves its amount alone', () => {
  const { board, click, wait } = rig();
  for (const pedal of PEDAL_IDS) {
    wait(0.5);                                  // past the lockout of the previous toggle
    const knob = board.model.mainKnob(pedal);
    const before = board.model.param(pedal, knob), was = board.model.isOn(pedal);
    click(centre(sw(board, pedal)));
    assert.equal(board.model.isOn(pedal), !was, `${pedal} toggled`);
    assert.equal(board.model.param(pedal, knob), before, `${pedal} amount unchanged`);
  }
});

test('controller (mouse): dragging each disc turns its main knob, never toggles; saved on release', () => {
  const { board, storage, drag, wait } = rig();
  board.model.setParam('wah', 'mode', 0);
  const report = [];
  for (const pedal of PEDAL_IDS) {
    wait(0.5);
    const knob = board.model.mainKnob(pedal);
    board.model.setParam(pedal, knob, 0.3);
    const was = board.model.isOn(pedal);
    drag(centre(sw(board, pedal)), -90);
    const after = board.model.param(pedal, knob);
    assert.equal(board.model.isOn(pedal), was, `${pedal} not toggled`);
    assert.ok(Math.abs(after - (0.3 + MOUSE_UP_90)) < 0.02, `${pedal}.${knob}: ${after}`);
    assert.ok(close(saved(storage, pedal, knob), after), `${pedal} saved`);
    report.push(`${pedal}.${knob} ${after.toFixed(2)}`);
  }
  return report.join(', ');
});

test('controller: wah disc = pedal position in hand mode, sensitivity in auto mode', () => {
  const { board, drag, wait } = rig();
  board.model.toggle('wah', true);
  board.model.setParam('wah', 'mode', 0);
  board.model.setParam('wah', 'position', 0.2);
  const sens = board.model.param('wah', 'sensitivity');
  drag(centre(sw(board, 'wah')), -90);
  assert.ok(board.model.param('wah', 'position') > 0.45, 'hand: position moved');
  assert.equal(board.model.param('wah', 'sensitivity'), sens, 'hand: sensitivity untouched');
  wait(0.5);
  board.model.setParam('wah', 'mode', 1);
  const pos = board.model.param('wah', 'position');
  drag(centre(sw(board, 'wah')), 90);
  assert.ok(board.model.param('wah', 'sensitivity') < sens - 0.2, 'auto: sensitivity down');
  assert.equal(board.model.param('wah', 'position'), pos, 'auto: position untouched');
  assert.equal(board.model.isOn('wah'), true);
});

test('controller: dragging an off pedal\'s disc sets the amount but leaves it off', () => {
  const { board, drag } = rig();
  assert.equal(board.model.isOn('reverb'), false);
  const before = board.model.param('reverb', 'mix');
  drag(centre(sw(board, 'reverb')), -60);
  assert.equal(board.model.isOn('reverb'), false, 'still off');
  assert.ok(board.model.param('reverb', 'mix') > before + 0.1, 'amount set');
});

test('controller: lockout: a second click within 0.4 s neither toggles nor changes the amount', () => {
  const { board, click, wait } = rig();
  const target = centre(sw(board, 'chorus'));
  const depth = board.model.param('chorus', 'depth');
  click(target);
  assert.equal(board.model.isOn('chorus'), true);
  click(target);
  assert.equal(board.model.isOn('chorus'), true, 'locked out');
  assert.equal(board.model.param('chorus', 'depth'), depth);
  wait(0.4);
  click(target);
  assert.equal(board.model.isOn('chorus'), false);
});

test('controller: the small knob and the disc are one value (both directions)', () => {
  const { board, drag, wait } = rig();
  const small = board.targets().find(t => t.kind === 'knob' && t.pedal === 'delay' && t.knob === 'mix');
  drag({ x: small.cx, y: small.cy }, -60);
  const v = board.model.param('delay', 'mix');
  assert.ok(v > 0.4, 'small knob moved');
  assert.equal(board.model.mainKnob('delay'), 'mix', 'the disc reads the same knob');
  wait(0.5);
  drag(centre(sw(board, 'delay')), 60);
  const w = board.model.param('delay', 'mix');
  assert.ok(w < v - 0.1, 'disc moved it down');
  const refreshed = board.targets().find(t => t.kind === 'knob' && t.pedal === 'delay' && t.knob === 'mix');
  assert.equal(refreshed.value, w, 'the small knob shows the disc\'s value');
});

test('controller: wheel over a disc turns its amount (on or off); over the wah disc it glides the pedal', () => {
  const { board, spin, wait } = rig();
  const drive = board.model.param('overdrive', 'drive');
  const e = spin(-100, centre(sw(board, 'overdrive')));
  assert.ok(e.prevented, 'no page scroll');
  assert.ok(board.model.param('overdrive', 'drive') > drive, 'turned');
  assert.equal(board.model.isOn('overdrive'), true, 'wheel never toggles');
  const mix = board.model.param('reverb', 'mix');
  spin(-100, centre(sw(board, 'reverb')));
  assert.ok(board.model.param('reverb', 'mix') > mix, 'off pedal: set');
  assert.equal(board.model.isOn('reverb'), false);
  board.model.toggle('wah', true);
  board.model.setParam('wah', 'mode', 0);
  board.model.setParam('wah', 'position', 0.5);
  spin(-100, centre(sw(board, 'wah')));
  wait(0.5);
  assert.ok(Math.abs(board.model.param('wah', 'position') - (0.5 + 1 / 12)) < 1e-9, 'one notch of the wah wheel');
});

test('controller (camera): pinch-drag on a disc in the footswitch zone; quick pinch toggles', () => {
  const { board, frame, wait } = rig({ mouse: false });
  const p = centre(sw(board, 'delay'));
  const was = board.model.isOn('delay');
  const before = board.model.param('delay', 'mix');
  for (let i = 0; i < 12; i++) frame([cam(p, false)], 'playing');                 // settle
  for (let i = 0; i <= 20; i++) frame([cam({ x: p.x, y: p.y - 90 * i / 20 }, true)], 'playing');
  for (let i = 0; i < 10; i++) frame([cam({ x: p.x, y: p.y - 90 }, true)], 'playing');
  frame([cam({ x: p.x, y: p.y - 90 }, false)], 'playing');
  assert.equal(board.model.isOn('delay'), was, 'drag did not toggle');
  assert.ok(Math.abs(board.model.param('delay', 'mix') - (before + MOUSE_UP_90)) < 0.03, `mix ${board.model.param('delay', 'mix')}`);
  wait(0.5);
  const mix = board.model.param('delay', 'mix');
  for (let i = 0; i < 12; i++) frame([cam(p, false)], 'playing');
  for (let i = 0; i < 8; i++) frame([cam(p, true)], 'playing');
  frame([cam(p, false)], 'playing');
  assert.equal(board.model.isOn('delay'), !was, 'tap toggled');
  assert.equal(board.model.param('delay', 'mix'), mix, 'tap left the amount');
});

test('controller: tuning screen discs (simple row and advanced panel) drag too', () => {
  const { board, drag, wait, frame } = rig();
  board.openTuning();
  frame();
  const row = board.targets().find(t => t.kind === 'switch' && t.pedal === 'chorus');
  const depth = board.model.param('chorus', 'depth');
  drag(centre(row), -60);
  assert.ok(board.model.param('chorus', 'depth') > depth + 0.1, 'simple row');
  assert.equal(board.model.isOn('chorus'), false);
  wait(0.5);
  board.model.setMode('advanced');
  board.select('overdrive');
  const panel = board.targets().find(t => t.kind === 'switch' && t.pedal === 'overdrive');
  const drive = board.model.param('overdrive', 'drive');
  drag(centre(panel), 60);
  assert.ok(board.model.param('overdrive', 'drive') < drive - 0.1, 'advanced panel');
  assert.equal(board.model.isOn('overdrive'), true);
});

console.table(results);
const failed = results.filter(r => r.result === 'FAIL').length;
if (failed) { console.error(`${failed} test(s) failed`); process.exit(1); }
console.log('disc drag tests passed');
