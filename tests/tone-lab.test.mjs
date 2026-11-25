// node tests/tone-lab.test.mjs
// Pure DSP pieces behind the tone lab: clipping curves, Web Audio biquad formulas, effect chains as
// stage lists (and that the game's electric chain did not change), voice parameters, the lab combos,
// the strum performances, and the Node model of a part.
import assert from 'node:assert/strict';
import { hardClipCurve, clipCurve, curveSlope, shapeSample, chokeDepthDb, distortionCurve } from '../src/core/audio/distortion.js';
import { biquadCoefficients, biquadMagnitude, processStages, stagesResponse, driveDb, deepestNotchDb } from '../src/core/audio/stages.js';
import { TONES, LEGACY_ELECTRIC, RHYTHM_DISTORTION, ampStages } from '../src/core/audio/tones.js';
import { voiceParams } from '../src/core/audio/voice-params.js';
import { LAB_COMBOS, LAB_ORDER, boosterStages } from '../src/core/audio/tone-lab.js';
import { buildPerformance, loopSection, barAtOrAfter, PERFORMANCES } from '../src/lab/performances.js';
import { strum, A5, A5_EIGHT, rms, responseNotch, secondHarmonicDb } from '../src/lab/metrics.js';
import { renderPart, seeded } from '../tools/tone-lab/model.mjs';
import { powerChordAnalysis } from '../src/core/music/power-chords.js';
import { createSongMap } from '../src/core/game/song-map.js';
import { parseChord, chordPitchClasses, mod12 } from '../src/core/music/theory.js';
import { createFFT } from '../src/core/analysis/dsp.js';
import { SETTINGS } from '../src/settings.js';

const results = [];
function test(name, fn) {
  try { const note = fn(); results.push({ test: name, result: 'PASS', detail: note ?? '' }); }
  catch (error) { results.push({ test: name, result: 'FAIL', detail: error.message.split('\n')[0] }); }
}
const db = x => 20 * Math.log10(x);

test('hard clip curve: finite, bounded, monotonic for any drive, knee and bias (no NaN)', () => {
  for (const drive of [0, 1e-9, 0.01, 1, 3, 50, 1e6, NaN, Infinity, -3]) {
    for (const n of [1, 2, 4, 20, 0, NaN, Infinity, -2]) {
      for (const bias of [0, 0.08, 0.3, 5, NaN, -1]) {
        const curve = hardClipCurve(drive, { n, bias });
        let previous = -Infinity, peak = 0;
        for (const v of curve) {
          assert.ok(Number.isFinite(v), `drive ${drive} n ${n} bias ${bias}: non-finite`);
          assert.ok(v >= previous - 1e-7, `drive ${drive} n ${n}: not monotonic`);
          previous = v; peak = Math.max(peak, Math.abs(v));
        }
        assert.ok(peak <= 1 + 1e-6 && peak > 0.99, `peak ${peak}`);
        assert.ok(Math.abs(shapeSample(0, curve)) < 0.01, `drive ${drive} n ${n} bias ${bias}: silence is not silent`);
        const slope = curveSlope(curve);
        assert.ok(Number.isFinite(slope) && slope > 0);
      }
    }
  }
  // clipCurve dispatches; the tanh kind is exactly the existing curve.
  const a = clipCurve({ kind: 'tanh', drive: 4, bias: 0.08 }), b = distortionCurve(4, { bias: 0.08 });
  assert.deepEqual(Array.from(a), Array.from(b));
  // A harder knee bends later: at 60% of full input the n = 4 curve is closer to its ceiling.
  const soft = hardClipCurve(3, { n: 2, bias: 0 }), hard = hardClipCurve(3, { n: 4, bias: 0 });
  assert.ok(shapeSample(0.6, hard) > shapeSample(0.6, soft));
});

test('choke depth follows the drive and is finite', () => {
  assert.equal(chokeDepthDb(24), 90);
  assert.equal(chokeDepthDb(46), 112);
  for (const v of [NaN, -10, Infinity, undefined]) assert.ok(Number.isFinite(chokeDepthDb(v)));
  return `24 dB → ${chokeDepthDb(24)} dB, 46 dB → ${chokeDepthDb(46)} dB`;
});

