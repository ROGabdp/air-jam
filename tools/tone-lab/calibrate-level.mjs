// node tools/tone-lab/calibrate-level.mjs
// Measures the electric rig's loudness for every overdrive × distortion drive state (Node model) and
// prints the auto-level table for src/core/audio/electric-rig.js (AUTO_LEVEL_DB), relative to 丁
// (the 搖滾 preset). Reference playing: eighth-note downstrokes of a 4-string A5 at 105 BPM,
// velocity 0.6, 4 s; RMS of the chain output (both takes) after the first 0.5 s, 3 seeds.
import { SETTINGS } from '../../src/settings.js';
import { rigFromSnapshot, electricTone, DING_KNOBS } from '../../src/core/audio/electric-rig.js';
import { chug, A5, rms } from '../../src/lab/metrics.js';
import { renderPart } from './model.mjs';

const GRID = [0, 0.25, 0.5, 0.75, 1];
const ZEROS = Array.from({ length: 6 }, () => new Array(6).fill(0));
const SAMPLE_RATE = 44100;
const events = chug(A5.slice(0, 4), { bpm: 105, seconds: 4, velocity: 0.6 });

/** A pedalboard snapshot with only the two drive pedals (null = off). */
export function driveSnapshot(od, dist, { odTone = DING_KNOBS.overdrive.tone, distTone = 0.5 } = {}) {
  return {
    autoLevel: true,
    pedals: {
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

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('calibrate-level.mjs')) {
  const reference = loudnessDb(driveSnapshot(DING_KNOBS.overdrive.drive, DING_KNOBS.distortion.drive));
  const states = [null, ...GRID];
  const table = states.map(od => states.map(dist => +(reference - loudnessDb(driveSnapshot(od, dist))).toFixed(1)));
  console.log(`丁 reference loudness ${reference.toFixed(1)} dB (chain output RMS)`);
  console.log('export const AUTO_LEVEL_DB = [');
  for (const row of table) console.log(`  [${row.join(', ')}],`);
  console.log('];');
}
