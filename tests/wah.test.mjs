// node tests/wah.test.mjs
// The wah pedal (src/core/audio/wah.js, the 'wahFilter'/'wahGain' stages in stages.js, the engine's
// position signal): frequency and Q mapping, smoothing step bounds, the strum-driven auto wah, the
// beat-synced sweep under tempo corrections, loudness compensation, and the engine wiring on a fake
// AudioContext. Strip gating (no plucks from the strip): tests/pedalboard.test.mjs; availability and
// the on-page controls: tests/menu.test.mjs.
import assert from 'node:assert/strict';
import {
  SMITH, WAH_RANGES, WAH_MOTION, wahSettings, wahFrequency, wahQ, wahCompensation, createWahControl,
  simulateParam, lfoPosition, beatsPerCycle,
} from '../src/core/audio/wah.js';
import { wahStageAt, wahQCurve, wahCompCurve, WAH_COMP_SPAN, stagesResponse } from '../src/core/audio/stages.js';
import { rigFromSnapshot, rigStages, toneVoicing } from '../src/core/audio/electric-rig.js';
import { createAudioEngine } from '../src/core/audio/engine.js';
import { TONES } from '../src/core/audio/tones.js';
import { createPedalModel, visibleKnobs, PEDAL_TYPES } from '../src/core/pedals/model.js';
import { analyzeSync, retime } from '../src/core/analysis/analysis.js';
import { renderBacking } from '../src/core/song/backing-synth.js';
import { DEMO } from '../src/core/song/demo-song.js';
import { createSongMap } from '../src/core/game/song-map.js';
import { SETTINGS } from '../src/settings.js';
import { FakeAudioContext } from './fake-audio-context.mjs';
import { wahLevelRows } from '../tools/tone-lab/calibrate-level.mjs';

const results = [];
function test(name, fn) {
  try { const note = fn(); results.push({ test: name, result: 'PASS', detail: note ?? '' }); }
  catch (error) { results.push({ test: name, result: 'FAIL', detail: error.message.split('\n')[0] }); }
}
const cents = (a, b) => 1200 * Math.abs(Math.log2(a / b));
const db = x => 20 * Math.log10(x);

function wahPedal(params = {}, { on = true, mode = 'simple' } = {}) {
  const model = createPedalModel();
  model.applyPreset('clean');
  model.setMode(mode);
  model.toggle('wah', on);
  for (const [knob, value] of Object.entries(params)) model.setParam('wah', knob, value);
  return model.snapshot();
}

// ---------- mapping ----------
test('mapping: defaults are Smith\'s CryBaby (450 Hz → 2.2 kHz, Q 8 → 2), in simple and advanced mode', () => {
  for (const mode of ['simple', 'advanced']) {
    const wah = rigFromSnapshot(wahPedal({}, { mode })).wah;
    assert.ok(Math.abs(wahFrequency(wah, 0) - 450) < 0.5, `${mode} heel ${wahFrequency(wah, 0)}`);
    assert.ok(Math.abs(wahFrequency(wah, 1) - 450 * Math.pow(2, 2.3)) < 1, `${mode} toe ${wahFrequency(wah, 1)}`);
    for (const w of [0, 0.3, 0.5, 1]) {
      assert.ok(Math.abs(wahFrequency(wah, w) - 450 * Math.pow(2, 2.3 * w)) < 1, `fr(${w})`);
      assert.ok(Math.abs(wahQ(wah, w) - Math.pow(2, 2 * (1 - w) + 1)) < 1e-6, `Q(${w})`);
    }
  }
  return `fr 450·2^(2.3w), Q 2^(2(1−w)+1); SMITH ${JSON.stringify(SMITH)}`;
});

