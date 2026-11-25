// The wah pedal (娃娃音) of the electric rig. Pure: knob mapping, loudness compensation, and the
// controller that moves the pedal position w (0 = heel, dark; 1 = toe, bright) from the edge strip
// (hand), from the player's strums (auto) or from the song's beat grid (auto, 跟拍子).
//
// Sound (stages.js 'wahFilter' + 'wahGain', placed before the overdrive as on a real board): a
// resonant band-pass after Julius O. Smith's digital CryBaby approximation, centre
// fr = 450·2^(2.3·w) Hz and Q = 2^(2(1−w)+1) (8 at the heel → 2 at the toe). Smith's version is a
// two-pole resonator with one zero at DC; Web Audio's band-pass biquad has the same poles, a zero
// at DC and one at Nyquist (the same skirts in the guitar range) and a peak gain of exactly 1 at
// any Q, so the level can be compensated separately and exactly ('wahGain', a line in dB over w).
//
// The position is one AudioParam per engine part (a ConstantSourceNode's offset) that every wah
// stage reads through fixed curves, so moving it never touches the rest of the chain and every
// move is a setTargetAtTime (no steps). The controller below only produces AudioParam calls;
// simulateParam() replays them sample by sample for tests and Node measurements.
import { biquadCoefficients, biquadMagnitude, WAH_Q_EXPONENT } from './stages.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
const logScale = ([lo, hi], v) => lo * Math.pow(hi / lo, clamp(v, 0, 1));
const logKnob = ([lo, hi], value) => Math.log(value / lo) / Math.log(hi / lo);

// Smith's CryBaby: 450 Hz → 2216 Hz (2.3 octaves), Q 8 → 2.
export const SMITH = { lowHz: 450, octaves: 2.3, qScale: 2 };

/**
 * Knob ranges (the pedal model stores 0..1). Simple mode: 範圍 widens or narrows the sweep around
 * Smith's geometric centre (≈ 1 kHz), 0.5 = Smith. Advanced: heel and toe frequencies, resonance
 * (× on Q), auto sensitivity, attack and decay.
 */
export const WAH_RANGES = {
  octaves: [1.3, 3.3],
  lowHz: [250, 700],
  highHz: [1200, 3500],
  resonance: [0.5, 2],
  attackMs: [10, 100],
  decayMs: [60, 1000],
};
export const WAH_DEFAULT_KNOBS = {
  range: 0.5,
  low: logKnob(WAH_RANGES.lowHz, SMITH.lowHz),
  high: logKnob(WAH_RANGES.highHz, SMITH.lowHz * Math.pow(2, SMITH.octaves)),
  resonance: logKnob(WAH_RANGES.resonance, 1),
  sensitivity: 0.5,
  attack: logKnob(WAH_RANGES.attackMs, 30),
  decay: logKnob(WAH_RANGES.decayMs, 250),
};

/** Auto mode and the hand strip (seconds unless noted). */
export const WAH_MOTION = {
  rest: 0.1,             // auto: where the pedal rests between strums (mostly heel)
  handTau: 0.03,         // strip: glide time constant (smooths 30 fps camera steps)
  switchTau: 0.06,       // mode changes glide to the new place
  lfoTau: 0.02,          // 跟拍子: chase time constant; targets are taken this far ahead
  lfoCycle: 0.55,        // 跟拍子: one sweep lasts the power-of-two number of beats closest to this
  strumWindow: 0.14,     // plucks this close belong to one strum (SETTINGS.strumWindow)
};

const sensitivityGain = s => Math.pow(2, -1 + 3 * clamp(s, 0, 1));   // 0.5× … 4×; 0.5 → 1.41×

/**
 * Wah settings from the pedal's knobs. Simple mode reads 手控/自動 and 範圍 only; the advanced
 * knobs keep their defaults there (D-016: simple mode has at most two controls and sounds good).
 * @param {{ on: boolean, params: object }|null} pedal  snapshot.pedals.wah
 * @param {{ advanced?: boolean }} [o]
 */
