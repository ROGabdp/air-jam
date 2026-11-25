// node tests/instrument.test.mjs
// Logic checks that need no browser: pluck synthesis, gesture recognition, crossing detection,
// pitch snapping, scoring, and the air-strings instrument driven by synthetic hands.
import assert from 'node:assert/strict';
import { renderPluck } from '../src/core/audio/karplus.js';
import { createGestureRecognizer } from '../src/core/hands/gestures.js';
import { PluckDetector } from '../src/instruments/air-strings/pluck-detector.js';
import { createPitchSnapper } from '../src/core/music/pitch-snap.js';
import { chordPitchClasses, scalePitchClasses, parseChord, mod12, C_MAJOR_PENTATONIC, chordName, noteToMidi } from '../src/core/music/theory.js';
import { guardRoots, allowedRoots, powerChordAnalysis } from '../src/core/music/power-chords.js';
import { distortionCurve, curveSlope, shapeSample, releaseTimeConstant, ceilingCurve } from '../src/core/audio/distortion.js';
import { TONES, RHYTHM_DISTORTION } from '../src/core/audio/tones.js';
import { createScorer } from '../src/core/game/scoring.js';
import { createSongMap } from '../src/core/game/song-map.js';
import { createAirStrings } from '../src/instruments/air-strings/index.js';
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

// ---------- Karplus-Strong ----------
function fundamental(data, sampleRate, expected) {
  // Autocorrelation peak near the expected period, refined by parabolic interpolation.
  const from = 2000, size = 16384;
  const acf = lag => { let s = 0; for (let i = from; i < from + size; i++) s += data[i] * data[i + lag]; return s; };
  const guess = sampleRate / expected;
  let best = Math.round(guess), bestValue = -Infinity;
  for (let lag = Math.floor(guess * 0.9); lag <= Math.ceil(guess * 1.1); lag++) {
    const value = acf(lag);
    if (value > bestValue) { bestValue = value; best = lag; }
  }
  const a = acf(best - 1), b = acf(best), c = acf(best + 1);
  return sampleRate / (best + 0.5 * (a - c) / (a - 2 * b + c));
}

test('pluck synth is in tune (within 5 cents) and never exceeds full scale', () => {
  const cents = [];
  for (const sampleRate of [44100, 48000]) {
    for (const freq of [82.41, 130.81, 220, 329.63, 523.25, 880, 1046.5]) {
      for (const damping of [0.5, 0.25]) {
        const data = renderPluck({ freq, sampleRate, t60: 3, brightness: 0.7, pickPosition: 0.3, damping, random: seeded(freq | 0) });
        let peak = 0;
        for (const v of data) { assert.ok(Number.isFinite(v)); peak = Math.max(peak, Math.abs(v)); }
        assert.ok(peak <= 1.0001, `peak ${peak}`);
        const error = 1200 * Math.log2(fundamental(data, sampleRate, freq) / freq);
        cents.push(Math.abs(error));
        assert.ok(Math.abs(error) < 5, `${freq} Hz @${sampleRate}: ${error.toFixed(2)} cents`);
      }
    }
  }
  return `max error ${Math.max(...cents).toFixed(2)} cents`;
});

test('pluck synth decays: last 100 ms is far quieter than the first', () => {
  const data = renderPluck({ freq: 220, sampleRate: 44100, t60: 2, random: seeded(3) });
  const rms = (from, n) => Math.sqrt(data.subarray(from, from + n).reduce((s, v) => s + v * v, 0) / n);
  const ratio = rms(data.length - 4410, 4410) / rms(441, 4410);
  assert.ok(ratio < 0.05, `ratio ${ratio}`);
  return `tail/head RMS ${ratio.toFixed(4)}`;
});

