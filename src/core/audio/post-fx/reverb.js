// 空間 (reverb) — post-effects slot 3 of 3 (chorus → delay → reverb), after the amp/cab and both takes.
// Interface and on/off rules: ./index.js. Docs: docs/設計說明.md 15.1.6 (bus) and 15.1.7 (this pedal).
//
//   input ───────────────────────────────────────────────────────────────────────► output  (dry, unity, always)
//     └► send ► pre-delay ► low cut ─┬► size send 0 ► convolver 0 (房間) ──┐
//        (on/off)                    ├► size send 1 ► convolver 1 (錄音室) ┼► tone (low-pass) ► wet ┘
//                                    ├► size send 2 ► convolver 2 (大廳) ──┤      (mix × level)
//                                    └► size send 3 ► convolver 3 (教堂) ──┘
//
// - Impulse responses are generated here (seeded noise, no files): decorrelated left/right noise in two
//   bands, the high band dying faster (darker tails), a few early reflections, no DC, energy 1.
//   One convolver per size step, all made at create; a size's IR is generated the first time the
//   pedal is on with that size, the other sizes one per idle period after that. Parts that never
//   switch the reverb on (lab tones, steel, nylon) build no IR at all.
// - Switching off closes `send`: what is already in the convolvers rings out (trails). Changing size
//   moves the size sends, so the old room's tail rings out and the new one starts from silence:
//   nothing is rebuilt and nothing jumps.
// - The wet path is high-passed (low cut) so the lows of the dry guitar stay clean.
// - Steel/nylon have their own room (tones.js) and get the "off" params here (engine: rig parts only).

export const id = 'reverb';

// Size steps. rt60: decay of the low band (−60 dB), seconds; range: where the measured broadband RT60
// (Schroeder backward integration, T30) must land; early: first/last early reflection (s); share:
// early-reflection share of the energy; damping: high band (above CROSSOVER_HZ) decay time / rt60.
export const REVERB_SIZES = [
  { id: 'room', label: 'pedal.step.room', rt60: 0.6, range: [0.4, 0.65], early: [0.004, 0.02], reflections: 6, share: 0.22, damping: 0.6 },
  { id: 'studio', label: 'pedal.step.studio', rt60: 1.15, range: [0.8, 1.25], early: [0.006, 0.032], reflections: 8, share: 0.16, damping: 0.5 },
  { id: 'hall', label: 'pedal.step.hall', rt60: 2.25, range: [1.6, 2.5], early: [0.01, 0.05], reflections: 10, share: 0.1, damping: 0.42 },
  { id: 'church', label: 'pedal.step.church', rt60: 4.0, range: [3.0, 4.3], early: [0.015, 0.075], reflections: 12, share: 0.07, damping: 0.36 },
];
export const CROSSOVER_HZ = 2000;
export const REVERB_SEED = 0x5eed;

// Knob ranges (physical units, as model.js knobValue() gives them) and defaults (normalised 0..1).
export const REVERB_RANGES = {
  mix: [0, 35],          // %: wet share; the dry path stays at unity, so wet gain = m / (1 − m)
  toneHz: [2000, 12000], // low-pass on the wet (log knob)
  preDelayMs: [0, 80],
  lowCutHz: [60, 800],   // high-pass on the wet (log knob)
  levelDb: [-12, 6],     // advanced mode only: trims the wet (the dry path is never touched)
};
export const REVERB_DEFAULT_KNOBS = { size: 1 / 3, mix: 0.4, tone: 0.5, preDelay: 0.25, lowCut: 0.5 };
export const MAX_PRE_DELAY = 0.1;  // s, DelayNode maximum
export const SIZE_TAU = 0.05;      // s, size change (send side)
export const SETTLE = 10;          // time constants until a closing send is set to exactly 0
const BUTTERWORTH_Q_DB = -3.0103;  // Web Audio lowpass/highpass Q is in dB

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = ([lo, hi], v) => lo + (hi - lo) * v;
const logLerp = ([lo, hi], v) => lo * Math.pow(hi / lo, v);
const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);

