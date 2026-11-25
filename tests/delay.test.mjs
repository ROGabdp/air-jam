// node tests/delay.test.mjs
// The 延遲 pedal (src/core/audio/post-fx/delay.js): echo time synced to the pulse (and unchanged by
// halving / doubling the tempo), chord-change ducking of old-chord echoes, feedback stability, smooth
// time and knob changes, exact bypass when off, trails after switching off, knobs for simple and
// advanced mode, the engine wiring, and peaks against the demo song (and the owner's samples when
// AIRJAM_SAMPLES or samples/ has s14.wav / s21.wav; read only).
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  syncSeconds, echoSeconds, delaySettings, paramsFromSnapshot, process as runDelay, create,
  DELAY_DSP, DELAY_SYNC, DELAY_RANGES,
} from '../src/core/audio/post-fx/delay.js';
import { createPostFxBus, postFxParams } from '../src/core/audio/post-fx/index.js';
import { analyzeSync, retime } from '../src/core/analysis/analysis.js';
import { renderDemoSong } from '../src/core/song/demo-song.js';
import { createPedalModel, visibleKnobs, PEDALS_WITH_SOUND } from '../src/core/pedals/model.js';
import { isPedalAvailable } from '../src/core/pedals/availability.js';
import { biquadCoefficients, biquadMagnitude } from '../src/core/audio/stages.js';
import { createAudioEngine, PEDAL_TAU } from '../src/core/audio/engine.js';
import { TONES } from '../src/core/audio/tones.js';
import { rigFromSnapshot, electricTone } from '../src/core/audio/electric-rig.js';
import { renderPart, renderMaster } from '../tools/tone-lab/model.mjs';
import { strum, chug, A5, rms, peakOf } from '../src/lab/metrics.js';
import { midiToFreq } from '../src/core/music/theory.js';
import { SETTINGS } from '../src/settings.js';
import { FakeAudioContext } from './fake-audio-context.mjs';

const results = [];
function test(name, fn) {
  try { const note = fn(); results.push({ test: name, result: 'PASS', detail: note ?? '' }); }
  catch (error) { results.push({ test: name, result: 'FAIL', detail: error.message.split('\n')[0] }); }
}
const db = x => 20 * Math.log10(Math.max(1e-12, x));
const SR = 48000;

function snapshotWith(knobs = {}, { mode = 'simple', on = true, preset = 'rock' } = {}) {
  const model = createPedalModel();
  model.applyPreset(preset);
  model.setMode(mode);
  model.toggle('delay', on);
  for (const [knob, value] of Object.entries(knobs)) model.setParam('delay', knob, value);
  return model.snapshot();
}
const paramsWith = (...a) => paramsFromSnapshot(snapshotWith(...a));
const silence = seconds => ({ left: new Float32Array(Math.round(seconds * SR)), right: new Float32Array(Math.round(seconds * SR)) });
const click = (signal, t, amp = 1) => { const i = Math.round(t * SR); signal.left[i] += amp; signal.right[i] += amp; return signal; };
const minus = (a, b) => ({ left: a.left.map((x, i) => x - b.left[i]), right: a.right.map((x, i) => x - b.right[i]), sampleRate: SR });
// Peak |wet| in a window (both channels).
function peakIn(sig, from, to) {
  let p = 0;
  for (let i = Math.max(0, Math.round(from * SR)); i < Math.min(sig.left.length, Math.round(to * SR)); i++) p = Math.max(p, Math.abs(sig.left[i]), Math.abs(sig.right[i]));
  return p;
}
const withRate = s => ({ ...s, sampleRate: SR });

// ---------- tempo sync ----------