// ---------- gestures ----------
// A schematic hand: palm 100 px tall, fingers extended or curled, thumb–index gap adjustable.
function makeHand({ x = 300, y = 300, pinchGap = 80, curled = false, scale = 1, jitter = 0, random = Math.random }) {
  const points = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  const put = (i, px, py) => { points[i] = { x: x + px * scale + (random() - 0.5) * jitter, y: y + py * scale + (random() - 0.5) * jitter, z: 0 }; };
  put(0, 0, 0);
  [[5, -30], [9, 0], [13, 25], [17, 45]].forEach(([base, dx]) => {
    const reach = curled ? [-100, -85, -70, -75] : [-100, -140, -170, -195];
    reach.forEach((dy, k) => put(base + k, dx, dy + (base === 9 ? 0 : 8)));
  });
  put(1, -35, -25); put(2, -55, -55); put(3, -60, -85);
  // Thumb tip sits pinchGap away from the index tip.
  put(4, points[8].x - x + 0, 0);
  points[4] = { x: points[8].x - pinchGap * scale, y: points[8].y, z: 0 };
  if (curled) points[4] = { x: x - 20 * scale, y: y - 70 * scale, z: 0 };
  return points;
}

test('pinch uses hysteresis and is independent of hand size', () => {
  for (const scale of [0.5, 1, 2]) {
    const recognizer = createGestureRecognizer(SETTINGS);
    const step = (gap, time) => recognizer.update([makeHand({ pinchGap: gap, scale })], time)[0];
    assert.equal(step(80, 0).pinching, false);
    assert.equal(step(42, 0.03).pinching, false, 'between thresholds stays open');
    assert.equal(step(30, 0.06).pinching, true);
    assert.equal(step(45, 0.09).pinching, true, 'between thresholds stays pinched');
    assert.equal(step(60, 0.12).pinching, false);
  }
});

test('pinch does not flicker with ±6 px landmark noise around the threshold', () => {
  const recognizer = createGestureRecognizer(SETTINGS);
  const random = seeded(42);
  let flips = 0, previous = null;
  for (let i = 0; i < 300; i++) {
    const hand = recognizer.update([makeHand({ pinchGap: 30, jitter: 12, random })], i / 30)[0];
    if (previous !== null && hand.pinching !== previous) flips++;
    previous = hand.pinching;
  }
  assert.ok(flips <= 1, `${flips} flips`);
  return `${flips} state changes in 300 noisy frames`;
});

test('fist is detected, blocks pinching, and a pinch with curled fingers is not a fist', () => {
  const recognizer = createGestureRecognizer(SETTINGS);
  const fist = recognizer.update([makeHand({ curled: true })], 0)[0];
  assert.equal(fist.fist, true);
  assert.equal(fist.pinching, false);
  const other = createGestureRecognizer(SETTINGS);
  const pinchCurled = makeHand({ curled: true });
  // Index finger extended towards the thumb, other fingers curled.
  pinchCurled[8] = { x: 270, y: 150, z: 0 };
  pinchCurled[4] = { x: 262, y: 160, z: 0 };
  const hand = other.update([pinchCurled], 0)[0];
  assert.equal(hand.fist, false);
  assert.equal(hand.pinching, true);
});

test('hand identities survive swapped detection order', () => {
  const recognizer = createGestureRecognizer(SETTINGS);
  const first = recognizer.update([makeHand({ x: 200 }), makeHand({ x: 700 })], 0);
  const second = recognizer.update([makeHand({ x: 705 }), makeHand({ x: 204 })], 0.03);
  assert.equal(second[0].id, first[1].id);
  assert.equal(second[1].id, first[0].id);
});

// ---------- crossing detection ----------
const STRING = { id: 1, a: { x: 100, y: 300 }, b: { x: 500, y: 300 } };

test('a swipe across a string plucks once, at the right position', () => {
  const detector = new PluckDetector(0.07);
  let hits = [];
  for (let y = 200; y <= 400; y += 40) hits = hits.concat(detector.detect('h', { x: 200, y }, 90, [STRING]));
  assert.equal(hits.length, 1);
  assert.ok(Math.abs(hits[0].u - 0.25) < 0.01);
});