test('mapping: frequency rises and Q falls monotonically with w, bounded for every knob setting', () => {
  let fMin = Infinity, fMax = 0, qMin = Infinity, qMax = 0;
  const corners = [0, 0.5, 1];
  for (const range of corners) for (const low of corners) for (const high of corners) for (const resonance of corners) for (const mode of ['simple', 'advanced']) {
    const rig = rigFromSnapshot(wahPedal({ range, low, high, resonance }, { mode }));
    const [filter] = rigStages(rig)[0].branches[1].stages;
    let lastF = 0, lastQ = Infinity;
    for (let i = 0; i <= 50; i++) {
      const w = i / 50;
      const { frequency, Q } = wahStageAt(filter, w);
      assert.ok(frequency > lastF && Q < lastQ, `monotonic at w ${w}`);
      assert.ok(Math.abs(frequency - wahFrequency(rig.wah, w)) < 1e-6 * frequency, 'stage = mapping');
      lastF = frequency; lastQ = Q;
      fMin = Math.min(fMin, frequency); fMax = Math.max(fMax, frequency); qMin = Math.min(qMin, Q); qMax = Math.max(qMax, Q);
    }
    // Outside 0..1 the position clamps.
    assert.equal(wahStageAt(filter, -3).frequency, wahStageAt(filter, 0).frequency);
    assert.equal(wahStageAt(filter, 7).Q, wahStageAt(filter, 1).Q);
  }
  assert.ok(fMin >= 200 && fMax <= 3600, `${fMin.toFixed(0)}–${fMax.toFixed(0)} Hz`);
  assert.ok(qMin >= 0.9 && qMax <= 16.1, `Q ${qMin.toFixed(2)}–${qMax.toFixed(2)}`);
  return `centre ${fMin.toFixed(0)}–${fMax.toFixed(0)} Hz, Q ${qMin.toFixed(2)}–${qMax.toFixed(2)} over all knobs`;
});

test('mapping: the browser\'s control curves (WaveShaper, linear interpolation) match the formulas', () => {
  const q = wahQCurve(), comp = wahCompCurve();
  const at = (curve, x) => {
    const v = (curve.length - 1) * (x + 1) / 2, i = Math.min(curve.length - 2, Math.floor(v));
    return curve[i] + (curve[i + 1] - curve[i]) * (v - i);
  };
  let worstQ = 0, worstComp = 0;
  for (let i = 0; i <= 997; i++) {
    const w = i / 997;
    worstQ = Math.max(worstQ, Math.abs(at(q, w) / Math.pow(4, 1 - w) - 1));
    const x = -1 + 2 * w;
    worstComp = Math.max(worstComp, Math.abs(db(at(comp, x)) - WAH_COMP_SPAN * x));
  }
  assert.ok(worstQ < 1e-4, `Q curve error ${worstQ}`);
  assert.ok(worstComp < 0.01, `compensation curve error ${worstComp} dB`);
  return `Q curve ≤ ${(worstQ * 100).toExponential(1)}%, gain curve ≤ ${worstComp.toFixed(4)} dB`;
});

test('mapping: the band-pass peaks at the centre frequency with 0 dB before compensation', () => {
  const rig = rigFromSnapshot(wahPedal());
  const [filter] = rigStages(rig)[0].branches[1].stages;
  const freqs = Array.from({ length: 400 }, (_, i) => 100 * Math.pow(2, i / 60));
  for (const w of [0, 0.25, 0.5, 0.75, 1]) {
    const response = stagesResponse([filter], freqs, 48000, { wah: w });
    const peak = response.indexOf(Math.max(...response));
    assert.ok(cents(freqs[peak], wahFrequency(rig.wah, w)) < 25, `peak at w ${w}`);
    assert.ok(Math.abs(db(response[peak])) < 0.05);
  }
});

// ---------- smoothing ----------
// Chrome recomputes the band-pass every sample when its parameters come from a connected signal;
// a browser that only updates once per 128-frame block would step. Both are bounded here.
function steps(track, rig, block = 128) {
  const f = w => wahFrequency(rig.wah, w);
  let perSample = 0, perBlock = 0, gainBlock = 0;
  for (let i = 1; i < track.length; i++) perSample = Math.max(perSample, cents(f(track[i]), f(track[i - 1])));
  for (let i = block; i < track.length; i += block) {
    perBlock = Math.max(perBlock, cents(f(track[i]), f(track[i - block])));
    gainBlock = Math.max(gainBlock, Math.abs(rig.wah.compSlope * (track[i] - track[i - block])));
  }
  return { perSample, perBlock, gainBlock };
}