test('sync: the pulse × 2^k (or × 1.5 · 2^k) in 280–450 ms, same for ×2 / ×½ / ×4 of the pulse', () => {
  const rows = [];
  for (const bpm of [60, 72, 85, 90, 100, 104.9, 120, 140, 160, 180, 200]) {
    for (const per of [1, 2, 4, 0.5]) {
      const pulse = 60 / bpm / per;
      const s = syncSeconds(pulse);
      assert.ok(s >= DELAY_SYNC.minSeconds && s <= DELAY_SYNC.maxSeconds, `${bpm} BPM, pulse ${pulse}: ${s}`);
      const k = Math.log2(s / pulse), k15 = Math.log2(s / pulse / 1.5);
      assert.ok(Math.abs(k - Math.round(k)) < 1e-9 || Math.abs(k15 - Math.round(k15)) < 1e-9, `on the pulse grid: ${s / pulse}`);
      for (const f of [2, 0.5, 4, 0.25]) assert.equal(syncSeconds(pulse * f), s, `×${f}`);
      // A straight multiple wins when one is in range.
      if (Math.abs(k - Math.round(k)) > 1e-9) assert.ok(s / 1.5 < DELAY_SYNC.minSeconds);
    }
    rows.push(`${bpm}:${Math.round(syncSeconds(30 / bpm) * 1000)}`);
  }
  assert.equal(syncSeconds(0.3), 0.3);
  assert.equal(syncSeconds(0.25), 0.375, '240 BPM eighths → dotted');
  assert.equal(syncSeconds(NaN), DELAY_SYNC.fallbackSeconds);
  return `BPM:ms ${rows.join(' ')}`;
});

test('sync: 慢一半／快一倍 (retime ×½, ×2 and back) of the analysed demo song keep the echo time', () => {
  const demo = renderDemoSong(22050);
  const analysis = analyzeSync(demo.samples, demo.sampleRate);
  const base = syncSeconds(analysis.pulse);
  const seen = [];
  for (const factors of [[0.5], [2], [2, 0.5], [0.5, 2]]) {
    let a = analysis, f = 1;
    for (const x of factors) { f *= x; a = retime(analysis, { factor: f }); }
    const s = syncSeconds(a.pulse);
    assert.ok(Math.abs(s - base) < 1e-9, `factor ${f}: pulse ${a.pulse} → ${s} vs ${base}`);
    seen.push(`×${f}: ${a.bpm.toFixed(1)} BPM`);
  }
  const echo = echoSeconds(delaySettings(paramsWith()), { pulseSeconds: analysis.pulse, beatSeconds: 60 / analysis.bpm });
  assert.equal(echo, base);
  return `demo ${analysis.bpm.toFixed(1)} BPM, pulse ${(analysis.pulse * 1000).toFixed(1)} ms → echo ${(base * 1000).toFixed(1)} ms; ${seen.join(', ')}`;
});

test('time: no song → 375 ms; steps ×½ / ×1 / ×2; 自由 in ms; simple mode ignores advanced-only knobs', () => {
  const tempo = { pulseSeconds: 0.3, beatSeconds: 0.6 };
  assert.equal(echoSeconds(delaySettings(paramsWith()), null), 0.375);
  assert.equal(echoSeconds(delaySettings(paramsWith()), tempo), 0.3);
  assert.equal(echoSeconds(delaySettings(paramsWith({ time: 0 }, { mode: 'advanced' })), tempo), 0.15);
  assert.equal(echoSeconds(delaySettings(paramsWith({ time: 1 }, { mode: 'advanced' })), tempo), 0.6);
  const free = delaySettings(paramsWith({ sync: 1, free: 1 }, { mode: 'advanced' }));
  assert.equal(echoSeconds(free, tempo), 1.2);
  // The same board in simple mode: synced, 中, centred, full duck, unity level.
  const simple = delaySettings(paramsWith({ sync: 1, time: 1, pingpong: 1, duck: 0, level: 1, tone: 0 }, { mode: 'simple' }));
  assert.deepEqual([simple.sync, simple.step, simple.pingpong, simple.duck, simple.levelGain, Math.round(simple.toneHz)], [true, 1, 0, 1, 1, 3000]);
  assert.equal(echoSeconds(simple, tempo), 0.3);
});

test('knobs: simple = 回音量 + 重複 (≤ 2); advanced adds time, tone, ping-pong, duck, level; delay has sound', () => {
  assert.deepEqual(visibleKnobs('delay', 'simple').map(k => k.id), ['mix', 'feedback']);
  assert.deepEqual(visibleKnobs('delay', 'advanced').map(k => k.id), ['mix', 'feedback', 'sync', 'time', 'free', 'tone', 'pingpong', 'duck', 'level']);
  assert.ok(PEDALS_WITH_SOUND.includes('delay') && isPedalAvailable('delay'));
  const s = delaySettings(paramsWith({}, { mode: 'advanced' }));
  assert.ok(Math.abs(s.mix - 0.2) < 1e-9 && Math.abs(s.feedback - 0.3) < 1e-9, `${s.mix} ${s.feedback}`);
  assert.ok(Math.abs(s.freeSeconds - 0.375) < 0.002 && Math.abs(s.toneHz - 3000) < 1 && s.duck === 1 && s.sync && s.step === 1);
  assert.ok(Math.abs(db(s.levelGain)) < 0.1);
  // The rock preset leaves the delay off (presets unchanged).
  assert.equal(paramsFromSnapshot(createPedalModel().snapshot()).on, false);
  return `defaults: mix ${s.mix * 100}%, feedback ${s.feedback * 100}%, free ${(s.freeSeconds * 1000).toFixed(0)} ms, tone ${s.toneHz.toFixed(0)} Hz`;
});