test('a fingertip trembling on the string does not re-trigger', () => {
  const detector = new PluckDetector(0.07);
  const random = seeded(7);
  let count = 0;
  detector.detect('h', { x: 300, y: 280 }, 90, [STRING]);
  for (let i = 0; i < 600; i++) {
    count += detector.detect('h', { x: 300 + (random() - 0.5) * 8, y: 300 + (random() - 0.5) * 11 }, 90, [STRING]).length;
  }
  assert.equal(count, 0);
});

test('passing beyond the end of a string does not pluck it', () => {
  const detector = new PluckDetector(0.07);
  let count = 0;
  for (let y = 200; y <= 400; y += 25) count += detector.detect('h', { x: 560, y }, 90, [STRING]).length;
  assert.equal(count, 0);
});

test('one fast frame across three strings reports them in crossing order', () => {
  const detector = new PluckDetector(0.07);
  const strings = [320, 300, 340].map((y, i) => ({ id: i, a: { x: 100, y }, b: { x: 500, y } }));
  detector.detect('h', { x: 300, y: 250 }, 90, strings);
  const hits = detector.detect('h', { x: 310, y: 400 }, 90, strings);
  assert.deepEqual(hits.map(h => h.string.a.y), [300, 320, 340]);
  const back = detector.detect('h', { x: 300, y: 250 }, 90, strings);
  assert.deepEqual(back.map(h => h.string.a.y), [340, 320, 300]);
});

// ---------- pitch snapping ----------
test('chord mode only ever yields chord tones, for all 24 chords and every slot', () => {
  const settings = { ...SETTINGS, snapMode: 'chord' };
  const snapper = createPitchSnapper(settings);
  let checked = 0;
  for (let root = 0; root < 12; root++) for (const minor of [false, true]) {
    const chord = { root, minor };
    snapper.setChord(chord);
    let previous = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const note = snapper.note(i / 100);
      assert.ok(chordPitchClasses(chord).includes(mod12(note.midi)));
      assert.ok(note.midi >= previous, 'higher position never gives a lower note');
      previous = note.midi;
      checked++;
    }
  }
  return `${checked} notes checked`;
});

test('scale mode, free mode and the no-analysis fallback', () => {
  const settings = { ...SETTINGS, snapMode: 'scale' };
  const snapper = createPitchSnapper(settings);
  for (let i = 0; i <= 20; i++) assert.ok(C_MAJOR_PENTATONIC.includes(mod12(snapper.note(i / 20).midi)), 'no key → pentatonic');
  snapper.setKey(parseChord('Dm'));
  for (let i = 0; i <= 20; i++) assert.ok(scalePitchClasses(parseChord('Dm')).includes(mod12(snapper.note(i / 20).midi)));
  settings.snapMode = 'chord';
  assert.equal(snapper.effectiveMode(), 'scale', 'chord mode without a chord falls back to the key');
  settings.snapMode = 'free';
  const low = snapper.note(0, 1).freq, octave = snapper.note(0.5, 2).freq;
  assert.ok(Math.abs(octave / low - 2) < 1e-9, 'half the length doubles the frequency');
  snapper.setVoicing('power');
  settings.snapMode = 'chord';
  snapper.setChord(parseChord('C'));
  for (let i = 0; i <= 20; i++) assert.ok([0, 7].includes(mod12(snapper.note(i / 20).midi)));
});

