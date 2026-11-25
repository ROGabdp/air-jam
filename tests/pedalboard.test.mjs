// node tests/pedalboard.test.mjs
// Pedalboard UI logic without a browser: the data model (presets, modes, clamping, storage), pinch
// tap / hold / drag on synthetic landmark sequences with jitter, the knob latch, the lockout, and
// zone gating against the real air-strings instrument (nothing is created, plucked, deleted or
// cleared from inside the footswitch zone).
import assert from 'node:assert/strict';
import {
  createPedalModel, defaultBoard, serializeBoard, deserializeBoard, loadBoard, saveBoard, boardSnapshot,
  PEDAL_TYPES, PEDAL_IDS, PRESETS, STANDARD_ORDER, MAX_SIMPLE_KNOBS, visibleKnobs, knobOf, knobValue, STORAGE_KEY,
} from '../src/core/pedals/model.js';
import { createPedalGestures, createLockout, toPointers, classifyPress } from '../src/core/pedals/gestures.js';
import { createPedalboard } from '../src/core/pedals/pedalboard.js';
import { zoneRect } from '../src/core/pedals/layout.js';
import { createGestureRecognizer } from '../src/core/hands/gestures.js';
import { createAirStrings } from '../src/instruments/air-strings/index.js';
import { createPitchSnapper } from '../src/core/music/pitch-snap.js';
import { SETTINGS } from '../src/settings.js';
import { createMouseInput } from '../src/core/hands/mouse.js';

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
  return { data, getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), writes: 0 };
}
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---------- data model ----------
test('model: six pedals, every knob default in 0..1, at most two simple knobs per pedal', () => {
  assert.deepEqual(PEDAL_IDS, ['wah', 'overdrive', 'distortion', 'chorus', 'delay', 'reverb']);
  for (const id of PEDAL_IDS) {
    for (const knob of PEDAL_TYPES[id].knobs) assert.ok(knob.default >= 0 && knob.default <= 1, `${id}.${knob.id}`);
    assert.ok(visibleKnobs(id, 'simple').length <= MAX_SIMPLE_KNOBS, id);
    assert.ok(visibleKnobs(id, 'advanced').some(k => k.id === 'level'), `${id} has a level knob in advanced`);
    assert.ok(!visibleKnobs(id, 'simple').some(k => k.id === 'level'), `${id} level is advanced only`);
  }
});

test('model: presets set pedals and knobs; any edit makes the board "custom"', () => {
  const model = createPedalModel();
  assert.equal(model.preset, 'rock');
  for (const preset of PRESETS) {
    model.applyPreset(preset.id);
    assert.equal(model.preset, preset.id);
    for (const id of PEDAL_IDS) assert.equal(model.isOn(id), !!preset.on[id], `${preset.id}: ${id}`);
  }
  model.applyPreset('metal');
  assert.ok(close(model.param('distortion', 'drive'), PRESETS.find(p => p.id === 'metal').on.distortion.drive));
  model.toggle('chorus');
  assert.equal(model.preset, null);
  model.applyPreset('clean');
  model.setParam('reverb', 'mix', 0.2);
  assert.equal(model.preset, null);
  model.applyPreset('clean');
  model.setParam('wah', 'position', 0.9, { commit: false });
  assert.equal(model.preset, 'clean', 'moving the wah is playing, not editing the sound');
  assert.equal(model.applyPreset('no-such-preset'), false);
});

test('model: simple mode = classic order + auto level; advanced keeps the player\'s order and levels', () => {
  const model = createPedalModel();
  model.setMode('advanced');
  assert.equal(model.move('reverb', -1), true);
  assert.equal(model.move('wah', -1), false, 'first item cannot move further left');
  let snap = model.snapshot();
  assert.equal(snap.autoLevel, false);
  assert.deepEqual(snap.order, ['wah', 'overdrive', 'distortion', 'amp', 'chorus', 'reverb', 'delay']);
  model.setParam('overdrive', 'level', 0.1);
  model.setMode('simple');
  snap = model.snapshot();
  assert.equal(snap.autoLevel, true);
  assert.deepEqual(snap.order, STANDARD_ORDER);
  assert.ok(close(snap.pedals.overdrive.params.level, 0.1), 'level is kept, only ignored');
  model.setMode('advanced');
  assert.deepEqual(model.snapshot().order.slice(-2), ['reverb', 'delay'], 'custom order comes back');
  model.setMode('bogus');
  assert.equal(model.mode, 'advanced');
});

