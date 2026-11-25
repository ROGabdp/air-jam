// The game's electric guitar: the tone lab's 丁 (labD) as a pedal rig. An amp and cabinet that are
// always on, with an overdrive (丁's booster) and a distortion (丁's second, harder clipper) in front
// of it, both switchable and turnable from the pedalboard (src/core/pedals/). Pure: maps a
// pedalboard snapshot to rig numbers (rigFromSnapshot) and the rig to a stage list (rigStages,
// stages.js), which builds the Web Audio graph in the browser and runs in Node for measurements.
//
// Every rig has the same stage-list shape, so a playing chain moves to new settings without being
// rebuilt (stages.js buildSwitchableStages): knobs glide (setTargetAtTime); a pedal switched on or
// off, or a preset, sets a silent second copy of the chain and cross-fades to it. Inside a copy a
// pedal's on/off is a branch weight of 0 or 1 (never in between while it is heard, so the bypass
// and clipper branches do not have to line up in time). Clipping curves never change; drive is the
// gain in front of them.
//
//   bus → [wah: bypass | band-pass + compensation] → [overdrive: bypass | booster] → tight HP, mid bump
//       → [distortion: clean | hard | fuzz] → cabinet (HP 75, thump, mud, presence, tilt, two LPs,
//       low restore) → level
//
// The wah's band-pass and compensation read the part's wah position signal (wah.js); its knobs
// are stage numbers like any other. Chorus, delay and reverb have no sound yet (owner decision:
// staged later); see PEDALS_WITH_SOUND in src/core/pedals/model.js.
import { clipCurve, curveSlope, chokeDepthDb } from './distortion.js';
import { driveDb, buildSwitchableStages } from './stages.js';
import { wahSettings, wahCompensation } from './wah.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
const fromDb = db => Math.pow(10, db / 20);
const biquad = (id, type, frequency, Q, gain) => ({ kind: 'biquad', id, type, frequency, Q, ...(gain !== undefined ? { gain } : {}) });

// 丁's booster (docs/效果器_設計挑戰.md S3: in series, low shelf down before the clipper and partly
// back after it, a gentle low-pass for the fizz). tone-lab.js re-exports it for 乙丙丁.
export const BOOSTER = { shelfHz: 700, cut: -12, gain: 4, drive: 2, restore: 6, toneHz: 3200 };
// 丁's amp and cabinet (tone-lab.js LAB_AMP_THICK; a test checks they stay equal).
export const AMP = {
  tightHz: 80, preMidHz: 750, preMidGain: 5, preGain: 10, drive: 3, bias: 0.08, clip: 'hard', clipN: 4,
  thumpHz: 150, thumpGain: 6, mudHz: 420, mudGain: 0, presenceHz: 1700, presenceGain: 3,
  cabHz: 4500, lowShelfHz: 250, lowShelfGain: 10, level: 0.2,
};
// 丁's strings and double-tracking (tone-lab.js uses the same values).
export const LONG_STRING = { t60: 6, damping: 0.15, brightness: 0.8, maxSeconds: 6 };
export const NEAR_BRIDGE = { mode: 'fixed', position: 0.15 };
export const DOUBLE = { pan: 0.7, delay: 0.014, detuneCents: 4, driveScale: 0.9, preMidShift: 100 };

const BOOST_CURVE = { kind: 'tanh', drive: BOOSTER.drive, bias: 0 };
const HARD_CURVE = { kind: 'hard', drive: AMP.drive, bias: AMP.bias, n: AMP.clipN };
// Top of the distortion range: harder knee, strongly asymmetric (see distortion.js fuzzCurve).
const FUZZ_CURVE = { kind: 'fuzz', drive: AMP.drive, n: 12, ceiling: 0.55 };
export const BOOST_SLOPE = curveSlope(clipCurve(BOOST_CURVE));
export const HARD_SLOPE = curveSlope(clipCurve(HARD_CURVE));
export const FUZZ_SLOPE = curveSlope(clipCurve(FUZZ_CURVE));