// ---------- rock chord mode: power chords, key guard, distortion, choke ----------
test('power chords: only root and fifth, for all 24 detected chords and every slot, in a low register', () => {
  const settings = { ...SETTINGS, snapMode: 'chord' };
  const snapper = createPitchSnapper(settings);
  snapper.setVoicing(TONES.electric.voicing);
  const lowest = noteToMidi(settings.powerLowestNote);
  let checked = 0, top = -Infinity;
  for (let root = 0; root < 12; root++) for (const minor of [false, true]) {
    // What the song map hands the snapper: the triad tracker's chord reduced to its root.
    const detected = { root, minor };
    const [power] = powerChordAnalysis({ beats: [0], chords: [detected], duration: 1, key: null }, { guard: false }).chords;
    snapper.setChord(power);
    assert.equal(chordName(power), `${chordName({ root, minor: false })}5`);
    const allowed = [root, mod12(root + 7)];
    let previous = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const note = snapper.note(i / 100);
      assert.ok(allowed.includes(mod12(note.midi)), `${chordName(detected)}: pitch class ${mod12(note.midi)}`);
      assert.ok(note.midi >= previous, 'higher position never gives a lower note');
      previous = note.midi;
      checked++;
    }
    const bottom = snapper.note(0).midi;
    assert.equal(mod12(bottom), root, 'the longest string plays the root');
    assert.ok(bottom >= lowest && bottom < lowest + 12, 'roots sit in the bottom octave');
    top = Math.max(top, snapper.note(1).midi);
  }
  assert.ok(top <= lowest + 11 + 12 * Math.floor((settings.powerSteps - 1) / 2) + ((settings.powerSteps - 1) % 2 ? 7 : 0), `top note ${top}`);
  return `${checked} notes checked, highest midi ${top}`;
});

test('key guard: rock degrees kept, others held from the previous chord (synthetic progressions)', () => {
  const roots = list => list.map(n => parseChord(n).root);
  const names = rs => rs.map(r => chordName({ root: r, minor: false }));
  const am = parseChord('Am'), a = parseChord('A'), c = parseChord('C');
  assert.deepEqual(names(allowedRoots(am)), ['C', 'D', 'E', 'F', 'G', 'A']);
  assert.deepEqual(names(allowedRoots(a)), ['C', 'D', 'E', 'F', 'F#', 'G', 'A', 'B']);
  // Minor: i-bVII-bVI-V stays; a B (ii) and a C# (III) are held from the chord before.
  let out = guardRoots(roots(['Am', 'G', 'F', 'Bm', 'E', 'C#m', 'Am']), am);
  assert.deepEqual(names(out.roots), ['A', 'G', 'F', 'F', 'E', 'E', 'A']);
  assert.equal(out.replaced, 2);
  // Major: I-V-vi-IV and ii stay; iii (E in C) and a tritone root (F#) are held.
  out = guardRoots(roots(['C', 'G', 'Am', 'F', 'Dm', 'Em', 'F#', 'C']), c);
  assert.deepEqual(names(out.roots), ['C', 'G', 'A', 'F', 'D', 'D', 'D', 'C']);
  // Blues-rock in A: A-D-E-G-C all stay.
  out = guardRoots(roots(['A', 'D', 'E', 'G', 'C', 'A']), a);
  assert.equal(out.replaced, 0);
  // An out-of-key start takes the first in-key root; nothing in key at all gives the tonic.
  assert.deepEqual(names(guardRoots(roots(['C#', 'D#', 'A', 'G']), am).roots), ['A', 'A', 'A', 'G']);
  assert.deepEqual(names(guardRoots(roots(['C#', 'D#']), am).roots), ['A', 'A']);
  // No key, no guard.
  assert.deepEqual(guardRoots([1, 6, 11], null).roots, [1, 6, 11]);

  // On a song map: names are power chords, Am and A merge, the input is untouched.
  const beats = [0, 0.5, 1, 1.5, 2, 2.5];
  const analysis = { beats, duration: 3, key: am, chords: ['Am', 'A', 'G', 'Bm', 'F', 'E'].map(parseChord), segments: [] };
  const frozen = JSON.stringify(analysis);
  const guarded = powerChordAnalysis(analysis);
  assert.deepEqual(guarded.segments.map(s => s.name), ['A5', 'G5', 'F5', 'E5']);
  assert.deepEqual(guarded.segments[0].detected, ['Am', 'A']);
  assert.deepEqual(guarded.segments[1].detected, ['G', 'Bm']);
  assert.deepEqual(powerChordAnalysis(analysis, { guard: false }).segments.map(s => s.name), ['A5', 'G5', 'B5', 'F5', 'E5']);
  assert.equal(JSON.stringify(analysis), frozen);
  const map = createSongMap({ ...guarded, beatInBar: beats.map((_, i) => i % 4), bpm: 120 });
  assert.equal(map.chordAt(1.2).name, 'G5');
  assert.equal(map.nearestBeat(0.5).chordChanged, false, 'Am to A is no chord change for power chords');
});