test('model: clamping, steps and physical values', () => {
  const model = createPedalModel();
  assert.equal(model.setParam('overdrive', 'drive', 3), 1);
  assert.equal(model.setParam('overdrive', 'drive', -2), 0);
  assert.equal(model.setParam('overdrive', 'drive', NaN), 0);
  assert.equal(model.setParam('overdrive', 'nope', 0.5), null);
  assert.equal(model.setParam('delay', 'time', 0.4), 0.5, 'three steps snap to 0, 0.5, 1');
  assert.equal(model.cycle('delay', 'time'), 1);
  assert.equal(model.cycle('delay', 'time'), 0, 'cycling wraps');
  assert.ok(close(knobValue(knobOf('overdrive', 'drive'), 0.5), 24));
  assert.ok(close(knobValue(knobOf('chorus', 'rate'), 0), 0.1) && close(knobValue(knobOf('chorus', 'rate'), 1), 3));
  assert.ok(close(knobValue(knobOf('chorus', 'rate'), 0.5), Math.sqrt(0.3)), 'log curve: geometric middle');
  assert.equal(knobValue(knobOf('reverb', 'size'), 0.9), 2);
});

test('model: serialise → JSON → deserialise round trip, and garbage gives a valid board', () => {
  const model = createPedalModel();
  model.setMode('advanced');
  model.move('chorus', 1);
  model.toggle('wah');
  model.setParam('delay', 'feedback', 0.37);
  const copy = deserializeBoard(JSON.parse(JSON.stringify(serializeBoard(model.board))));
  assert.deepEqual(copy, model.board);
  for (const junk of [null, 42, 'x', {}, { v: 2 }, { v: 1, order: ['amp'] }, { v: 1, pedals: { wah: 'on' } }]) {
    const board = deserializeBoard(junk);
    assert.deepEqual(boardSnapshot(board).order, STANDARD_ORDER);
    assert.equal(Object.keys(board.pedals).length, 6);
  }
  const odd = deserializeBoard({ v: 1, mode: 'expert', preset: 'x', order: [1, 2], pedals: {
    overdrive: { on: 'yes', params: { drive: 7, tone: -1, bogus: 3 } }, delay: { on: true, params: { time: 0.3 } } } });
  assert.equal(odd.mode, 'simple');
  assert.equal(odd.preset, null);
  assert.equal(odd.pedals.overdrive.on, false, 'only a real true turns a pedal on');
  assert.equal(odd.pedals.overdrive.params.drive, 1);
  assert.equal(odd.pedals.overdrive.params.tone, 0);
  assert.equal(odd.pedals.overdrive.params.bogus, undefined);
  assert.equal(odd.pedals.delay.params.time, 0.5);
});

test('model: storage survives a reload, broken storage never throws, drags are saved on release only', () => {
  const storage = memoryStorage();
  const first = createPedalModel({ storage });
  first.applyPreset('metal');
  first.toggle('delay');
  const second = createPedalModel({ storage });
  assert.deepEqual(second.board, first.board);
  storage.setItem(STORAGE_KEY, '{not json');
  assert.deepEqual(loadBoard(storage), defaultBoard());
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  assert.deepEqual(loadBoard(broken), defaultBoard());
  assert.equal(saveBoard(broken, defaultBoard()), false);
  const model = createPedalModel({ storage: broken });
  model.toggle('wah');
  assert.equal(model.isOn('wah'), true);

  const counting = memoryStorage();
  let writes = 0;
  const setItem = counting.setItem;
  counting.setItem = (k, v) => { writes++; setItem(k, v); };
  const live = createPedalModel({ storage: counting });
  for (let i = 0; i < 30; i++) live.setParam('overdrive', 'drive', i / 30, { commit: false });
  assert.equal(writes, 0);
  live.setParam('overdrive', 'drive', 0.6);
  assert.equal(writes, 1);
});