// ---------- stability ----------

test('stability: feedback ≤ 60 % and |H_hp · H_lp| ≤ 1 → loop gain < 1; impulse dies away', () => {
  assert.equal(delaySettings({ simple: false, values: { feedback: 500 } }).feedback, 0.6);
  assert.equal(delaySettings({ simple: false, values: { feedback: -3 } }).feedback, 0);
  let worst = 0;
  for (const hz of [DELAY_RANGES.toneHz[0], 3000, DELAY_RANGES.toneHz[1]]) {
    const lp = biquadCoefficients('lowpass', hz, DELAY_DSP.filterQ, 0, SR), hp = biquadCoefficients('highpass', DELAY_DSP.highpassHz, DELAY_DSP.filterQ, 0, SR);
    for (let f = 20; f < 20000; f *= 1.02) worst = Math.max(worst, biquadMagnitude(lp, f, SR) * biquadMagnitude(hp, f, SR));
  }
  assert.ok(worst <= 1.0001, `filter peak ${worst}`);
  const notes = [];
  for (const pingpong of [0, 1]) {
    const params = paramsWith({ mix: 1, feedback: 1, tone: 1, pingpong, time: 0 }, { mode: 'advanced' });
    const out = runDelay(params, click(silence(12), 0.05), { sampleRate: SR, tempo: { pulseSeconds: 0.3, beatSeconds: 0.6 } });
    // One-second windows (late repeats smear across short ones): each ≥ 20 dB below the last
    // (0.6 per 150 ms pass is −29.6 dB/s at the filters' peak).
    const energy = k => rms(withRate(out), 0.06 + k, 1.06 + k);
    for (let k = 0; k < 10 && db(energy(k + 1)) > -250; k++) assert.ok(db(energy(k) / energy(k + 1)) >= 20, `ping-pong ${pingpong}: ${k} s: ${db(energy(k)).toFixed(1)} → ${db(energy(k + 1)).toFixed(1)} dB`);
    const tail = db(peakIn(out, 10, 12) / peakIn(out, 0.1, 0.4));
    assert.ok(tail < -80, `tail ${tail.toFixed(0)} dB`);
    notes.push(`${pingpong ? 'ping-pong' : 'stereo'}: 10 s tail ${tail.toFixed(0)} dB`);
  }
  return `max |H| ${worst.toFixed(4)} × 0.6; ${notes.join(', ')}`;
});

// ---------- bypass, trails ----------

test('bypass: off returns the signal itself; a new slot is x + 0 (send exactly 0, no automation)', () => {
  const sig = { left: Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 9)), right: new Float32Array(4800) };
  assert.equal(runDelay(paramsWith({}, { on: false }), sig, { sampleRate: SR }), sig);
  assert.equal(runDelay(paramsFromSnapshot(null), sig, { sampleRate: SR }), sig);
  const ctx = new FakeAudioContext();
  const input = ctx.createGain(), output = ctx.createGain();
  const fx = create(ctx, { input, output });
  const { dry, send } = fx.nodes;
  assert.deepEqual([dry.gain.value, send.gain.value], [1, 0]);
  fx.setTempo({ pulseSeconds: 0.3, beatSeconds: 0.6 }, { now: 0 });
  fx.apply(paramsFromSnapshot(null), { type: 'tone' }, { now: 0, tau: PEDAL_TAU.toggle });
  const gains = ctx.created.filter(n => n.kind === 'gain' && n !== input && n !== output && n !== fx.nodes.lfo);
  assert.ok(gains.every(g => g.gain.calls.length === 0), 'off: no gain automated');
  assert.ok(input.outputs.has(dry) && dry.outputs.has(output), 'dry path');
  fx.dispose();
  assert.equal(input.outputs.size, 0);
  assert.equal(fx.nodes.lfo.stoppedAt, 0);
});

