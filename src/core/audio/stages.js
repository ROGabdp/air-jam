// Effect chains described as data: a list of series stages. The same list builds Web Audio nodes in
// the browser (buildStages) and runs as plain JS in Node (processStages, stagesResponse), so the
// measurement tools hear the chain the game builds.
//
// Stage kinds:
//   { kind: 'biquad', type, frequency, Q?, gain? }   BiquadFilterNode (Web Audio semantics: Q is in
//                                                    dB for lowpass/highpass, ignored by shelves)
//   { kind: 'gain', value }                         GainNode
//   { kind: 'shaper', curve: { kind, drive, bias, n }, oversample? }   WaveShaperNode
//   { kind: 'mix', branches: [{ weight, stages }] }  parallel branches summed, a GainNode per branch
//                                                    (cross-fades: a pedal's on/off, the clipper blend)
//   { kind: 'wahFilter', frequency, cents, qScale }  band-pass steered by the wah position w (0..1):
//                                                    centre frequency·2^(cents·w/1200), Q qScale·4^(1−w)
//   { kind: 'wahGain', compDb, compSlope }           gain of compDb + compSlope·w (dB): the wah's
//                                                    loudness compensation
// The wah position is not a stage number: it is one control signal per chain (a ConstantSourceNode
// in the browser, fanned out to every wah stage through fixed curves; a number or a per-sample
// track in Node), so it can move every frame without touching the rest of the chain (wah.js).
// Any stage may carry an `id` (documentation only). A chain built from a list can later be moved to
// another list of the same shape (same kinds, types, curves in the same places) with update(): the
// numbers glide there with setTargetAtTime and nothing is rebuilt, so a ringing note is never cut.
import { clipCurve, curveSlope, shapeSample } from './distortion.js';

// Wah stages (see above). The compensation slope reaches the gain through an exponential curve
// that spans ±WAH_COMP_SPAN dB, so the slope is a plain gain in front of the curve and can glide.
export const WAH_COMP_SPAN = 30;
export const WAH_Q_EXPONENT = 2;          // Q = qScale · 2^(WAH_Q_EXPONENT·(1 − w)) (Smith: 2^(2(1−w)+1))
const fromDb = db => Math.pow(10, db / 20);
const clamp01 = w => Math.max(0, Math.min(1, Number.isFinite(w) ? w : 0));
const wahSlope = stage => Math.max(-WAH_COMP_SPAN, Math.min(WAH_COMP_SPAN, stage.compSlope));

/** Centre frequency and Q (wahFilter) or linear gain (wahGain) of a wah stage at position w. */
export function wahStageAt(stage, w) {
  const x = clamp01(w);
  if (stage.kind === 'wahFilter') {
    return { frequency: stage.frequency * Math.pow(2, stage.cents * x / 1200), Q: stage.qScale * Math.pow(2, WAH_Q_EXPONENT * (1 - x)) };
  }
  if (stage.kind === 'wahGain') return { gain: fromDb(stage.compDb + wahSlope(stage) * x) };
  throw new Error(`not a wah stage: ${stage.kind}`);
}

// Fixed curves from the control signal (WaveShaper input −1..1; the wah position uses 0..1).
const CONTROL_POINTS = 1025;
const controlCurve = f => Float32Array.from({ length: CONTROL_POINTS }, (_, i) => f(-1 + 2 * i / (CONTROL_POINTS - 1)));
let qCurveCache = null, compCurveCache = null;
export const wahQCurve = () => (qCurveCache ??= controlCurve(x => Math.pow(2, WAH_Q_EXPONENT * (1 - clamp01(x)))));
export const wahCompCurve = () => (compCurveCache ??= controlCurve(x => fromDb(WAH_COMP_SPAN * x)));
const wahPosition = (wah, i) => (typeof wah === 'number' ? wah : wah?.[i] ?? 0.5);

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
 * Builds the stages as Web Audio nodes.
 * @returns {{ input: AudioNode, output: AudioNode, nodes: AudioNode[], dispose(): void,
 *             update(stages: object[], o?: { when?: number, tau?: number }): void }}
 */
