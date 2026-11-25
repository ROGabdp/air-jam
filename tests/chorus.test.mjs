// node tests/chorus.test.mjs
// 合聲 (src/core/audio/post-fx/chorus.js): knob mapping, the LFO's delay sweep and detune cap,
// smoothing (no zipper), exact bypass when off, click-free switching, stereo spread and the darker,
// low-cut wet, the Web Audio graph (fake context, engine), and peaks against the demo song (and the
// owner's local samples when AIRJAM_SAMPLES points at a folder with s14.wav / s21.wav; never copied).
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as chorus from '../src/core/audio/post-fx/chorus.js';
import { CHORUS, CHORUS_RANGES, CHORUS_DEFAULT_KNOBS, chorusSettings, chorusTargets, renderChorus } from '../src/core/audio/post-fx/chorus.js';
import { createPedalModel, PEDALS_WITH_SOUND, PRESETS, visibleKnobs, knobOf, knobValue } from '../src/core/pedals/model.js';
import { isPedalAvailable } from '../src/core/pedals/availability.js';
import { createAudioEngine, PEDAL_TAU } from '../src/core/audio/engine.js';
import { TONES } from '../src/core/audio/tones.js';
import { rigFromSnapshot, electricTone } from '../src/core/audio/electric-rig.js';
import { renderDemoSong } from '../src/core/song/demo-song.js';
import { chug, A5, rms, peakOf } from '../src/lab/metrics.js';
import { renderPart, renderMaster } from '../tools/tone-lab/model.mjs';
import { SETTINGS } from '../src/settings.js';
import { FakeAudioContext } from './fake-audio-context.mjs';

const results = [];
function test(name, fn) {
  try { const note = fn(); results.push({ test: name, result: 'PASS', detail: note ?? '' }); }
  catch (error) { if (process.env.DEBUG) console.error(error); results.push({ test: name, result: 'FAIL', detail: error.message.split('\n')[0] }); }
}

const SR = 48000;
const db = x => 20 * Math.log10(x);
const knobs = (n = 21) => Array.from({ length: n }, (_, i) => i / (n - 1));
const pedal = (params = {}, on = true) => ({ on, sound: true, params: { ...CHORUS_DEFAULT_KNOBS, ...params } });
const paramsOf = (params = {}, { on = true, advanced = true } = {}) =>
  chorus.paramsFromSnapshot({ mode: advanced ? 'advanced' : 'simple', pedals: { chorus: pedal(params, on) } });
const sine = (freq, seconds, amp = 0.5, sampleRate = SR) => {
  const left = Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, i) => amp * Math.sin(2 * Math.PI * freq * i / sampleRate));
  return { left, right: Float32Array.from(left) };
};
const maxStep = ({ left, right }, from = 0, to = left.length) => {
  let m = 0;
  for (const ch of [left, right]) for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(ch[i] - ch[i - 1]));
  return m;
};
// Sample-exact (x · 1 + 0 turns −0 into +0, which is the same sample).
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const rmsOf = (x, from, to) => { let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i]; return Math.sqrt(s / (to - from)); };