test('trails: switching off closes only the send; echoes ring out, new playing gets none', () => {
  const tempo = { pulseSeconds: 0.3, beatSeconds: 0.6 };
  const on = paramsWith({ mix: 1, feedback: 0.8 });
  const off = { ...on, on: false };
  const base = click(click(silence(4), 0.2), 0.5);
  const later = click(click(click(silence(4), 0.2), 0.5), 2.0);
  const o = { sampleRate: SR, tempo, events: [{ time: 1.0, type: 'apply', params: off }] };
  const a = runDelay(on, base, o), b = runDelay(on, later, o);
  const wetA = minus(a, base);
  const before = peakIn(wetA, 0.45, 1.0), after = peakIn(wetA, 1.05, 1.95);
  assert.ok(db(after / before) > -12, `trail after switching off ${db(after / before).toFixed(1)} dB`);
  // The click at 2.0 (send closed) adds nothing to the wet signal.
  const extra = peakIn(minus(minus(b, later), wetA), 2.05, 4);
  assert.ok(db(extra / before) < -90, `echo of a note after switching off ${db(extra / before).toFixed(0)} dB`);
  // Fake graph: off touches send and dry only.
  const ctx = new FakeAudioContext();
  const fx = create(ctx, { input: ctx.createGain(), output: ctx.createGain() });
  fx.apply(on, { type: 'toggle' }, { now: 0, tau: PEDAL_TAU.toggle });
  const counts = () => ctx.created.map(n => Object.values(n).filter(v => v?.calls).reduce((s, p) => s + p.calls.length, 0));
  const was = counts();
  fx.apply(off, { type: 'toggle' }, { now: 1, tau: PEDAL_TAU.toggle });
  const changed = ctx.created.filter((n, i) => counts()[i] !== was[i]);
  assert.deepEqual(changed, [fx.nodes.send], 'only the send moves (dry already at 1)');
  assert.equal(fx.nodes.send.gain.calls.at(-1).target, 0);
  return `trail ${db(after / before).toFixed(1)} dB vs before; new note's echo ${db(extra / before).toFixed(0)} dB`;
});

// ---------- smoothing ----------

test('smoothing: knobs glide with the given tau; delay time only ramps (40 ms) on a loop with nothing in flight', () => {
  const ctx = new FakeAudioContext();
  const fx = create(ctx, { input: ctx.createGain(), output: ctx.createGain() });
  const nodes = ctx.created.length;
  fx.setTempo({ pulseSeconds: 0.3, beatSeconds: 0.6 }, { now: 0 });
  fx.apply(paramsWith(), { type: 'toggle' }, { now: 0, tau: PEDAL_TAU.toggle });
  for (let i = 0; i < 20; i++) fx.apply(paramsWith({ mix: i / 19, feedback: 1 - i / 19 }), { type: 'param' }, { now: 1 + i / 30, tau: PEDAL_TAU.knob });
  const gainCalls = ctx.created.filter(n => n.kind === 'gain').flatMap(n => n.gain.calls);
  assert.ok(gainCalls.every(c => c.type === 'target'), 'gains only glide');
  assert.ok(gainCalls.filter(c => c.time >= 1).every(c => c.tau === PEDAL_TAU.knob));
  // A tempo change: the idle loop ramps over 40 ms, then the send crossfades to it.
  fx.setTempo({ pulseSeconds: 0.4, beatSeconds: 0.8 }, { now: 3 });
  const [a, b] = fx.nodes.loops.map(l => l.lines[0].delayTime.calls.filter(c => c.time >= 3));
  assert.equal(a.length, 0, 'the loop with echoes in flight keeps its time');
  assert.deepEqual(b.map(c => c.type), ['cancel', 'set', 'linear']);
  assert.ok(Math.abs(b[2].time - 3 - DELAY_DSP.rampSeconds) < 1e-9 && b[2].value === 0.4);
  // Half the tempo again: same pulse grid, nothing moves.
  const before = ctx.created.reduce((s, n) => s + Object.values(n).filter(v => v?.calls).reduce((t, p) => t + p.calls.length, 0), 0);
  fx.setTempo({ pulseSeconds: 0.8, beatSeconds: 1.6 }, { now: 4 });
  fx.setTempo({ pulseSeconds: 0.2, beatSeconds: 0.4 }, { now: 4.1 });
  const after = ctx.created.reduce((s, n) => s + Object.values(n).filter(v => v?.calls).reduce((t, p) => t + p.calls.length, 0), 0);
  assert.equal(after, before, '×2 / ×½ of the pulse: no automation at all');
  assert.equal(ctx.created.length, nodes, 'nothing rebuilt');
});

