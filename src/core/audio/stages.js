// Effect chains described as data: a list of series stages. The same list builds Web Audio nodes in
// the browser (buildStages) and runs as plain JS in Node (processStages, stagesResponse), so the
// measurement tools hear the chain the game builds.
//
// Stage kinds:
//   { kind: 'biquad', type, frequency, Q?, gain? }   BiquadFilterNode (Web Audio semantics: Q is in
//                                                    dB for lowpass/highpass, ignored by shelves)
//   { kind: 'gain', value }                         GainNode
//   { kind: 'shaper', curve: { kind, drive, bias, n }, oversample? }   WaveShaperNode
import { clipCurve, curveSlope, shapeSample } from './distortion.js';

/**
 * Normalised biquad coefficients as the Web Audio spec computes them (Audio EQ Cookbook with the
 * spec's choices: Q in dB for lowpass/highpass, shelf slope S = 1).
 * @returns {{ b0: number, b1: number, b2: number, a1: number, a2: number }}
 */
export function biquadCoefficients(type, frequency, Q = 1, gain = 0, sampleRate = 48000) {
  const nyquist = sampleRate / 2;
  const f0 = Math.max(1e-3, Math.min(nyquist * 0.9999, frequency));
  const w0 = 2 * Math.PI * f0 / sampleRate;
  const cos = Math.cos(w0), sin = Math.sin(w0);
  const A = Math.pow(10, gain / 40);
  const alphaQ = sin / (2 * Math.max(1e-4, Q));
  const alphaQdB = sin / (2 * Math.pow(10, Q / 20));
  const alphaS = (sin / 2) * Math.SQRT2;
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
      a0 = 1 + alphaQdB; a1 = -2 * cos; a2 = 1 - alphaQdB;
      break;
    case 'highpass':
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
      a0 = 1 + alphaQdB; a1 = -2 * cos; a2 = 1 - alphaQdB;
      break;
    case 'bandpass':
      b0 = alphaQ; b1 = 0; b2 = -alphaQ;
      a0 = 1 + alphaQ; a1 = -2 * cos; a2 = 1 - alphaQ;
      break;
    case 'peaking':
      b0 = 1 + alphaQ * A; b1 = -2 * cos; b2 = 1 - alphaQ * A;
      a0 = 1 + alphaQ / A; a1 = -2 * cos; a2 = 1 - alphaQ / A;
      break;
    case 'lowshelf': {
      const s = 2 * alphaS * Math.sqrt(A);
      b0 = A * ((A + 1) - (A - 1) * cos + s); b1 = 2 * A * ((A - 1) - (A + 1) * cos); b2 = A * ((A + 1) - (A - 1) * cos - s);
      a0 = (A + 1) + (A - 1) * cos + s; a1 = -2 * ((A - 1) + (A + 1) * cos); a2 = (A + 1) + (A - 1) * cos - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * alphaS * Math.sqrt(A);
      b0 = A * ((A + 1) + (A - 1) * cos + s); b1 = -2 * A * ((A - 1) + (A + 1) * cos); b2 = A * ((A + 1) + (A - 1) * cos - s);
      a0 = (A + 1) - (A - 1) * cos + s; a1 = 2 * ((A - 1) - (A + 1) * cos); a2 = (A + 1) - (A - 1) * cos - s;
      break;
    }
    default: throw new Error(`unsupported biquad type: ${type}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// |H| of a normalised biquad at a frequency.
export function biquadMagnitude(c, frequency, sampleRate) {
  const w = 2 * Math.PI * frequency / sampleRate;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2);
  const dr = 1 + c.a1 * c1 + c.a2 * c2, di = -(c.a1 * s1 + c.a2 * s2);
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

const curveCache = new Map();
export function stageCurve(stage) {
  const key = JSON.stringify(stage.curve);
  let curve = curveCache.get(key);
  if (!curve) { curve = clipCurve(stage.curve); curveCache.set(key, curve); }
  return curve;
}

/**
 * Builds the stages as a series of Web Audio nodes.
 * @returns {{ input: AudioNode, output: AudioNode, nodes: AudioNode[], dispose(): void }}
 */
export function buildStages(ctx, stages) {
  const input = ctx.createGain();
  const nodes = [input];
  for (const stage of stages) {
    let node;
    if (stage.kind === 'biquad') {
      node = ctx.createBiquadFilter();
      node.type = stage.type;
      node.frequency.value = stage.frequency;
      if (stage.Q !== undefined) node.Q.value = stage.Q;
      if (stage.gain !== undefined) node.gain.value = stage.gain;
    } else if (stage.kind === 'gain') {
      node = ctx.createGain();
      node.gain.value = stage.value;
    } else if (stage.kind === 'shaper') {
      node = ctx.createWaveShaper();
      node.curve = stageCurve(stage);
      node.oversample = stage.oversample ?? '4x';
    } else {
      throw new Error(`unknown stage kind: ${stage.kind}`);
    }
    nodes.at(-1).connect(node);
    nodes.push(node);
  }
  return {
    input,
    output: nodes.at(-1),
    nodes,
    dispose() { for (const node of nodes) node.disconnect(); },
  };
}

/**
 * Runs the stages over one channel (a copy; the input is not modified). The shaper is applied
 * without oversampling, so aliasing above ~5 kHz differs from the browser; levels and envelopes
 * match closely.
 */
export function processStages(stages, input, sampleRate) {
  const out = Float32Array.from(input);
  for (const stage of stages) {
    if (stage.kind === 'gain') {
      for (let i = 0; i < out.length; i++) out[i] *= stage.value;
    } else if (stage.kind === 'shaper') {
      const curve = stageCurve(stage);
      for (let i = 0; i < out.length; i++) out[i] = shapeSample(out[i], curve);
    } else if (stage.kind === 'biquad') {
      const c = biquadCoefficients(stage.type, stage.frequency, stage.Q ?? 1, stage.gain ?? 0, sampleRate);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < out.length; i++) {
        const x = out[i];
        const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        out[i] = Math.abs(y) < 1e-30 ? 0 : y;
      }
    }
  }
  return out;
}

/**
 * Small-signal magnitude response (linear) of the stages at each frequency: biquad magnitudes,
 * gains, and each shaper's slope at rest.
 */
export function stagesResponse(stages, frequencies, sampleRate = 48000) {
  return frequencies.map(frequency => {
    let magnitude = 1;
    for (const stage of stages) {
      if (stage.kind === 'gain') magnitude *= Math.abs(stage.value);
      else if (stage.kind === 'shaper') magnitude *= curveSlope(stageCurve(stage));
      else if (stage.kind === 'biquad') {
        magnitude *= biquadMagnitude(biquadCoefficients(stage.type, stage.frequency, stage.Q ?? 1, stage.gain ?? 0, sampleRate), frequency, sampleRate);
      }
    }
    return magnitude;
  });
}

/**
 * Drive (dB): small-signal gain up to and including the last shaper, i.e. how far a quiet input is
 * pushed into the last clipper (stages after it do not change how hard it clips). By default only
 * gains and shaper slopes count (the mid-band "total gain" the research and challenge docs quote:
 * the current electric tone is ~24 dB); with `frequency`, the filters at that frequency count too.
 */
export function driveDb(stages, { frequency = null, sampleRate = 48000 } = {}) {
  const last = stages.map(s => s.kind).lastIndexOf('shaper');
  if (last < 0) return 0;
  const upTo = stages.slice(0, last + 1).filter(s => frequency !== null || s.kind !== 'biquad');
  const [magnitude] = stagesResponse(upTo, [frequency ?? 1000], sampleRate);
  return 20 * Math.log10(magnitude);
}

/**
 * Deepest notch in a response (dB): for every point, how far it sits below the lower of the
 * highest points on its left and right. 0 for a monotonic or single-peaked response.
 */
export function deepestNotchDb(magnitudesDb) {
  const n = magnitudesDb.length;
  const leftMax = new Array(n), rightMax = new Array(n);
  for (let i = 0, m = -Infinity; i < n; i++) { m = Math.max(m, magnitudesDb[i]); leftMax[i] = m; }
  for (let i = n - 1, m = -Infinity; i >= 0; i--) { m = Math.max(m, magnitudesDb[i]); rightMax[i] = m; }
  let deepest = 0;
  for (let i = 0; i < n; i++) deepest = Math.max(deepest, Math.min(leftMax[i], rightMax[i]) - magnitudesDb[i]);
  return deepest;
}