// ---------- mapping ----------
test('mapping: every knob monotonic and inside its range; defaults are the documented sound', () => {
  const sweep = (name, key) => knobs().map(v => chorusSettings(pedal({ [name]: v }), { advanced: true })[key]);
  const increasing = (xs, label) => xs.slice(1).forEach((x, i) => assert.ok(x > xs[i], `${label} rises`));
  increasing(sweep('rate', 'rateHz'), 'rate');
  increasing(sweep('mix', 'wet'), 'mix');
  increasing(sweep('tone', 'toneHz'), 'tone');
  increasing(sweep('width', 'width'), 'width');
  increasing(sweep('level', 'outGain'), 'level');
  const depth = sweep('depth', 'depthMs');
  depth.slice(1).forEach((x, i) => assert.ok(x >= depth[i], 'depth never falls'));
  for (const v of knobs()) {
    const s = chorusSettings(pedal({ rate: v, depth: v, mix: v, tone: v, width: v, level: v }), { advanced: true });
    assert.ok(s.rateHz >= CHORUS_RANGES.rateHz[0] - 1e-9 && s.rateHz <= CHORUS_RANGES.rateHz[1] + 1e-9);
    assert.ok(s.depthMs >= 0 && s.depthMs <= CHORUS_RANGES.depthMs[1]);
    assert.ok(s.wet >= 0 && s.wet <= 1 + 1e-9, 'wet never louder than the dry');
    assert.ok(s.toneHz >= CHORUS_RANGES.toneHz[0] - 1e-6 && s.toneHz <= CHORUS_RANGES.toneHz[1] + 1e-6);
    assert.ok(s.width >= 0 && s.width <= 1);
    assert.ok(db(s.outGain) >= -12 - 1e-9 && db(s.outGain) <= 6 + 1e-9);
  }
  for (const v of [-1, 2, NaN]) assert.ok(Object.values(chorusSettings(pedal({ rate: v, depth: v, mix: v }), { advanced: true })).every(Number.isFinite));
  const d = chorusSettings(null);
  assert.ok(Math.abs(d.rateHz - 0.8) < 1e-9 && d.depthMs === 2 && Math.abs(d.wet - 2 / 3) < 1e-9 && Math.abs(d.toneHz - 4000) < 1e-6 && d.width === 1 && d.outGain === 1);
  return `defaults: ${d.rateHz} Hz, ±${d.depthMs} ms, wet ${d.wet.toFixed(2)}, low-pass ${d.toneHz.toFixed(0)} Hz, width ${d.width * 100}%`;
});

test('knobs: simple = 速度 and 深度; advanced = all six; model values match the DSP mapping', () => {
  assert.deepEqual(visibleKnobs('chorus', 'simple').map(k => k.id), ['rate', 'depth']);
  assert.deepEqual(visibleKnobs('chorus', 'advanced').map(k => k.id), ['rate', 'depth', 'mix', 'tone', 'width', 'level']);
  for (const v of [0, 0.3, 0.77, 1]) {
    const s = chorusSettings(pedal({ rate: v, mix: v, tone: v, width: v, level: v }), { advanced: true });
    assert.ok(Math.abs(knobValue(knobOf('chorus', 'rate'), v) - s.rateHz) < 1e-9);
    assert.ok(Math.abs(knobValue(knobOf('chorus', 'tone'), v) - s.toneHz) < 1e-6);
    assert.ok(Math.abs(knobValue(knobOf('chorus', 'mix'), v) / 100 - s.wet / (1 + s.wet)) < 1e-9);
    assert.ok(Math.abs(knobValue(knobOf('chorus', 'level'), v) - db(s.outGain)) < 1e-9);
  }
  // Simple mode: the advanced knobs keep their defaults (stored values are kept, not used).
  const hidden = { mix: 0, tone: 0, width: 0, level: 0 };
  const simple = chorusSettings(pedal(hidden), { advanced: false });
  const base = chorusSettings(pedal({}), { advanced: false });
  assert.deepEqual(simple, base);
  assert.equal(simple.outGain, 1, 'simple mode never moves the dry');
});

