// 合聲 (chorus) — post-effects slot 1 of 3 (chorus → delay → reverb), after the amp/cab and both takes.
// Interface and on/off rules: ./index.js; design: docs/設計說明.md 15.1.7.
//
// An analog (bucket-brigade) chorus in the CE-2 manner (docs/效果器研究.md sections 1 and 4): a short
// delay whose time a triangle LFO sweeps, mixed with the dry signal; the pitch wobble of the delayed
// copy against the dry one is the shimmer. Built once at create:
//
//   input ─► dry (unity) ──────────────────────────────────────────────────────────► output
//     └──► send (mono) ► high-pass 150 Hz ► low-pass (tone) ┬► delay A ► pan −width ┐
//                                                           └► delay B ► pan +width ┴► wet ► output
//   LFO (triangle, rate) ► +depth ► delay A.delayTime;  LFO ► −depth ► delay B.delayTime
//
// - Delay 11 ms ± depth (0–4 ms, so 7–15 ms): the classic chorus window (below ~5 ms it turns into a
//   flanger, above ~20 ms into a slap-back double). The two lines sweep in opposite directions (LFO
//   phase 180°) and are panned apart by 寬度, so the shimmer moves across the stereo field.
// - The swept delay detunes the copy by |d delay / dt| = 4 · rate · depth (triangle). It is capped at
//   CHORUS.maxDetune by shrinking the depth at high rates, so no knob corner turns the chorus into a
//   seasick vibrato.
// - Only the wet is band-limited: the high-pass keeps the lows centred and solid (a swept low end
//   sounds wobbly and eats headroom), the low-pass is the BBD's darker, warmer copy (音色 knob).
// - Dry stays at unity: on/off and 混合 move only the wet gain, with setTargetAtTime; off at create =
//   wet exactly 0, so the slot is x · 1 + 0. The advanced mode's 音量 is the pedal's output level: it
//   scales dry and wet while the pedal is on and goes back to exactly 1 when it is switched off.
//   Simple mode never moves the dry gain.
// - No look-ahead: the dry path has no delay.
import { biquadCoefficients } from '../stages.js';

export const id = 'chorus';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
const logScale = ([lo, hi], v) => lo * Math.pow(hi / lo, clamp(v, 0, 1));
const linScale = ([lo, hi], v) => lo + (hi - lo) * clamp(v, 0, 1);
const logKnob = ([lo, hi], value) => Math.log(value / lo) / Math.log(hi / lo);

/** Knob ranges (physical units; model.js builds the pedal's knobs from these). */
export const CHORUS_RANGES = {
  rateHz: [0.1, 5],        // LFO rate (log)
  depthMs: [0, 4],         // LFO amplitude around CHORUS.centreMs
  mixPercent: [0, 50],     // wet / (dry + wet): 50 % = as loud as the dry, the CE-2's fixed mix
  toneHz: [1500, 8000],    // wet low-pass (log)
  widthPercent: [0, 100],  // stereo spread of the two swept copies
  levelDb: [-12, 6],       // output level (advanced mode)
};

/** Fixed design numbers. */
export const CHORUS = {
  centreMs: 11,
  highpassHz: 150,
  maxDetune: 0.03,         // |d delay / dt| ≤ 3 % (≈ 50 cents at most, on the straight parts of the sweep)
  maxDelaySeconds: 0.03,   // DelayNode capacity (centre + depth = 15 ms at most)
  q: 20 * Math.log10(Math.SQRT1_2),   // Web Audio Q in dB: −3.01 dB = Butterworth
  snapTaus: 12,            // after switching off, snap the faded gains to exactly 0 / 1 this many τ later
};

/** Default knob positions (0..1), chosen for 清音 and 搖滾 (docs/設計說明.md 15.1.7). */
export const CHORUS_DEFAULT_KNOBS = {
  rate: logKnob(CHORUS_RANGES.rateHz, 0.8),
  depth: 0.5,              // ±2 ms → ≈ 11 cents at 0.8 Hz
  mix: 0.8,                // 40 % → wet gain 0.67
  tone: logKnob(CHORUS_RANGES.toneHz, 4000),
  width: 1,
  level: 2 / 3,            // 0 dB
};

/**
 * Pure: the chorus's numbers for a pedal ({ on, params } from a snapshot, or null = defaults).
 * Simple mode shows 速度 and 深度; the other knobs keep their defaults there (like the wah).
 * @returns {{ rateHz, depthMs, wet, toneHz, width, outGain }}
 *   depthMs: the LFO amplitude actually used (after the detune cap); wet: wet gain against a unity
 *   dry; width: 0..1 (pan of the two copies); outGain: the advanced 音量 (1 in simple mode).
 */
