// Tone lab combos 甲乙丙丁 (docs/效果器_設計挑戰.md 4.2, first round): candidate electric tones for
// the owner to compare by ear. They are only used by the lab (?lab=1) and by ?tone=labA..labD; the
// game's default tones in tones.js are unchanged. Each combo adds one group of changes to the
// previous one, so a preference points at the change that caused it:
//   甲 labA  the current electric tone, as is
//   乙 labB  research plan only: a booster stage before the amp and a harder second clipper (~46 dB)
//   丙 labC  乙 + pick near the bridge (whatever the finger crossed), long sustain, strum choke
//   丁 labD  丙 + lows restored after the clipper, double-tracked (two takes panned apart)
import { TONES, RHYTHM_DISTORTION, ampStages } from './tones.js';
import { buildStages, driveDb } from './stages.js';
import { chokeDepthDb } from './distortion.js';

const biquad = (type, frequency, Q, gain) => ({ kind: 'biquad', type, frequency, Q, ...(gain !== undefined ? { gain } : {}) });

/**
 * Booster in series (the challenge's S3 recommendation instead of a parallel clean path, which
 * would comb-filter against the oversampled clipper's latency): a low shelf takes the lows down
 * before the gain so mostly the mids clip, then part of the lows comes back after the clipper,
 * and a gentle low-pass smooths the fizz. All BiquadFilterNodes, so the values can be smoothed later.
 */
export const BOOSTER = { shelfHz: 700, cut: -12, gain: 4, drive: 2, restore: 6, toneHz: 3200 };
export function boosterStages(o = BOOSTER) {
  return [
    biquad('lowshelf', o.shelfHz, undefined, o.cut),
    { kind: 'gain', value: o.gain },
    { kind: 'shaper', curve: { kind: 'tanh', drive: o.drive, bias: 0 }, oversample: '4x' },
    biquad('lowshelf', o.shelfHz, undefined, o.restore),
    biquad('lowpass', o.toneHz, -3.01),
  ];
}

// Second (amp) stage of 乙: the same amp and cabinet, a harder curve (n = 4) and a bit more gain.
export const LAB_AMP = { ...RHYTHM_DISTORTION, preGain: 10, drive: 3, clip: 'hard', clipN: 4, level: 0.2 };
// 丁: lows restored after the clipper. Pre-clip high-pass 110 → 80 Hz, +6 dB at 150 Hz (the
// cabinet thump a real amp has), no 420 Hz scoop, and a +10 dB low shelf at 250 Hz at the end.
// The challenge's starting values (+6 dB at 120–200 Hz only) left 60–300 Hz at ~5% of the energy
// in the Node model (the booster keeps lows out of the clipper, so little comes out of it); the
// shelf brings it to the ≥ 15% target.
export const LAB_AMP_THICK = { ...LAB_AMP, tightHz: 80, thumpHz: 150, thumpGain: 6, mudGain: 0, lowShelfHz: 250, lowShelfGain: 10 };
// 丁's second take: drive 10% lower and the pre-clip mid bump 100 Hz higher, so the sides differ.
export const LAB_AMP_THICK_DOUBLE = { ...LAB_AMP_THICK, preGain: LAB_AMP_THICK.preGain * 0.9, preMidHz: LAB_AMP_THICK.preMidHz + 100 };

const stagesB = [...boosterStages(), ...ampStages(LAB_AMP)];
const stagesD = [...boosterStages(), ...ampStages(LAB_AMP_THICK)];
const stagesDouble = [...boosterStages(), ...ampStages(LAB_AMP_THICK_DOUBLE)];

function combo(id, letter, fields) {
  const tone = { ...TONES.electric, id, letter, ...fields };
  // Choke depth follows the actual drive (40 dB audible + drive + 26 dB for stacked voices).
  if (fields.stages) tone.releaseDepthDb = chokeDepthDb(driveDb(fields.stages));
  tone.createChain = ctx => buildStages(ctx, tone.stages);
  if (tone.double) tone.double.createChain = ctx => buildStages(ctx, tone.double.stages);
  return tone;
}

// Long sustain: t60 4 s (the challenge's starting value) still fell 10 dB within ~1.4 s, because
// the harmonics that drive the clipper decay much faster than the fundamental; a lighter loop
// filter (damping 0.3 → 0.15) and t60 6 s keep a 4-string strum within 10 dB for ~2.1 s and
// within 20 dB for ~3 s (tools/tone-lab/measure.mjs).
const LONG_STRING = { ...TONES.electric.string, t60: 6, damping: 0.15, maxSeconds: 6 };
const NEAR_BRIDGE = { mode: 'fixed', position: 0.15 };

export const LAB_COMBOS = {
  labA: { ...TONES.electric, id: 'labA', letter: '甲' },
  labB: combo('labB', '乙', { stages: stagesB }),
  labC: combo('labC', '丙', { stages: stagesB, pick: NEAR_BRIDGE, string: LONG_STRING, strumChoke: 0.03 }),
  labD: combo('labD', '丁', {
    stages: stagesD, pick: NEAR_BRIDGE, string: LONG_STRING, strumChoke: 0.03,
    double: { stages: stagesDouble, pan: 0.7, delay: 0.014, detuneCents: 4 },
  }),
};

export const LAB_ORDER = ['labA', 'labB', 'labC', 'labD'];