test('smoothing: the strip glides — a fast sweep and a jump stay within per-sample and per-block bounds', () => {
  const sampleRate = 48000;
  const snapshot = wahPedal({ mode: 0 });
  const rig = rigFromSnapshot(snapshot);
  const control = createWahControl();
  const calls = [...control.configure(rig.wah, 0)];
  // 30 fps camera frames: heel → toe in 0.2 s, hold, then a jump back to the heel (a hand re-entering).
  for (let k = 0; k <= 30; k++) {
    const t = 0.3 + k / 30;
    const w = k <= 6 ? k / 6 : k < 20 ? 1 : 0;
    calls.push(...control.configure({ ...rig.wah, position: w }, t));
  }
  const track = simulateParam(calls, { sampleRate, duration: 1.6 });
  const s = steps(track, rig);
  assert.ok(s.perSample < 6, `per sample ${s.perSample.toFixed(2)} cents`);
  assert.ok(s.perBlock < 300, `per block ${s.perBlock.toFixed(0)} cents`);
  assert.ok(s.gainBlock < 1, `compensation ${s.gainBlock.toFixed(2)} dB per block`);
  assert.ok(Math.abs(track.at(-1)) < 0.01, 'reaches the jump target');
  return `strip: ≤ ${s.perSample.toFixed(2)} cents/sample, ≤ ${s.perBlock.toFixed(0)} cents and ${s.gainBlock.toFixed(2)} dB per block (τ ${WAH_MOTION.handTau * 1000} ms)`;
});

test('smoothing: auto wah (default attack) and 跟拍子 frames stay within per-sample bounds', () => {
  const sampleRate = 48000;
  const rig = rigFromSnapshot(wahPedal({ mode: 1 }));
  const control = createWahControl();
  const calls = [...control.configure(rig.wah, 0)];
  for (let t = 0.2; t < 1.5; t += 30 / 105) for (let k = 0; k < 4; k++) calls.push(...control.pluck(t + k * 0.015, 1));
  const strumTrack = simulateParam(calls, { sampleRate, duration: 1.6 });
  const a = steps(strumTrack, rig);
  const beat = rigFromSnapshot(wahPedal({ mode: 1, source: 1 }, { mode: 'advanced' }));
  const lfo = createWahControl();
  const lfoCalls = [...lfo.configure(beat.wah, 0)];
  for (let t = 0; t < 3; t += 1 / 60) lfoCalls.push(...lfo.frame(t, at => ({ beats: at / 0.5, beatSeconds: 0.5 })));
  const b = steps(simulateParam(lfoCalls, { sampleRate, duration: 3 }), beat);
  assert.ok(a.perSample < 15, `strum ${a.perSample.toFixed(2)} cents/sample`);
  assert.ok(a.perBlock < 700, `strum ${a.perBlock.toFixed(0)} cents/block`);
  assert.ok(b.perSample < 2 && b.perBlock < 250, `beat ${b.perSample.toFixed(2)} / ${b.perBlock.toFixed(0)} cents`);
  return `auto (attack ${(rig.wah.attack * 1000).toFixed(0)} ms, velocity 1): ≤ ${a.perSample.toFixed(1)} cents/sample, ${a.perBlock.toFixed(0)} cents/block; `
    + `跟拍子 ≤ ${b.perSample.toFixed(2)} cents/sample, ${b.perBlock.toFixed(0)} cents/block`;
});

