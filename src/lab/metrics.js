// Tone lab measurements (docs/效果器_設計挑戰.md 4.3). Pure and renderer-agnostic: a renderer turns
// { tone, events, chokes, duration, song?, master?, strings? } into { sampleRate, left, right,
// limiterDb? }. tools/tone-lab/model.mjs renders in Node; src/lab/offline-render.js renders the real
// Web Audio graph in an OfflineAudioContext. Same definitions on both sides.
import { renderPluck } from '../core/audio/karplus.js';
import { voiceParams } from '../core/audio/voice-params.js';
import { stagesResponse, driveDb, deepestNotchDb } from '../core/audio/stages.js';
import { createFFT } from '../core/analysis/dsp.js';
import { midiToFreq } from '../core/music/theory.js';

// A5 power chord on the power-chord ladder from E2 (src/core/music/power-chords.js): A2 E3 A3 E4 A4.
export const A5 = [45, 52, 57, 64, 69].map(midiToFreq);
// 8 strings on 5 steps (neighbouring strings double a note, as tests/instrument.test.mjs does).
export const A5_EIGHT = [A5[0], A5[0], A5[1], A5[1], A5[2], A5[2], A5[3], A5[3]];
// Reference acceptance targets from the challenge doc 4.3.
export const TARGETS = {
  levelDrop: 6, velocitySpread: 4, secondHarmonic: -10, lowShare: 15, boosterNotch: 3,
  chokeDepth: 40, peak: 0.99, limiter: 3,
};

const db = x => 20 * Math.log10(Math.max(1e-12, x));

/** One strum: strings low → high (a downstroke), strumGap apart, one key per string. */
export function strum(freqs, { time = 0, velocity = 0.6, position = 0.5, gap = 0.015, up = false } = {}) {
  const order = freqs.map((freq, i) => ({ freq, i }));
  if (up) order.reverse();
  return order.map(({ freq, i }, k) => ({ time: time + k * gap, freq, velocity, position, key: `s${i}` }));
}

/** Eighth-note downstrokes of a chord for `seconds` at `bpm`. */
export function chug(freqs, { bpm = 105, seconds = 16, velocity = 0.6, position = 0.5, gap = 0.015 } = {}) {
  const step = 30 / bpm;
  const events = [];
  for (let t = 0; t < seconds - 1e-9; t += step) events.push(...strum(freqs, { time: t, velocity, position, gap }));
  return events;
}

// RMS of both channels in [from, to) seconds.
export function rms({ sampleRate, left, right }, from = 0, to = Infinity) {
  const a = Math.max(0, Math.round(from * sampleRate)), b = Math.min(left.length, Math.round(to * sampleRate));
  let sum = 0;
  for (let i = a; i < b; i++) sum += left[i] * left[i] + right[i] * right[i];
  return Math.sqrt(sum / Math.max(1, 2 * (b - a)));
}
// Level (dB) in a 20 ms window centred on t.
export const levelAt = (out, t, half = 0.01) => db(rms(out, t - half, t + half));
export function peakOf({ left, right }) {
  let peak = 0;
  for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  return peak;
}

// Welch power spectrum of the mid signal: { bin (Hz per bin), power: Float64Array }.
export function powerSpectrum({ sampleRate, left, right }, size = 8192) {
  const fft = createFFT(size);
  const re = new Float32Array(size), im = new Float32Array(size), power = new Float64Array(size / 2);
  const hann = i => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size);
  for (let start = 0; start + size <= left.length; start += size / 2) {
    for (let i = 0; i < size; i++) { re[i] = 0.5 * (left[start + i] + right[start + i]) * hann(i); im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < size / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
  }
  return { bin: sampleRate / size, power };
}
export function bandShare(spectrum, lo, hi, totalLo = 20, totalHi = 20000) {
  let band = 0, total = 0;
  spectrum.power.forEach((p, k) => {
    const f = k * spectrum.bin;
    if (f >= totalLo && f < totalHi) total += p;
    if (f >= lo && f < hi) band += p;
  });
  return total > 0 ? band / total : 0;
}