export function buildStages(ctx, stages, { wah = null } = {}) {
  const nodes = [];
  // The wah position signal: shared from outside (one per part), or a fixed one of our own.
  let control = wah;
  const wahControl = () => {
    if (control) return control;
    const source = ctx.createConstantSource();
    source.offset.value = 0.5;
    source.start();
    nodes.push(source);
    return (control = source);
  };
  // Every automatable AudioParam in the order stageNumbers() lists the values.
  const params = [];

  // Builds `list` in series after `from`; returns the last node.
  function series(from, list) {
    let last = from;
    for (const stage of list) {
      let node;
      if (stage.kind === 'biquad') {
        node = ctx.createBiquadFilter();
        node.type = stage.type;
        node.frequency.value = stage.frequency;
        if (stage.Q !== undefined) node.Q.value = stage.Q;
        if (stage.gain !== undefined) node.gain.value = stage.gain;
        params.push(node.frequency, node.Q, node.gain);
        last.connect(node);
      } else if (stage.kind === 'gain') {
        node = ctx.createGain();
        node.gain.value = stage.value;
        params.push(node.gain);
        last.connect(node);
      } else if (stage.kind === 'shaper') {
        node = ctx.createWaveShaper();
        node.curve = stageCurve(stage);
        node.oversample = stage.oversample ?? '4x';
        last.connect(node);
      } else if (stage.kind === 'wahFilter') {
        node = ctx.createBiquadFilter();
        node.type = 'bandpass';
        node.frequency.value = stage.frequency;
        node.Q.value = 0;                       // all of Q comes from the control curve
        const cents = ctx.createGain();
        cents.gain.value = stage.cents;
        const qShape = ctx.createWaveShaper();
        qShape.curve = wahQCurve();
        qShape.oversample = 'none';
        const qScale = ctx.createGain();
        qScale.gain.value = stage.qScale;
        wahControl().connect(cents).connect(node.detune);
        wahControl().connect(qShape);
        qShape.connect(qScale).connect(node.Q);
        nodes.push(cents, qShape, qScale);
        params.push(node.frequency, cents.gain, qScale.gain);
        last.connect(node);
      } else if (stage.kind === 'wahGain') {
        node = ctx.createGain();
        node.gain.value = 0;                    // all of the gain comes from the control curve
        const slope = ctx.createGain();
        slope.gain.value = wahSlope(stage) / WAH_COMP_SPAN;
        const shape = ctx.createWaveShaper();
        shape.curve = wahCompCurve();
        shape.oversample = 'none';
        const offset = ctx.createGain();
        offset.gain.value = fromDb(stage.compDb);
        wahControl().connect(slope);
        slope.connect(shape).connect(offset).connect(node.gain);
        nodes.push(slope, shape, offset);
        params.push(offset.gain, slope.gain);
        last.connect(node);
      } else if (stage.kind === 'mix') {
        node = ctx.createGain();
        for (const branch of stage.branches) {
          const weight = ctx.createGain();
          weight.gain.value = branch.weight;
          params.push(weight.gain);
          nodes.push(weight);
          series(last, branch.stages).connect(weight);
          weight.connect(node);
        }
      } else {
        throw new Error(`unknown stage kind: ${stage.kind}`);
      }
      nodes.push(node);
      last = node;
    }
    return last;
  }

  const input = ctx.createGain();
  nodes.push(input);
  const output = series(input, stages);
  const shape = shapeOf(stages);
  return {
    input,
    output,
    nodes,
    dispose() { for (const node of nodes) node.disconnect(); },
    // Glides to the numbers of `next` (tau > 0), or sets them at `when` (tau = 0: only on a silent chain).
    update(next, { when = ctx.currentTime, tau = 0.02 } = {}) {
      if (shapeOf(next) !== shape) throw new Error('stage list has a different shape; build a new chain');
      stageNumbers(next).forEach((value, i) => {
        if (value === undefined) return;
        params[i].cancelScheduledValues(when);
        if (tau > 0) params[i].setTargetAtTime(value, when, tau);
        else params[i].setValueAtTime(value, when);
      });
    },
  };
}