// ---------- auto wah ----------
test('auto wah: each strum opens the pedal (louder = further), closes over the decay; one strum = one sweep', () => {
  const sampleRate = 8000;
  const rig = rigFromSnapshot(wahPedal({ mode: 1 }));
  const control = createWahControl();
  const calls = [...control.configure(rig.wah, 0)];
  const strums = [[0.5, 0.9], [1.5, 0.3], [2.5, 0.9]];
  for (const [t, v] of strums) for (let k = 0; k < 4; k++) calls.push(...control.pluck(t + k * 0.015, v * (k === 2 ? 1 : 0.9)));
  const track = simulateParam(calls, { sampleRate, duration: 3.5 });
  const at = t => track[Math.round(t * sampleRate)];
  const peakAfter = t0 => {
    let best = 0, when = t0;
    for (let t = t0; t < t0 + 0.4; t += 1 / sampleRate) if (at(t) > best) { best = at(t); when = t; }
    return { best, when };
  };
  assert.ok(Math.abs(at(0.45) - WAH_MOTION.rest) < 0.01, 'rests before the first strum');
  const loud = peakAfter(0.5), soft = peakAfter(1.5);
  assert.ok(loud.best > 0.8 && soft.best < loud.best - 0.25, `peaks ${loud.best.toFixed(2)} / ${soft.best.toFixed(2)}`);
  assert.ok(loud.when - 0.5 >= rig.wah.attack * 0.8 && loud.when - 0.5 <= rig.wah.attack * 2 + 0.05, `peak ${((loud.when - 0.5) * 1000).toFixed(0)} ms after the strum`);
  // One rise per strum: after the peak it only falls until the next strum.
  for (let t = loud.when + 0.01; t < 1.49; t += 0.01) assert.ok(at(t) <= at(t - 0.01) + 1e-6, `still rising at ${t.toFixed(2)}`);
  assert.ok(at(1.45) - WAH_MOTION.rest < 0.05, `closed again ${at(1.45).toFixed(3)}`);
  // Sensitivity: the same soft strum reaches further when it is turned up.
  const keen = rigFromSnapshot(wahPedal({ mode: 1, sensitivity: 1 }, { mode: 'advanced' }));
  const c2 = createWahControl();
  const t2 = simulateParam([...c2.configure(keen.wah, 0), ...c2.pluck(0.5, 0.3)], { sampleRate, duration: 1 });
  assert.ok(Math.max(...t2) > soft.best + 0.3, 'sensitivity raises the peak');
  // Hand mode and 跟拍子 ignore plucks.
  const hand = createWahControl();
  hand.configure(rigFromSnapshot(wahPedal({ mode: 0 })).wah, 0);
  assert.deepEqual(hand.pluck(0.5, 1), []);
  return `peak ${loud.best.toFixed(2)} (vel .9) / ${soft.best.toFixed(2)} (vel .3), ${((loud.when - 0.5) * 1000).toFixed(0)} ms after the strum; rest ${WAH_MOTION.rest}`;
});

// ---------- 跟拍子 ----------
test('跟拍子: the sweep stays on the pulse grid with the same speed when the tempo is halved or doubled', () => {
  const { samples, sampleRate } = renderBacking(DEMO);
  const auto = analyzeSync(samples, sampleRate);
  const maps = [1, 0.5, 2].map(factor => createSongMap(factor === 1 ? auto : retime(auto, { factor })));
  const curve = map => t => {
    const beat = map.beatPhase(t);
    return lfoPosition(beat.inBar + beat.phase, 60 / map.bpm);   // as src/app/app.js's wah clock
  };
  const curves = maps.map(curve);
  // Toe positions (w = 1) over 8 s, compared with the original tempo's.
  const peaks = c => {
    const out = [];
    for (let t = 2; t < 10; t += 0.002) if (c(t) > c(t - 0.002) && c(t) >= c(t + 0.002) && c(t) > 0.99) out.push(t);
    return out;
  };
  const base = peaks(curves[0]);
  const period = (base.at(-1) - base[0]) / (base.length - 1);
  const pulse = 60 / maps[0].bpm / Math.max(1, auto.autoTempo.grouping);
  const detail = [];
  maps.forEach((map, k) => {
    const p = peaks(curves[k]);
    const per = (p.at(-1) - p[0]) / (p.length - 1);
    assert.ok(Math.abs(per - period) < 0.01, `factor ${[1, 0.5, 2][k]}: period ${per.toFixed(3)} vs ${period.toFixed(3)}`);
    // Every toe lands on the detected pulse grid (the original beats here: one pulse per beat).
    for (const t of p) {
      const n = maps[0].nearestBeat(t);
      assert.ok(Math.abs(n.delta) < 0.02, `toe ${t.toFixed(3)} is ${(n.delta * 1000).toFixed(0)} ms off the pulse grid`);
    }
    detail.push(`×${[1, 0.5, 2][k]} ${map.bpm.toFixed(0)} BPM → ${beatsPerCycle(60 / map.bpm)} beat(s)/sweep`);
  });
  return `${detail.join(', ')}; sweep ${period.toFixed(3)} s (pulse ${pulse.toFixed(3)} s)`;
});