/** Pure: the pedal's numbers from a board snapshot; off for null, an off pedal or one without sound. */
export function paramsFromSnapshot(snapshot) {
  const pedal = snapshot?.pedals?.reverb;
  return {
    on: pedal?.on === true && pedal?.sound === true,
    values: { ...(pedal?.values ?? {}) },
    manual: snapshot ? snapshot.autoLevel === false : false,
  };
}

/** Mix (%) → wet gain with the dry path at unity: m / (1 − m). Monotonic, 0 at 0, ≈ 0.54 at 35 %. */
export function wetGain(mixPercent) {
  const m = clamp(finite(mixPercent, 0), REVERB_RANGES.mix[0], REVERB_RANGES.mix[1]) / 100;
  return m / (1 - m);
}

/**
 * Pure: params (paramsFromSnapshot) → the numbers the nodes get. Missing values take the defaults;
 * everything is clamped to its range. The level knob counts only in advanced mode (manual).
 */
export function reverbSettings(params) {
  const v = params?.values ?? {};
  const n = REVERB_SIZES.length - 1;
  const size = clamp(Math.round(finite(v.size, REVERB_DEFAULT_KNOBS.size * n)), 0, n);
  const mix = clamp(finite(v.mix, lerp(REVERB_RANGES.mix, REVERB_DEFAULT_KNOBS.mix)), ...REVERB_RANGES.mix);
  const levelDb = params?.manual ? clamp(finite(v.level, 0), ...REVERB_RANGES.levelDb) : 0;
  return {
    on: params?.on === true,
    size,
    mix,
    wet: wetGain(mix) * Math.pow(10, levelDb / 20),
    preDelay: clamp(finite(v.preDelay, lerp(REVERB_RANGES.preDelayMs, REVERB_DEFAULT_KNOBS.preDelay)), ...REVERB_RANGES.preDelayMs) / 1000,
    lowCutHz: clamp(finite(v.lowCut, logLerp(REVERB_RANGES.lowCutHz, REVERB_DEFAULT_KNOBS.lowCut)), ...REVERB_RANGES.lowCutHz),
    toneHz: clamp(finite(v.tone, logLerp(REVERB_RANGES.toneHz, REVERB_DEFAULT_KNOBS.tone)), ...REVERB_RANGES.toneHz),
  };
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stereo impulse response for a size step. Deterministic for (size, sampleRate, seed).
 * Diffuse tail: white noise split at CROSSOVER_HZ, the low band decaying −60 dB over rt60, the high
 * band over rt60 × damping, faded in between the first and last early reflection, the last 15 %
 * faded out. Early reflections: single taps at random times in `early`, amplitudes falling with
 * time, random signs, different per channel. Then the DC is removed (a scaled copy of the envelope is
 * subtracted, so Σh = 0) and each channel is normalised to energy Σh² = 1 (a steady broadband input
 * comes out at about its own RMS).
 * @returns {{ left: Float32Array, right: Float32Array, sampleRate: number, size: number }}
 */
export function generateImpulseResponse(sizeIndex, sampleRate, { seed = REVERB_SEED } = {}) {
  const size = REVERB_SIZES[sizeIndex];
  const length = Math.ceil(size.rt60 * 1.05 * sampleRate);
  const split = 1 - Math.exp(-2 * Math.PI * CROSSOVER_HZ / sampleRate);
  const lowStep = Math.exp(-Math.log(1000) / (size.rt60 * sampleRate));
  const highStep = Math.exp(-Math.log(1000) / (size.rt60 * size.damping * sampleRate));
  const onset = Math.round(size.early[0] * sampleRate);
  const full = Math.max(onset + 1, Math.round(size.early[1] * sampleRate));
  const fadeFrom = Math.floor(length * 0.85);
  const channel = c => {
    const random = mulberry((seed ^ Math.imul(sizeIndex + 1, 0x9E3779B1) ^ Math.imul(c + 1, 0x85EBCA6B)) >>> 0);
    const h = new Float32Array(length);
    const shape = new Float32Array(length);
    let low = 0, envLow = 1, envHigh = 1, diffuse = 0;
    for (let i = 0; i < length; i++) {
      const noise = random() * 2 - 1;
      low += split * (noise - low);
      const ramp = i < onset ? 0 : i < full ? 0.5 - 0.5 * Math.cos(Math.PI * (i - onset) / (full - onset)) : 1;
      const fade = i < fadeFrom ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (i - fadeFrom) / (length - fadeFrom));
      h[i] = (low * envLow + (noise - low) * envHigh) * ramp * fade;
      shape[i] = envLow * ramp * fade;
      diffuse += h[i] * h[i];
      envLow *= lowStep;
      envHigh *= highStep;
    }
    // Early reflections: `share` of the total energy, falling 0.8× per tap.
    const taps = [];
    for (let k = 0; k < size.reflections; k++) {
      const time = size.early[0] + (size.early[1] - size.early[0]) * (k + random()) / size.reflections;
      taps.push({ at: Math.round(time * sampleRate), amp: Math.pow(0.8, k) * (random() < 0.5 ? -1 : 1) });
    }
    const tapEnergy = taps.reduce((sum, t) => sum + t.amp * t.amp, 0);
    const scale = Math.sqrt(size.share / (1 - size.share) * diffuse / tapEnergy);
    for (const t of taps) h[t.at] += t.amp * scale;
    // No DC: subtract the envelope scaled so the sum is exactly zero.
    let sum = 0, shapeSum = 0;
    for (let i = 0; i < length; i++) { sum += h[i]; shapeSum += shape[i]; }
    const dc = sum / shapeSum;
    let energy = 0;
    for (let i = 0; i < length; i++) { h[i] -= dc * shape[i]; energy += h[i] * h[i]; }
    const norm = 1 / Math.sqrt(energy);
    for (let i = 0; i < length; i++) h[i] *= norm;
    return h;
  };
  return { left: channel(0), right: channel(1), sampleRate, size: sizeIndex };
}

