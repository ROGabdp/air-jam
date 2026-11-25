// Song analysis: beat grid, per-beat chords and key from a mono signal.
// Pure computation (Float32Array + sampleRate in, plain data out) so it runs in Node tests,
// on the main thread in slices, or in a worker.
import { decimateSteps, stft } from './dsp.js';
import { chordName } from '../music/theory.js';

export const ANALYSIS = {
  rate: 11025,
  onsetSize: 1024,
  onsetHop: 256,
  // Where inside an analysis frame a rising onset is registered (calibrated in tests/analysis.test.mjs).
  onsetCenter: 0.58,
  chromaSize: 4096,
  chromaHop: 512,
  chromaMinHz: 55,
  chromaMaxHz: 2000,
  overtoneSuppression: 0.7,
  overtoneTolerance: 0.02,
  minBpm: 70,
  maxBpm: 180,
  tempoPrior: 110,
  bassMaxHz: 180,
  doubleTempoRatio: 0.5,
  doubleTempoMinSupport: 0.25,
  doubleTempoBassSupport: 0.3,
  tightness: 100,
  chordChangePenalty: 0.25,
  silenceRatio: 0.05,
};

// Subtract the local mean, half-wave rectify and scale to unit RMS.
function normaliseEnvelope(flux) {
  const n = flux.length;
  const env = new Float32Array(n);
  const half = 16;
  let running = 0;
  for (let j = 0; j <= Math.min(n - 1, half); j++) running += flux[j];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
    env[i] = Math.max(0, flux[i] - running / (hi - lo + 1));
    total += env[i] * env[i];
    if (i + half + 1 < n) running += flux[i + half + 1];
    if (i - half >= 0) running -= flux[i - half];
  }
  const std = Math.sqrt(total / Math.max(1, n));
  if (std > 1e-9) for (let i = 0; i < n; i++) env[i] /= std;
  return env;
}

// Spectral-flux onset strength, full band plus a bass band (used to settle tempo octave).
function* onsetEnvelopes(x, sampleRate) {
  const flux = [], lowFlux = [];
  const lowBins = Math.ceil(ANALYSIS.bassMaxHz * ANALYSIS.onsetSize / sampleRate);
  let prev = null;
  yield* stft(x, ANALYSIS.onsetSize, ANALYSIS.onsetHop, mag => {
    const cur = new Float32Array(mag.length);
    let sum = 0, low = 0;
    for (let k = 0; k < mag.length; k++) {
      cur[k] = Math.log1p(mag[k]);
      if (prev && cur[k] > prev[k]) {
        sum += cur[k] - prev[k];
        if (k <= lowBins) low += cur[k] - prev[k];
      }
    }
    prev = cur;
    flux.push(sum);
    lowFlux.push(low);
  });
  return { env: normaliseEnvelope(flux), bassEnv: normaliseEnvelope(lowFlux) };
}

function autocorrelation(env, maxLag) {
  const n = env.length;
  const acf = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag && lag < n; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += env[i] * env[i + lag];
    acf[lag] = sum / (n - lag);
  }
  return acf;
}

