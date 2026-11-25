// node tests/reverb.test.mjs
// 空間 (reverb, src/core/audio/post-fx/reverb.js): the generated impulse responses (deterministic,
// RT60 per size step, monotonic decay, darker tails, decorrelated left/right, no DC), the knob mapping,
// the Web Audio graph on a fake context (bypass exact, nothing built after create, IRs only when
// needed), size changes without jumps and trails after switching off (the fake context's automation
// replayed through the Node model), and the peak against the demo song and, when present, the
// owner's local songs (samples/s14.wav, s21.wav or $AIRJAM_SAMPLES; never committed).
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as reverb from '../src/core/audio/post-fx/reverb.js';
import {
  REVERB_SIZES, REVERB_RANGES, REVERB_DEFAULT_KNOBS, CROSSOVER_HZ, generateImpulseResponse, reverbSettings,
  wetGain, paramsFromSnapshot, renderWet, convolve, SIZE_TAU,
} from '../src/core/audio/post-fx/reverb.js';
import { createPostFxBus, postFxParams } from '../src/core/audio/post-fx/index.js';
import { createAudioEngine, PEDAL_TAU } from '../src/core/audio/engine.js';
import { TONES } from '../src/core/audio/tones.js';
import { rigFromSnapshot, electricTone } from '../src/core/audio/electric-rig.js';
import { simulateParam } from '../src/core/audio/wah.js';
import { createPedalModel, visibleKnobs, knobOf, knobValue, PEDAL_TYPES } from '../src/core/pedals/model.js';
import { isPedalAvailable } from '../src/core/pedals/availability.js';
import pedalTexts from '../src/i18n/zh-Hant.pedals.js';
import { renderPart, renderMaster } from '../tools/tone-lab/model.mjs';
import { chug, A5, rms, peakOf } from '../src/lab/metrics.js';
import { renderDemoSong } from '../src/core/song/demo-song.js';
import { SETTINGS } from '../src/settings.js';
import { FakeAudioContext } from './fake-audio-context.mjs';

const results = [];
function test(name, fn) {
  try { const note = fn(); results.push({ test: name, result: 'PASS', detail: note ?? '' }); }
  catch (error) { results.push({ test: name, result: 'FAIL', detail: error.message.split('\n')[0] }); }
}
const db = x => 20 * Math.log10(x);
const SR = 48000;

// Broadband RT60 from Schroeder backward integration, T30 (−5 → −35 dB) × 2.
function rt60(h, sampleRate = SR) {
  const edc = new Float64Array(h.length);
  let sum = 0;
  for (let i = h.length - 1; i >= 0; i--) { sum += h[i] * h[i]; edc[i] = sum; }
  const level = i => 10 * Math.log10(edc[i] / edc[0]);
  let a = -1;
  for (let i = 0; i < h.length; i++) {
    if (a < 0 && level(i) <= -5) a = i;
    if (level(i) <= -35) return 2 * (i - a) / sampleRate;
  }
  return Infinity;
}
const windowEnergy = (h, from, to) => { let e = 0; for (let i = from; i < Math.min(to, h.length); i++) e += h[i] * h[i]; return e; };
function correlation(a, b, lag = 0) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = Math.max(0, -lag); i < Math.min(a.length, b.length - lag); i++) { ab += a[i] * b[i + lag]; aa += a[i] * a[i]; bb += b[i + lag] * b[i + lag]; }
  return ab / Math.sqrt(aa * bb);
}
function onePoleHigh(x, hz, sampleRate = SR) {
  const k = 1 - Math.exp(-2 * Math.PI * hz / sampleRate);
  const y = new Float32Array(x.length);
  let low = 0;
  for (let i = 0; i < x.length; i++) { low += k * (x[i] - low); y[i] = x[i] - low; }
  return y;
}
const maxStep = (x, from, to) => { let m = 0; for (let i = Math.max(1, from); i < Math.min(to, x.length); i++) m = Math.max(m, Math.abs(x[i] - x[i - 1])); return m; };

function reverbSnapshot({ on = true, mode = 'simple', preset = 'rock', ...params } = {}) {
  const model = createPedalModel();
  model.applyPreset(preset);
  model.setMode(mode);
  model.toggle('reverb', on);
  for (const [knob, value] of Object.entries(params)) model.setParam('reverb', knob, value);
  return model.snapshot();
}
const paramsOf = o => paramsFromSnapshot(reverbSnapshot(o));