test('smoothing (model): echoes keep their exact time and level across tempo changes; no zipper', () => {
  const t1 = { pulseSeconds: 0.3, beatSeconds: 0.6 }, t2 = { pulseSeconds: 0.4, beatSeconds: 0.8 }, t3 = { pulseSeconds: 0.375, beatSeconds: 0.75 };
  const params = paramsWith({ mix: 1, feedback: 0 });
  const clicks = [1.0, 1.85, 2.1, 3.0];
  // 1 kHz bursts (10 ms, Hann): their level survives the fractional reads of the wobble, unlike clicks.
  const sig = silence(5);
  const burstN = Math.round(0.01 * SR);
  for (const t of clicks) {
    const i0 = Math.round(t * SR);
    for (let i = 0; i < burstN; i++) { const x = Math.sin(2 * Math.PI * 1000 * i / SR) * 0.5 * (1 - Math.cos(2 * Math.PI * i / burstN)); sig.left[i0 + i] += x; sig.right[i0 + i] += x; }
  }
  // 2.0: switch to the idle loop at 400 ms; 2.05: nothing sent since has come out yet → retimed in place.
  const events = [{ time: 2.0, type: 'tempo', tempo: t2 }, { time: 2.05, type: 'tempo', tempo: t3 }];
  const out = runDelay(params, sig, { sampleRate: SR, tempo: t1, events, trace: true });
  const wet = minus(out, sig);
  const echoAt = (t, T) => rms(wet, t + T - 0.002, t + T + 0.014);
  const ref = echoAt(1.0, 0.3);
  const rows = [[1.85, 0.3, 'sent before the change: old time (trail)'], [2.1, 0.375, 'after both changes'], [3.0, 0.375, 'later']];
  for (const [t, T, what] of rows) {
    const e = echoAt(t, T);
    assert.ok(Math.abs(db(e / ref)) < 0.3, `${what}: ${db(e / ref).toFixed(2)} dB`);
  }
  // Nothing at the wrong time (no doubled or smeared echoes).
  for (const [from, to] of [[2.18, 2.47], [2.5, 3.37], [3.4, 5]]) assert.ok(db(peakIn(wet, from, to) / ref) < -40, `stray wet ${from}–${to}: ${db(peakIn(wet, from, to) / ref).toFixed(0)} dB`);
  // Per-block time change bounded (128 samples): a ramp of |ΔT| over 40 ms, plus the ±0.15 ms wobble.
  let worst = 0;
  for (const track of out.trace.time) for (let i = 128; i < track.length; i += 128) worst = Math.max(worst, Math.abs(track[i] - track[i - 128]));
  const bound = 0.1 * 128 / (DELAY_DSP.rampSeconds * SR) + 1e-6;
  assert.ok(worst <= bound, `per block ${(worst * 1000).toFixed(2)} ms > ${(bound * 1000).toFixed(2)} ms`);
  assert.equal(out.trace.control.active, 1, 'the second change (2.05 s) retimed the new loop in place');
  return `largest time step per 128-sample block ${(worst * 1000).toFixed(2)} ms (ramps only on a loop with nothing in flight)`;
});

// ---------- chord change ----------

// An old chord strummed on eighths, choked at `at` (the engine's chord change), through the electric rig.
function chordRender({ events, chokeAt = null, duration, params, tempo, chordChanges }) {
  const tone = electricTone(rigFromSnapshot(snapshotWith({}, { on: false })));
  const chokes = chokeAt == null ? [] : [{ time: chokeAt, keep: [0] }];
  const dry = renderPart(tone, events, { duration, chokes, sampleRate: SR, settings: SETTINGS, seed: 3 });
  const out = runDelay(params, dry, { sampleRate: SR, tempo, chordChanges: chordChanges ?? (chokeAt == null ? [] : [chokeAt]) });
  return { dry, out, wet: minus(out, dry) };
}