test('distortion and ceiling curves: finite, bounded, monotonic for any drive (no NaN or infinite gain)', () => {
  for (const drive of [0, 1e-9, 0.01, 1, RHYTHM_DISTORTION.drive, 50, 1e6, NaN, Infinity, -3]) {
    const curve = distortionCurve(drive, { bias: RHYTHM_DISTORTION.bias });
    assert.ok(curve.length % 2 === 1);
    let previous = -Infinity, peak = 0;
    for (const v of curve) {
      assert.ok(Number.isFinite(v), `drive ${drive}: non-finite value`);
      assert.ok(v >= previous - 1e-7, `drive ${drive}: not monotonic`);
      previous = v; peak = Math.max(peak, Math.abs(v));
    }
    assert.ok(peak <= 1 + 1e-6 && peak > 0.99, `drive ${drive}: peak ${peak}`);
    const slope = curveSlope(curve);
    assert.ok(Number.isFinite(slope) && slope > 0, `drive ${drive}: slope ${slope}`);
    for (const x of [-10, -1, -0.3, 0, 0.3, 1, 10, Infinity, -Infinity]) assert.ok(Math.abs(shapeSample(x, curve)) <= 1 + 1e-6);
  }
  // Master ceiling: identity below the knee, never above 0.99 whatever the input.
  const ceiling = ceilingCurve();
  for (const x of [0, 0.25, 0.5, 0.89]) assert.ok(Math.abs(shapeSample(x, ceiling) - x) < 1e-3);
  for (const x of [0.95, 1, 2, 1e9, -1e9]) assert.ok(Math.abs(shapeSample(x, ceiling)) <= 0.99 + 1e-6);
  const gain = RHYTHM_DISTORTION.preGain * curveSlope(distortionCurve(RHYTHM_DISTORTION.drive, { bias: RHYTHM_DISTORTION.bias }));
  return `rhythm small-signal gain ${gain.toFixed(1)}x (${(20 * Math.log10(gain)).toFixed(1)} dB)`;
});

// Model of the electric chain up to the clipper: plucks x voice gain -> bus 0.3 -> pre-gain -> curve
// (the linear filters around it do not change how far the choked voices fall). A hard 8-string strum
// of A5 at full velocity, chord change at 0.4 s; compare the output 80-90 ms after it with the
// 20 ms before. setTargetAtTime(0, t0, tau) is v0 * exp(-(t - t0) / tau).
function chokeDrop(tone, fadeSeconds) {
  const sampleRate = 44100, t0 = Math.round(0.4 * sampleRate), length = Math.round(0.6 * sampleRate);
  const curve = distortionCurve(RHYTHM_DISTORTION.drive, { bias: RHYTHM_DISTORTION.bias });
  const tau = releaseTimeConstant(fadeSeconds, tone.releaseDepthDb) * sampleRate;
  const freqs = [110, 110, 164.81, 164.81, 220, 220, 329.63, 329.63];   // 8 strings on the A5 ladder
  const sum = new Float32Array(length);
  freqs.forEach((freq, k) => {
    const data = renderPluck({ freq, sampleRate, t60: tone.string.t60, damping: tone.string.damping, brightness: tone.string.brightness, random: seeded(17 + k) });
    const start = Math.round(k * 0.015 * sampleRate);                    // strum gap
    for (let i = start; i < length && i - start < data.length; i++) sum[i] += data[i - start];
  });
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const env = i < t0 ? 1 : Math.exp(-(i - t0) / tau);
    out[i] = shapeSample(sum[i] * env * 0.3 * RHYTHM_DISTORTION.preGain, curve);
  }
  const rms = (from, to) => Math.sqrt(out.subarray(from, to).reduce((s, v) => s + v * v, 0) / (to - from));
  const before = rms(t0 - Math.round(0.02 * sampleRate), t0);
  const db = (from, to) => 20 * Math.log10(rms(t0 + Math.round(from * sampleRate), t0 + Math.round(to * sampleRate)) / before);
  let reach = null;   // first 5 ms window at or below -40 dB
  for (let ms = 0; ms < 190 && reach === null; ms++) if (db(ms / 1000, (ms + 5) / 1000) <= -40) reach = ms + 5;
  return { drop: db(0.08, 0.09), reach };
}