// Replays a fake AudioParam's automation (setTargetAtTime calls) as a per-sample curve.
const curve = (param, duration, sampleRate = SR) => simulateParam(
  param.calls.map(c => (c.type === 'target' ? { ...c, value: c.target } : c)),
  { sampleRate, duration, initial: param.value });

// A slot built on a fake context, its nodes found by role.
function fakeSlot() {
  const ctx = new FakeAudioContext({ sampleRate: SR });
  const input = ctx.createGain(), output = ctx.createGain();
  const fx = reverb.create(ctx, { input, output, part: 'rhythm' });
  const convolvers = ctx.created.filter(n => n.kind === 'convolver');
  const gains = ctx.created.filter(n => n.kind === 'gain' && n !== input && n !== output);
  const send = gains.find(g => input.outputs.has(g));
  const sizeSends = convolvers.map(c => gains.find(g => g.outputs.has(c)));
  const wet = gains.find(g => g.outputs.has(output));
  return { ctx, input, output, fx, convolvers, send, sizeSends, wet };
}
// Per-size send curves (master × size) from the fake automation.
const sendCurves = (slot, duration) => {
  const master = curve(slot.send.gain, duration);
  return slot.sizeSends.map(g => { const c = curve(g.gain, duration); return c.map((v, i) => v * master[i]); });
};

// A guitar signal: the rock preset (丁) chugging A5 eighth notes, Node model.
function guitar(seconds, { bpm = 105, sampleRate = SR, seed = 3 } = {}) {
  const tone = electricTone(rigFromSnapshot(reverbSnapshot({ on: false })));
  return renderPart(tone, chug(A5.slice(0, 4), { bpm, seconds, velocity: 0.6 }), { duration: seconds, settings: SETTINGS, sampleRate, seed });
}

// ---------- impulse responses ----------
test('IR: deterministic for (size, sample rate, seed); another seed or size gives another IR', () => {
  for (const sr of [44100, 48000]) for (let s = 0; s < REVERB_SIZES.length; s++) {
    const a = generateImpulseResponse(s, sr), b = generateImpulseResponse(s, sr);
    assert.deepEqual(a.left, b.left); assert.deepEqual(a.right, b.right);
  }
  const c = generateImpulseResponse(1, SR, { seed: 7 }), d = generateImpulseResponse(1, SR);
  assert.ok(Math.abs(correlation(c.left, d.left)) < 0.1, 'seed changes the noise');
  return `${REVERB_SIZES.length} sizes × 44.1/48 kHz`;
});

test('IR: RT60 (Schroeder T30) of every size step is inside its range, both channels, both rates', () => {
  const notes = [];
  for (let s = 0; s < REVERB_SIZES.length; s++) {
    const { id, range } = REVERB_SIZES[s];
    for (const sr of [44100, 48000]) {
      const ir = generateImpulseResponse(s, sr);
      for (const side of ['left', 'right']) {
        const t = rt60(ir[side], sr);
        assert.ok(t >= range[0] && t <= range[1], `${id} ${side} ${sr}: ${t.toFixed(2)} s not in ${range}`);
      }
      if (sr === SR) notes.push(`${id} ${rt60(ir.left).toFixed(2)} s`);
    }
  }
  const ranges = REVERB_SIZES.map(s => s.range);
  for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i][0] > ranges[i - 1][1], 'steps do not overlap');
  return notes.join(', ');
});

test('IR: energy falls in every 50 ms window after the early reflections; the tail gets darker', () => {
  const notes = [];
  for (let s = 0; s < REVERB_SIZES.length; s++) {
    const { id, early, rt60: rt } = REVERB_SIZES[s];
    const ir = generateImpulseResponse(s, SR);
    for (const side of ['left', 'right']) {
      const h = ir[side];
      const win = Math.round(0.05 * SR);
      let prev = Infinity;
      for (let from = Math.round((early[1] + 0.005) * SR); from + win <= h.length; from += win) {
        const e = windowEnergy(h, from, from + win);
        assert.ok(e < prev, `${id} ${side}: energy rises at ${(from / SR).toFixed(2)} s`);
        prev = e;
      }
    }
    // Share of the energy above 4 kHz, early part vs. a third into the tail.
    const high = onePoleHigh(ir.left, 4000);
    const share = (a, b) => windowEnergy(high, a, b) / windowEnergy(ir.left, a, b);
    const at = t => Math.round(t * SR);
    const early0 = share(at(early[1]), at(early[1] + 0.1)), late = share(at(rt / 3), at(rt / 3 + 0.1));
    assert.ok(db(late / early0) < -3, `${id}: tail not darker (${db(late / early0).toFixed(1)} dB)`);
    notes.push(`${id} ${db(late / early0).toFixed(0)} dB`);
  }
  return `>4 kHz share, ⅓ RT vs early: ${notes.join(', ')}`;
});