/**
 * Two copies of a chain fed by the same input, one audible at a time. Knob moves glide on the
 * audible copy (update); a switch (a pedal on/off, a preset) sets the silent copy to the new numbers
 * and cross-fades to it (switchTo), so the change sounds like a cross-fade between two settled
 * sounds: no level spike while a loud branch fades out and a quieter one is levelled up, and the
 * clipper/bypass branches inside a copy never have to line up in time. The silent copy keeps
 * running, so its filters are warm when it fades in.
 * @returns {{ input, output, nodes, dispose(), update(stages, o?), switchTo(stages, o?) }}
 */
export function buildSwitchableStages(ctx, stages, controls = {}) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const copies = [0, 1].map(i => {
    const chain = buildStages(ctx, stages, controls);
    const fader = ctx.createGain();
    fader.gain.value = i === 0 ? 1 : 0;
    input.connect(chain.input);
    chain.output.connect(fader).connect(output);
    return { chain, fader };
  });
  let active = 0;
  let busyUntil = -Infinity;   // a switch is still fading: the other copy is not silent yet
  return {
    input,
    output,
    get nodes() { return [input, output, ...copies.flatMap(c => [...c.chain.nodes, c.fader])]; },
    get active() { return active; },
    dispose() {
      input.disconnect(); output.disconnect();
      for (const c of copies) { c.chain.dispose(); c.fader.disconnect(); }
    },
    update(next, { when = ctx.currentTime, tau = 0.025 } = {}) {
      copies[active].chain.update(next, { when, tau });
    },
    /**
     * @param {object} [o]
     * @param {number} [o.fade]  cross-fade time constant (s); ~3× is the audible length
     * @param {number} [o.settle] wait (s) between setting the silent copy and starting the fade
     * @returns {boolean} false when a previous switch was still fading (then it glides instead)
     */
    switchTo(next, { when = ctx.currentTime, fade = 0.012, settle = 0.005 } = {}) {
      if (when < busyUntil) { copies[active].chain.update(next, { when, tau: fade }); return false; }
      const from = copies[active], to = copies[1 - active];
      to.chain.update(next, { when, tau: 0 });
      for (const [copy, target] of [[from, 0], [to, 1]]) {
        copy.fader.gain.cancelScheduledValues(when);
        copy.fader.gain.setTargetAtTime(target, when + settle, fade);
      }
      active = 1 - active;
      busyUntil = when + settle + fade * 7;
      return true;
    },
  };
}

// Automatable numbers of a stage list in the order buildStages creates their AudioParams
// (biquad: frequency, Q, gain; gain: value; mix: per branch its weight, then the branch's own).
export function stageNumbers(stages, out = []) {
  for (const stage of stages) {
    if (stage.kind === 'biquad') out.push(stage.frequency, stage.Q, stage.gain);
    else if (stage.kind === 'gain') out.push(stage.value);
    else if (stage.kind === 'wahFilter') out.push(stage.frequency, stage.cents, stage.qScale);
    else if (stage.kind === 'wahGain') out.push(fromDb(stage.compDb), wahSlope(stage) / WAH_COMP_SPAN);
    else if (stage.kind === 'mix') {
      for (const branch of stage.branches) { out.push(branch.weight); stageNumbers(branch.stages, out); }
    }
  }
  return out;
}

// Everything update() cannot glide (kinds, filter types, curves, oversampling), as a string.
export function shapeOf(stages) {
  return JSON.stringify(stages, (key, value) => (
    ['frequency', 'Q', 'gain', 'value', 'weight', 'id', 'cents', 'qScale', 'compDb', 'compSlope'].includes(key) && typeof value !== 'object' ? 0 : value));
}

/**
 * Runs the stages over one channel (a copy; the input is not modified). The shaper is applied
 * without oversampling, so aliasing above ~5 kHz differs from the browser; levels and envelopes
 * match closely. `wah` is the wah position: a number, or a per-sample track (the band-pass then
 * recomputes its coefficients every sample, as Chrome does for an a-rate parameter with an input).
 */