test('跟拍子: per-frame chase follows the grid; with no song it sweeps on a free 100 BPM pulse', () => {
  const rig = rigFromSnapshot(wahPedal({ mode: 1, source: 1 }, { mode: 'advanced' }));
  assert.equal(rig.wah.source, 'beat');
  const control = createWahControl();
  const calls = [...control.configure(rig.wah, 0)];
  for (let t = 0; t < 4; t += 1 / 60) calls.push(...control.frame(t, null));
  const track = simulateParam(calls, { sampleRate: 1000, duration: 4 });
  const ideal = t => lfoPosition(t * 100 / 60, 0.6);
  let worst = 0;
  for (let t = 1; t < 3.95; t += 0.01) worst = Math.max(worst, Math.abs(track[Math.round(t * 1000)] - ideal(t)));
  assert.ok(worst < 0.1, `chase error ${worst.toFixed(3)}`);
  assert.equal(control.pluck(1, 1).length, 0, 'strums do not move it');
  return `chase error ≤ ${worst.toFixed(3)} of the range`;
});

// ---------- loudness ----------
test('loudness: in simple mode the wah stays within ±1.5 dB of the bypass across w (clean and 搖滾)', () => {
  const detail = [];
  for (const preset of ['clean', 'rock']) {
    const snapshotOf = on => {
      const model = createPedalModel();
      model.applyPreset(preset);
      model.toggle('wah', on);
      model.setParam('wah', 'mode', 0);
      return model.snapshot();
    };
    const rows = wahLevelRows(snapshotOf, { seconds: 2 });
    for (const v of rows) assert.ok(Math.abs(v) <= 1.5, `${preset}: ${rows.map(x => x.toFixed(1)).join(' ')}`);
    detail.push(`${preset} ${rows.map(x => x.toFixed(1)).join('/')}`);
  }
  return `wah on − off (dB) at w 0/.25/.5/.75/1: ${detail.join('; ')}`;
});

test('loudness: the compensation line fits the strum spectrum within 2 dB for every range', () => {
  let worst = 0;
  for (const range of [0, 0.25, 0.5, 0.75, 1]) {
    const wah = wahSettings({ on: true, params: { range } });
    worst = Math.max(worst, wahCompensation(wah).errorDb);
  }
  assert.ok(worst < 2, `${worst.toFixed(2)} dB`);
  return `worst deviation ${worst.toFixed(2)} dB`;
});

// ---------- knobs and voicing ----------
test('knobs: simple mode has two wah controls (手控／自動, 範圍); advanced has the real-pedal set', () => {
  assert.deepEqual(visibleKnobs('wah', 'simple').map(k => k.id), ['mode', 'range']);
  assert.deepEqual(visibleKnobs('wah', 'advanced').map(k => k.id),
    ['mode', 'source', 'low', 'high', 'resonance', 'sensitivity', 'attack', 'decay', 'level']);
  for (const knob of PEDAL_TYPES.wah.knobs) assert.ok(knob.default >= 0 && knob.default <= 1, knob.id);
  // Advanced-only knobs do nothing in simple mode (it always sounds like the defaults).
  const simple = rigFromSnapshot(wahPedal({ resonance: 1, sensitivity: 1, attack: 1, source: 1, low: 0, high: 1 }));
  const plain = rigFromSnapshot(wahPedal());
  assert.deepEqual(simple.wah, plain.wah);
  const advanced = rigFromSnapshot(wahPedal({ resonance: 1, low: 0, high: 1, source: 1 }, { mode: 'advanced' }));
  assert.ok(advanced.wah.qScale > plain.wah.qScale * 1.9 && advanced.wah.lowHz < 260 && advanced.wah.highHz > 3400 && advanced.wah.source === 'beat');
  assert.equal(WAH_RANGES.lowHz[0], 250);
});

test('voicing: the wah alone keeps triads; only overdrive or distortion switch to power chords', () => {
  assert.equal(toneVoicing(TONES.electric, wahPedal()), 'triad');
  const model = createPedalModel();
  model.applyPreset('rock');
  model.toggle('wah', true);
  assert.equal(toneVoicing(TONES.electric, model.snapshot()), 'power');
});