test('IR: left and right decorrelated (|r| < 0.1 at lags up to ±2 ms); no DC; energy 1; peak < 0.35', () => {
  let worst = 0;
  for (let s = 0; s < REVERB_SIZES.length; s++) {
    const { left, right } = generateImpulseResponse(s, SR);
    for (let lag = -96; lag <= 96; lag += 8) worst = Math.max(worst, Math.abs(correlation(left, right, lag)));
    for (const h of [left, right]) {
      let sum = 0, energy = 0, peak = 0;
      for (const v of h) { sum += v; energy += v * v; peak = Math.max(peak, Math.abs(v)); }
      assert.ok(Math.abs(sum) < 1e-4, `${REVERB_SIZES[s].id}: DC ${sum}`);
      assert.ok(Math.abs(energy - 1) < 1e-4, `energy ${energy}`);
      assert.ok(peak < 0.35, `peak ${peak}`);
    }
  }
  assert.ok(worst < 0.1, `L/R correlation ${worst.toFixed(3)}`);
  return `max |r| ${worst.toFixed(3)}`;
});

test('IR: build cost (Node, 48 kHz) and memory per size', () => {
  const rows = REVERB_SIZES.map((size, s) => {
    const t0 = performance.now();
    const ir = generateImpulseResponse(s, SR, { seed: 99 });
    return `${size.id} ${(performance.now() - t0).toFixed(1)} ms / ${(ir.left.length * 8 / 1e6).toFixed(2)} MB`;
  });
  return rows.join(', ');
});

// ---------- mapping ----------
test('mapping: wet gain m/(1−m) is 0 at 0, monotonic, ≤ 0.54 at 35 %, clamped outside', () => {
  let prev = -1;
  for (let m = 0; m <= 35; m += 0.5) { const w = wetGain(m); assert.ok(w > prev); prev = w; }
  assert.equal(wetGain(0), 0);
  assert.ok(Math.abs(wetGain(35) - 0.35 / 0.65) < 1e-12);
  assert.equal(wetGain(80), wetGain(35)); assert.equal(wetGain(-5), 0); assert.equal(wetGain(NaN), 0);
  return `default ${REVERB_RANGES.mix[1] * REVERB_DEFAULT_KNOBS.mix}% → ${db(wetGain(REVERB_RANGES.mix[1] * REVERB_DEFAULT_KNOBS.mix)).toFixed(1)} dB, max ${db(wetGain(35)).toFixed(1)} dB`;
});

test('mapping: every knob swept 0 → 1 moves its number monotonically inside its range', () => {
  const field = { size: 'size', mix: 'wet', tone: 'toneHz', preDelay: 'preDelay', lowCut: 'lowCutHz', level: 'wet' };
  for (const knob of PEDAL_TYPES.reverb.knobs) {
    let prev = -Infinity;
    for (let v = 0; v <= 1.0001; v += 0.05) {
      const s = reverbSettings(paramsOf({ mode: 'advanced', [knob.id]: v }));
      const x = s[field[knob.id]];
      assert.ok(Number.isFinite(x) && x >= prev - 1e-12, `${knob.id} at ${v}`);
      prev = x;
      assert.ok(s.size >= 0 && s.size < REVERB_SIZES.length && s.wet >= 0 && s.wet <= wetGain(35) * 2 + 1e-9);
      assert.ok(s.preDelay >= 0 && s.preDelay <= reverb.MAX_PRE_DELAY);
      assert.ok(s.lowCutHz >= 60 && s.lowCutHz <= 800 && s.toneHz >= 2000 && s.toneHz <= 12000);
    }
  }
  // Garbage and missing values fall back to the defaults or the range ends.
  const junk = reverbSettings({ on: true, values: { size: 9, mix: NaN, tone: -1, preDelay: 1e6, lowCut: undefined } });
  assert.deepEqual([junk.size, junk.wet, junk.toneHz, junk.preDelay], [3, wetGain(14), 2000, 0.08]);
  // Level counts only in advanced mode.
  const loud = { level: 1, mix: 0.5 };
  assert.equal(reverbSettings(paramsOf({ ...loud })).wet, wetGain(17.5));
  assert.ok(Math.abs(reverbSettings(paramsOf({ ...loud, mode: 'advanced' })).wet / wetGain(17.5) - 2) < 0.01, '+6 dB');
});