// Beat period in envelope frames, from the autocorrelation of the onset envelope.
export function estimatePeriod(env, framesPerSecond, bassEnv = null) {
  const n = env.length;
  const minLag = Math.ceil(framesPerSecond * 60 / ANALYSIS.maxBpm);
  const maxLag = Math.ceil(framesPerSecond * 60 / ANALYSIS.minBpm);
  const acf = autocorrelation(env, maxLag * 4 + 8);
  const prior = lag => {
    const octaves = Math.log2(60 * framesPerSecond / lag / ANALYSIS.tempoPrior);
    return Math.exp(-0.5 * (octaves / 0.9) ** 2);
  };
  const localMax = (center, reach) => {
    let best = Math.round(center);
    const lo = Math.max(2, Math.round(center) - reach), hi = Math.min(acf.length - 2, Math.round(center) + reach);
    for (let l = lo; l <= hi; l++) if (acf[l] > acf[best]) best = l;
    return best;
  };
  const refine = (center, reach) => {
    const best = localMax(center, reach);
    const a = acf[best - 1], b = acf[best], c = acf[best + 1];
    const denom = a - 2 * b + c;
    return best + (denom < 0 ? 0.5 * (a - c) / denom : 0);
  };

  let bestLag = minLag, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const score = (acf[lag] + 0.5 * acf[lag * 2] + 0.33 * acf[lag * 3] + 0.25 * acf[lag * 4]) * prior(lag);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  // Octave check. Kick/snare alternation makes the two-beat lag stronger than the beat lag, so the
  // search above often lands on half tempo; eighth-note melodies or hi-hats pull the other way.
  // Bass and kick rarely move faster than the beat, so the bass-band envelope arbitrates.
  const halfLag = Math.round(bestLag / 2);
  if (halfLag >= minLag) {
    const candidate = localMax(halfLag, 1);
    let bassSupport = null;
    if (bassEnv) {
      const bassAcf = autocorrelation(bassEnv, bestLag + 2);
      const peak = lag => Math.max(bassAcf[lag - 1], bassAcf[lag], bassAcf[lag + 1]);
      if (peak(bestLag) > 0.05) bassSupport = peak(candidate) / peak(bestLag);
    }
    const support = acf[candidate] / acf[bestLag];
    const faster = bassSupport === null
      ? support * prior(candidate) > ANALYSIS.doubleTempoRatio * prior(bestLag)
      : support > ANALYSIS.doubleTempoMinSupport && bassSupport > ANALYSIS.doubleTempoBassSupport;
    if (faster) bestLag = candidate;
  }
  let period = refine(bestLag, 3);
  if (period * 4 + 4 < Math.min(n, acf.length - 2)) period = refine(period * 4, 3) / 4;
  return period;
}

// Dynamic-programming beat tracker (Ellis 2007): beats land on onsets while keeping a steady period.
export function trackBeats(env, period) {
  const n = env.length;
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const nearest = Math.max(1, Math.round(period / 2));
  const farthest = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = 0, bestPrev = -1;
    for (let p = Math.max(0, t - farthest); p <= t - nearest; p++) {
      const gap = Math.log((t - p) / period);
      const s = score[p] - ANALYSIS.tightness * gap * gap;
      if (s > best) { best = s; bestPrev = p; }
    }
    score[t] = env[t] + best;
    back[t] = bestPrev;
  }
  let end = n - 1;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (score[t] > score[end]) end = t;
  const beats = [];
  for (let t = end; t >= 0; t = back[t]) beats.push(t);
  return beats.reverse();
}

// Local linear regression over neighbouring beats removes frame-quantisation jitter.
function smoothBeats(times, reach = 4) {
  return times.map((time, i) => {
    const a = Math.max(0, i - reach), b = Math.min(times.length - 1, i + reach);
    const m = b - a + 1;
    if (m < 3) return time;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let j = a; j <= b; j++) { sx += j; sy += times[j]; sxx += j * j; sxy += j * times[j]; }
    const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx);
    return (sy - slope * sx) / m + slope * i;
  });
}

// Peak-picked chroma. The 3rd and 5th partials of one loud note (a held vocal, a lead line) land on
// its fifth and major third, so a single note looks like a major triad. A partial is therefore
// down-weighted when a peak at least as strong sits at a third or a fifth of its frequency.
function* chromaFrames(x, sampleRate) {
  const size = ANALYSIS.chromaSize;
  const frames = [];
  const binHz = sampleRate / size;
  const kMin = Math.max(2, Math.ceil(ANALYSIS.chromaMinHz / binHz));
  const kMax = Math.min(size / 2 - 2, Math.floor(ANALYSIS.chromaMaxHz / binHz));
  const peakHz = new Float32Array(size / 2);    // interpolated frequency of the peak in bin k, 0 if none
  const peakMag = new Float32Array(size / 2);
  const peaks = [];
  const hasFundamental = (hz, mag, ratio) => {
    const center = Math.round(hz / ratio / binHz);
    for (let k = Math.max(2, center - 1); k <= center + 1; k++) {
      if (peakMag[k] >= mag && Math.abs(peakHz[k] * ratio / hz - 1) < ANALYSIS.overtoneTolerance) return true;
    }
    return false;
  };
  yield* stft(x, size, ANALYSIS.chromaHop, mag => {
    const chroma = new Float32Array(12);
    for (const k of peaks) { peakHz[k] = 0; peakMag[k] = 0; }
    peaks.length = 0;
    for (let k = 2; k <= kMax; k++) {
      // Spectral peaks only, with parabolic interpolation, so a partial lands in one pitch class.
      if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) {
        const a = mag[k - 1], b = mag[k], c = mag[k + 1];
        const shift = 0.5 * (a - c) / (a - 2 * b + c || 1);
        peakHz[k] = (k + shift) * binHz;
        peakMag[k] = b;
        peaks.push(k);
      }
    }
    for (const k of peaks) {
      if (k < kMin) continue;
      const hz = peakHz[k], m = peakMag[k];
      const overtone = hasFundamental(hz, m, 3) || hasFundamental(hz, m, 5);
      const midi = 69 + 12 * Math.log2(hz / 440);
      chroma[((Math.round(midi) % 12) + 12) % 12] += overtone ? m * (1 - ANALYSIS.overtoneSuppression) : m;
    }
    frames.push(chroma);
  });
  return frames;
}