test('chord-change choke: the distorted output is at least 40 dB down 80 ms after the change', () => {
  const tone = TONES.electric;
  assert.ok(tone.chordChoke <= 0.08 + 1e-9);
  const { drop, reach } = chokeDrop(tone, tone.chordChoke);
  assert.ok(drop <= -40 && reach <= 80, `only ${drop.toFixed(1)} dB`);
  // The acoustic release depth (-26 dB at the voice) would leave the distorted chord far louder.
  const naive = chokeDrop({ ...tone, releaseDepthDb: TONES.steel.releaseDepthDb }, tone.chordChoke);
  assert.ok(naive.drop > -40);
  return `-40 dB after ${reach} ms, ${drop.toFixed(1)} dB at 80-90 ms (acoustic release depth: ${naive.drop.toFixed(1)} dB)`;
});

// ---------- scoring ----------
function steadyMap(bpm = 120, bars = 8) {
  const beats = Array.from({ length: bars * 4 }, (_, i) => 1 + i * 60 / bpm);
  const names = ['C', 'G', 'Am', 'F'];
  const chords = beats.map((_, i) => parseChord(names[Math.floor(i / 4) % 4]));
  const segments = [];
  chords.forEach((chord, i) => {
    const last = segments[segments.length - 1];
    if (last && last.root === chord.root && last.minor === chord.minor) last.end = beats[i] + 0.5;
    else segments.push({ ...chord, name: names[Math.floor(i / 4) % 4], start: i ? beats[i] : 0, end: beats[i] + 0.5 });
  });
  return createSongMap({ beats, beatInBar: beats.map((_, i) => i % 4), chords, segments, duration: beats.at(-1) + 1, bpm, key: parseChord('C') });
}

test('judging windows, combo, once-per-beat, chord-change bonus, strum doubling', () => {
  const map = steadyMap();
  const scorer = createScorer(SETTINGS);
  assert.equal(scorer.hit(1.5 + 0.03, map).grade, 'perfect');            // beat 1
  assert.equal(scorer.hit(2.0 + 0.11, map).grade, 'good');               // beat 2
  assert.equal(scorer.hit(2.5 - 0.20, map).grade, null, 'off-beat scores nothing');
  assert.equal(scorer.state.combo, 2, 'off-beat does not break the combo');
  const before = scorer.state.score;
  assert.equal(scorer.hit(2.5 - 0.01, map).grade, 'perfect');
  assert.equal(scorer.hit(2.5 + 0.20, map).grade, null);
  const again = scorer.hit(2.5 + 0.36, map);                              // nearest beat is 3.0 (good window) → scores
  assert.equal(again.grade, 'good');
  assert.equal(scorer.hit(3.0 + 0.3, map).grade, null);
  // Wiggling around one beat pays once.
  const wiggle = createScorer(SETTINGS);
  wiggle.hit(1.5, map); wiggle.hit(1.5 + 0.15, map);
  assert.equal(wiggle.state.perfect + wiggle.state.good, 1);
  // Downbeat of bar 2 is a chord change (C → G) at beat index 4 = 3.0 s.
  const bonus = createScorer(SETTINGS);
  const r = bonus.hit(3.0, map);
  assert.equal(r.chordChange, true);
  assert.equal(r.points, 200);
  // Three strings within the strum window double the points of the judged hit.
  const strum = createScorer(SETTINGS);
  const a = strum.hit(1.5, map), b = strum.hit(1.515, map), c = strum.hit(1.53, map);
  assert.equal(a.points, 100); assert.equal(b.points, 0); assert.equal(c.strum, true);
  assert.equal(strum.state.score, 200);
  assert.equal(strum.state.combo, 1, 'a strum is one combo step');
  // Combo lapses quietly after comboIdleBeats.
  strum.tick(1.5 + 9 * 0.5, map);
  assert.equal(strum.state.combo, 0);
  return `score after mixed hits ${before}`;
});