/**
 * Physical ranges of the pedal knobs (the pedal model's knobValue() gives the same numbers; the
 * model stores 0..1). Drive is the small-signal gain into the clipper (dB, at mid frequencies).
 * 丁 sits at overdrive 18.4 dB (knob 0.27) and distortion 27.7 dB (knob 0.49); the distortion goes
 * 18 dB past it, and over the top 30% of its knob blends into the fuzz clipper with up to 6 dB more.
 */
export const RANGES = {
  wah: { level: [-12, 6] },
  overdrive: { drive: [12, 36], tone: [-8, 6], level: [-12, 6] },
  distortion: { drive: [10, 46], tone: [0, 1], level: [-12, 6] },
};
export const FUZZ = { from: 0.7, max: 0.85, extraDb: 6, gritHz: 2500, gritDb: 5 };
// Amp tilt from a tone knob (0..1): ±TILT_DB at 1.5 kHz, half the opposite at 300 Hz.
export const TILT_DB = 6;
// Low restore after the clipper: 丁's +10 dB with the distortion on, less when clean.
export const LOW_RESTORE = { clean: 8, crunch: 9, distortion: AMP.lowShelfGain };

// Rig numbers for 丁 itself (the 搖滾 preset).
export const DING = {
  overdrive: { on: true, drive: 20 * Math.log10(BOOSTER.gain * BOOST_SLOPE), tone: 0, level: 0 },
  distortion: { on: true, drive: 20 * Math.log10(AMP.preGain * HARD_SLOPE), tone: 0.5, level: 0 },
};
const knobOf = (range, value) => (value - range[0]) / (range[1] - range[0]);
// 0..1 knob positions of 丁 (the pedal model's 搖滾 preset uses these).
export const DING_KNOBS = {
  overdrive: { drive: knobOf(RANGES.overdrive.drive, DING.overdrive.drive), tone: knobOf(RANGES.overdrive.tone, 0) },
  distortion: { drive: knobOf(RANGES.distortion.drive, DING.distortion.drive), tone: 0.5 },
};

/**
 * Auto-level (dB) by overdrive and distortion state, measured with tools/tone-lab/calibrate-level.mjs
 * (Node model: eighth-note 4-string A5 strums, velocity 0.6, RMS after the chain, both takes) so the
 * output stays as loud as 丁 whatever the drive. Rows: overdrive off, then knob 0, .25, .5, .75, 1;
 * columns: distortion off, then knob 0, .25, .5, .75, 1. Bilinear between knob points.
 */
export const AUTO_LEVEL_DB = [
  [20.8, 11.5, 4.7, 1.5, 0.5, -0.8],
  [11.7, 4.5, 1.2, 0.2, -0.1, -1.1],
  [6.4, 2.1, 0.4, 0, -0.2, -1.2],
  [2.2, 0.9, 0.1, -0.1, -0.2, -1.3],
  [-0.6, 0.3, -0.2, -0.3, -0.4, -1.4],
  [-2.2, 0, -0.3, -0.4, -0.5, -1.5],
];
const GRID = [0, 0.25, 0.5, 0.75, 1];

/**
 * Output trim (dB) while the wah is on, by drive state, so the wah stays as loud as the bypass after
 * the clippers (its own compensation matches the level going into them). Measured with
 * tools/tone-lab/calibrate-level.mjs --wah-trim: minus the mean over w = 0, .25, .5, .75, 1 of
 * (wah on − wah off), eighth-note strums on five power chords. Rows: overdrive off, then knob 0,
 * .5, 1; columns: distortion off, then knob 0, .5, 1.
 */
export const WAH_TRIM_DB = [
  [0, 0.1, 0.2, 0.4],
  [-0.4, 0.1, 0.3, 0.7],
  [-1.1, 0.2, 0.3, 0.8],
  [-2, 0.3, 0.5, 0.9],
];
export const WAH_TRIM_GRID = [0, 0.5, 1];