test('chord change: old-chord echoes ≥ 20 dB down within one echo period (dry untouched)', () => {
  const rows = [];
  for (const [pulse, knobs, mode] of [[0.3, {}, 'simple'], [0.286, { mix: 1, feedback: 1 }, 'simple'], [0.375, { mix: 1, feedback: 1 }, 'simple'],
    [0.2, { mix: 1, feedback: 1, time: 1, pingpong: 1 }, 'advanced'], [0.3, { mix: 1, feedback: 1, time: 0 }, 'advanced']]) {
    const tempo = { pulseSeconds: pulse, beatSeconds: pulse * 2 };
    const params = paramsWith(knobs, { mode });
    const T = echoSeconds(delaySettings(params), tempo);
    const at = 3;
    const events = chug(A5.slice(0, 3), { bpm: 30 / pulse, seconds: at - 0.02 });
    const duration = at + 3 * T + 0.3;
    const { dry, wet } = chordRender({ events, chokeAt: at, duration, params, tempo });
    const before = rms(wet, at - T, at);
    const after = rms(wet, at + T, at + 2 * T);
    // Loudest 20 ms window from one period after the change on.
    let worst = 0;
    for (let t = at + T; t < duration - 0.02; t += 0.01) worst = Math.max(worst, rms(wet, t, t + 0.02));
    const drop = db(before / after), peakDrop = db(before / worst);
    assert.ok(drop >= 20 && peakDrop >= 20, `T ${T}: ${drop.toFixed(1)} dB (windows ${peakDrop.toFixed(1)} dB)`);
    // Without ducking the old echoes keep going.
    const noDuck = chordRender({ events, chokeAt: at, duration, params: paramsWith({ ...knobs, duck: 0 }, { mode: 'advanced' }), tempo });
    const plain = db(rms(noDuck.wet, at - T, at) / rms(noDuck.wet, at + T, at + 2 * T));
    rows.push(`${Math.round(T * 1000)} ms: ${drop.toFixed(0)} dB (20 ms windows ${peakDrop.toFixed(0)}, no duck ${plain.toFixed(0)})`);
  }
  return rows.join('; ');
});

test('chord change: a new chord struck at the change still echoes (loses only its first ~30 ms)', () => {
  const tempo = { pulseSeconds: 0.3, beatSeconds: 0.6 };
  const params = paramsWith({ mix: 1, feedback: 0.5 });
  const C5 = [48, 55, 60].map(midiToFreq);
  const rows = [];
  for (const offset of [0, 0.05, 0.15]) {
    const events = strum(C5, { time: 1 + offset, velocity: 0.7 });
    const ducked = chordRender({ events, duration: 2.6, params, tempo, chordChanges: [1] });
    const free = chordRender({ events, duration: 2.6, params, tempo, chordChanges: [] });
    const loss = db(rms(free.wet, 1.3, 1.9) / rms(ducked.wet, 1.3, 1.9));
    assert.ok(loss < (offset === 0 ? 6 : 1.5), `strum ${offset * 1000} ms after the change: ${loss.toFixed(1)} dB`);
    rows.push(`+${offset * 1000} ms: −${loss.toFixed(1)} dB`);
  }
  return `new-chord echo level vs no ducking: ${rows.join(', ')}`;
});

// ---------- engine ----------

test('engine: the rhythm part\'s delay follows the board, the tempo and chord changes; nothing rebuilt', () => {
  const ctx = new FakeAudioContext();
  const engine = createAudioEngine(SETTINGS, { context: ctx });
  engine.setTone(TONES.electric);
  const fx = engine.postFx('rhythm').slots.find(s => s.id === 'delay').fx;
  const nodes = ctx.created.length;
  engine.setTempo({ pulseSeconds: 0.286, beatSeconds: 0.571 });
  engine.applyPedals(snapshotWith(), { type: 'toggle', id: 'delay', on: true });
  assert.equal(fx.nodes.send.gain.calls.at(-1).target, 1);
  assert.ok(Math.abs(fx.control.state.loopSeconds[fx.control.state.active] - 0.286) < 1e-9);
  ctx.currentTime = 2;
  engine.chokeChord([0, 4, 7], { when: 2.1 });
  const duck = fx.nodes.sendDuck.gain.calls.filter(c => c.type === 'target');
  assert.deepEqual(duck.slice(-2).map(c => [c.target, c.time]), [[0, 2.1], [1, 2.1 + DELAY_DSP.sendHold]]);
  engine.setTone(TONES.steel);
  assert.equal(fx.nodes.send.gain.calls.at(-1).target, 0, 'steel: send closed (trails)');
  engine.setTone(TONES.electric);
  assert.equal(fx.nodes.send.gain.calls.at(-1).target, 1);
  assert.equal(engine.postFx('rhythm').slots.find(s => s.id === 'delay').fx, fx, 'same slot after tone changes');
  assert.equal(fx.nodes.dry.gain.calls.filter(c => c.time >= 2).length, 0, 'chord change: dry untouched');
  const bus = createPostFxBus(new FakeAudioContext());
  bus.apply(postFxParams(snapshotWith()), { type: 'load' }, { tau: PEDAL_TAU.toggle });
  bus.dispose();
  return `${nodes} nodes in the engine with the delay slot`;
});

