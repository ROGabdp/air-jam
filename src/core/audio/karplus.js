// Karplus-Strong plucked string, rendered offline into a Float32Array (pure, testable in Node).

/**
 * @param {object} o
 * @param {number} o.freq          fundamental in Hz
 * @param {number} o.sampleRate
 * @param {number} o.t60           seconds for the fundamental to decay by 60 dB
 * @param {number} o.brightness    0..1 low-pass applied to the excitation (1 = raw noise)
 * @param {number} o.pickPosition  0..0.5 distance from the nearer end; shapes the excitation with a comb
 * @param {number} o.damping       0..0.5 loop filter mix; higher loses treble faster
 * @param {number} [o.maxSeconds]
 * @param {() => number} [o.random]
 */
export function renderPluck({
  freq, sampleRate, t60 = 3, brightness = 0.6, pickPosition = 0.5, damping = 0.5,
  maxSeconds = 3, random = Math.random,
}) {
  const period = sampleRate / freq;
  const seconds = Math.min(maxSeconds, Math.max(0.35, t60 * 0.9));
  const length = Math.floor(seconds * sampleRate);
  const out = new Float32Array(length);

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

  let index = 0, previous = 0, apIn = 0, apOut = 0, outPeak = 1e-9;
  for (let i = 0; i < length; i++) {
    const current = line[index];
    out[i] = current;
    if (Math.abs(current) > outPeak) outPeak = Math.abs(current);
    const filtered = loopGain * ((1 - damping) * current + damping * previous);
    previous = current;
    apOut = allpass * filtered + apIn - allpass * apOut;
    apIn = filtered;
    line[index] = apOut;
    if (++index === whole) index = 0;
  }

  // A short attack ramp removes the first-sample click; the tail fade hides the truncation.
  const attack = Math.min(length, Math.floor(sampleRate * 0.0015));
  for (let i = 0; i < attack; i++) out[i] *= i / attack;
  const fade = Math.min(length, Math.floor(sampleRate * 0.12));
  for (let i = 0; i < fade; i++) out[length - 1 - i] *= i / fade;
  for (let i = 0; i < length; i++) out[i] /= outPeak;
  return out;
}
