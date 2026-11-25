// Karplus-Strong plucked string, rendered offline into Float32Arrays (pure, testable in Node).
// createPluck renders a string in pieces (the engine plays the first part right away and renders
// the rest later, see engine.js); renderPluck renders it in one go. Both give the same samples.

// The output is normalised by its peak within this window. The peak is always in the first period or
// two (checked over 270 plucks per tone: never after 50 ms), so this equals the whole-buffer peak,
// but a renderer can normalise before it has rendered the tail.
export const PEAK_WINDOW_SECONDS = 0.1;

/**
 * The 延音 (sustain) knob: a sustainer (compressor with make-up gain) on each string's own signal,
 * before the voice gain, so the pick attack passes untouched and the ring that follows is pulled up
 * towards it. Below the threshold the gain is (1 − 1/ratio)·(threshold − envelope) dB, so the decay in
 * dB slows by `ratio`, until the make-up gain reaches its maximum and the string decays naturally
 * again. Knob s (0..1): ratio 1 + (maxRatio − 1)·s, make-up up to maxMakeupDb·s; 0 = off.
 * Envelope: peak follower (attack/release time constants) on the normalised string, updated once
 * per `block` samples from the block's peak; the gain is recomputed then and ramped across the block.
 */
export const SUSTAINER = { maxRatio: 6, maxMakeupDb: 30, thresholdDb: -6, attackMs: 2, releaseMs: 80, block: 32 };
const NATURAL_DB = 54;   // a pluck is cut where its fundamental is 54 dB down (0.9·t60)

/** Ratio and make-up ceiling (dB) for a sustain knob value 0..1. */
export function sustainerSettings(sustain) {
  const s = Math.max(0, Math.min(1, Number.isFinite(sustain) ? sustain : 0));
  return { ratio: 1 + (SUSTAINER.maxRatio - 1) * s, makeupDb: SUSTAINER.maxMakeupDb * s };
}

/** How much longer a pluck is rendered with this sustain (the make-up keeps its end audible). */
export const sustainStretch = sustain => 1 + sustainerSettings(sustain).makeupDb / NATURAL_DB;

/**
 * @param {object} o
 * @param {number} o.freq          fundamental in Hz
 * @param {number} o.sampleRate
 * @param {number} o.t60           seconds for the fundamental to decay by 60 dB
 * @param {number} o.brightness    0..1 low-pass applied to the excitation (1 = raw noise)
 * @param {number} o.pickPosition  0..0.5 distance from the nearer end; shapes the excitation with a comb
 * @param {number} o.damping       0..0.5 loop filter mix; higher loses treble faster
 * @param {number} [o.maxSeconds]
 * @param {number} [o.sustain]     0..1 the sustainer (SUSTAINER; 0 = off, the plain string)
 * @param {() => number} [o.random]
 * @returns {{ length: number, rendered: number, next(count: number): Float32Array }}
 *          next() returns the following `count` samples (fewer at the end, empty when done)
 */