// ---------- peaks ----------

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
  const from = 10 * fmt.rate, frames = Math.min(14 * fmt.rate, Math.floor(data.length / 2 / fmt.channels) - from);
  const left = new Float32Array(frames), right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = data.readInt16LE((from + i) * 2 * fmt.channels) / 32768;
    right[i] = data.readInt16LE(((from + i) * fmt.channels + (fmt.channels > 1 ? 1 : 0)) * 2) / 32768;
  }
  return { left, right, sampleRate: fmt.rate };
}

test('peaks: delay on (default and maximum) against the demo song and the samples stays under the ceiling', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = process.env.AIRJAM_SAMPLES ?? join(root, 'samples');
  const songs = [];
  const demo = renderDemoSong(44100);
  const a = Math.round(10 * 44100);
  songs.push({ name: 'demo', bpm: 100, song: { left: demo.samples.slice(a, a + 14 * 44100), right: demo.samples.slice(a, a + 14 * 44100), sampleRate: 44100 } });
  for (const [file, bpm] of [['s14.wav', 160], ['s21.wav', 104.9]]) {
    const path = join(dir, file);
    if (existsSync(path)) { const song = readWav(path); if (song?.sampleRate === 44100) songs.push({ name: file, bpm, song }); }
  }
  const rows = [];
  for (const { name, bpm, song } of songs) {
    const sampleRate = song.sampleRate, duration = song.left.length / sampleRate;
    const beat = 60 / bpm, tempo = { pulseSeconds: beat / 2, beatSeconds: beat };
    const tone = electricTone(rigFromSnapshot(snapshotWith({}, { on: false })));
    const events = chug(A5, { bpm, seconds: duration - 1, velocity: 0.8 });
    const chokes = [];
    for (let t = 4 * beat * 2; t < duration - 1; t += 4 * beat * 2) chokes.push({ time: t, keep: [9, 4] });
    const off = renderPart(tone, events, { duration, chokes, sampleRate, settings: SETTINGS, seed: 5 });
    const row = { song: name };
    const offMaster = renderMaster(off, song, { sampleRate, settings: SETTINGS });
    for (const [label, params] of [['off', null], ['default', paramsWith()], ['max', paramsWith({ mix: 1, feedback: 1 })]]) {
      const part = params ? runDelay(params, off, { sampleRate, tempo, chordChanges: chokes.map(c => c.time) }) : off;
      const master = params ? renderMaster({ left: part.left, right: part.right }, song, { sampleRate, settings: SETTINGS }) : offMaster;
      let limiter = 0;
      for (let i = sampleRate; i < master.reductionDb.length; i++) limiter = Math.min(limiter, master.reductionDb[i]);
      const peak = peakOf(master);
      assert.ok(peak <= 0.995, `${name} ${label}: peak ${peak}`);
      row[label] = `part ${db(peakOf(part)).toFixed(1)} dB, out ${peak.toFixed(3)}, limiter ${limiter.toFixed(1)} dB`;
      if (label !== 'off') assert.ok(db(peakOf(part)) - db(peakOf(off)) < 3, `${name} ${label}: part peak +${(db(peakOf(part)) - db(peakOf(off))).toFixed(1)} dB`);
    }
    rows.push(row);
  }
  console.table(rows);
  return `${songs.map(s => s.name).join(', ')} (table above)`;
});

console.table(results);
const failed = results.filter(r => r.result === 'FAIL').length;
if (failed) { console.error(`${failed} test(s) failed`); process.exit(1); }
console.log('delay tests passed');
