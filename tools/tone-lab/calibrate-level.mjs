// node tools/tone-lab/calibrate-level.mjs [--wah]
// Measures the electric rig's loudness for every overdrive × distortion drive state (Node model) and
// prints the auto-level table for src/core/audio/electric-rig.js (AUTO_LEVEL_DB), relative to 丁
// (the 搖滾 preset). Reference playing: eighth-note downstrokes of a 4-string A5 at 105 BPM,
// velocity 0.6, 4 s; RMS of the chain output (both takes) after the first 0.5 s, 3 seeds.
// --wah: instead prints the strum spectrum at the wah's input (src/core/audio/wah.js STRUM_BANDS),
// 1/6-octave bands from 63 Hz, which the wah's loudness compensation is fitted to: the same playing
// on five power chords (E5 G5 A5 C5 D5, 4 strings), averaged so no one chord's harmonics dominate.
// --wah-trim: prints the wah's output trim by drive state (electric-rig.js WAH_TRIM_DB): minus the
// mean over w = 0…1 of (wah on − wah off), same five chords, 3 s each.
import { SETTINGS } from '../../src/settings.js';
import { rigFromSnapshot, electricTone, DING_KNOBS, WAH_TRIM_GRID } from '../../src/core/audio/electric-rig.js';
import { chug, A5, rms, powerSpectrum } from '../../src/lab/metrics.js';
import { renderPart } from './model.mjs';
import { midiToFreq } from '../../src/core/music/theory.js';

// Five 4-string power chords (root, fifth, octave, fifth above) on the power-chord ladder from E2.
export const WAH_CHORDS = [40, 43, 45, 48, 50].map(root => [0, 7, 12, 19].map(i => midiToFreq(root + i)));

const GRID = [0, 0.25, 0.5, 0.75, 1];
const ZEROS = Array.from({ length: 6 }, () => new Array(6).fill(0));
const SAMPLE_RATE = 44100;
const events = chug(A5.slice(0, 4), { bpm: 105, seconds: 4, velocity: 0.6 });

/** A pedalboard snapshot with only the two drive pedals (null = off), and optionally the wah. */
export function driveSnapshot(od, dist, { odTone = DING_KNOBS.overdrive.tone, distTone = 0.5, wah = false } = {}) {
  return {
    autoLevel: true,
    mode: 'simple',
    pedals: {
      wah: { on: wah, params: { mode: 0, range: 0.5, position: 0.5 } },
      overdrive: { on: od !== null, params: { drive: od ?? DING_KNOBS.overdrive.drive, tone: odTone, level: 0.67 } },
      distortion: { on: dist !== null, params: { drive: dist ?? DING_KNOBS.distortion.drive, tone: distTone, level: 0.67 } },
    },
  };
}

export function loudnessDb(snapshot, { levelTable = ZEROS, seconds = 4 } = {}) {
  let sum = 0;
  for (const seed of [1, 2, 3]) {
    const tone = electricTone(rigFromSnapshot(snapshot, { levelTable }));
    const out = renderPart(tone, events.filter(e => e.time < seconds), { duration: seconds, settings: SETTINGS, sampleRate: SAMPLE_RATE, seed });
    sum += 20 * Math.log10(rms(out, 0.5));
  }
  return sum / 3;
}

/** Strum spectrum at the part bus (no chain), 1/6-octave bands 63 Hz … 8 kHz, dB relative to the loudest. */
export function strumBands({ fromHz = 63, perOctave = 6, toHz = 8000 } = {}) {
  const bare = electricTone();
  const tone = { ...bare, stages: [], double: { ...bare.double, stages: [] } };
  const count = Math.floor(perOctave * Math.log2(toHz / fromHz)) + 1;
  const power = new Array(count).fill(0);
  for (const [seed, chord] of WAH_CHORDS.entries()) {
    const out = renderPart(tone, chug(chord, { bpm: 105, seconds: 4, velocity: 0.6 }), { duration: 4, settings: SETTINGS, sampleRate: SAMPLE_RATE, seed: seed + 1 });
    const spectrum = powerSpectrum(out);
    spectrum.power.forEach((p, k) => {
      const f = k * spectrum.bin;
      const band = Math.round(perOctave * Math.log2(f / fromHz));
      if (f > 0 && band >= 0 && band < count) power[band] += p;
    });
  }
  const top = Math.max(...power);
  return { fromHz, perOctave, db: power.map(p => +(10 * Math.log10(Math.max(1e-12, p / top))).toFixed(1)) };
}

/**
 * Level (dB) of the wah on minus off, per position, for a snapshot builder (on) => snapshot,
 * averaged over the five chords. `trim` false: without the WAH_TRIM_DB table (calibration).
 */
export function wahLevelRows(snapshotOf, { positions = [0, 0.25, 0.5, 0.75, 1], seconds = 3, trim = true } = {}) {
  const zeros = Array.from({ length: 4 }, () => new Array(4).fill(0));
  const options = trim ? {} : { wahTrim: zeros };
  const level = (snapshot, wah) => WAH_CHORDS.reduce((sum, chord, k) => {
    const out = renderPart(electricTone(rigFromSnapshot(snapshot, options)), chug(chord, { bpm: 105, seconds, velocity: 0.6 }),
      { duration: seconds, settings: SETTINGS, sampleRate: SAMPLE_RATE, seed: k + 1, wah });
    return sum + 20 * Math.log10(rms(out, 0.5));
  }, 0) / WAH_CHORDS.length;
  const off = level(snapshotOf(false), 0.5);
  return positions.map(w => level(snapshotOf(true), w) - off);
}

const isMain = process.argv[1]?.endsWith('calibrate-level.mjs');
if (isMain && process.argv.includes('--wah-trim')) {
  const states = [null, ...WAH_TRIM_GRID];
  console.log('export const WAH_TRIM_DB = [');
  for (const od of states) {
    const row = states.map(dist => {
      const rel = wahLevelRows(on => driveSnapshot(od, dist, { wah: on }), { trim: false });
      return +(-rel.reduce((a, b) => a + b, 0) / rel.length).toFixed(1);
    });
    console.log(`  [${row.join(', ')}],`);
  }
  console.log('];');
} else if (isMain && process.argv.includes('--wah')) {
  const bands = strumBands();
  console.log(`export const STRUM_BANDS = { fromHz: ${bands.fromHz}, perOctave: ${bands.perOctave}, db: [`);
  for (let i = 0; i < bands.db.length; i += 12) console.log(`  ${bands.db.slice(i, i + 12).join(', ')},`);
  console.log('] };');
} else if (isMain) {
  const reference = loudnessDb(driveSnapshot(DING_KNOBS.overdrive.drive, DING_KNOBS.distortion.drive));
  const states = [null, ...GRID];
  const table = states.map(od => states.map(dist => +(reference - loudnessDb(driveSnapshot(od, dist))).toFixed(1)));
  console.log(`丁 reference loudness ${reference.toFixed(1)} dB (chain output RMS)`);
  console.log('export const AUTO_LEVEL_DB = [');
  for (const row of table) console.log(`  [${row.join(', ')}],`);
  console.log('];');
}