test('model: simple mode shows 大小 and 混合; advanced shows six knobs; default 錄音室, 14 %', () => {
  assert.deepEqual(visibleKnobs('reverb', 'simple').map(k => k.id), ['size', 'mix']);
  assert.deepEqual(visibleKnobs('reverb', 'advanced').map(k => k.id), ['size', 'mix', 'tone', 'preDelay', 'lowCut', 'level']);
  for (const knob of PEDAL_TYPES.reverb.knobs) {
    assert.ok(pedalTexts[knob.label], knob.label);
    for (const step of knob.steps ?? []) assert.ok(pedalTexts[step], step);
  }
  const s = reverbSettings(paramsOf({}));
  assert.deepEqual([REVERB_SIZES[s.size].id, s.mix], ['studio', 14]);
  assert.equal(knobValue(knobOf('reverb', 'size'), 0), 0);
  assert.equal(isPedalAvailable('reverb'), true);
  assert.equal(paramsOf({}).on, true);
  assert.equal(paramsOf({ on: false }).on, false);
  assert.equal(paramsFromSnapshot(null).on, false);
  return `大小：${knobOf('reverb', 'size').steps.map(k => pedalTexts[k]).join('／')}`;
});

// ---------- the Web Audio graph (fake context) ----------
test('graph: dry path at unity, wet return exactly 0 until switched on; off changes nothing (bit-exact)', () => {
  const slot = fakeSlot();
  assert.ok(slot.input.outputs.has(slot.output));
  assert.equal(slot.wet.gain.value, 0);
  assert.equal(slot.send.gain.value, 0);
  for (const c of slot.convolvers) { assert.equal(c.normalize, false); assert.equal(c.buffer, null, 'no IR before the pedal is on'); }
  slot.fx.apply(paramsOf({ on: false }), { type: 'load' }, { now: 0, tau: PEDAL_TAU.toggle });
  slot.fx.apply(postFxParams(null).reverb, { type: 'tone' }, { now: 0, tau: PEDAL_TAU.toggle });
  assert.equal(slot.wet.gain.calls.length + slot.send.gain.calls.length, 0, 'no automation while off');
  assert.equal(slot.fx.irBuilds.length, 0);
  // Node model: off returns its input.
  const signal = { left: new Float32Array([1, 2]), right: new Float32Array([3, 4]) };
  assert.equal(reverb.process(paramsOf({ on: false }), signal), signal);
});

test('graph: nothing is created after create; IRs only for sizes used (others in idle time)', () => {
  const slot = fakeSlot();
  const nodes = slot.ctx.created.length;
  let now = 0;
  slot.fx.apply(paramsOf({}), { type: 'toggle', id: 'reverb', on: true }, { now, tau: PEDAL_TAU.toggle });
  assert.deepEqual(slot.fx.irBuilds.map(b => b.size), ['studio'], 'only the size in use');
  for (let i = 0; i < 40; i++) {
    now += 0.05;
    const p = paramsOf({ size: (i % 4) / 3, mix: i / 40, mode: i % 2 ? 'advanced' : 'simple', tone: 1 - i / 40, preDelay: i / 40, lowCut: i / 40 });
    slot.fx.apply(i % 7 ? p : { ...p, on: false }, { type: 'param', id: 'reverb', knob: 'mix' }, { now, tau: PEDAL_TAU.knob });
  }
  assert.equal(slot.ctx.created.length, nodes, 'no nodes');
  assert.equal(slot.fx.irBuilds.length, 4, 'each IR built once');
  assert.ok(slot.convolvers.every(c => c.buffer?.length > 0));
  // A dragged mix knob only moves the wet return.
  const before = slot.ctx.created.map(n => Object.values(n).filter(v => v?.calls).reduce((a, p) => a + p.calls.length, 0));
  slot.fx.apply(paramsOf({ mix: 0.9, size: 1 }), { type: 'param' }, { now: now + 1, tau: PEDAL_TAU.knob });
  slot.fx.apply(paramsOf({ mix: 0.8, size: 1 }), { type: 'param' }, { now: now + 1.1, tau: PEDAL_TAU.knob });
  const after = slot.ctx.created.map(n => Object.values(n).filter(v => v?.calls).reduce((a, p) => a + p.calls.length, 0));
  const moved = slot.ctx.created.filter((_, i) => after[i] !== before[i]);
  assert.ok(moved.includes(slot.wet) && moved.length <= 2 + slot.sizeSends.length, `${moved.length} nodes moved`);
  slot.fx.dispose();
  assert.equal(slot.input.outputs.size, 0);
  return `${nodes - 2} nodes per part`;
});