export function createPluck({
  freq, sampleRate, t60 = 3, brightness = 0.6, pickPosition = 0.5, damping = 0.5,
  maxSeconds = 3, sustain = 0, random = Math.random,
}) {
  const period = sampleRate / freq;
  const stretch = sustain > 0 ? sustainStretch(sustain) : 1;
  const seconds = Math.min(maxSeconds * stretch, Math.max(0.35, t60 * 0.9 * stretch));
  const length = Math.floor(seconds * sampleRate);

  // Loop delay = integer line + loop filter delay (about `damping` samples) + all-pass fraction.
  let whole = Math.floor(period - damping - 0.1);
  let fraction = period - damping - whole;
  if (whole < 2) { whole = 2; fraction = 0.5; }
  const allpass = (1 - fraction) / (1 + fraction);
  const loopGain = Math.pow(10, -3 / (freq * t60));

  // Excitation: one period of noise, low-passed by brightness and combed by pick position.
  const burst = new Float32Array(whole);
  let smooth = 0, mean = 0;
  const cutoff = 0.06 + 0.94 * brightness * brightness;
  for (let i = 0; i < whole; i++) {
    smooth += cutoff * ((random() * 2 - 1) - smooth);
    burst[i] = smooth;
    mean += smooth / whole;
  }
  const comb = Math.max(1, Math.round(whole * Math.min(pickPosition, 1 - pickPosition)));
  const line = new Float32Array(whole);
  let peak = 1e-9;
  for (let i = 0; i < whole; i++) {
    line[i] = (burst[i] - mean) - 0.9 * (burst[(i - comb + whole) % whole] - mean);
    if (Math.abs(line[i]) > peak) peak = Math.abs(line[i]);
  }
  for (let i = 0; i < whole; i++) line[i] /= peak;

  const attack = Math.min(length, Math.floor(sampleRate * 0.0015));
  const fade = Math.min(length, Math.floor(sampleRate * 0.12));
  const window = Math.min(length, Math.ceil(sampleRate * PEAK_WINDOW_SECONDS));
  let index = 0, previous = 0, apIn = 0, apOut = 0, position = 0, scale = 0;

  // Sustainer state (carried across next() calls, so pieces equal one whole render). Per block:
  // the envelope follows the previous block's peak, then the gain ramps to its new value.
  const comp = sustain > 0 ? sustainerSettings(sustain) : null;
  const block = SUSTAINER.block;
  const envAttack = 1 - Math.exp(-block / (SUSTAINER.attackMs * 1e-3 * sampleRate));
  const envRelease = 1 - Math.exp(-block / (SUSTAINER.releaseMs * 1e-3 * sampleRate));
  const slope = comp ? 1 - 1 / comp.ratio : 0;
  let env = 1, blockPeak = 0, gain = 1, gainStep = 0;   // env starts at the normalised peak: no boost on the attack
  // Also applies the normalisation (one pass over the samples instead of two).
  function sustainer(out, n) {
    let e = env, bp = blockPeak, g = gain, step = gainStep, k = 0;
    const sc = scale, at = position, threshold = SUSTAINER.thresholdDb, ceiling = comp.makeupDb;
    while (k < n) {
      const into = (at + k) % block;
      if (into === 0) {
        e += (bp > e ? envAttack : envRelease) * (bp - e);
        bp = 0;
        const envDb = e > 1e-9 ? 20 * Math.log10(e) : -180;
        const upDb = envDb < threshold ? Math.min(ceiling, slope * (threshold - envDb)) : 0;
        step = (Math.pow(10, upDb / 20) - g) / block;
      }
      const end = Math.min(n, k + block - into);
      for (; k < end; k++) {
        g += step;
        const x = out[k] * sc;
        const a = x < 0 ? -x : x;
        if (a > bp) bp = a;
        out[k] = x * g;
      }
    }
    env = e; blockPeak = bp; gain = g; gainStep = step;
  }

  // Runs the string loop for `count` samples into out[offset..] (state in locals: much faster in V8
  // than closure variables in the inner loop).
  function run(out, offset, count) {
    let i = index, prev = previous, xIn = apIn, yOut = apOut;
    const end = offset + count;
    for (let k = offset; k < end; k++) {
      const current = line[i];
      out[k] = current;
      const filtered = loopGain * ((1 - damping) * current + damping * prev);
      prev = current;
      yOut = allpass * filtered + xIn - allpass * yOut;
      xIn = filtered;
      line[i] = yOut;
      if (++i === whole) i = 0;
    }
    index = i; previous = prev; apIn = xIn; apOut = yOut;
  }

  // The peak window is rendered first (kept until it has been handed out), so the scale is known.
  const head = new Float32Array(window);
  run(head, 0, window);
  let outPeak = 1e-9;
  for (let i = 0; i < window; i++) if (Math.abs(head[i]) > outPeak) outPeak = Math.abs(head[i]);
  scale = 1 / outPeak;

  return {
    length,
    get rendered() { return position; },
    next(count) {
      const n = Math.max(0, Math.min(count, length - position));
      const out = new Float32Array(n);
      const fromHead = Math.max(0, Math.min(n, window - position));
      if (fromHead) out.set(head.subarray(position, position + fromHead));
      if (n > fromHead) run(out, fromHead, n - fromHead);
      // A short attack ramp removes the first-sample click; the tail fade hides the truncation.
      if (comp) sustainer(out, n);
      else for (let k = 0; k < n; k++) out[k] *= scale;
      for (let i = Math.max(position, 0); i < Math.min(attack, position + n); i++) out[i - position] *= i / attack;
      for (let i = Math.max(position, length - fade); i < position + n; i++) out[i - position] *= (length - 1 - i) / fade;
      position += n;
      return out;
    },
  };
}

/** The whole pluck in one buffer (same options as createPluck). */
export function renderPluck(options) {
  const pluck = createPluck(options);
  return pluck.next(pluck.length);
}