// ---------- engine ----------
test('engine: one position signal per part drives both takes; strip moves and strums only automate it', () => {
  const ctx = new FakeAudioContext();
  const engine = createAudioEngine({ ...SETTINGS }, { context: ctx, streaming: true });
  engine.applyPedals(wahPedal({ mode: 0, position: 0.2 }));
  engine.setTone(TONES.electric);
  const sources = ctx.created.filter(n => n.kind === 'constant');
  assert.equal(sources.length, 1, 'one wah signal for the part');
  assert.equal(engine.wahParam, sources[0].offset);
  const filters = ctx.created.filter(n => n.kind === 'biquad' && n.type === 'bandpass');
  assert.equal(filters.length, 4, 'two takes × two switchable copies');
  // The signal reaches every band-pass's detune and Q (through its cents gain and Q curve).
  const reaches = (from, target, seen = new Set()) => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return [...(from.outputs ?? [])].some(next => reaches(next, target, seen));
  };
  for (const f of filters) assert.ok(reaches(sources[0], f.detune) && reaches(sources[0], f.Q), 'controls every filter');
  const offset = sources[0].offset;
  assert.ok(offset.calls.some(c => c.type === 'target' && c.target === 0.2), 'glides to the strip position');
  // A strip move: only the position param is automated, nothing else in the chain.
  const params = ctx.created.flatMap(n => Object.values(n).filter(v => v?.calls && v !== offset));
  const before = params.map(p => p.calls.length);
  const nodes = ctx.created.length;
  ctx.currentTime = 1;
  engine.applyPedals(wahPedal({ mode: 0, position: 0.9 }), { type: 'param', id: 'wah', knob: 'position', value: 0.9, commit: false });
  assert.deepEqual(params.map(p => p.calls.length), before, 'no other parameter touched');
  assert.equal(ctx.created.length, nodes, 'nothing rebuilt');
  const last = offset.calls.at(-1);
  assert.equal(last.type, 'target');
  assert.equal(last.target, 0.9);
  assert.equal(last.tau, WAH_MOTION.handTau);
  // Auto: a strum schedules the envelope at the pluck's time.
  engine.applyPedals(wahPedal({ mode: 1 }), { type: 'param', id: 'wah', knob: 'mode', value: 1, commit: true });
  const n = offset.calls.length;
  ctx.currentTime = 2;
  engine.pluck({ freq: 110, velocity: 0.8 });
  const strum = offset.calls.slice(n);
  assert.ok(strum.some(c => c.type === 'target' && c.time === 2 && c.target > 0.8), JSON.stringify(strum));
  // 跟拍子: every frame chases the grid.
  engine.applyPedals(wahPedal({ mode: 1, source: 1 }, { mode: 'advanced' }), { type: 'param', id: 'wah', knob: 'source', value: 1, commit: true });
  const m = offset.calls.length;
  engine.tickWah();
  assert.ok(offset.calls.length > m, 'tick automates the position');
});

test('engine: switching the wah on cross-fades to the other copy; the rock sound with the wah off is unchanged', () => {
  const ctx = new FakeAudioContext();
  const engine = createAudioEngine({ ...SETTINGS }, { context: ctx, streaming: true });
  const model = createPedalModel();
  engine.applyPedals(model.snapshot());
  engine.setTone(TONES.electric);
  const [wahMix] = engine.tone.stages;
  assert.deepEqual(wahMix.branches.map(b => b.weight), [1, 0], 'rock: the wah is bypassed (the 搖滾 = 丁 render test covers the sound)');
  model.toggle('wah', true);
  engine.applyPedals(model.snapshot(), { type: 'toggle', id: 'wah', on: true });
  const faders = ctx.created.filter(n => n.kind === 'gain' && n.gain.calls.some(c => c.type === 'target' && c.tau === 0.012));
  assert.ok(faders.length >= 2, 'faders cross-fade (toggle time constant)');
});

console.table(results);
const failed = results.filter(r => r.result === 'FAIL').length;
if (failed) { console.error(`${failed} test(s) failed`); process.exit(1); }
console.log('wah tests passed');