const TEMPLATES = Array.from({ length: 24 }, (_, i) => {
  const root = i % 12, minor = i >= 12;
  const t = new Float32Array(12);
  t[root] = 1;
  t[(root + (minor ? 3 : 4)) % 12] = 1;
  t[(root + 7) % 12] = 1;
  return t;
});

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < 12; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

// Viterbi over 24 chords; changing chord costs less on the downbeat and most on beats 2 and 4.
function smoothChords(scores, beatInBar, penalty) {
  const n = scores.length;
  if (n === 0) return [];
  let prev = Float32Array.from(scores[0]);
  const links = [];
  for (let b = 1; b < n; b++) {
    let bestPrev = 0;
    for (let c = 1; c < 24; c++) if (prev[c] > prev[bestPrev]) bestPrev = c;
    const cost = penalty * (beatInBar[b] === 0 ? 0.5 : beatInBar[b] === 2 ? 1 : 1.5);
    const cur = new Float32Array(24);
    const link = new Int8Array(24);
    for (let c = 0; c < 24; c++) {
      if (prev[c] >= prev[bestPrev] - cost) { cur[c] = prev[c] + scores[b][c]; link[c] = c; }
      else { cur[c] = prev[bestPrev] - cost + scores[b][c]; link[c] = bestPrev; }
    }
    links.push(link);
    prev = cur;
  }
  let state = 0;
  for (let c = 1; c < 24; c++) if (prev[c] > prev[state]) state = c;
  const path = new Array(n);
  path[n - 1] = state;
  for (let b = n - 1; b > 0; b--) { state = links[b - 1][state]; path[b - 1] = state; }
  return path;
}

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Krumhansl-Schmuckler key estimate from a summed chroma vector.
export function estimateKey(totalChroma) {
  let mean = 0;
  for (let i = 0; i < 12; i++) mean += totalChroma[i] / 12;
  const correlation = (profile, root) => {
    let profileMean = 0;
    for (let i = 0; i < 12; i++) profileMean += profile[i] / 12;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < 12; i++) {
      const dx = totalChroma[(i + root) % 12] - mean, dy = profile[i] - profileMean;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    return sxx > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  };
  let best = { root: 0, minor: false }, bestScore = -Infinity;
  for (let root = 0; root < 12; root++) {
    for (const minor of [false, true]) {
      const s = correlation(minor ? MINOR_PROFILE : MAJOR_PROFILE, root);
      if (s > bestScore) { bestScore = s; best = { root, minor }; }
    }
  }
  return best;
}