// ---------- LFO ----------
test('LFO: delay sweeps 11 ms ± depth (7–15 ms at most); detune capped at high rates', () => {
  const rows = [];
  for (const [rate, depth] of [[0, 0], [0, 1], [CHORUS_DEFAULT_KNOBS.rate, 0.5], [1, 1], [0.7, 1]]) {
    const params = paramsOf({ rate, depth });
    const s = params.settings;
    const seconds = Math.min(12, 1.2 / s.rateHz);
    const out = renderChorus(sine(440, seconds, 0.1), { sampleRate: SR, initial: params });
    const lo = Math.min(...out.trace.map(b => b.delayMs[0])), hi = Math.max(...out.trace.map(b => b.delayMs[1]));
    assert.ok(lo >= CHORUS.centreMs - s.depthMs - 1e-6 && hi <= CHORUS.centreMs + s.depthMs + 1e-6, `${lo}…${hi}`);
    assert.ok(lo >= 7 - 1e-6 && hi <= 15 + 1e-6 && hi / 1000 < CHORUS.maxDelaySeconds);
    if (s.depthMs > 0) assert.ok(hi - lo > 1.9 * s.depthMs, `sweep reaches ±depth (${(hi - lo).toFixed(2)} ms)`);
    const detune = 4 * s.rateHz * s.depthMs / 1000;
    assert.ok(detune <= CHORUS.maxDetune + 1e-12, `detune ${detune}`);
    // Measured slope per block (ms / ms) agrees with the cap.
    const slope = Math.max(...out.trace.map(b => (b.delayMs[1] - b.delayMs[0]) / (128 / SR * 1000)));
    assert.ok(slope <= CHORUS.maxDetune * 1.01, `slope ${slope}`);
    rows.push(`${s.rateHz.toFixed(2)} Hz ±${s.depthMs.toFixed(2)} ms → ${(1200 * Math.log2(1 + detune)).toFixed(0)} ct`);
  }
  return rows.join('; ');
});

// ---------- smoothing ----------
test('smoothing: knob jumps glide like setTargetAtTime — per-block steps bounded, no zipper', () => {
  const from = paramsOf({ rate: 0, depth: 0, mix: 0, tone: 0, width: 0, level: 0 });
  const to = paramsOf({ rate: 1, depth: 1, mix: 1, tone: 1, width: 1, level: 1 });
  const tau = PEDAL_TAU.knob;
  const out = renderChorus(sine(330, 0.6), { sampleRate: SR, initial: from, changes: [{ time: 0.1, params: to, tau }] });
  const a = chorusTargets(from), b = chorusTargets(to);
  const bound = 1 - Math.exp(-128 / (tau * SR));      // largest share of a jump one block may take
  let worst = 0;
  for (const key of Object.keys(a)) {
    const span = Math.abs(b[key] - a[key]);
    if (!span) continue;
    for (let i = 1; i < out.trace.length; i++) {
      const step = Math.abs(out.trace[i][key] - out.trace[i - 1][key]) / span;
      worst = Math.max(worst, step);
      assert.ok(step <= bound + 1e-9, `${key}: ${step.toFixed(3)} of the jump in one block`);
    }
    assert.ok(Math.abs(out.trace.at(-1)[key] - b[key]) / span < 1e-6, `${key} arrives`);
  }
  // The Web Audio side asks for the same thing: setTargetAtTime with the engine's τ, nothing abrupt.
  const ctx = new FakeAudioContext();
  const io = { input: ctx.createGain(), output: ctx.createGain() };
  const fx = chorus.create(ctx, io);
  fx.apply(from, { type: 'toggle' }, { now: 0, tau: PEDAL_TAU.toggle });
  fx.apply(to, { type: 'param' }, { now: 1, tau });
  const calls = ctx.created.flatMap(n => Object.values(n).filter(v => v?.calls).flatMap(p => p.calls.map(c => ({ ...c, p }))));
  const late = calls.filter(c => c.time === 1 && c.type !== 'cancel');
  assert.ok(late.length >= 8 && late.every(c => c.type === 'target' && c.tau === tau), 'every knob glides');
  assert.ok(calls.every(c => c.type !== 'linear' && c.type !== 'exp'));
  return `≤ ${(worst * 100).toFixed(1)} % of a full-range jump per 128-sample block (τ ${tau * 1000} ms)`;
});