test('graph: the engine passes the reverb to the electric rig only; steel closes the send (trails)', () => {
  const ctx = new FakeAudioContext();
  const engine = createAudioEngine(SETTINGS, { context: ctx });
  engine.setTone(TONES.electric);
  const bus = engine.postFx('rhythm');
  const slot = bus.slots.find(s => s.id === 'reverb');
  const send = [...slot.input.outputs].find(n => n !== slot.output);
  const nodes = ctx.created.length;
  const lastTarget = param => param.calls.filter(c => c.type === 'target').at(-1).target;
  engine.applyPedals(reverbSnapshot(), { type: 'toggle', id: 'reverb', on: true });
  assert.equal(lastTarget(send.gain), 1);
  assert.equal(slot.fx.irBuilds.length, 1);
  engine.setTone(TONES.steel);
  assert.equal(lastTarget(send.gain), 0, 'steel: send closed');
  const wet = ctx.created.find(n => n.kind === 'gain' && n.outputs.has(slot.output) && n !== slot.input);
  assert.ok(lastTarget(wet.gain) > 0, 'return stays open: the tail rings out');
  engine.setTone(TONES.electric);
  assert.equal(lastTarget(send.gain), 1);
  // Steel's own room is a new convolver of the steel chain (tones.js); the reverb's four are not rebuilt.
  assert.equal(ctx.created.filter(n => n.kind === 'convolver' && n.normalize === false).length, 4, 'one part, four convolvers');
  assert.equal(slot.fx.irBuilds.length, 1, 'no IR rebuilt');
  assert.ok(ctx.created.length >= nodes);
});

test('graph: a closed send lands on exactly 0 (so the browser can idle the convolver); reopening in between is not undone', () => {
  const slot = fakeSlot();
  slot.fx.apply(paramsOf({}), { type: 'toggle' }, { now: 0, tau: PEDAL_TAU.toggle });
  slot.fx.apply(paramsOf({ size: 1 }), { type: 'param' }, { now: 0.5, tau: PEDAL_TAU.knob });
  slot.fx.apply(paramsOf({ size: 1, on: false }), { type: 'toggle' }, { now: 1, tau: PEDAL_TAU.toggle });
  let send = curve(slot.send.gain, 3), sizes = slot.sizeSends.map(g => curve(g.gain, 3));
  assert.equal(send[Math.round(1.2 * SR)], 0, 'master send exactly 0');
  assert.equal(sizes[1][Math.round(1.2 * SR)], 0, 'the old size send exactly 0');
  assert.ok(sizes[3][Math.round(1.2 * SR)] > 0.9999);
  const settleStep = Math.max(...[send, sizes[1]].map(c => maxStep(c, 1, c.length)));
  assert.ok(settleStep < 0.05, `largest step on a send ${settleStep.toFixed(4)} (the ramps' own steps)`);
  // Off then on again before the off had settled: the pending "set 0" is cancelled.
  slot.fx.apply(paramsOf({ size: 1, on: false }), { type: 'toggle' }, { now: 2, tau: PEDAL_TAU.toggle });
  slot.fx.apply(paramsOf({ size: 1 }), { type: 'toggle' }, { now: 2.05, tau: PEDAL_TAU.toggle });
  send = curve(slot.send.gain, 3);
  assert.ok(send[Math.round(2.9 * SR)] > 0.999, 'reopened send stays open');
});