test('model: listeners get a snapshot and the change; macros keep the knobs\' offsets', () => {
  const model = createPedalModel();
  const seen = [];
  const off = model.subscribe((snapshot, change) => seen.push({ snapshot, change }));
  model.toggle('chorus');
  assert.equal(seen[0].change.type, 'toggle');
  assert.equal(seen[0].snapshot.pedals.chorus.on, true);
  model.setParam('overdrive', 'tone', 0.25);
  assert.equal(seen[1].change.type, 'param');
  assert.ok(close(seen[1].snapshot.pedals.overdrive.values.tone, -8 + 14 * 0.25));
  off();
  model.toggle('chorus');
  assert.equal(seen.length, 2);

  model.applyPreset('rock');
  const rock = PRESETS.find(p => p.id === 'rock').on;
  const od0 = rock.overdrive.drive, dist0 = rock.distortion.drive, mean0 = (od0 + dist0) / 2;
  const base = model.macroBase('drive');
  assert.ok(close(base.mean, mean0));
  model.setMacro('drive', mean0 + 0.2, base);
  assert.ok(close(model.param('overdrive', 'drive'), od0 + 0.2) && close(model.param('distortion', 'drive'), dist0 + 0.2));
  const top = mean0 + (1 - dist0) + 0.05;   // distortion clamps at 1, overdrive keeps following
  model.setMacro('drive', top, base);
  assert.ok(close(model.param('distortion', 'drive'), 1) && close(model.param('overdrive', 'drive'), od0 + top - mean0));
  model.setMacro('drive', mean0, base);    // back to the start: no drift
  assert.ok(close(model.param('overdrive', 'drive'), od0) && close(model.param('distortion', 'drive'), dist0));
});

// ---------- gestures on synthetic landmarks ----------
// Same schematic hand as tests/instrument.test.mjs: palm 100 px, index tip 187 px above the wrist.
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
// The pinch point sits at (x − 30 − gap / 2, y − 187).
const PINCH_DY = -187;

const knobTarget = { kind: 'knob', id: 'k', value: 0.5, rect: { x: 0, y: 0, w: 1000, h: 1000 } };
const switchTarget = { kind: 'switch', id: 's', rect: { x: 0, y: 0, w: 1000, h: 1000 } };

// Drives recognizer → pointers → pedal gestures at 30 fps. script: [{ frames, gap, dy, jitter }]
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
const kinds = events => events.filter(e => e.type === 'release').map(e => e.kind);

test('gestures: pinch-tap, pinch-hold and pinch-drag are told apart (±6 px jitter)', () => {
  const report = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    const tap = perform(switchTarget, [{ frames: 6, gap: 20, jitter: 12 }, { frames: 6, gap: 80, jitter: 12 }], { seed });
    assert.deepEqual(kinds(tap), ['tap'], `tap seed ${seed}`);
    assert.equal(tap.filter(e => e.type === 'tap').length, 1);
    const hold = perform(switchTarget, [{ frames: 20, gap: 20, jitter: 12 }, { frames: 6, gap: 80 }], { seed });
    assert.deepEqual(kinds(hold), ['hold'], `hold seed ${seed}`);
    assert.equal(hold.filter(e => e.type === 'tap').length, 0);
    const swipe = perform(switchTarget, [{ frames: 6, gap: 20, dy: -120, jitter: 12 }, { frames: 4, gap: 80 }], { seed });
    assert.equal(swipe.filter(e => e.type === 'tap').length, 0, 'a moving pinch is not a tap');
    const drag = perform(knobTarget, [{ frames: 15, gap: 20, dy: -100, jitter: 12 }, { frames: 10, gap: 20, jitter: 12 }, { frames: 6, gap: 80 }], { seed });
    assert.deepEqual(kinds(drag), ['drag'], `drag seed ${seed}`);
    const end = drag.find(e => e.type === 'knobEnd');
    report.push(end.value.toFixed(3));
    // 100 px up = 1 palm, 2.5 palms = full range, minus the 0.12-palm dead band; the press frame
    // already carries the first 6.7 px step: (93 − 12) / 250 ≈ 0.33 on top of 0.5.
    assert.ok(Math.abs(end.value - 0.83) < 0.05, `drag value ${end.value}`);
  }
  assert.equal(classifyPress({ duration: 0.2, travel: 10, dragged: false }, SETTINGS, 100), 'tap');
  assert.equal(classifyPress({ duration: 0.5, travel: 10, dragged: false }, SETTINGS, 100), 'hold');
  assert.equal(classifyPress({ duration: 0.2, travel: 60, dragged: false }, SETTINGS, 100), 'hold');
  return `drag 1 palm up from 0.5 → ${report.join(', ')}`;
});