const irCache = new Map();
function cachedIR(size, sampleRate) {
  const key = `${sampleRate}:${size}`;
  if (!irCache.has(key)) irCache.set(key, generateImpulseResponse(size, sampleRate));
  return irCache.get(key);
}

/**
 * @param {BaseAudioContext} ctx
 * @returns the slot instance (index.js), plus `irBuilds` ({ size, ms } of main thread per IR built)
 *          and `buildAll()` (measurements).
 */
export function create(ctx, { input, output }) {
  const gain = value => { const g = ctx.createGain(); g.gain.value = value; return g; };
  const biquad = (type, frequency) => {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = frequency; f.Q.value = BUTTERWORTH_Q_DB;
    return f;
  };
  const initial = reverbSettings({ on: false, values: {} });
  const send = gain(0);
  const preDelay = ctx.createDelay(MAX_PRE_DELAY);
  preDelay.delayTime.value = initial.preDelay;
  const lowCut = biquad('highpass', initial.lowCutHz);
  const sizeSends = REVERB_SIZES.map(() => gain(0));
  const convolvers = REVERB_SIZES.map(() => { const c = ctx.createConvolver(); c.normalize = false; return c; });
  const tone = biquad('lowpass', initial.toneHz);
  const wet = gain(0);

  input.connect(output);
  input.connect(send);
  send.connect(preDelay).connect(lowCut);
  REVERB_SIZES.forEach((_, i) => { lowCut.connect(sizeSends[i]).connect(convolvers[i]).connect(tone); });
  tone.connect(wet).connect(output);

  const clock = () => globalThis.performance?.now?.() ?? Date.now();
  const irBuilds = [];
  function ensure(size) {
    if (convolvers[size].buffer) return;
    const started = clock();
    const ir = generateImpulseResponse(size, ctx.sampleRate);
    const buffer = ctx.createBuffer(2, ir.left.length, ctx.sampleRate);
    buffer.getChannelData(0).set(ir.left);
    buffer.getChannelData(1).set(ir.right);
    convolvers[size].buffer = buffer;
    irBuilds.push({ size: REVERB_SIZES[size].id, ms: clock() - started });
  }
  // After the first switch-on, the other sizes are built one per idle period (browser only).
  let idle = null;
  function buildRestWhenIdle() {
    if (idle !== null || typeof globalThis.requestIdleCallback !== 'function') return;
    const next = REVERB_SIZES.findIndex((_, i) => !convolvers[i].buffer);
    if (next < 0) return;
    idle = globalThis.requestIdleCallback(() => { idle = null; ensure(next); buildRestWhenIdle(); }, { timeout: 3000 });
  }

  // Only move a parameter when its target changes (a dragged mix knob does not re-send the others).
  // A send going to 0 lands on exactly 0 after SETTLE time constants (the remaining e^−10 step is
  // −87 dB): an exponential approach never reaches 0, and only an exact 0 lets the browser treat
  // the convolver's input as silent and stop computing it once its tail has rung out.
  const last = new Map([[send.gain, 0], [wet.gain, 0], ...sizeSends.map(g => [g.gain, 0])]);
  const target = (param, value, now, tau) => {
    if (last.get(param) === value) return;
    last.set(param, value);
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, tau);
    if (value === 0) param.setValueAtTime(0, now + SETTLE * tau);
  };

  return {
    irBuilds,
    buildAll() { REVERB_SIZES.forEach((_, i) => ensure(i)); },
    apply(params, change, { now = ctx.currentTime, tau = 0.012 } = {}) {
      const s = reverbSettings(params);
      if (!s.on) {
        // Close the send only: the tails ring out at the level they had.
        target(send.gain, 0, now, tau);
        return;
      }
      ensure(s.size);
      buildRestWhenIdle();
      const sizeTau = Math.max(tau, SIZE_TAU);
      sizeSends.forEach((g, i) => target(g.gain, i === s.size ? 1 : 0, now, sizeTau));
      target(preDelay.delayTime, s.preDelay, now, tau);
      target(lowCut.frequency, s.lowCutHz, now, tau);
      target(tone.frequency, s.toneHz, now, tau);
      target(wet.gain, s.wet, now, tau);
      target(send.gain, 1, now, tau);
    },
    dispose() {
      if (idle !== null) globalThis.cancelIdleCallback?.(idle);
      idle = null;
      input.disconnect(output);
      input.disconnect(send);
      for (const node of [send, preDelay, lowCut, ...sizeSends, ...convolvers, tone, wet]) node.disconnect();
    },
  };
}

