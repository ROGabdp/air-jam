export function createFFT(n) {
  const levels = Math.round(Math.log2(n));
  if (1 << levels !== n) throw new Error('FFT size must be a power of two');
  const reverse = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) if (i & (1 << b)) r |= 1 << (levels - 1 - b);
    reverse[i] = r;
  }
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos(2 * Math.PI * k / n);
    sin[k] = Math.sin(2 * Math.PI * k / n);
  }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = reverse[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const tre = re[j + half] * cos[k] + im[j + half] * sin[k];
          const tim = -re[j + half] * sin[k] + im[j + half] * cos[k];
          re[j + half] = re[j] - tre;
          im[j + half] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  };
}

// Integer-factor decimation with a Hann-windowed sinc low-pass, peak-normalised.
export function decimate(samples, sampleRate, targetRate) {
  const steps = decimateSteps(samples, sampleRate, targetRate);
  let step;
  while (!(step = steps.next()).done);
  return step.value;
}

// Generator form: yields a 0..1 fraction now and then (a long song takes a noticeable moment).
export function* decimateSteps(samples, sampleRate, targetRate) {
  const factor = Math.max(1, Math.round(sampleRate / targetRate));
  const length = Math.floor(samples.length / factor);
  const out = new Float32Array(length);
  if (factor === 1) {
    out.set(samples.subarray(0, length));
  } else {
    const half = factor * 8;
    const taps = new Float32Array(2 * half + 1);
    const cutoff = 0.45 / factor;
    let sum = 0;
    for (let i = -half; i <= half; i++) {
      const sinc = i === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * i) / (Math.PI * i);
      const tap = sinc * (0.5 + 0.5 * Math.cos(Math.PI * i / half));
      taps[i + half] = tap;
      sum += tap;
    }
    for (let i = 0; i < taps.length; i++) taps[i] /= sum;
    const n = samples.length;
    for (let o = 0; o < length; o++) {
      const center = o * factor;
      const from = Math.max(0, center - half);
      const to = Math.min(n - 1, center + half);
      let acc = 0;
      for (let i = from; i <= to; i++) acc += samples[i] * taps[i - center + half];
      out[o] = acc;
      if ((o & 0xffff) === 0xffff) yield o / length;
    }
  }
  let peak = 0;
  for (let i = 0; i < length; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
  if (peak > 1e-9) for (let i = 0; i < length; i++) out[i] /= peak;
  return { samples: out, sampleRate: sampleRate / factor };
}

// Generator STFT: calls onFrame(magnitudes, frameIndex) and yields a 0..1 fraction now and then.
export function* stft(x, size, hop, onFrame) {
  const fft = createFFT(size);
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size);
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const mag = new Float32Array(size / 2);
  const frames = Math.max(0, Math.floor((x.length - size) / hop) + 1);
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    for (let i = 0; i < size; i++) { re[i] = x[start + i] * window[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < size / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    onFrame(mag, f);
    if ((f & 31) === 31) yield f / frames;
  }
  return frames;
}