test('gestures: a still, jittery pinch on a knob does not turn it', () => {
  const events = perform(knobTarget, [{ frames: 45, gap: 20, jitter: 12 }, { frames: 6, gap: 80 }]);
  assert.equal(events.filter(e => e.type === 'knob').length, 0);
  assert.deepEqual(kinds(events), ['hold']);
});

test('gestures: knob latch ignores the jump of the pinch point while letting go', () => {
  const report = [];
  for (const seed of [11, 12, 13]) {
    // Drag up, rest 0.3 s, then the point drops 40 px in the 2 frames before the pinch opens.
    const events = perform(knobTarget, [
      { frames: 12, gap: 20, dy: -100 }, { frames: 9, gap: 20, jitter: 4 }, { frames: 2, gap: 30, dy: 40 }, { frames: 5, gap: 90 },
    ], { seed });
    const turning = events.filter(e => e.type === 'knob');
    const restValue = turning.filter(e => e.time < events.find(x => x.type === 'knobEnd').time - 0.15).at(-1).value;
    const lastSeen = turning.at(-1).value;
    const end = events.find(e => e.type === 'knobEnd').value;
    report.push(`${restValue.toFixed(3)} → end ${end.toFixed(3)} (unlatched ${lastSeen.toFixed(3)})`);
    assert.ok(Math.abs(end - restValue) < 0.025, `latched ${end} vs resting ${restValue}`);
    assert.ok(restValue - lastSeen > 0.08, 'the test really has a release jump');
  }
  return report.join('; ');
});

test('gestures: a hand that appears pinched, or pinches before it settles, presses nothing', () => {
  const recognizer = createGestureRecognizer(SETTINGS);
  const pedal = createPedalGestures(SETTINGS);
  let time = 0;
  const run = gap => pedal.update(toPointers(recognizer.update([makeHand({ pinchGap: gap })], time += 1 / 30)), time, () => ({ ...switchTarget }));
  const events = [];
  for (let i = 0; i < 5; i++) events.push(...run(20));      // rises into view already pinched
  for (let i = 0; i < 5; i++) events.push(...run(80));
  assert.equal(events.length, 0);
  const fresh = createPedalGestures(SETTINGS);
  const recognizer2 = createGestureRecognizer(SETTINGS);
  time = 0;
  const run2 = gap => fresh.update(toPointers(recognizer2.update([makeHand({ pinchGap: gap })], time += 1 / 30)), time, () => ({ ...switchTarget }));
  const quick = [...run2(80), ...run2(80), ...run2(20), ...run2(20), ...run2(80)];   // pinched 67 ms after appearing
  assert.equal(quick.filter(e => e.type === 'tap').length, 0);
});

test('gestures: 0.4 s lockout after a toggle', () => {
  const lockout = createLockout(400);
  assert.equal(lockout.blocked(0), false);
  lockout.trigger(1);
  assert.equal(lockout.blocked(1.39), true);
  assert.equal(lockout.blocked(1.41), false);
});

// ---------- the controller with the mouse and the real instrument ----------
const STAGE = { width: 1280, height: 720 };
const mouseHover = p => ({ id: 'mouse', source: 'mouse', palm: 90, points: null, fist: false, pinching: false, fresh: false,
  tip: { ...p }, pinchPoint: { ...p }, center: { ...p }, tipSpeed: 600 });
const mouseDrag = (a, b) => [
  { ...mouseHover(a), id: 'mouse-anchor', pinching: true },
  { ...mouseHover(b), id: 'mouse-drag', pinching: true },
];
const camHand = (id, p, extra = {}) => ({ ...mouseHover(p), id, source: 'camera', ...extra });