// ---------- bypass ----------
test('bypass: off is bit-exact (create, Node model, and again after switching off)', () => {
  const x = sine(220, 1, 0.7);
  x.right = x.right.map(v => -0.5 * v);
  assert.equal(chorus.process(paramsOf({}, { on: false }), x), x, 'off: same arrays back');
  const idle = renderChorus(x, { sampleRate: SR });
  assert.ok(same(idle.left, x.left) && same(idle.right, x.right));
  // On at 0.1 s, off at 0.3 s: from the snap on (12 τ later) the output is the input again.
  const tau = PEDAL_TAU.toggle;
  const out = renderChorus(x, { sampleRate: SR, changes: [{ time: 0.1, params: paramsOf({ level: 1 }), tau }, { time: 0.3, params: paramsOf({}, { on: false }), tau }] });
  const snap = Math.ceil((0.3 + CHORUS.snapTaus * tau) * SR) + 1;
  // The 15 ms delay line still holds wet input, but the wet gain is exactly 0.
  assert.ok(same(out.left.subarray(snap), x.left.subarray(snap)) && same(out.right.subarray(snap), x.right.subarray(snap)));
  assert.notDeepEqual(out.left.subarray(0.15 * SR, 0.25 * SR), x.left.subarray(0.15 * SR, 0.25 * SR), 'it was on');
  // Fake context: off at create is a unity dry plus a wet gain of exactly 0, and nothing automated.
  const ctx = new FakeAudioContext();
  const io = { input: ctx.createGain(), output: ctx.createGain() };
  const fx = chorus.create(ctx, io);
  const { dry, wet } = fx.nodes;
  assert.ok(io.input.outputs.has(dry) && dry.outputs.has(io.output) && wet.outputs.has(io.output));
  assert.equal(dry.gain.value, 1); assert.equal(wet.gain.value, 0);
  fx.apply(chorus.paramsFromSnapshot(null), { type: 'load' }, { now: 0, tau });
  assert.equal(ctx.created.flatMap(n => Object.values(n).filter(v => v?.calls).flatMap(p => p.calls)).length, 0, 'off → off schedules nothing');
  // On, then off: the wet glides to 0 and is set to exactly 0 twelve τ later; the dry back to 1.
  fx.apply(paramsOf({ level: 0 }), { type: 'toggle' }, { now: 1, tau });
  fx.apply(paramsOf({}, { on: false }), { type: 'toggle' }, { now: 2, tau });
  const wetCalls = wet.gain.calls.filter(c => c.type !== 'cancel');
  assert.deepEqual(wetCalls.slice(-2).map(c => [c.type, c.target ?? c.value]), [['target', 0], ['set', 0]]);
  assert.ok(Math.abs(wetCalls.at(-1).time - (2 + CHORUS.snapTaus * tau)) < 1e-12);
  assert.deepEqual(dry.gain.calls.filter(c => c.type === 'set').at(-1).value, 1);
});

// ---------- switching ----------
test('switching: on, knob jumps and off are click-free (sample-to-sample steps stay in range)', () => {
  const x = sine(220, 1.6, 0.5);
  const quiet = paramsOf({ rate: 0, depth: 0, mix: 0.3 });
  const wild = paramsOf({ rate: 1, depth: 1, mix: 1, tone: 1, width: 0, level: 1 });
  const out = renderChorus(x, { sampleRate: SR, changes: [
    { time: 0.25, params: quiet, tau: PEDAL_TAU.toggle },
    { time: 0.6, params: wild, tau: PEDAL_TAU.knob },
    { time: 1.0, params: paramsOf({}, { on: false }), tau: PEDAL_TAU.toggle },
  ] });
  // Reference: the same pedal settled (no transitions) — the largest step it makes by itself.
  const settled = [quiet, wild].map(p => maxStep(renderChorus(x, { sampleRate: SR, initial: p }), 0.1 * SR));
  const reference = Math.max(maxStep(x), ...settled);
  const worst = maxStep(out);
  assert.ok(worst <= reference * 1.05, `worst step ${worst.toFixed(4)} vs ${reference.toFixed(4)}`);
  return `worst step ${worst.toFixed(4)} (settled ${reference.toFixed(4)}, dry ${maxStep(x).toFixed(4)})`;
});