// Linear position of x in a grid of equally spaced knob points: [index, fraction].
function gridAt(x, grid = GRID) {
  const v = clamp(x, 0, 1) * (grid.length - 1);
  const i = Math.min(grid.length - 2, Math.floor(v));
  return [i, v - i];
}

/** Auto-level (dB) for pedal states { on, knob } (knob = the drive knob, 0..1). */
export function autoLevelDb(od, dist, table = AUTO_LEVEL_DB, grid = GRID) {
  const rows = od.on ? gridAt(od.knob, grid) : null, cols = dist.on ? gridAt(dist.knob, grid) : null;
  const cell = (r, c) => table[r][c];
  const rowValue = c => (rows ? cell(1 + rows[0], c) * (1 - rows[1]) + cell(2 + rows[0], c) * rows[1] : cell(0, c));
  if (!cols) return rowValue(0);
  return rowValue(1 + cols[0]) * (1 - cols[1]) + rowValue(2 + cols[0]) * cols[1];
}

// Loudness compensation of the wah for its frequencies and Q (memoised: the strip moves the
// position, not these, but snapshots arrive every frame while it moves).
const wahLevelCache = new Map();
function wahLevels(wah) {
  const key = `${wah.lowHz.toFixed(3)}|${wah.highHz.toFixed(3)}|${wah.qScale.toFixed(4)}`;
  let levels = wahLevelCache.get(key);
  if (!levels) {
    const { compDb, compSlope } = wahCompensation(wah);
    levels = { compDb, compSlope };
    if (wahLevelCache.size > 64) wahLevelCache.clear();
    wahLevelCache.set(key, levels);
  }
  return levels;
}

/**
 * Rig numbers from a pedalboard snapshot (src/core/pedals/model.js boardSnapshot). Without a
 * snapshot (no pedalboard on the page) the rig is 丁. Only `on` and the 0..1 `params` are read, so
 * the mapping does not depend on the model's display units.
 * @param {object|null} snapshot
 * @param {object} [o]
 * @param {number[][]} [o.levelTable]  auto-level table (calibration passes zeros)
 * @param {number[][]} [o.wahTrim]     wah output trim table (calibration passes zeros)
 */
export function rigFromSnapshot(snapshot, { levelTable = AUTO_LEVEL_DB, wahTrim = WAH_TRIM_DB } = {}) {
  const pedal = id => snapshot?.pedals?.[id] ?? null;
  const knob = (id, name, fallback) => clamp(pedal(id)?.params?.[name] ?? fallback, 0, 1);
  const scale = ([lo, hi], v) => lo + (hi - lo) * v;
  const od = pedal('overdrive'), dist = pedal('distortion');
  const odOn = snapshot ? od?.on === true : true;
  const distOn = snapshot ? dist?.on === true : true;
  const manual = snapshot ? snapshot.autoLevel === false : false;
  const odDrive = knob('overdrive', 'drive', DING_KNOBS.overdrive.drive);
  const distDrive = knob('distortion', 'drive', DING_KNOBS.distortion.drive);
  const odTone = knob('overdrive', 'tone', DING_KNOBS.overdrive.tone);
  const distTone = knob('distortion', 'tone', 0.5);
  const fuzz = FUZZ.max * Math.pow(clamp((distDrive - FUZZ.from) / (1 - FUZZ.from), 0, 1), 1.5);
  const wah = wahSettings(snapshot ? pedal('wah') : null, { advanced: snapshot?.mode === 'advanced' });
  // Clean amp: the mean of both tone knobs tilts it, so the brightness macro works in 清音 too.
  const tiltKnob = distOn ? distTone : (odTone + distTone) / 2;
  return {
    overdrive: {
      on: odOn,
      drive: scale(RANGES.overdrive.drive, odDrive),
      tone: scale(RANGES.overdrive.tone, odTone),
      level: manual ? scale(RANGES.overdrive.level, knob('overdrive', 'level', 0.67)) : 0,
    },
    distortion: {
      on: distOn,
      drive: scale(RANGES.distortion.drive, distDrive),
      fuzz,
      level: manual ? scale(RANGES.distortion.level, knob('distortion', 'level', 0.67)) : 0,
    },
    wah: {
      ...wah,
      ...wahLevels(wah),
      level: manual ? scale(RANGES.wah.level, knob('wah', 'level', 0.67)) : 0,
    },
    // 延音 (the amp's knob, 0 = off): a sustainer on each string (karplus.js SUSTAINER).
    sustain: clamp(snapshot?.amp?.params?.sustain ?? 0, 0, 1),
    tiltDb: TILT_DB * 2 * (tiltKnob - 0.5),
    lowRestoreDb: distOn ? LOW_RESTORE.distortion : odOn ? LOW_RESTORE.crunch : LOW_RESTORE.clean,
    levelDb: autoLevelDb({ on: odOn, knob: odDrive }, { on: distOn, knob: distDrive }, levelTable)
      + (wah.on ? autoLevelDb({ on: odOn, knob: odDrive }, { on: distOn, knob: distDrive }, wahTrim, WAH_TRIM_GRID) : 0),
    engaged: odOn || distOn,
  };
}