export function chorusSettings(pedal, { advanced = false } = {}) {
  const knob = name => clamp(pedal?.params?.[name] ?? CHORUS_DEFAULT_KNOBS[name], 0, 1);
  const adv = name => (advanced ? knob(name) : CHORUS_DEFAULT_KNOBS[name]);
  const rateHz = logScale(CHORUS_RANGES.rateHz, knob('rate'));
  const depthKnobMs = linScale(CHORUS_RANGES.depthMs, knob('depth'));
  const depthMs = Math.min(depthKnobMs, (CHORUS.maxDetune / (4 * rateHz)) * 1000);
  const mix = linScale(CHORUS_RANGES.mixPercent, adv('mix')) / 100;
  return {
    rateHz,
    depthMs,
    wet: mix / (1 - mix),
    toneHz: logScale(CHORUS_RANGES.toneHz, adv('tone')),
    width: linScale(CHORUS_RANGES.widthPercent, adv('width')) / 100,
    outGain: advanced ? Math.pow(10, linScale(CHORUS_RANGES.levelDb, knob('level')) / 20) : 1,
  };
}

/** Pure: the pedal's numbers from a board snapshot; off for null, an off pedal or one without sound. */
export function paramsFromSnapshot(snapshot) {
  const pedal = snapshot?.pedals?.chorus;
  return {
    on: pedal?.on === true && pedal?.sound === true,
    values: { ...(pedal?.values ?? {}) },
    settings: chorusSettings(pedal ?? null, { advanced: snapshot?.mode === 'advanced' }),
  };
}

/** Targets of every smoothed parameter for params (off: wet 0, dry 1; the rest follows the knobs). */
export function chorusTargets(params) {
  const s = params?.settings ?? chorusSettings(null);
  const on = params?.on === true;
  return {
    wet: on ? s.wet * s.outGain : 0,
    dry: on ? s.outGain : 1,
    rate: s.rateHz,
    depth: s.depthMs / 1000,
    tone: s.toneHz,
    width: s.width,
  };
}

export function create(ctx, { input, output }) {
  const dry = ctx.createGain();
  input.connect(dry);
  dry.connect(output);

  const send = ctx.createGain();
  send.channelCount = 1;                  // stereo → mono, (L + R) / 2
  send.channelCountMode = 'explicit';
  send.channelInterpretation = 'speakers';
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = CHORUS.highpassHz;
  highpass.Q.value = CHORUS.q;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.Q.value = CHORUS.q;
  const lfo = ctx.createOscillator();
  lfo.type = 'triangle';
  const wet = ctx.createGain();
  wet.gain.value = 0;                     // off at create: the slot is exactly x · 1 + 0
  const lines = [-1, 1].map(sign => {
    const delay = ctx.createDelay(CHORUS.maxDelaySeconds);
    delay.delayTime.value = CHORUS.centreMs / 1000;
    const depth = ctx.createGain();
    const pan = ctx.createStereoPanner();
    lowpass.connect(delay);
    lfo.connect(depth);
    depth.connect(delay.delayTime);
    delay.connect(pan);
    pan.connect(wet);
    return { sign, delay, depth, pan };
  });
  input.connect(send);
  send.connect(highpass);
  highpass.connect(lowpass);
  wet.connect(output);

  // Everything but the gains starts on the defaults, so the first switch-on only fades the wet in.
  const initial = chorusTargets(null);
  lfo.frequency.value = initial.rate;
  lowpass.frequency.value = initial.tone;
  for (const line of lines) {
    line.depth.gain.value = line.sign * initial.depth;
    line.pan.pan.value = line.sign * initial.width;
  }
  lfo.start();

  // Only targets that changed are rescheduled: applyPedals comes at frame rate while the wah strip
  // moves, and a glide in progress must keep running as it was.
  const scheduled = { ...initial, wet: 0, dry: 1 };
  const automated = {
    wet: [[wet.gain, 1]], dry: [[dry.gain, 1]], rate: [[lfo.frequency, 1]], tone: [[lowpass.frequency, 1]],
    depth: lines.map(l => [l.depth.gain, l.sign]), width: lines.map(l => [l.pan.pan, l.sign]),
  };
  // Faded out → exactly 0 (wet) and 1 (dry) a while later, so an off pedal is bit-exact again.
  const snaps = { wet: 0, dry: 1 };
  return {
    nodes: { dry, send, highpass, lowpass, lines, lfo, wet },
    apply(params, change, { now = ctx.currentTime, tau = 0.012 } = {}) {
      const t = chorusTargets(params);
      for (const [key, list] of Object.entries(automated)) {
        if (t[key] === scheduled[key]) continue;
        scheduled[key] = t[key];
        for (const [param, sign] of list) {
          param.cancelScheduledValues(now);
          param.setTargetAtTime(sign * t[key], now, tau);
          if (snaps[key] === t[key]) param.setValueAtTime(t[key], now + CHORUS.snapTaus * tau);
        }
      }
    },
    dispose() {
      try { lfo.stop(); } catch { /* not started */ }
      for (const node of [dry, send, highpass, lowpass, lfo, wet, ...lines.flatMap(l => [l.delay, l.depth, l.pan])]) node.disconnect();
      input.disconnect(dry);
      input.disconnect(send);
    },
  };
}

// ---------- Node model ----------

// One biquad in direct form I (as Web Audio runs it), coefficients swappable per block.
const biquadState = () => ({ x1: 0, x2: 0, y1: 0, y2: 0 });
function biquadStep(c, s, x) {
  const y = c.b0 * x + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;
  s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y;
  return y;
}
const SNAPS = { wet: 0, dry: 1 };