// ---------- sound ----------
test('sound: stereo spread by 寬度, lows stay dry and centred, the wet is darker', () => {
  const corr = (a, b, from) => { let ab = 0, aa = 0, bb = 0; for (let i = from; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; } return ab / Math.sqrt(aa * bb); };
  const x = sine(440, 2, 0.4);
  const wetOnly = (params, sig = x) => {
    const on = renderChorus(sig, { sampleRate: SR, initial: params });
    return { left: on.left.map((v, i) => v - sig.left[i]), right: on.right.map((v, i) => v - sig.right[i]) };
  };
  const wide = wetOnly(paramsOf({ width: 1, depth: 1 })), narrow = wetOnly(paramsOf({ width: 0, depth: 1 }));
  const from = 0.1 * SR;
  const cw = corr(wide.left, wide.right, from), cn = corr(narrow.left, narrow.right, from);
  assert.ok(cn > 0.9999, `width 0: L = R (${cn})`);
  assert.ok(cw < 0.9, `width 100 %: L and R differ (${cw.toFixed(3)})`);
  const band = (freq, params = paramsOf({})) => {
    const s = sine(freq, 1, 0.4);
    const w = wetOnly(params, s);
    return db(rmsOf(w.left, 0.2 * SR, SR) / rmsOf(s.left, 0.2 * SR, SR));
  };
  const low = band(60), mid = band(1000), high = band(8000);
  assert.ok(low < mid - 12, `60 Hz wet ${low.toFixed(1)} dB vs 1 kHz ${mid.toFixed(1)} dB`);
  assert.ok(high < mid - 9, `8 kHz wet ${high.toFixed(1)} dB vs 1 kHz ${mid.toFixed(1)} dB`);
  const bright = band(8000, paramsOf({ tone: 1 }));
  assert.ok(bright > high + 6, '音色 opens the wet');
  return `wet vs input: 60 Hz ${low.toFixed(1)}, 1 kHz ${mid.toFixed(1)}, 8 kHz ${high.toFixed(1)} dB (音色 max ${bright.toFixed(1)}); L/R correlation of the wet ${cw.toFixed(2)}`;
});

// ---------- Web Audio graph ----------
test('graph: built once, nothing created on changes, LFO drives both delays in opposite directions', () => {
  const ctx = new FakeAudioContext();
  const io = { input: ctx.createGain(), output: ctx.createGain() };
  const fx = chorus.create(ctx, io);
  const { lfo, lines, send, lowpass, highpass } = fx.nodes;
  assert.equal(lfo.type, 'triangle'); assert.ok(lfo.startedAt !== null);
  assert.equal(send.channelCount, 1);
  assert.equal(highpass.frequency.value, CHORUS.highpassHz);
  assert.deepEqual(lines.map(l => [l.depth.gain.value * 1000, l.pan.pan.value]), [[-2, -1], [2, 1]]);
  for (const l of lines) {
    assert.ok(lfo.outputs.has(l.depth) && l.depth.outputs.has(l.delay.delayTime) && lowpass.outputs.has(l.delay));
    assert.ok(Math.abs(l.delay.delayTime.value - CHORUS.centreMs / 1000) < 1e-12 && l.delay.maxDelayTime >= 0.015);
  }
  const count = ctx.created.length;
  for (const v of knobs(5)) fx.apply(paramsOf({ rate: v, depth: v, mix: v, tone: v }), { type: 'param' }, { now: v, tau: PEDAL_TAU.knob });
  assert.equal(ctx.created.length, count);
  fx.dispose();
  assert.equal(io.input.outputs.size, 0);
  assert.ok(ctx.created.every(n => n === io.output || n === ctx.destination || n.outputs.size === 0));
});

test('engine: chorus fades in on the electric rig only; steel gets it off', () => {
  const ctx = new FakeAudioContext();
  const engine = createAudioEngine(SETTINGS, { context: ctx });
  engine.setTone(TONES.electric);
  const fx = engine.postFx('rhythm').slots[0].fx;
  const model = createPedalModel();
  model.toggle('chorus', true);
  engine.applyPedals(model.snapshot(), { type: 'toggle', id: 'chorus', on: true });
  const wetTarget = () => fx.nodes.wet.gain.calls.filter(c => c.type === 'target').at(-1)?.target;
  assert.ok(Math.abs(wetTarget() - 2 / 3) < 1e-9);
  engine.setTone(TONES.steel);
  assert.equal(wetTarget(), 0);
  engine.setTone(TONES.electric);
  assert.ok(wetTarget() > 0);
});