// ---------- the instrument, driven by synthetic hands ----------
function mouseHand(id, point, extra = {}) {
  return { id, source: 'mouse', palm: 90, points: null, fist: false, pinching: false, fresh: false,
    tip: { ...point }, pinchPoint: { ...point }, center: { ...point }, tipSpeed: 600, ...extra };
}

function rig(settingsOverride = {}) {
  const settings = { ...SETTINGS, ...settingsOverride };
  const pitch = createPitchSnapper(settings);
  const played = [];
  const noop = () => {};
  const instrument = createAirStrings();
  instrument.init({
    settings, t: key => key, stage: { width: 1280, height: 720 }, pitch,
    fx: { burst: noop, shatter: noop, popText: noop },
    judge: () => ({ grade: null, points: 0, combo: 0 }),
    combo: () => 0,
    audio: { pluck: o => played.push(o), ringTime: () => 0.5 },
  });
  let time = 0;
  const frame = hands => { time += 1 / 60; instrument.onHands(hands, time); instrument.update(1 / 60); };
  const drag = (a, b) => {
    frame([mouseHand('mouse-anchor', a, { pinching: true }), mouseHand('mouse-drag', a, { pinching: true })]);
    frame([mouseHand('mouse-anchor', a, { pinching: true }), mouseHand('mouse-drag', b, { pinching: true })]);
    frame([mouseHand('mouse', b, { fresh: true })]);
  };
  const swipe = (from, to, steps = 4) => {
    for (let i = 0; i <= steps; i++) {
      frame([mouseHand('mouse', { x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }, { fresh: i === 0 })]);
    }
  };
  const wait = seconds => { for (let i = 0; i < seconds * 60; i++) frame([]); };
  return { instrument, pitch, played, settings, frame, drag, swipe, wait };
}

test('air strings: drag makes a string, too-short drags do not, swipe plucks it', () => {
  const { instrument, played, drag, swipe, wait } = rig();
  drag({ x: 300, y: 300 }, { x: 330, y: 300 });
  assert.equal(instrument.strings.length, 0, 'shorter than 8% of the width');
  drag({ x: 300, y: 300 }, { x: 800, y: 300 });
  assert.equal(instrument.strings.length, 1);
  assert.equal(played.length, 1, 'confirmation ding');
  wait(0.4);
  swipe({ x: 425, y: 250 }, { x: 425, y: 350 });
  assert.equal(played.length, 2);
  assert.ok(Math.abs(played[1].position - 0.25) < 0.02);
  assert.ok(played[1].velocity > 0.5);
});

test('air strings: in chord mode every pluck is a chord tone, before and after chord changes', () => {
  const { instrument, pitch, played, drag, swipe, wait } = rig();
  pitch.setChord(parseChord('C'));
  const lengths = [120, 260, 400, 560, 700, 900, 1100];
  lengths.forEach((length, i) => drag({ x: 60, y: 80 + i * 80 }, { x: 60 + length, y: 80 + i * 80 }));
  wait(0.4);
  let checked = 0;
  for (const name of ['C', 'Am', 'F', 'G', 'D#m', 'B']) {
    const chord = parseChord(name);
    pitch.setChord(chord);
    instrument.onChordChange(chord);
    played.length = 0;
    swipe({ x: 100, y: 40 }, { x: 100, y: 680 }, 12);
    wait(0.3);
    assert.equal(played.length, lengths.length, `${name}: all strings sounded`);
    for (const voice of played) {
      const midi = Math.round(69 + 12 * Math.log2(voice.freq / 440));
      assert.ok(chordPitchClasses(chord).includes(mod12(midi)), `${name}: got pitch class ${mod12(midi)}`);
      checked++;
    }
    const freqs = played.map(v => v.freq);
    assert.deepEqual(freqs, [...freqs].sort((a, b) => b - a), 'longer strings sound lower');
  }
  return `${checked} plucks checked`;
});