function rig({ withPedals = true } = {}) {
  const settings = { ...SETTINGS };
  const storage = memoryStorage();
  const board = withPedals ? createPedalboard({ settings, t: k => k, stage: STAGE, storage }) : null;
  const instrument = createAirStrings();
  const played = [];
  const noop = () => {};
  instrument.init({
    settings, t: k => k, stage: STAGE, pitch: createPitchSnapper(settings),
    fx: { burst: noop, shatter: noop, popText: noop }, judge: () => ({ grade: null, points: 0, combo: 0 }), combo: () => 0,
    audio: { pluck: o => played.push(o), ringTime: () => 0.5 },
  });
  let time = 0;
  const frame = (hands, state = 'playing') => {
    time += 1 / 60;
    instrument.onHands(board ? board.route(hands, time, state) : hands, time);
    instrument.update(1 / 60);
  };
  const wait = s => { for (let i = 0; i < s * 60; i++) frame([]); };
  const click = p => { frame([mouseHover(p)]); for (let i = 0; i < 5; i++) frame(mouseDrag(p, p)); frame([mouseHover(p)]); };
  const drag = (a, b, steps = 6) => {
    frame([mouseHover(a)]);
    for (let i = 0; i <= steps; i++) frame(mouseDrag(a, { x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }));
    frame([mouseHover(b)]);
  };
  const swipe = (from, to, steps = 6) => {
    for (let i = 0; i <= steps; i++) frame([mouseHover({ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps })]);
  };
  return { board, instrument, played, storage, settings, frame, wait, click, drag, swipe, get time() { return time; } };
}
const find = (board, pred) => board.targets().find(pred);

test('controller: a click on a footswitch toggles it; a second click within 0.4 s is ignored', () => {
  const { board, click, wait } = rig();
  const od = find(board, t => t.kind === 'switch' && t.pedal === 'overdrive');
  const chorus = find(board, t => t.kind === 'switch' && t.pedal === 'chorus');
  assert.equal(board.model.isOn('overdrive'), true);
  click({ x: od.cx, y: od.cy });
  assert.equal(board.model.isOn('overdrive'), false);
  click({ x: chorus.cx, y: chorus.cy });       // ~120 ms later
  assert.equal(board.model.isOn('chorus'), false, 'locked out');
  wait(0.4);
  click({ x: chorus.cx, y: chorus.cy });
  assert.equal(board.model.isOn('chorus'), true);
});

test('controller: dragging a zone knob up turns it (relative), and the value is saved on release', () => {
  const { board, storage, drag } = rig();
  const knob = find(board, t => t.kind === 'knob' && t.pedal === 'distortion' && t.knob === 'drive');
  const before = board.model.param('distortion', 'drive');
  drag({ x: knob.cx, y: knob.cy }, { x: knob.cx + 5, y: knob.cy - 90 });
  const after = board.model.param('distortion', 'drive');
  const expected = before + (90 - SETTINGS.pedalDragDeadband * 90) / (90 * SETTINGS.pedalKnobTravel);
  assert.ok(Math.abs(after - expected) < 0.03, `${before} → ${after}, expected ≈ ${expected}`);
  assert.ok(close(JSON.parse(storage.getItem(STORAGE_KEY)).pedals.distortion.params.drive, after));
  return `${before.toFixed(2)} → ${after.toFixed(2)}`;
});

test('zone gating: no string is created from inside the zone, nor by a drag that starts there', () => {
  const { board, instrument, drag } = rig();
  const zone = zoneRect(STAGE, SETTINGS);
  drag({ x: 300, y: zone.y + 40 }, { x: 900, y: zone.y + 60 });
  assert.equal(instrument.strings.length, 0, 'inside the zone');
  drag({ x: 300, y: zone.y + 40 }, { x: 900, y: 200 });
  assert.equal(instrument.strings.length, 0, 'started in the zone');
  assert.equal(instrument.drafting, false);
  drag({ x: 300, y: 300 }, { x: 900, y: 300 });
  assert.equal(instrument.strings.length, 1, 'control: above the zone a drag makes a string');
  void board;
});