export function wahSettings(pedal, { advanced = false } = {}) {
  const knob = (name, fallback) => clamp(pedal?.params?.[name] ?? fallback, 0, 1);
  const adv = (name, fallback) => (advanced ? knob(name, fallback) : fallback);
  let lowHz, highHz;
  if (advanced) {
    lowHz = logScale(WAH_RANGES.lowHz, knob('low', WAH_DEFAULT_KNOBS.low));
    highHz = logScale(WAH_RANGES.highHz, knob('high', WAH_DEFAULT_KNOBS.high));
  } else {
    const range = knob('range', WAH_DEFAULT_KNOBS.range);
    const octaves = WAH_RANGES.octaves[0] + (WAH_RANGES.octaves[1] - WAH_RANGES.octaves[0]) * range;
    lowHz = SMITH.lowHz * Math.pow(2, (SMITH.octaves - octaves) / 2);
    highHz = lowHz * Math.pow(2, octaves);
  }
  return {
    on: pedal?.on === true,
    mode: knob('mode', 1) >= 0.5 ? 'auto' : 'hand',
    source: adv('source', 0) >= 0.5 ? 'beat' : 'strum',
    position: knob('position', 0.5),
    lowHz,
    highHz,
    qScale: SMITH.qScale * logScale(WAH_RANGES.resonance, adv('resonance', WAH_DEFAULT_KNOBS.resonance)),
    gain: sensitivityGain(adv('sensitivity', WAH_DEFAULT_KNOBS.sensitivity)),
    attack: logScale(WAH_RANGES.attackMs, adv('attack', WAH_DEFAULT_KNOBS.attack)) / 1000,
    decay: logScale(WAH_RANGES.decayMs, adv('decay', WAH_DEFAULT_KNOBS.decay)) / 1000,
  };
}

export const wahFrequency = (wah, w) => wah.lowHz * Math.pow(wah.highHz / wah.lowHz, clamp(w, 0, 1));
export const wahQ = (wah, w) => wah.qScale * Math.pow(2, WAH_Q_EXPONENT * (1 - clamp(w, 0, 1)));

/**
 * Power spectrum of a typical strum at the wah's input (the part bus), in 1/6-octave bands (dB,
 * relative). Measured with tools/tone-lab/calibrate-level.mjs --wah (丁's strings and picking,
 * eighth-note downstrokes at 105 BPM, velocity 0.6, averaged over E5 G5 A5 C5 D5; both takes).
 */
export const STRUM_BANDS = { fromHz: 63, perOctave: 6, db: [
  -41.8, -40.2, -22.3, -23, -20, -19.6, -17.3, -16.6, -12.3, -19.6, -11.2, -10.7,
  -8.1, -6.9, -6.7, -13.5, -6.6, -3.9, -3.7, -4.6, -3.9, -6.7, -3.5, -2.7,
  -2.8, -2.3, -1.2, -2.5, -2.9, -1.5, -2.4, -0.5, 0, -1, -1.2, -1,
  -1.5, -1.3, -1.9, -2.5, -3, -3.3,
] };

/**
 * Loudness compensation of the band-pass for a typical strum: the gain (dB) that keeps the wah as
 * loud as the bypass, as a line compDb + compSlope·w fitted to the band-pass's power over the
 * strum spectrum at nine positions. Also returns the worst deviation of the line (dB).
 */
export function wahCompensation(wah, { bands = STRUM_BANDS, weight = null, sampleRate = 48000 } = {}) {
  const freqs = bands.db.map((_, i) => bands.fromHz * Math.pow(2, i / bands.perOctave));
  const power = bands.db.map((d, i) => Math.pow(10, d / 10) * (weight ? weight(freqs[i]) : 1));
  const total = power.reduce((a, b) => a + b, 0);
  if (!total) return { compDb: 0, compSlope: 0, errorDb: 0 };
  const ws = Array.from({ length: 9 }, (_, i) => i / 8);
  const need = ws.map(w => {
    const c = biquadCoefficients('bandpass', wahFrequency(wah, w), wahQ(wah, w), 0, sampleRate);
    const passed = freqs.reduce((sum, f, i) => sum + power[i] * biquadMagnitude(c, f, sampleRate) ** 2, 0);
    return -10 * Math.log10(Math.max(1e-12, passed / total));
  });
  const mw = ws.reduce((a, b) => a + b, 0) / ws.length, mn = need.reduce((a, b) => a + b, 0) / need.length;
  let sxy = 0, sxx = 0;
  ws.forEach((w, i) => { sxy += (w - mw) * (need[i] - mn); sxx += (w - mw) ** 2; });
  const compSlope = sxy / sxx, compDb = mn - compSlope * mw;
  const errorDb = Math.max(...need.map((n, i) => Math.abs(n - (compDb + compSlope * ws[i]))));
  return { compDb, compSlope, errorDb, need };
}

// ---------- the pedal position over time ----------

/** Beats per sweep for 跟拍子: the power of two (¼…4) whose length is closest to lfoCycle. */
export function beatsPerCycle(beatSeconds, target = WAH_MOTION.lfoCycle) {
  if (!(beatSeconds > 0)) return 1;
  return Math.pow(2, clamp(Math.round(Math.log2(target / beatSeconds)), -2, 2));
}