// ---------- board ----------
test('board: chorus has sound and is usable; presets unchanged (none switches it on)', () => {
  assert.ok(PEDALS_WITH_SOUND.includes('chorus'));
  assert.ok(isPedalAvailable('chorus'));
  const model = createPedalModel();
  assert.equal(model.snapshot().pedals.chorus.sound, true);
  for (const p of PRESETS) assert.equal('chorus' in p.on, false, p.id);
  assert.equal(chorus.paramsFromSnapshot(model.snapshot()).on, false, 'default board: off');
  model.toggle('chorus', true);
  assert.equal(chorus.paramsFromSnapshot(model.snapshot()).on, true);
});

// ---------- peaks against songs ----------
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

test('peaks: demo song (and local samples) — output peak safe, level change small', () => {
  const sampleRate = 44100, seconds = 6, n = seconds * sampleRate;
  const songs = [];
  const demo = renderDemoSong(sampleRate);
  songs.push({ name: 'demo', bpm: 100, left: demo.samples.slice(10 * sampleRate, 10 * sampleRate + n), right: demo.samples.slice(10 * sampleRate, 10 * sampleRate + n) });
  const dir = process.env.AIRJAM_SAMPLES;
  for (const [file, bpm] of [['s14.wav', 160], ['s21.wav', 104.9]]) {
    if (!dir || !existsSync(join(dir, file))) continue;
    const s = readWav(join(dir, file));
    if (s?.sampleRate === sampleRate) songs.push({ name: file, bpm, left: s.left.slice(10 * sampleRate, 10 * sampleRate + n), right: s.right.slice(10 * sampleRate, 10 * sampleRate + n) });
  }
  const rows = [];
  for (const preset of ['clean', 'rock']) {
    const model = createPedalModel();
    model.applyPreset(preset);
    const tone = electricTone(rigFromSnapshot(model.snapshot()));
    for (const song of songs) {
      const events = chug([A5[0], A5[1], A5[2], A5[3]], { bpm: song.bpm, seconds, velocity: 0.8 });
      const part = renderPart(tone, events, { duration: seconds, sampleRate, settings: SETTINGS });
      for (const [label, params] of [['default', paramsOf({}, { advanced: false })], ['max', paramsOf({ rate: 1, depth: 1, mix: 1, tone: 1, width: 1, level: 1 })]]) {
        const wet = chorus.process(params, part, { sampleRate });
        const ratio = peakOf(wet) / peakOf(part);
        const bound = (1 + params.settings.wet * Math.SQRT2) * params.settings.outGain;   // dry + wet (filter overshoot, panning)
        assert.ok(ratio <= bound, `${preset}/${song.name}/${label}: part peak ×${ratio.toFixed(2)}`);
        const master = renderMaster(wet, song, { sampleRate, settings: SETTINGS });
        const peak = peakOf(master);
        assert.ok(peak <= 1, `${preset}/${song.name}/${label}: master peak ${peak}`);
        const off = renderMaster(part, song, { sampleRate, settings: SETTINGS });
        const lim = out => out.reductionDb.subarray(sampleRate).reduce((m, v) => Math.min(m, v), 0);
        const gainDb = db(rms({ ...wet, sampleRate }) / rms(part));
        if (label === 'default') assert.ok(gainDb > 0 && gainDb < 2, `${preset}/${song.name}: ${gainDb.toFixed(2)} dB louder`);
        if (label === 'default') rows.push(`${preset}/${song.name}: part +${gainDb.toFixed(1)} dB, peak ×${ratio.toFixed(2)}, master peak ${peakOf(off).toFixed(2)}→${peak.toFixed(2)}, limiter ${lim(off).toFixed(1)}→${lim(master).toFixed(1)} dB`);
      }
    }
  }
  return rows.join('; ');
});

console.table(results);
const failed = results.filter(r => r.result === 'FAIL');
if (failed.length) { console.error(`${failed.length} chorus test(s) failed`); process.exit(1); }
console.log('chorus tests passed');