test('zone gating: a string reaching into the zone is not plucked or deleted from inside it', () => {
  const { board, instrument, played, swipe, wait, frame } = rig();
  const zone = zoneRect(STAGE, SETTINGS);
  // A string lying inside the zone (e.g. drawn before the zone was turned on): made by talking to
  // the instrument directly, bypassing the board. The same string in a rig without the board is
  // the control.
  const y = zone.y + 30;
  const ghost = rig({ withPedals: false });
  ghost.drag({ x: 300, y }, { x: 900, y });
  instrument.onHands(mouseDrag({ x: 300, y }, { x: 900, y }), 0.002);
  instrument.onHands([mouseHover({ x: 900, y })], 0.003);
  assert.equal(instrument.strings.length, 1);
  wait(0.5);
  const count = played.length;
  swipe({ x: 600, y: y - 25 }, { x: 600, y: y + 25 });
  swipe({ x: 500, y: y + 25 }, { x: 500, y: y - 25 });
  assert.equal(played.length, count, 'no pluck inside the zone');

  // Camera: a fist held on it for 1.5 s, then two fists (one in the zone) for 1.5 s.
  for (let i = 0; i < 90; i++) frame([camHand('L', { x: 600, y }, { fist: true })]);
  assert.equal(instrument.strings.length, 1, 'fist delete does not fire in the zone');
  for (let i = 0; i < 90; i++) frame([camHand('L', { x: 600, y }, { fist: true }), camHand('R', { x: 600, y: 200 }, { fist: true })]);
  assert.equal(instrument.strings.length, 1, 'two-fist clear needs both fists outside the zone');
  // Control: the same swipe without the pedalboard plucks.
  ghost.wait(0.5);
  const before = ghost.played.length;
  ghost.swipe({ x: 600, y: y - 25 }, { x: 600, y: y + 25 });
  assert.equal(ghost.played.length, before + 1);
  void board;
});

test('zone gating: a hand pressing a pedal stays the pedalboard\'s until it lets go', () => {
  const { board, instrument, frame } = rig();
  const knob = find(board, t => t.kind === 'knob' && t.pedal === 'overdrive' && t.knob === 'drive');
  // Camera hands: L settles open in the zone, pinches the knob and drags far up out of the zone,
  // while R pinches above: two pinching hands would normally stretch a string.
  for (let i = 0; i < 15; i++) frame([camHand('L', { x: knob.cx, y: knob.cy }), camHand('R', { x: 900, y: 250 })]);
  for (let i = 0; i < 40; i++) {
    const y = knob.cy - i * 8;
    frame([camHand('L', { x: knob.cx, y }, { pinching: true }), camHand('R', { x: 900, y: 250 }, { pinching: true })]);
  }
  for (let i = 0; i < 20; i++) frame([camHand('L', { x: knob.cx, y: 200 }), camHand('R', { x: 900, y: 250 })]);
  assert.equal(instrument.strings.length, 0);
  assert.ok(board.model.param('overdrive', 'drive') > 0.9, 'the knob turned instead');
});

test('tuning screen: strings are inert, Esc closes it, it only opens in the ready state', () => {
  const { board, instrument, frame } = rig();
  assert.equal(board.handleKey('p', 'playing'), true);
  assert.equal(board.tuningOpen, false, 'not while playing');
  frame([], 'ready');
  assert.equal(board.handleKey('p', 'ready'), true);
  assert.equal(board.tuningOpen, true);
  for (let i = 0; i < 4; i++) frame(mouseDrag({ x: 300, y: 300 }, { x: 900, y: 300 }), 'ready');
  frame([mouseHover({ x: 900, y: 300 })], 'ready');
  assert.equal(instrument.strings.length, 0);
  assert.equal(board.handleKey(' ', 'ready'), true, 'space cannot start the song from here');
  assert.equal(board.handleKey('escape', 'ready'), true);
  assert.equal(board.tuningOpen, false);
  board.openTuning();
  frame([], 'playing');
  assert.equal(board.tuningOpen, false, 'leaving the ready state closes it');
});