// Generator form: yields progress (0..1) and returns the analysis result.
export function* analyzeSteps(samples, sampleRate) {
  const duration = samples.length / sampleRate;
  const decimation = decimateSteps(samples, sampleRate, ANALYSIS.rate);
  let step;
  while (!(step = decimation.next()).done) yield 0.04 * step.value;
  const { samples: x, sampleRate: sr } = step.value;
  yield 0.04;

  const envSteps = onsetEnvelopes(x, sr);
  while (!(step = envSteps.next()).done) yield 0.04 + 0.36 * step.value;
  const { env, bassEnv } = step.value;

  const framesPerSecond = sr / ANALYSIS.onsetHop;
  const period = estimatePeriod(env, framesPerSecond, bassEnv);
  yield 0.44;
  const frameTime = f => (f * ANALYSIS.onsetHop + ANALYSIS.onsetSize * ANALYSIS.onsetCenter) / sr;
  const beats = smoothBeats(trackBeats(env, period).map(frameTime));
  if (beats.length < 8) throw new Error('not enough beats');
  const bpm = 60 * (beats.length - 1) / (beats[beats.length - 1] - beats[0]);
  yield 0.5;

  // Quiet intros and outros have no onsets; continue the grid at the same spacing.
  const firstGap = beats[1] - beats[0];
  while (beats[0] - firstGap >= 0) beats.unshift(beats[0] - firstGap);
  const lastGap = beats[beats.length - 1] - beats[beats.length - 2];
  while (beats[beats.length - 1] + lastGap <= duration) beats.push(beats[beats.length - 1] + lastGap);

  const chromaSteps = chromaFrames(x, sr);
  while (!(step = chromaSteps.next()).done) yield 0.5 + 0.46 * step.value;
  const frames = step.value;

  const n = beats.length;
  const beatChroma = [];
  const total = new Float32Array(12);
  const energy = new Float32Array(n);
  let loudest = 0;
  for (let b = 0; b < n; b++) {
    const start = beats[b];
    const end = b + 1 < n ? beats[b + 1] : duration;
    const chroma = new Float32Array(12);
    const first = Math.max(0, Math.ceil((start * sr - ANALYSIS.chromaSize / 2) / ANALYSIS.chromaHop));
    for (let f = first; f < frames.length; f++) {
      if ((f * ANALYSIS.chromaHop + ANALYSIS.chromaSize / 2) / sr >= end) break;
      for (let i = 0; i < 12; i++) chroma[i] += frames[f][i];
    }
    for (let i = 0; i < 12; i++) { total[i] += chroma[i]; energy[b] += chroma[i]; }
    if (energy[b] > loudest) loudest = energy[b];
    beatChroma.push(chroma);
  }
  const audible = b => energy[b] >= loudest * ANALYSIS.silenceRatio;

  // Bar phase: chords mostly change on the downbeat, so pick the phase with the largest harmonic change.
  const change = [0, 0, 0, 0];
  for (let b = 1; b < n; b++) {
    if (audible(b) && audible(b - 1)) change[b % 4] += 1 - cosine(beatChroma[b], beatChroma[b - 1]);
  }
  const phase = change.indexOf(Math.max(...change));
  const beatInBar = beats.map((_, b) => (((b - phase) % 4) + 4) % 4);

  const scores = beatChroma.map((chroma, b) => {
    const row = new Float32Array(24);
    if (audible(b)) for (let c = 0; c < 24; c++) row[c] = cosine(chroma, TEMPLATES[c]);
    return row;
  });
  const chords = smoothChords(scores, beatInBar, ANALYSIS.chordChangePenalty)
    .map(c => ({ root: c % 12, minor: c >= 12 }));

  const segments = [];
  for (let b = 0; b < n; b++) {
    const last = segments[segments.length - 1];
    const end = b + 1 < n ? beats[b + 1] : duration;
    if (last && last.root === chords[b].root && last.minor === chords[b].minor) last.end = end;
    else segments.push({ start: b === 0 ? 0 : beats[b], end, ...chords[b], name: chordName(chords[b]) });
  }

  yield 1;
  return { duration, bpm, beats, beatInBar, chords, segments, key: estimateKey(total) };
}

export function analyzeSync(samples, sampleRate) {
  const steps = analyzeSteps(samples, sampleRate);
  let step;
  while (!(step = steps.next()).done);
  return step.value;
}

// Runs the generator in time slices so the UI stays responsive.
export async function analyzeAsync(samples, sampleRate, onProgress, sliceMs = 20) {
  const steps = analyzeSteps(samples, sampleRate);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  for (;;) {
    const sliceEnd = now() + sliceMs;
    let step;
    do {
      step = steps.next();
      if (step.done) { onProgress?.(1); return step.value; }
    } while (now() < sliceEnd);
    onProgress?.(step.value);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}
