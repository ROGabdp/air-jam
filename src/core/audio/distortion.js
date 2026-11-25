// Pure helpers for the distorted tones: the waveshaper transfer curve, a Node-side model of how
// WaveShaperNode applies it, and the release time constant that makes a choked voice fall below a
// given level *after* the distortion (which flattens the input's decay by roughly its drive).

/**
 * Soft-clipping transfer curve for a WaveShaperNode, mapping input -1..1 to output -1..1.
 * y = tanh(drive · (x + bias)) − tanh(drive · bias), normalised so the curve ends at ±1 at most.
 * A small bias makes the clipping slightly asymmetric (adds even harmonics, a warmer edge).
 * @param {number} drive  slope at the origin before normalisation (clamped to 0.01..100)
 * @param {object} [o]
 * @param {number} [o.bias]     0..0.3
 * @param {number} [o.samples]  curve length (odd, so x = 0 is sampled exactly)
 */
export function distortionCurve(drive, { bias = 0.08, samples = 4097 } = {}) {
  const k = Number.isFinite(drive) ? Math.max(0.01, Math.min(100, drive)) : drive > 0 ? 100 : 0.01;
  // Keep the bias inside the soft region (k·b ≤ 0.4): at a high drive a fixed bias would move the
  // clipping step off zero and gate quiet signals to a constant.
  const b = Math.max(0, Math.min(0.3, bias, 0.4 / k));
  const n = Math.max(3, samples | 1);
  const curve = new Float32Array(n);
  const offset = Math.tanh(k * b);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * (x + b)) - offset;
    peak = Math.max(peak, Math.abs(curve[i]));
  }
  for (let i = 0; i < n; i++) curve[i] /= peak;
  return curve;
}

// Small-signal gain of a curve around x = 0 (output change per input change).
export function curveSlope(curve) {
  const mid = (curve.length - 1) / 2;
  const step = 2 / (curve.length - 1);
  return (curve[mid + 1] - curve[mid - 1]) / (2 * step);
}

// What WaveShaperNode does to one sample: clamp to -1..1, then interpolate linearly in the curve.
export function shapeSample(x, curve) {
  const n = curve.length;
  const v = ((Math.max(-1, Math.min(1, x)) + 1) / 2) * (n - 1);
  const i = Math.min(n - 2, Math.floor(v));
  const f = v - i;
  return curve[i] * (1 - f) + curve[i + 1] * f;
}

/**
 * Time constant for `gain.setTargetAtTime(0, t, τ)` so the voice is `depthDb` quieter after
 * `seconds`. For a distorted chain, depthDb = the wanted drop at the output + the chain's drive,
 * because the clipper turns the first `drive` dB of input decay into almost no output decay.
 */
export function releaseTimeConstant(seconds, depthDb) {
  return seconds / Math.log(Math.pow(10, Math.max(1, depthDb) / 20));
}

/**
 * Output ceiling for the master bus: straight up to `knee`, then a soft knee that never exceeds
 * `max`. WaveShaperNode clamps its input to -1..1, so the output is bounded by `max` whatever comes
 * in; the limiter in front only lets brief overshoots through, so this rarely acts.
 */
export function ceilingCurve({ knee = 0.9, max = 0.99, samples = 4097 } = {}) {
  const n = Math.max(3, samples | 1);
  const curve = new Float32Array(n);
  const room = max - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    curve[i] = Math.sign(x) * (a <= knee ? a : knee + room * Math.tanh((a - knee) / room));
  }
  return curve;
}

/**
 * Harder clipping curve for a WaveShaperNode: y = f(k(x + b)) − f(k·b), f(u) = u / (1 + |u|ⁿ)^(1/n),
 * normalised to ±1 at most. n ≈ 2 is close to tanh; n = 4 keeps the small-signal region straighter
 * and bends into the ceiling later and more sharply (more "edge", still no hard corner).
 * @param {number} drive  slope at the origin before normalisation (clamped to 0.01..100)
 * @param {object} [o]
 * @param {number} [o.n]        knee sharpness, clamped to 1..20
 * @param {number} [o.bias]     0..0.3, kept inside the straight region (k·b ≤ 0.4)
 * @param {number} [o.samples]  curve length (odd)
 */