// ---------- Node model ----------

// Radix-2 FFT (the algorithm of src/core/analysis/dsp.js createFFT, with double-precision twiddles;
// kept here so the audio code does not import the analysis module).
const ffts = new Map();
function fftOf(n) {
  if (ffts.has(n)) return ffts.get(n);
  const levels = Math.round(Math.log2(n));
  const reverse = new Uint32Array(n);
  for (let i = 1; i < n; i++) reverse[i] = (reverse[i >> 1] >> 1) | ((i & 1) << (levels - 1));
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) { cos[k] = Math.cos(2 * Math.PI * k / n); sin[k] = Math.sin(2 * Math.PI * k / n); }
  const fft = (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = reverse[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const tre = re[j + half] * cos[k] + im[j + half] * sin[k];
          const tim = -re[j + half] * sin[k] + im[j + half] * cos[k];
          re[j + half] = re[j] - tre; im[j + half] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  };
  ffts.set(n, fft);
  return fft;
}

/** Linear convolution y = x * h, first `length` samples (one complex FFT carries both inputs). */
export function convolve(x, h, length = x.length) {
  let n = 1;
  while (n < x.length + h.length - 1) n *= 2;
  const fft = fftOf(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(x); im.set(h);
  fft(re, im);
  // Z = X + iH: X[k] = (Z[k] + Z*[n−k]) / 2, H[k] = (Z[k] − Z*[n−k]) / 2i; Y = X·H; inverse by
  // conjugation, y = Re fft(conj Y) / n.
  const yr = new Float64Array(n), yi = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const m = (n - k) & (n - 1);
    const xr = (re[k] + re[m]) / 2, xi = (im[k] - im[m]) / 2;
    const hr = (im[k] + im[m]) / 2, hi = (re[m] - re[k]) / 2;
    yr[k] = xr * hr - xi * hi;
    yi[k] = -(xr * hi + xi * hr);
  }
  fft(yr, yi);
  const out = new Float32Array(length);
  for (let i = 0; i < Math.min(length, n); i++) out[i] = yr[i] / n;
  return out;
}