/**
 * 2nd harmonic relative to the fundamental (dB) of the Karplus source alone, for a pluck crossed at
 * `position`, averaged over `repeats` noise seeds. Renderer-independent.
 */
export function secondHarmonicDb(tone, settings, { freq = A5[0], position = 0.5, velocity = 0.6, sampleRate = 48000, repeats = 8, random = Math.random } = {}) {
  const size = 16384, fft = createFFT(size);
  const { render } = voiceParams(tone, { freq, velocity, position }, settings);
  let h1 = 0, h2 = 0;
  const peakNear = (mag, f) => {
    const k = Math.round(f * size / sampleRate);
    let best = 0;
    for (let j = k - 3; j <= k + 3; j++) best = Math.max(best, mag[j]);
    return best;
  };
  for (let r = 0; r < repeats; r++) {
    const data = renderPluck({ ...render, sampleRate, random });
    const re = new Float32Array(size), im = new Float32Array(size);
    const from = Math.round(0.05 * sampleRate);
    for (let i = 0; i < size && from + i < data.length; i++) re[i] = data[from + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / size));
    fft(re, im);
    const mag = new Float64Array(size / 2);
    for (let k = 0; k < size / 2; k++) mag[k] = re[k] * re[k] + im[k] * im[k];
    h1 += peakNear(mag, render.freq);
    h2 += peakNear(mag, 2 * render.freq);
  }
  return 10 * Math.log10(h2 / h1);
}

/** Small-signal response of a stage list, 100 Hz – 5 kHz (dB), and its deepest notch. */
export function responseNotch(stages, sampleRate = 48000) {
  const freqs = [];
  for (let f = 100; f <= 5000; f *= Math.pow(2, 1 / 24)) freqs.push(f);
  const dbs = stagesResponse(stages, freqs, sampleRate).map(db);
  return { freqs, dbs, notch: deepestNotchDb(dbs) };
}

/**
 * All metrics for one tone. `song` (optional) is { left, right, sampleRate } of a song section at
 * the renderer's sample rate, used for the mix metrics; without it those are skipped.
 * @param {object} o
 * @param {(spec) => Promise<object>} o.render
 * @param tone
 * @param settings
 * @param {{ left, right, sampleRate } | null} [o.song]
 * @param {number} [o.repeats]    strums averaged per level metric
 * @param {number} [o.mixSeconds] length of the mix render
 * @param {number} [o.bpm]        tempo of the eighth-note strumming for the mix metrics
 * @param {object} [o.booster]    the tone's booster stages, if any (for the notch check)
 */
