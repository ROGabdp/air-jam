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