/**
 * 跟拍子 position at song beat position `beats` (continuous, counted from the bar line: beat in bar +
 * phase): the toe on every cycle start (a beat; for 2- and 4-beat cycles the downbeat), the heel
 * half a cycle later. The cycle is a power of two of beats chosen
 * from the beat length, so halving or doubling the tempo (the player's tempo buttons) keeps the
 * same sweep on the same pulse grid.
 */
export function lfoPosition(beats, beatSeconds) {
  const phase = beats / beatsPerCycle(beatSeconds);
  return 0.5 + 0.5 * Math.cos(2 * Math.PI * phase);
}

/**
 * Turns pedal settings, strip moves, strums and frames into AudioParam calls on the position
 * param: [{ type: 'cancel', time } | { type: 'target', value, time, tau } | { type: 'set', value, time }].
 * The engine performs them in order; simulateParam() replays them in Node.
 */
export function createWahControl({ strumWindow = WAH_MOTION.strumWindow } = {}) {
  let wah = wahSettings(null);
  let strum = null;          // { t0, peak }
  const glide = (value, time, tau) => [{ type: 'cancel', time }, { type: 'target', value, time, tau }];
  const auto = () => wah.on && wah.mode === 'auto';

  return {
    get settings() { return wah; },
    /**
     * New settings (every pedalboard change). Returns the calls for a mode change or a strip move.
     */
    configure(next, now) {
      const before = wah;
      wah = next;
      if (!next.on) return [];
      if (next.mode === 'hand') {
        const moved = before.mode !== 'hand' || !before.on;
        if (moved || before.position !== next.position) return glide(next.position, now, moved ? WAH_MOTION.switchTau : WAH_MOTION.handTau);
        return [];
      }
      if (before.mode !== 'auto' || !before.on || before.source !== next.source) {
        strum = null;
        return glide(WAH_MOTION.rest, now, WAH_MOTION.switchTau);
      }
      return [];
    },
    /**
     * A pluck at audio time `when` (velocity 0..1). In auto mode (跟刷弦) the first pluck of a strum
     * opens the pedal towards a peak set by velocity × sensitivity in `attack`, and it closes back
     * to rest over `decay`; louder plucks later in the same strum raise the peak.
     */
    pluck(when, velocity) {
      if (!auto() || wah.source !== 'strum') return [];
      const peak = WAH_MOTION.rest + (1 - WAH_MOTION.rest) * Math.min(1, Math.max(0, velocity) * wah.gain);
      if (strum && when - strum.last <= strumWindow && when >= strum.t0) {
        strum.last = when;
        if (peak <= strum.peak + 1e-6) return [];
        strum.peak = peak;
      } else {
        strum = { t0: when, last: when, peak };
      }
      const closeAt = Math.max(strum.t0 + wah.attack, when + wah.attack / 3);
      return [
        { type: 'cancel', time: when },
        { type: 'target', value: strum.peak, time: when, tau: wah.attack / 3 },
        { type: 'target', value: WAH_MOTION.rest, time: closeAt, tau: wah.decay / 3 },
      ];
    },
    /**
     * Every frame. 跟拍子: chase the beat-grid position a little ahead. `clock(time)` gives the beat
     * position at an audio time: { beats, beatSeconds } or null (no song: a free 100 BPM pulse).
     */
    frame(now, clock = null) {
      if (!auto() || wah.source !== 'beat') return [];
      const at = now + WAH_MOTION.lfoTau;
      const grid = clock?.(at) ?? { beats: at * 100 / 60, beatSeconds: 0.6 };
      return glide(lfoPosition(grid.beats, grid.beatSeconds), now, WAH_MOTION.lfoTau);
    },
  };
}

/**
 * Replays AudioParam calls (in call order, Web Audio semantics for cancel / set / setTarget) into a
 * per-sample track from 0 to `duration` seconds.
 */
export function simulateParam(calls, { sampleRate = 48000, duration, initial = 0.5 }) {
  let events = [];
  for (const call of calls) {
    if (call.type === 'cancel') events = events.filter(e => e.time < call.time);
    else events.push(call);
  }
  events.sort((a, b) => a.time - b.time);
  const track = new Float32Array(Math.round(duration * sampleRate));
  let value = initial, current = null, start = 0, next = 0;
  for (let i = 0; i < track.length; i++) {
    const t = i / sampleRate;
    while (next < events.length && events[next].time <= t) {
      current = events[next++];
      start = value;
      if (current.type === 'set') value = current.value;
    }
    if (current?.type === 'target') value = current.value + (start - current.value) * Math.exp(-(t - current.time) / current.tau);
    track[i] = value;
  }
  return track;
}