test('biquads follow the Web Audio formulas: unity where they should be, gain where they should be', () => {
  const sr = 48000;
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a.toFixed(3)} vs ${b}`);
  near(db(biquadMagnitude(biquadCoefficients('lowpass', 1000, 0.7, 0, sr), 10, sr)), 0, 0.01, 'lowpass DC');
  assert.ok(db(biquadMagnitude(biquadCoefficients('lowpass', 1000, 0.7, 0, sr), 20000, sr)) < -40);
  near(db(biquadMagnitude(biquadCoefficients('highpass', 100, 0.7, 0, sr), 20000, sr)), 0, 0.05, 'highpass top');
  // Web Audio's lowpass/highpass Q is a resonance in dB at the cutoff.
  near(db(biquadMagnitude(biquadCoefficients('lowpass', 1000, 6, 0, sr), 1000, sr)), 6, 0.1, 'lowpass Q in dB');
  near(db(biquadMagnitude(biquadCoefficients('peaking', 750, 0.8, 5, sr), 750, sr)), 5, 0.01, 'peaking centre');
  near(db(biquadMagnitude(biquadCoefficients('lowshelf', 700, 1, -12, sr), 20, sr)), -12, 0.05, 'low shelf');
  near(db(biquadMagnitude(biquadCoefficients('lowshelf', 700, 1, -12, sr), 15000, sr)), 0, 0.1, 'low shelf top');
  near(db(biquadMagnitude(biquadCoefficients('highshelf', 3500, 1, 2, sr), 20000, sr)), 2, 0.1, 'high shelf');
  for (const type of ['lowpass', 'highpass', 'bandpass', 'peaking', 'lowshelf', 'highshelf']) {
    for (const f of [0, 1, 24000, 1e6, -5]) {
      const c = biquadCoefficients(type, f, 0.7, 3, sr);
      for (const v of Object.values(c)) assert.ok(Number.isFinite(v), `${type} @ ${f}: ${JSON.stringify(c)}`);
    }
  }
});

test('stage simulation agrees with the analytic small-signal response', () => {
  const sr = 48000, size = 1 << 15;
  for (const id of LAB_ORDER) {
    const stages = LAB_COMBOS[id].stages;
    const impulse = new Float32Array(size);
    impulse[0] = 1e-6;                                     // far below every clipper's knee
    const out = processStages(stages, impulse, sr);
    const re = Float32Array.from(out, v => v / 1e-6), im = new Float32Array(size);
    createFFT(size)(re, im);
    for (const f of [150, 500, 1000, 3000]) {
      const k = Math.round(f * size / sr);
      const simulated = db(Math.hypot(re[k], im[k]));
      const analytic = db(stagesResponse(stages, [k * sr / size], sr)[0]);
      assert.ok(Math.abs(simulated - analytic) < 0.5, `${id} @ ${f} Hz: simulated ${simulated.toFixed(2)} vs ${analytic.toFixed(2)} dB`);
    }
    for (const v of out) assert.ok(Number.isFinite(v));
  }
});

test('甲 (the electric tone before 丁) is unchanged: stage list = the old node graph', () => {
  const o = RHYTHM_DISTORTION;
  const expected = [
    ['biquad', 'highpass', o.tightHz, 0.7], ['biquad', 'peaking', o.preMidHz, 0.8, o.preMidGain], ['gain', o.preGain],
    ['shaper', 'tanh', o.drive, o.bias], ['biquad', 'highpass', 75, 0.7], ['biquad', 'peaking', o.thumpHz, 1.1, o.thumpGain],
    ['biquad', 'peaking', o.mudHz, 1.0, o.mudGain], ['biquad', 'peaking', o.presenceHz, 0.9, o.presenceGain],
    ['biquad', 'lowpass', o.cabHz, 0.9], ['biquad', 'lowpass', o.cabHz * 1.25, 0.6], ['gain', o.level],
  ];
  const actual = LEGACY_ELECTRIC.stages.map(s => (s.kind === 'biquad' ? ['biquad', s.type, s.frequency, s.Q, ...(s.gain !== undefined ? [s.gain] : [])]
    : s.kind === 'gain' ? ['gain', s.value] : ['shaper', s.curve.kind, s.curve.drive, s.curve.bias]));
  assert.deepEqual(actual, expected);
  assert.equal(LEGACY_ELECTRIC.stages[3].oversample, '4x');
  assert.deepEqual(ampStages(RHYTHM_DISTORTION), LEGACY_ELECTRIC.stages);
  assert.equal(LEGACY_ELECTRIC.releaseDepthDb, 90);
  assert.ok(!LEGACY_ELECTRIC.strumChoke && !LEGACY_ELECTRIC.double && !LEGACY_ELECTRIC.pick && !LEGACY_ELECTRIC.string.maxSeconds);
  assert.deepEqual(LAB_COMBOS.labA.stages, LEGACY_ELECTRIC.stages);
});

test('voice parameters for the finger-following tones (steel, nylon, 甲) match the engine formula before the refactor', () => {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const legacy = (tone, freq, velocity, position) => {
    const v = clamp(velocity, 0, 1);
    const edge = Math.min(1, Math.abs(position - 0.5) * 2);
    const sustain = clamp(0.004 / Math.max(1e-4, 1 - SETTINGS.decay), 0.2, 3);
    return {
      render: {
        freq: clamp(freq, 40, 4000),
        t60: clamp(tone.string.t60 * sustain * Math.pow(130 / freq, 0.45), 0.4, 6),
        damping: tone.string.damping * clamp(Math.sqrt(330 / freq), 0.3, 1),
        brightness: clamp(tone.string.brightness * (0.3 + 0.5 * edge + 0.3 * v), 0.05, 1),
        pickPosition: clamp(0.5 - 0.42 * edge, 0.06, 0.5),
      },
      gain: 0.22 + 0.78 * v * v,
    };
  };
  let count = 0;
  for (const tone of [TONES.steel, TONES.nylon, LEGACY_ELECTRIC]) {
    for (const freq of [30, 82.4, 110, 440, 1200, 5000]) {
      for (const velocity of [0, 0.1, 0.6, 1, 1.5]) {
        for (const position of [0, 0.1, 0.5, 0.77, 1]) {
          assert.deepEqual(voiceParams(tone, { freq, velocity, position }, SETTINGS), legacy(tone, freq, velocity, position));
          count++;
        }
      }
    }
  }
  return `${count} cases`;
});

test('lab combos: drive, derived choke depth, near-bridge pick, booster without notches', () => {
  const drive = Object.fromEntries(LAB_ORDER.map(id => [id, driveDb(LAB_COMBOS[id].stages)]));
  assert.ok(Math.abs(drive.labA - 24.4) < 0.5, `甲 ${drive.labA}`);
  for (const id of ['labB', 'labC', 'labD']) {
    assert.ok(drive[id] > 44 && drive[id] < 48, `${id} ${drive[id]}`);
    assert.equal(LAB_COMBOS[id].releaseDepthDb, chokeDepthDb(drive[id]));
  }
  assert.ok(Math.abs(driveDb(LAB_COMBOS.labD.double.stages) - drive.labD + 0.9) < 0.1, 'second take 10% less drive');
  assert.ok(responseNotch(boosterStages()).notch < 0.5);
  assert.ok(deepestNotchDb([0, -5, 0]) === 5 && deepestNotchDb([0, 1, 2, 3]) === 0);
  // 甲 and 乙 keep the hollow mid-string source; 丙 and 丁 pick near the bridge wherever the finger crosses.
  const random = seeded(3);
  const second = id => secondHarmonicDb(LAB_COMBOS[id], SETTINGS, { position: 0.5, repeats: 4, random });
  assert.ok(second('labA') < -15 && second('labC') > -10);
  for (const id of LAB_ORDER) {
    const tone = LAB_COMBOS[id];
    assert.equal(tone.voicing, 'power');
    for (const v of stagesResponse(tone.stages, [50, 500, 5000, 20000])) assert.ok(Number.isFinite(v) && v > 0);
  }
  return Object.entries(drive).map(([id, d]) => `${LAB_COMBOS[id].letter} ${d.toFixed(1)} dB`).join(', ');
});

// A steady 4/4 analysis: 105 BPM, A5 for 2 bars, then D5, E5, A5 ... (power chords).
function steadyAnalysis(bars = 16, bpm = 105) {
  const beats = Array.from({ length: bars * 4 }, (_, i) => 0.5 + i * 60 / bpm);
  const names = ['A', 'A', 'D', 'E'];
  const chords = beats.map((_, i) => parseChord(names[Math.floor(i / 4) % 4]));
  const analysis = {
    beats, beatInBar: beats.map((_, i) => i % 4), chords, duration: beats.at(-1) + 60 / bpm, bpm,
    key: parseChord('A'), segments: [],
  };
  return powerChordAnalysis(analysis, { guard: false });
}

test('strum performances: reproducible, chord tones only, inside the loop, chokes at chord changes', () => {
  const analysis = steadyAnalysis();
  const map = createSongMap(analysis);
  const section = loopSection(analysis, barAtOrAfter(analysis, 2), 8);
  assert.equal(section.bars, 8);
  const length = section.end - section.start;
  for (const kind of PERFORMANCES) {
    const a = buildPerformance(kind, analysis, time => map.chordAt(time), section, SETTINGS);
    const b = buildPerformance(kind, analysis, time => map.chordAt(time), section, SETTINGS);
    assert.deepEqual(a, b, `${kind} is not reproducible`);
    assert.ok(a.events.length > 0);
    for (const e of a.events) {
      assert.ok(e.time >= 0 && e.time < length, `${kind}: event at ${e.time}`);
      const chord = map.chordAt(section.start + Math.max(0, e.time) + 0.03);
      const pc = mod12(Math.round(69 + 12 * Math.log2(e.freq / 440)));
      const before = map.chordAt(section.start + e.time - 0.05);
      assert.ok(chordPitchClasses(chord, 'power').includes(pc) || chordPitchClasses(before, 'power').includes(pc), `${kind}: ${e.freq} Hz`);
      assert.ok(e.velocity >= 0.1 && e.velocity <= 1 && e.position > 0 && e.position < 1);
    }
    for (let i = 1; i < a.events.length; i++) assert.ok(a.events[i].time >= a.events[i - 1].time);
    // A → D → E → A: a choke at every change, including the loop point (E back to A).
    assert.equal(a.chokes.length, 8 / 4 * 3);
    for (const choke of a.chokes) assert.ok(choke.keep.length === 2);
  }
  const chug = buildPerformance('chug', analysis, time => map.chordAt(time), section, SETTINGS);
  assert.equal(chug.events.length, 8 * 8 * 3);
  const ring = buildPerformance('ring', analysis, time => map.chordAt(time), section, SETTINGS);
  assert.equal(ring.events.length, 8 * 5);
  return `loop ${length.toFixed(2)} s; script ${buildPerformance('script', analysis, time => map.chordAt(time), section, SETTINGS).events.length} plucks`;
});

test('Node model: finite output for every combo, chord choke ≥ 40 dB at 80 ms, double-tracking is wide', () => {
  const notes = [];
  for (const id of LAB_ORDER) {
    const tone = LAB_COMBOS[id];
    const extreme = [...strum(A5, { velocity: 0 }), ...strum(A5, { time: 0.2, velocity: 1, position: 0 }), ...strum(A5, { time: 0.3, velocity: 1.5, position: 1 })];
    const wild = renderPart(tone, extreme, { duration: 0.6, settings: SETTINGS, sampleRate: 44100 });
    for (const v of wild.left) assert.ok(Number.isFinite(v) && Math.abs(v) < 4);
    const out = renderPart(tone, strum(A5_EIGHT, { velocity: 1 }), { duration: 0.6, chokes: [{ time: 0.4, keep: [] }], settings: SETTINGS, sampleRate: 44100, seed: 5 });
    const drop = db(rms(out, 0.48, 0.49) / rms(out, 0.38, 0.4));
    assert.ok(drop <= -40, `${id}: ${drop.toFixed(1)} dB`);
    // Side vs mid: centred tones have almost no side, the double-tracked one a lot.
    let mid = 0, side = 0;
    for (let i = 0; i < out.left.length; i++) { mid += (out.left[i] + out.right[i]) ** 2; side += (out.left[i] - out.right[i]) ** 2; }
    const width = 10 * Math.log10(side / mid);
    if (id === 'labD') assert.ok(width > -6, `丁 side/mid ${width.toFixed(1)} dB`);
    else assert.ok(width < -15, `${id} side/mid ${width.toFixed(1)} dB`);
    notes.push(`${tone.letter} ${drop.toFixed(0)} dB, side ${width.toFixed(0)} dB`);
  }
  return notes.join('; ');
});

console.table(results);
const failed = results.filter(r => r.result === 'FAIL').length;
if (failed) { console.error(`${failed} test(s) failed`); process.exit(1); }
console.log('tone lab tests passed');