export function hardClipCurve(drive, { n = 4, bias = 0.08, samples = 4097 } = {}) {
  const k = Number.isFinite(drive) ? Math.max(0.01, Math.min(100, drive)) : drive > 0 ? 100 : 0.01;
  const p = Number.isFinite(n) ? Math.max(1, Math.min(20, n)) : 4;
  const b = Math.max(0, Math.min(0.3, Number.isFinite(bias) ? bias : 0, 0.4 / k));
  const f = u => u / Math.pow(1 + Math.pow(Math.abs(u), p), 1 / p);
  const count = Math.max(3, samples | 1);
  const curve = new Float32Array(count);
  const offset = f(k * b);
  let peak = 0;
  for (let i = 0; i < count; i++) {
    const x = (i / (count - 1)) * 2 - 1;
    curve[i] = f(k * (x + b)) - offset;
    peak = Math.max(peak, Math.abs(curve[i]));
  }
  for (let i = 0; i < count; i++) curve[i] /= peak;
  return curve;
}

/**
 * Fuzz-like curve for the top of the distortion range: a very hard knee on the positive side and a
 * softer, lower ceiling on the negative side (strongly asymmetric: lots of even harmonics, a
 * "broken" edge), y = f(k·x) with f(u) = u / (1 + uⁿ)^(1/n) for u ≥ 0 and
 * f(u) = −c · tanh(−u / c) for u < 0, normalised to ±1 at most. The slope at 0 is k on both sides,
 * so it can be cross-faded with the other clippers at the same input gain. The DC this adds is
 * removed by the cabinet high-pass after it.
 * @param {number} drive  slope at the origin before normalisation (clamped to 0.01..100)
 * @param {object} [o]
 * @param {number} [o.n]        positive knee sharpness, clamped to 1..40
 * @param {number} [o.ceiling]  negative ceiling relative to the positive one, clamped to 0.2..1
 */
export function fuzzCurve(drive, { n = 12, ceiling = 0.55, samples = 4097 } = {}) {
  const k = Number.isFinite(drive) ? Math.max(0.01, Math.min(100, drive)) : drive > 0 ? 100 : 0.01;
  const p = Number.isFinite(n) ? Math.max(1, Math.min(40, n)) : 12;
  const c = Number.isFinite(ceiling) ? Math.max(0.2, Math.min(1, ceiling)) : 0.55;
  const count = Math.max(3, samples | 1);
  const curve = new Float32Array(count);
  let peak = 0;
  for (let i = 0; i < count; i++) {
    const u = k * ((i / (count - 1)) * 2 - 1);
    curve[i] = u >= 0 ? u / Math.pow(1 + Math.pow(u, p), 1 / p) : -c * Math.tanh(-u / c);
    peak = Math.max(peak, Math.abs(curve[i]));
  }
  for (let i = 0; i < count; i++) curve[i] /= peak;
  return curve;
}

// Curve for a shaper stage description { kind: 'tanh' | 'hard' | 'fuzz', drive, bias, n, ceiling }.
export function clipCurve({ kind = 'tanh', drive, bias = 0, n = 4, ceiling }) {
  if (kind === 'fuzz') return fuzzCurve(drive, { n, ceiling });
  return kind === 'hard' ? hardClipCurve(drive, { n, bias }) : distortionCurve(drive, { bias });
}

/**
 * Release depth (dB, measured at the voice) for a distorted chain: the audible drop wanted at the
 * output, plus the chain's small-signal gain (the clipper turns that much input decay into almost
 * no output decay), plus a margin for stacked voices and velocity (8 strings at full velocity sit
 * up to ~26 dB above one quiet string). 24 dB of gain gives the 90 dB the current electric tone uses.
 */
export function chokeDepthDb(gainDb, { audibleDb = 40, stackDb = 26 } = {}) {
  const gain = Number.isFinite(gainDb) ? Math.max(0, gainDb) : 0;
  return audibleDb + gain + stackDb;
}