export function processStages(stages, input, sampleRate, { wah = 0.5 } = {}) {
  let out = Float32Array.from(input);
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
    } else if (stage.kind === 'wahFilter') {
      const fixed = typeof wah === 'number';
      let c = null, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < out.length; i++) {
        if (!c || !fixed) {
          const { frequency, Q } = wahStageAt(stage, wahPosition(wah, i));
          c = biquadCoefficients('bandpass', frequency, Q, 0, sampleRate);
        }
        const x = out[i];
        const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        out[i] = Math.abs(y) < 1e-30 ? 0 : y;
      }
    } else if (stage.kind === 'wahGain') {
      if (typeof wah === 'number') {
        const gain = wahStageAt(stage, wah).gain;
        for (let i = 0; i < out.length; i++) out[i] *= gain;
      } else {
        for (let i = 0; i < out.length; i++) out[i] *= wahStageAt(stage, wahPosition(wah, i)).gain;
      }
    } else if (stage.kind === 'mix') {
      // Silent branches (weight 0: a settled cross-fade) are skipped.
      const sum = new Float32Array(out.length);
      for (const branch of stage.branches) {
        if (!branch.weight) continue;
        const y = processStages(branch.stages, out, sampleRate, { wah });
        for (let i = 0; i < sum.length; i++) sum[i] += branch.weight * y[i];
      }
      out = sum;
    }
  }
  return out;
}

/**
 * Small-signal magnitude response (linear) of the stages at each frequency: biquad magnitudes,
 * gains, and each shaper's slope at rest.
 */
export function stagesResponse(stages, frequencies, sampleRate = 48000, { wah = 0.5 } = {}) {
  return frequencies.map(frequency => {
    let magnitude = 1;
    for (const stage of stages) {
      if (stage.kind === 'gain') magnitude *= Math.abs(stage.value);
      else if (stage.kind === 'wahGain') magnitude *= wahStageAt(stage, wah).gain;
      else if (stage.kind === 'wahFilter') {
        const { frequency: f0, Q } = wahStageAt(stage, wah);
        magnitude *= biquadMagnitude(biquadCoefficients('bandpass', f0, Q, 0, sampleRate), frequency, sampleRate);
      }
      else if (stage.kind === 'shaper') magnitude *= curveSlope(stageCurve(stage));
      else if (stage.kind === 'biquad') {
        magnitude *= biquadMagnitude(biquadCoefficients(stage.type, stage.frequency, stage.Q ?? 1, stage.gain ?? 0, sampleRate), frequency, sampleRate);
      } else if (stage.kind === 'mix') {
        // Branch magnitudes summed (exact for a settled cross-fade, where one branch has weight 1).
        magnitude *= stage.branches.reduce((sum, b) => sum + Math.abs(b.weight) * stagesResponse(b.stages, [frequency], sampleRate, { wah })[0], 0);
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
 * The wah (a filter with its own loudness compensation) only counts with `frequency`, at w = 0.5.
 */
export function driveDb(stages, { frequency = null, sampleRate = 48000 } = {}) {
  // A mix counts as a clipper when a live branch clips; its gain is then the weighted sum of its
  // branches' gains up to their last clipper.
  const clips = stage => stage.kind === 'shaper'
    || (stage.kind === 'mix' && stage.branches.some(b => b.weight && b.stages.some(clips)));
  let last = -1;
  stages.forEach((stage, i) => { if (clips(stage)) last = i; });
  if (last < 0) return 0;
  const strip = list => list
    .filter(s => frequency !== null || !['biquad', 'wahFilter', 'wahGain'].includes(s.kind))
    .map(s => (s.kind === 'mix' ? { ...s, branches: s.branches.map(b => ({ ...b, stages: strip(b.stages) })) } : s));
  const [magnitude] = stagesResponse(strip(stages.slice(0, last + 1)), [frequency ?? 1000], sampleRate);
  return 20 * Math.log10(Math.max(1e-12, magnitude));
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