// Web Audio's triangle starts at 0 going up, like a sine.
export const triangle = phase => 4 * Math.abs((((phase - 0.25) % 1) + 1) % 1 - 0.5) - 1;

/**
 * Node model of the slot with parameter automation, as create() + apply() schedule it: every
 * parameter follows its target like setTargetAtTime (one-pole per sample), the gains snap to 0 / 1
 * CHORUS.snapTaus · τ after a switch-off, the low-pass is updated per 128-sample block, delays read
 * with linear interpolation, panning is Web Audio's equal-power panning of a mono source.
 * @param {{ left: Float32Array, right: Float32Array }} signal
 * @param {object} o
 * @param {number} o.sampleRate
 * @param {{ time: number, params: object, tau?: number }[]} [o.changes]  apply() calls (seconds)
 * @param {object} [o.initial]  params already settled at time 0 (default: off, the state at create)
 * @returns {{ left, right, trace: { wet, dry, rate, depth, tone, width, delayMs: [min, max] }[] }}
 *   trace: one entry per 128-sample block (values at the block start; delayMs: range of delay B over
 *   the block, delay A is its mirror image around CHORUS.centreMs)
 */
export function renderChorus(signal, { sampleRate, changes = [], initial = null }) {
  const { left: inL, right: inR } = signal;
  const length = inL.length;
  const outL = new Float32Array(length), outR = new Float32Array(length);
  const cur = chorusTargets(initial);
  const target = { ...cur };
  const coef = Object.fromEntries(Object.keys(cur).map(key => [key, 0]));   // per-sample one-pole
  const snapAt = { wet: Infinity, dry: Infinity };
  const queue = [...changes].sort((a, b) => a.time - b.time);
  let next = 0;

  const size = Math.ceil(CHORUS.maxDelaySeconds * sampleRate) + 4;
  const buffer = new Float32Array(size);
  let write = 0;
  const hpC = biquadCoefficients('highpass', CHORUS.highpassHz, CHORUS.q, 0, sampleRate);
  const hp = biquadState(), lp = biquadState();
  let lpC = null, lpHz = NaN;
  let phase = 0;
  const trace = [];
  const centre = CHORUS.centreMs / 1000;
  const read = delaySamples => {
    const pos = write - delaySamples;
    const i0 = Math.floor(pos), frac = pos - i0;
    const a = buffer[((i0 % size) + size) % size], b = buffer[(((i0 + 1) % size) + size) % size];
    return a + (b - a) * frac;
  };

  for (let i = 0; i < length; i++) {
    const time = i / sampleRate;
    while (next < queue.length && queue[next].time <= time) {
      const change = queue[next++];
      const tau = change.tau ?? 0.012;
      const t = chorusTargets(change.params);
      for (const key in t) {
        if (t[key] === target[key]) continue;     // as create(): unchanged glides keep their τ
        target[key] = t[key];
        coef[key] = 1 - Math.exp(-1 / (tau * sampleRate));
        if (key in snapAt) snapAt[key] = t[key] === SNAPS[key] ? change.time + CHORUS.snapTaus * tau : Infinity;
      }
    }
    for (const key in cur) cur[key] += (target[key] - cur[key]) * coef[key];
    for (const key in snapAt) if (time >= snapAt[key]) { cur[key] = SNAPS[key]; snapAt[key] = Infinity; }
    if (i % 128 === 0) {
      if (cur.tone !== lpHz) { lpHz = cur.tone; lpC = biquadCoefficients('lowpass', lpHz, CHORUS.q, 0, sampleRate); }
      trace.push({ wet: cur.wet, dry: cur.dry, rate: cur.rate, depth: cur.depth, tone: cur.tone, width: cur.width, delayMs: [Infinity, -Infinity] });
    }
    buffer[write % size] = biquadStep(lpC, lp, biquadStep(hpC, hp, (inL[i] + inR[i]) / 2));
    const sweep = cur.depth * triangle(phase);
    phase = (phase + cur.rate / sampleRate) % 1;
    const block = trace[trace.length - 1].delayMs;
    let wetL = 0, wetR = 0;
    for (const sign of [-1, 1]) {
      const seconds = centre + sign * sweep;
      if (sign > 0 && seconds * 1000 < block[0]) block[0] = seconds * 1000;
      if (sign > 0 && seconds * 1000 > block[1]) block[1] = seconds * 1000;
      const y = read(seconds * sampleRate);
      const p = (sign * cur.width + 1) / 2;
      wetL += y * Math.cos(p * Math.PI / 2);
      wetR += y * Math.sin(p * Math.PI / 2);
    }
    write++;
    outL[i] = inL[i] * cur.dry + wetL * cur.wet;
    outR[i] = inR[i] * cur.dry + wetR * cur.wet;
  }
  return { left: outL, right: outR, trace };
}

/** Node model: off returns the signal unchanged; on renders the pedal settled from the start. */
export function process(params, signal, { sampleRate = 48000 } = {}) {
  if (!params?.on) return signal;
  const { left, right } = renderChorus(signal, { sampleRate, initial: params });
  return { left, right };
}