// ---------- sound (fake automation replayed in the Node model) ----------
const SECONDS = 3;
const signal = guitar(SECONDS);

function wetFor(slot, input = signal, duration = SECONDS) {
  const s = reverbSettings(paramsOf({}));
  return renderWet(input, SR, { sends: sendCurves(slot, duration), preDelay: s.preDelay, lowCutHz: s.lowCutHz, toneHz: s.toneHz });
}

test('size change: cross-fade on the send side, no jump bigger than the steady sizes make', () => {
  const rows = [];
  for (const [from, to] of [[1, 3], [3, 0], [0, 2]]) {
    const at = 1.5;
    const render = steps => {
      const slot = fakeSlot();
      for (const [t, size] of steps) slot.fx.apply(paramsOf({ size: size / 3 }), { type: 'param', id: 'reverb', knob: 'size' }, { now: t, tau: PEDAL_TAU.knob });
      return wetFor(slot);
    };
    const switched = render([[0, from], [at, to]]), a = render([[0, from]]), b = render([[0, to]]);
    const win = [Math.round((at - 0.01) * SR), Math.round((at + 0.4) * SR)];
    const jump = Math.max(maxStep(switched.left, ...win), maxStep(switched.right, ...win));
    const steady = Math.max(...[a, b].flatMap(r => [maxStep(r.left, ...win), maxStep(r.right, ...win)]));
    assert.ok(jump <= steady * 1.1 + 1e-6, `${from}→${to}: step ${jump.toFixed(4)} vs ${steady.toFixed(4)}`);
    // The old room's tail is still there right after the switch (not cut).
    const old = rms({ sampleRate: SR, ...a }, at + 0.02, at + 0.06), now = rms({ sampleRate: SR, ...switched }, at + 0.02, at + 0.06);
    assert.ok(now > old * 0.5, `${from}→${to}: tail cut`);
    rows.push(`${REVERB_SIZES[from].id}→${REVERB_SIZES[to].id} ${(jump / steady).toFixed(2)}×`);
  }
  return `largest sample step vs. steady sizes: ${rows.join(', ')} (size tau ${SIZE_TAU * 1000} ms)`;
});

test('off: the send closes and the tail rings out (trails); on again fades in', () => {
  const slot = fakeSlot();
  const off = 1.2;
  slot.fx.apply(paramsOf({ size: 2 / 3 }), { type: 'toggle' }, { now: 0, tau: PEDAL_TAU.toggle });
  slot.fx.apply(paramsOf({ size: 2 / 3, on: false }), { type: 'toggle' }, { now: off, tau: PEDAL_TAU.toggle });
  const wet = wetFor(slot);
  const out = { sampleRate: SR, ...wet };
  const before = rms(out, off - 0.2, off), after = rms(out, off + 0.1, off + 0.2), later = rms(out, off + 1.0, off + 1.1);
  assert.ok(db(after / before) > -12, `tail ${db(after / before).toFixed(1)} dB 0.1 s after off`);
  assert.ok(later < after && db(later / before) > -45, `still decaying, ${db(later / before).toFixed(1)} dB after 1 s`);
  const win = [Math.round((off - 0.01) * SR), Math.round((off + 0.1) * SR)];
  assert.ok(maxStep(wet.left, ...win) <= maxStep(wet.left, Math.round(0.3 * SR), win[0]) * 1.1, 'no click at off');
  return `hall: −${(-db(after / before)).toFixed(1)} dB 0.1 s after off, −${(-db(later / before)).toFixed(1)} dB after 1 s`;
});