test('tuning screen: presets, macro knob, advanced mode and reordering by click', () => {
  const { board, frame } = rig();
  frame([], 'ready');
  board.openTuning();
  // The tuning screen only stays open in the ready state.
  const R = (hands) => frame(hands, 'ready');
  const clickR = p => { R([mouseHover(p)]); for (let i = 0; i < 5; i++) R(mouseDrag(p, p)); R([mouseHover(p)]); for (let i = 0; i < 30; i++) R([]); };
  const at = t => ({ x: t.cx ?? t.rect.x + t.rect.w / 2, y: t.cy ?? t.rect.y + t.rect.h / 2 });
  clickR(at(find(board, t => t.action === 'preset' && t.preset === 'metal')));
  assert.equal(board.model.preset, 'metal');
  const macro = find(board, t => t.kind === 'knob' && t.macro === 'drive');
  const before = board.model.macro('drive');
  const a = at(macro), b = { x: a.x, y: a.y + 60 };
  R([mouseHover(a)]);
  for (let i = 0; i <= 6; i++) R(mouseDrag(a, { x: a.x, y: a.y + 60 * i / 6 }));
  R([mouseHover(b)]);
  assert.ok(board.model.macro('drive') < before - 0.15, 'dragging the drive macro down lowers both drives');
  assert.equal(board.model.preset, null);
  clickR(at(find(board, t => t.action === 'mode' && t.mode === 'advanced')));
  assert.equal(board.model.mode, 'advanced');
  clickR(at(find(board, t => t.kind === 'select' && t.pedal === 'delay')));
  assert.equal(board.selected, 'delay');
  clickR(at(find(board, t => t.action === 'move' && t.delta === -1)));
  assert.deepEqual(board.model.snapshot().order.slice(-3), ['delay', 'chorus', 'reverb']);
  assert.ok(find(board, t => t.kind === 'knob' && t.pedal === 'delay' && t.knob === 'level'), 'advanced shows level');
  clickR(at(find(board, t => t.action === 'done')));
  assert.equal(board.tuningOpen, false);
});

test('keyboard backup: 4–9 toggle the pedals in zone order, W switches the wah between hand and auto', () => {
  const { board } = rig();
  const order = board.model.pedalOrder();
  for (let i = 0; i < 6; i++) {
    const before = board.model.isOn(order[i]);
    assert.equal(board.handleKey(String(4 + i), 'playing'), true);
    assert.equal(board.model.isOn(order[i]), !before);
  }
  assert.equal(board.handleKey('4', 'intro'), false);
  const mode = board.model.param('wah', 'mode');
  board.handleKey('w', 'playing');
  assert.notEqual(board.model.param('wah', 'mode'), mode);
  assert.equal(board.model.isOn('wah'), true);
});

test('wah strip: hand height sets the position, the hand cannot pluck there, value kept on leaving', () => {
  const { board, instrument, played, frame, wait, drag } = rig();
  board.model.toggle('wah', true);
  board.model.setParam('wah', 'mode', 0);   // hand control: the strip appears
  const strip = find(board, t => t.kind === 'strip');
  assert.ok(strip, 'strip shown');
  const x = strip.rect.x + strip.rect.w / 2;
  // A string crossing under the strip, made away from it.
  drag({ x: 400, y: 300 }, { x: STAGE.width - 2, y: 300 });
  assert.equal(instrument.strings.length, 1);
  wait(0.5);
  const count = played.length;
  for (let i = 0; i <= 10; i++) frame([mouseHover({ x, y: 200 + i * 20 })]);
  assert.equal(played.length, count, 'moving through the strip does not pluck');
  const low = board.model.param('wah', 'position');
  for (let i = 0; i <= 10; i++) frame([mouseHover({ x, y: 400 - i * 25 })]);
  const high = board.model.param('wah', 'position');
  assert.ok(high > low + 0.4, `${low} → ${high}`);
  frame([mouseHover({ x: 300, y: 150 })]);
  wait(0.2);
  assert.equal(board.model.param('wah', 'position'), high);
  return `position ${low.toFixed(2)} → ${high.toFixed(2)}`;
});

test('mouse: a click shorter than one frame is still seen pressed for one poll', () => {
  const listeners = {};
  const element = { addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const mouse = createMouseInput(element, { onCommand() {} });
  mouse.setEnabled(true);
  const at = { clientX: 200, clientY: 650, button: 0 };
  listeners.mousemove(at);
  assert.equal(mouse.poll()[0].pinching, false);
  listeners.mousedown(at);
  listeners.mouseup(at);                        // both between two frames
  const pressed = mouse.poll();
  assert.equal(pressed.length, 2);
  assert.ok(pressed.every(h => h.pinching));
  const after = mouse.poll();
  assert.equal(after.length, 1);
  assert.equal(after[0].pinching, false);
  listeners.mousedown(at);                      // a normal click: seen pressed, then released
  assert.ok(mouse.poll().every(h => h.pinching));
  listeners.mouseup(at);
  assert.equal(mouse.poll()[0].pinching, false);
});

console.table(results);
const failed = results.filter(r => r.result === 'FAIL').length;
if (failed) { console.error(`${failed} test(s) failed`); process.exit(1); }
console.log('pedalboard tests passed');