/**
 * Stage list of the rig for one take ('main', or 'double': the second take of the double-tracking
 * has 10% less distortion drive and its mid bump 100 Hz higher, like 丁's).
 */
export function rigStages(rig, take = 'main') {
  const double = take === 'double';
  const od = rig.overdrive, dist = rig.distortion;
  const odPre = fromDb(od.drive) / BOOST_SLOPE;
  const distPre = fromDb(dist.drive) / HARD_SLOPE * (double ? DOUBLE.driveScale : 1);
  const fuzzPre = fromDb(dist.drive + FUZZ.extraDb * (dist.fuzz / FUZZ.max)) / FUZZ_SLOPE * (double ? DOUBLE.driveScale : 1);
  const odWet = od.on ? fromDb(od.level) : 0;
  const distWet = dist.on ? fromDb(dist.level) : 0;
  const wah = rig.wah ?? rigFromSnapshot(null).wah;
  return [
    {
      kind: 'mix', id: 'wah', branches: [
        { id: 'wah.bypass', weight: wah.on ? 0 : 1, stages: [] },
        {
          id: 'wah.on', weight: wah.on ? fromDb(wah.level) : 0, stages: [
            { kind: 'wahFilter', id: 'wah.filter', frequency: wah.lowHz, cents: 1200 * Math.log2(wah.highHz / wah.lowHz), qScale: wah.qScale },
            { kind: 'wahGain', id: 'wah.comp', compDb: wah.compDb, compSlope: wah.compSlope },
          ],
        },
      ],
    },
    {
      kind: 'mix', id: 'overdrive', branches: [
        { id: 'overdrive.bypass', weight: od.on ? 0 : 1, stages: [] },
        {
          id: 'overdrive.on', weight: odWet, stages: [
            biquad('overdrive.shelf', 'lowshelf', BOOSTER.shelfHz, undefined, BOOSTER.cut),
            { kind: 'gain', id: 'overdrive.drive', value: odPre },
            { kind: 'shaper', id: 'overdrive.clip', curve: BOOST_CURVE, oversample: '4x' },
            biquad('overdrive.restore', 'lowshelf', BOOSTER.shelfHz, undefined, BOOSTER.restore),
            biquad('overdrive.smooth', 'lowpass', BOOSTER.toneHz, -3.01),
            biquad('overdrive.tone', 'highshelf', 2000, undefined, od.tone),
          ],
        },
      ],
    },
    biquad('amp.tight', 'highpass', AMP.tightHz, 0.7),
    biquad('amp.mid', 'peaking', AMP.preMidHz + (double ? DOUBLE.preMidShift : 0), 0.8, AMP.preMidGain),
    {
      kind: 'mix', id: 'distortion', branches: [
        { id: 'distortion.clean', weight: dist.on ? 0 : 1, stages: [] },
        {
          id: 'distortion.hard', weight: distWet * (1 - dist.fuzz), stages: [
            { kind: 'gain', id: 'distortion.drive', value: distPre },
            { kind: 'shaper', id: 'distortion.clip', curve: HARD_CURVE, oversample: '4x' },
          ],
        },
        {
          id: 'distortion.fuzz', weight: distWet * dist.fuzz, stages: [
            { kind: 'gain', id: 'distortion.fuzzDrive', value: fuzzPre },
            { kind: 'shaper', id: 'distortion.fuzzClip', curve: FUZZ_CURVE, oversample: '4x' },
            biquad('distortion.grit', 'highshelf', FUZZ.gritHz, undefined, FUZZ.gritDb),
          ],
        },
      ],
    },
    biquad('cab.low', 'highpass', 75, 0.7),
    biquad('cab.thump', 'peaking', AMP.thumpHz, 1.1, AMP.thumpGain),
    biquad('cab.mud', 'peaking', AMP.mudHz, 1.0, AMP.mudGain),
    biquad('cab.presence', 'peaking', AMP.presenceHz, 0.9, AMP.presenceGain),
    biquad('cab.tiltLow', 'lowshelf', 300, undefined, -rig.tiltDb / 2),
    biquad('cab.tiltHigh', 'highshelf', 1500, undefined, rig.tiltDb),
    biquad('cab.lp1', 'lowpass', AMP.cabHz, 0.9),
    biquad('cab.lp2', 'lowpass', AMP.cabHz * 1.25, 0.6),
    biquad('cab.lows', 'lowshelf', AMP.lowShelfHz, undefined, rig.lowRestoreDb),
    { kind: 'gain', id: 'level', value: AMP.level * fromDb(rig.levelDb) },
  ];
}