export async function measureTone({ render, tone, settings, song = null, repeats = 6, mixSeconds = 16, bpm = 105, booster = null, random = Math.random }) {
  const result = { drive: driveDb(tone.stages ?? []), releaseDepthDb: tone.releaseDepthDb };
  const four = A5.slice(0, 4);
  const mean = values => values.reduce((s, v) => s + v, 0) / values.length;

  // 1. Level drop 0.03 → 0.5 s: one 4-string strum at velocity 0.3, crossing the middle.
  const drops = [], quiet = [], loud = [], sustains = [];
  for (let r = 0; r < repeats; r++) {
    const out = await render({ tone, events: strum(four, { velocity: 0.3 }), duration: 0.7 });
    drops.push(levelAt(out, 0.03) - levelAt(out, 0.5));
  }
  result.levelDrop = mean(drops);

  // 2. Velocity 0.1 vs 1.0 at 0.25 s.
  for (let r = 0; r < repeats; r++) {
    quiet.push(levelAt(await render({ tone, events: strum(four, { velocity: 0.1 }), duration: 0.4 }), 0.25));
    loud.push(levelAt(await render({ tone, events: strum(four, { velocity: 1 }), duration: 0.4 }), 0.25));
  }
  result.velocitySpread = mean(loud) - mean(quiet);

  // 3. Second harmonic across crossing positions (worst one).
  result.secondHarmonic = {};
  for (const position of [0.5, 0.4, 0.3, 0.2, 0.1]) {
    result.secondHarmonic[position] = secondHarmonicDb(tone, settings, { position, random });
  }
  result.secondHarmonicWorst = Math.min(...Object.values(result.secondHarmonic));

  // 4. Chord-change choke at max drive: 8 strings, full velocity, chord change at 0.4 s, nothing
  //    kept; output 80–90 ms after vs the 20 ms before. Plus the strum choke (all voices, its fade).
  const hard = strum(A5_EIGHT, { velocity: 1 });
  const chokeDrops = [], strumDrops = [];
  for (let r = 0; r < Math.max(2, repeats / 2); r++) {
    const out = await render({ tone, events: hard, chokes: [{ time: 0.4, keep: [] }], duration: 0.6 });
    chokeDrops.push(db(rms(out, 0.48, 0.49) / rms(out, 0.38, 0.4)));
    if (tone.strumChoke) {
      const s = await render({ tone, events: hard, chokes: [{ time: 0.4, all: true, fade: tone.strumChoke }], duration: 0.6 });
      strumDrops.push(db(rms(s, 0.4 + tone.strumChoke, 0.41 + tone.strumChoke) / rms(s, 0.38, 0.4)));
    }
  }
  result.chokeDepth = -mean(chokeDrops);
  result.strumChokeDepth = strumDrops.length ? -mean(strumDrops) : null;

  // 5. Sustain: one 4-string strum at velocity 0.6; time until the output is 10 (and 20) dB below
  //    its loudest point in the first 0.3 s.
  const sustains20 = [];
  for (let r = 0; r < Math.max(2, repeats / 2); r++) {
    const out = await render({ tone, events: strum(four, { velocity: 0.6 }), duration: 6.5 });
    let ref = -Infinity;
    for (let t = 0.05; t <= 0.3; t += 0.01) ref = Math.max(ref, levelAt(out, t, 0.025));
    const below = drop => {
      for (let t = 0.1; t < 6.45; t += 0.01) if (levelAt(out, t, 0.025) < ref - drop) return t;
      return 6.45;
    };
    sustains.push(below(10));
    sustains20.push(below(20));
  }
  result.sustain = mean(sustains);
  result.sustain20 = mean(sustains20);

  // 6. Eighth-note A5 4-string strumming at medium velocity: low-band share at the chain output,
  //    then against the song through the master bus: guitar vs song RMS, peak, limiter reduction.
  const chugEvents = chug(four, { bpm, seconds: mixSeconds, velocity: 0.6 });
  const chain = await render({ tone, events: chugEvents, duration: mixSeconds });
  result.lowShare = 100 * bandShare(powerSpectrum(chain), 60, 300);
  if (song) {
    const guitar = await render({ tone, events: chugEvents, duration: mixSeconds, master: true });
    const songAlone = await render({ tone, events: [], duration: mixSeconds, song, master: true, strings: false });
    const mix = await render({ tone, events: chugEvents, duration: mixSeconds, song, master: true });
    result.guitarVsSong = db(rms(guitar, 1) / rms(songAlone, 1));
    result.peak = peakOf(mix);
    result.limiterDb = mix.limiterDb ?? null;
    // The same mix with the guitar trimmed to the song's RMS, as the lab plays it.
    const trim = Math.pow(10, -result.guitarVsSong / 20);
    const matched = await render({ tone, events: chugEvents, duration: mixSeconds, song, master: true, trim });
    result.matched = { trim, peak: peakOf(matched), limiterDb: matched.limiterDb ?? null };
  }

  // 7. Booster small-signal response: deepest notch 100 Hz – 5 kHz.
  if (booster) result.boosterNotch = responseNotch(booster).notch;
  return result;
}