test('air strings: cooldown, pinching hands cannot pluck, max strings, delete command', () => {
  const { instrument, played, settings, frame, drag, swipe, wait } = rig();
  drag({ x: 200, y: 300 }, { x: 800, y: 300 });
  wait(0.4);
  played.length = 0;
  swipe({ x: 500, y: 280 }, { x: 500, y: 320 }, 1);
  swipe({ x: 500, y: 320 }, { x: 500, y: 280 }, 1);       // back within 120 ms
  assert.equal(played.length, 1, 'cooldown');
  wait(0.3);
  played.length = 0;
  // A pinching hand sweeping across the string while stretching a new one must not pluck.
  for (let y = 200; y <= 420; y += 20) {
    frame([mouseHand('mouse-anchor', { x: 100, y: 500 }, { pinching: true }), mouseHand('mouse-drag', { x: 500, y }, { pinching: true })]);
  }
  assert.equal(played.length, 0);
  frame([mouseHand('mouse', { x: 500, y: 420 }, { fresh: true })]);
  assert.equal(instrument.strings.length, 2);
  for (let i = 0; i < 10; i++) drag({ x: 100, y: 40 + i * 12 }, { x: 600, y: 40 + i * 12 });
  wait(1);
  assert.equal(instrument.strings.length, settings.maxStrings);
  const count = instrument.strings.length;
  const target = instrument.strings[0];
  instrument.onCommand({ type: 'deleteAt', x: (target.a.x + target.b.x) / 2, y: target.a.y + 3 });
  assert.equal(instrument.strings.length, count - 1);
});

test('air strings: a fist held on a string deletes it, two fists clear everything', () => {
  const { instrument, frame, drag, wait } = rig();
  drag({ x: 200, y: 300 }, { x: 800, y: 300 });
  drag({ x: 200, y: 500 }, { x: 800, y: 500 });
  wait(0.3);
  const fist = (id, x, y) => ({ ...mouseHand(id, { x, y }), source: 'camera', fist: true });
  for (let i = 0; i < 30; i++) frame([fist('a', 500, 310)]);            // 0.5 s: not yet
  assert.equal(instrument.strings.length, 2);
  for (let i = 0; i < 24; i++) frame([fist('a', 500, 310)]);            // 0.9 s total
  assert.equal(instrument.strings.length, 1);
  drag({ x: 200, y: 300 }, { x: 800, y: 300 });
  for (let i = 0; i < 50; i++) frame([fist('a', 100, 100), fist('b', 900, 100)]);
  assert.equal(instrument.strings.length, 2, 'two fists for 0.83 s: not yet');
  for (let i = 0; i < 15; i++) frame([fist('a', 100, 100), fist('b', 900, 100)]);
  assert.equal(instrument.strings.length, 0);
});

test('air strings: camera hands get a release grace while stretching', () => {
  const { instrument, frame } = rig();
  const cam = (id, x, pinching) => ({ ...mouseHand(id, { x, y: 300 }, { pinching }), source: 'camera' });
  frame([cam('L', 200, true), cam('R', 700, true)]);
  for (let i = 0; i < 5; i++) frame([cam('L', 200, true), cam('R', 700, false)]);   // 83 ms flicker
  assert.equal(instrument.strings.length, 0);
  assert.equal(instrument.drafting, true);
  frame([cam('L', 200, true), cam('R', 760, true)]);
  for (let i = 0; i < 12; i++) frame([cam('L', 200, false), cam('R', 760, false)]); // 200 ms: released
  assert.equal(instrument.strings.length, 1);
  assert.equal(instrument.strings[0].b.x, 760);
});

console.table(results);
const failed = results.filter(r => r.result === 'FAIL').length;
if (failed) { console.error(`${failed} test(s) failed`); process.exit(1); }
console.log('instrument tests passed');