test('Node model: dry untouched and not delayed; wet starts after the pre-delay; convolution exact', () => {
  const s = reverbSettings(paramsOf({ preDelay: 0.5, mode: 'advanced' }));
  const click = { left: new Float32Array(SR), right: new Float32Array(SR) };
  click.left[0] = 0.5; click.right[0] = 0.5;
  const out = reverb.process(paramsOf({ preDelay: 0.5, mode: 'advanced' }), click, { sampleRate: SR });
  const shift = Math.round(s.preDelay * SR);
  assert.equal(out.left[0], 0.5, 'dry at t = 0');
  for (let i = 1; i < shift; i++) assert.ok(Math.abs(out.left[i]) < 1e-9, `nothing before the pre-delay (${i})`);
  assert.ok(Math.max(...out.left.subarray(shift, shift + SR / 10).map(Math.abs)) > 1e-4);
  // FFT convolution equals direct convolution.
  const x = Float32Array.from({ length: 300 }, (_, i) => Math.sin(i * 0.3) * (i % 7 === 0 ? 1 : 0.2));
  const h = Float32Array.from({ length: 77 }, (_, i) => Math.exp(-i / 20) * (i % 2 ? 1 : -0.5));
  const y = convolve(x, h, 376);
  let err = 0;
  for (let n = 0; n < 376; n++) {
    let d = 0;
    for (let k = 0; k < h.length; k++) if (n - k >= 0 && n - k < x.length) d += x[n - k] * h[k];
    err = Math.max(err, Math.abs(d - y[n]));
  }
  assert.ok(err < 1e-5, `convolution error ${err}`);
  return `pre-delay ${(s.preDelay * 1000).toFixed(0)} ms`;
});

// ---------- level and peak against songs ----------
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function readWav(path) {
  const b = readFileSync(path);
  let o = 12, fmt = null, data = null;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') data = b.subarray(o + 8, Math.min(b.length, o + 8 + size));
    o += 8 + size + (size & 1);
  }
  if (!fmt || !data || fmt.bits !== 16) return null;
  const frames = Math.floor(data.length / 2 / fmt.channels);
  const left = new Float32Array(frames), right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = data.readInt16LE(i * 2 * fmt.channels) / 32768;
    right[i] = data.readInt16LE((i * fmt.channels + (fmt.channels > 1 ? 1 : 0)) * 2) / 32768;
  }
  return { left, right, sampleRate: fmt.rate };
}

test('peak: against the demo and the local songs, worst-case reverb keeps the mix ≤ 0.99', () => {
  const rate = 44100, seconds = 8;
  const cut = (song, from) => ({ left: song.left.slice(from * rate, (from + seconds) * rate), right: song.right.slice(from * rate, (from + seconds) * rate) });
  const demo = renderDemoSong(rate);
  const songs = [{ name: 'demo', bpm: 100, section: cut({ left: demo.samples, right: demo.samples }, 4) }];
  for (const [file, bpm] of [['s14.wav', 160], ['s21.wav', 104.9]]) {
    const path = join(process.env.AIRJAM_SAMPLES ?? join(root, 'samples'), file);
    const song = existsSync(path) ? readWav(path) : null;
    if (song?.sampleRate === rate) songs.push({ name: file, bpm, section: cut(song, 10) });
  }
  const cases = {
    off: { on: false },
    default: {},
    worst: { mode: 'advanced', size: 1, mix: 1, level: 1, tone: 1, lowCut: 0, preDelay: 0 },
  };
  const rows = [];
  for (const song of songs) {
    const row = [song.name];
    for (const [name, o] of Object.entries(cases)) {
      const snapshot = reverbSnapshot(o);
      const part = renderPart(electricTone(rigFromSnapshot(snapshot)), chug(A5.slice(0, 4), { bpm: song.bpm, seconds, velocity: 0.6 }),
        { duration: seconds, settings: SETTINGS, sampleRate: rate, seed: 5, post: postFxParams(snapshot) });
      const mix = renderMaster(part, song.section, { sampleRate: rate, settings: SETTINGS });
      let limiter = 0;
      for (let i = rate; i < mix.reductionDb.length; i++) limiter = Math.min(limiter, mix.reductionDb[i]);
      const peak = peakOf(mix);
      assert.ok(peak <= 0.99, `${song.name} ${name}: peak ${peak.toFixed(3)}`);
      row.push(`${name} ${peak.toFixed(3)}/${(-limiter).toFixed(1)}/${db(rms({ sampleRate: rate, ...part }, 1)).toFixed(1)}`);
    }
    rows.push(row.join(' '));
  }
  return `peak / limiter dB / guitar RMS dB — ${rows.join('; ')}`;
});

console.table(results);
const failed = results.filter(r => r.result === 'FAIL').length;
if (failed) { console.error(`${failed} test(s) failed`); process.exit(1); }
console.log('reverb tests passed');