// Small-signal drive of a rig (dB, gains × clipper slopes up to the last clipper; 丁 ≈ 46 dB).
export const rigDriveDb = rig => driveDb(rigStages(rig));

// Voicing rule (owner decision): power chords only while drive (overdrive or distortion) is engaged.
export const rigVoicing = rig => (rig.engaged ? 'power' : 'triad');

/**
 * The tone (tones.js shape) for a rig: 丁's strings, picking, chokes and double-tracking, with the
 * rig's stage lists and a choke depth that follows its drive. The engine keeps one chain per take
 * and moves it with update() when the pedals change; Node renders `stages`/`double.stages`.
 */
export function electricTone(rig = rigFromSnapshot(null), fields = {}) {
  const stages = rigStages(rig);
  const doubleStages = rigStages(rig, 'double');
  return {
    id: 'electric',
    rig: true,
    voicing: 'auto',
    panWidth: 0.15,
    releaseDepthDb: chokeDepthDb(driveDb(stages)),
    chordChoke: 0.08,
    strumChoke: 0.03,
    pick: NEAR_BRIDGE,
    string: { ...LONG_STRING },
    sustain: rig.sustain ?? 0,
    stages,
    // controls: { wah } (the part's wah position signal, shared by both takes).
    createChain: (ctx, controls) => buildSwitchableStages(ctx, stages, controls),
    double: {
      pan: DOUBLE.pan, delay: DOUBLE.delay, detuneCents: DOUBLE.detuneCents, stages: doubleStages,
      createChain: (ctx, controls) => buildSwitchableStages(ctx, doubleStages, controls),
    },
    ...fields,
  };
}

/** Voicing of a tone for a pedalboard snapshot ('auto' tones follow the rig). */
export function toneVoicing(tone, snapshot) {
  if (tone?.voicing !== 'auto') return tone?.voicing ?? 'triad';
  return rigVoicing(rigFromSnapshot(snapshot));
}