// Low-/high-pass biquad as Web Audio computes it (Audio EQ Cookbook, Q in dB), direct form I.
function biquadFilter(x, type, frequency, sampleRate) {
  const w = 2 * Math.PI * frequency / sampleRate;
  const cos = Math.cos(w), alpha = Math.sin(w) / (2 * Math.pow(10, BUTTERWORTH_Q_DB / 20));
  const b1 = type === 'lowpass' ? 1 - cos : -(1 + cos);
  const b0 = type === 'lowpass' ? b1 / 2 : -b1 / 2;
  const a0 = 1 + alpha;
  const [c0, c1, c3, c4] = [b0 / a0, b1 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = c0 * x[i] + c1 * x1 + c0 * x2 - c3 * y1 - c4 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/**
 * The wet path before the return gain, as the nodes compute it: pre-delay (whole samples), low cut,
 * per-size send × convolver, tone. `sends[i]` is a number or a per-sample curve (master send × size
 * send, e.g. wah.js simulateParam over the fake context's automation); the filters are static.
 */
export function renderWet({ left, right }, sampleRate, { sends, preDelay, lowCutHz, toneHz }) {
  const shift = Math.round(preDelay * sampleRate);
  const channel = (x, side) => {
    const delayed = new Float32Array(x.length);
    delayed.set(x.subarray(0, Math.max(0, x.length - shift)), shift);
    const cut = biquadFilter(delayed, 'highpass', lowCutHz, sampleRate);
    const sum = new Float32Array(x.length);
    sends.forEach((send, size) => {
      if (typeof send === 'number' ? send === 0 : send.every(v => v === 0)) return;
      const fed = typeof send === 'number' ? cut.map(v => v * send) : cut.map((v, i) => v * send[i]);
      const y = convolve(fed, cachedIR(size, sampleRate)[side], x.length);
      for (let i = 0; i < y.length; i++) sum[i] += y[i];
    });
    return biquadFilter(sum, 'lowpass', toneHz, sampleRate);
  };
  return { left: channel(left, 'left'), right: channel(right, 'right') };
}

/** Node model (static params). Off returns the signal unchanged; on: dry + wet, same length. */
export function process(params, signal, { sampleRate = 48000 } = {}) {
  const s = reverbSettings(params);
  if (!s.on) return signal;
  const sends = REVERB_SIZES.map((_, i) => (i === s.size ? 1 : 0));
  const wet = renderWet(signal, sampleRate, { sends, preDelay: s.preDelay, lowCutHz: s.lowCutHz, toneHz: s.toneHz });
  return {
    left: signal.left.map((v, i) => v + wet.left[i] * s.wet),
    right: signal.right.map((v, i) => v + wet.right[i] * s.wet),
  };
}
