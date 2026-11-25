// node tests/samples.test.mjs
// Local-only check on the owner's real songs (copyrighted, git-ignored, never committed).
// The test reads decoded WAV files and skips when they are missing. To make them:
//   ffmpeg -i "samples/sample 14.mp3" -ac 2 -ar 44100 samples/s14.wav
//   ffmpeg -i "samples/sample 21.mp3" -ac 2 -ar 44100 samples/s21.wav
// (AIRJAM_SAMPLES=<folder> reads them from somewhere else.)
//
// There is no ground truth for these songs. The references come from a separate measurement
// (docs/搖滾獨奏_設計挑戰.md 2.1): a steady pulse of 285.7 ms in s21 (12-bar blues at ~105 BPM) and
// 187.5 ms in s14 (160 or 80 BPM; which one is still to be confirmed by ear). The test checks that
// the beat is a whole number of those pulses and that the beats sit on an independently fitted
// pulse grid, i.e. no beat falls between two notes.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSync, retime } from '../src/core/analysis/analysis.js';
import { chordName } from '../src/core/music/theory.js';
import { powerChordAnalysis, allowedRoots } from '../src/core/music/power-chords.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const folder = process.env.AIRJAM_SAMPLES ?? join(root, 'samples');

const SONGS = [
  // beats: acceptable beat periods in ms (±3%); pulse: reference pulse in ms.
  { file: 's21.wav', pulse: 285.7, beats: [571.4, 285.7, 1142.9], note: '105 BPM (or 210/52.5, still on the pulse)' },
  { file: 's14.wav', pulse: 187.5, beats: [375, 750], note: '160 or 80 BPM' },
];
const PERIOD_TOLERANCE = 0.03;
const ALIGN_MS = 40;
const ALIGN_SHARE = 0.9;

function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: not a WAV file`);
  let o = 12, fmt = null, data = null;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(o + 8), channels: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') data = b.subarray(o + 8, Math.min(b.length, o + 8 + size));
    o += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${path}: missing fmt or data chunk`);
  const bytes = fmt.bits / 8, frames = Math.floor(data.length / bytes / fmt.channels);
  const read = fmt.format === 3 && fmt.bits === 32 ? i => data.readFloatLE(i * 4)
    : fmt.bits === 16 ? i => data.readInt16LE(i * 2) / 32768
      : fmt.bits === 24 ? i => data.readIntLE(i * 3, 3) / 8388608
        : null;
  if (!read) throw new Error(`${path}: unsupported WAV format (${fmt.format}, ${fmt.bits} bit)`);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) sum += read(i * fmt.channels + c);
    mono[i] = sum / fmt.channels;
  }
  return { samples: mono, sampleRate: fmt.rate };
}

// Independent reference: a broadband energy-rise envelope (5 ms hop) and the constant pulse grid
// near the reference period whose points collect the most onset strength.
function fitPulseGrid(samples, sampleRate, pulseMs) {
  const hop = Math.round(sampleRate * 0.005), size = hop * 4;
  const frames = Math.floor((samples.length - size) / hop);
  const env = new Float32Array(frames);
  let previous = 0;
  for (let f = 0; f < frames; f++) {
    let energy = 0;
    for (let i = f * hop; i < f * hop + size; i++) energy += samples[i] * samples[i];
    const level = Math.log(1e-9 + energy / size);
    env[f] = Math.max(0, level - previous);
    previous = level;
  }
  const hopSec = hop / sampleRate;
  const strength = (period, phase) => {
    let sum = 0;
    for (let t = phase; t < frames * hopSec; t += period) {
      const f = Math.round(t / hopSec);
      sum += Math.max(env[f - 1] ?? 0, env[f] ?? 0, env[f + 1] ?? 0);
    }
    return sum;
  };
  let best = { period: pulseMs / 1000, phase: 0, score: -Infinity };
  for (let period = pulseMs * 0.985 / 1000; period <= pulseMs * 1.015 / 1000; period += 0.00005) {
    for (let phase = 0; phase < period; phase += 0.002) {
      const score = strength(period, phase);
      if (score > best.score) best = { period, phase, score };
    }
  }
  // Onsets are registered at the energy rise; shift the grid to the frame centre.
  return { period: best.period, phase: best.phase + size / 2 / sampleRate };
}

function alignment(beats, grid, from = 0, to = Infinity) {
  let near = 0, count = 0;
  for (const time of beats) {
    if (time < from || time > to) continue;
    count++;
    const k = Math.round((time - grid.phase) / grid.period);
    if (Math.abs(time - (grid.phase + k * grid.period)) * 1000 <= ALIGN_MS) near++;
  }
  return count ? near / count : 0;
}

let failed = 0, ran = 0;
const table = [];
for (const song of SONGS) {
  const path = join(folder, song.file);
  if (!existsSync(path)) {
    console.log(`skip ${song.file}: not found in ${folder} (see the ffmpeg commands at the top of this file)`);
    continue;
  }
  ran++;
  const { samples, sampleRate } = readWav(path);
  const started = performance.now();
  const analysis = analyzeSync(samples, sampleRate);
  const ms = performance.now() - started;
  const grid = fitPulseGrid(samples, sampleRate, song.pulse);
  // Only beats inside the music count; the grid is extended through silent intros and outros.
  const beatMs = 60000 / analysis.bpm;
  const periodOk = song.beats.some(ref => Math.abs(beatMs / ref - 1) <= PERIOD_TOLERANCE);
  const aligned = alignment(analysis.beats, grid, 1, analysis.duration - 1);
  let ok = periodOk && aligned >= ALIGN_SHARE;

  const { grouping, meter, evidence } = analysis.autoTempo;
  console.log(`\n${song.file}: ${analysis.bpm.toFixed(2)} BPM (expected ${song.note}), key ${chordName(analysis.key)}, `
    + `pulse ${(analysis.pulse * 1000).toFixed(1)} ms (reference grid ${(grid.period * 1000).toFixed(1)} ms), `
    + `beat = ${grouping} pulses, ${meter}, bar ${analysis.barSeconds.toFixed(3)} s`);
  console.log(`  meter evidence: duple ${evidence.duple.toFixed(2)} triple ${evidence.triple.toFixed(2)}; `
    + `pulse-lag accents ${evidence.accents.join(' ')}; octave support ${evidence.support?.toFixed(2) ?? '-'} `
    + `bass ${evidence.bassSupport?.toFixed(2) ?? '-'}`);
  console.log(`  ${analysis.segments.length} chord segments: `
    + analysis.segments.map(s => `${s.name}@${s.start.toFixed(1)}`).join(' '));

  // Rock chord mode (electric tone): power chords from the triad roots, with and without the
  // in-key guard. Nothing outside the key's rock degrees may survive the guard.
  const raw = powerChordAnalysis(analysis, { guard: false });
  const guarded = powerChordAnalysis(analysis, { guard: true });
  const allowed = allowedRoots(analysis.key);
  const outOfKey = guarded.chords.filter(c => !allowed.includes(c.root)).length;
  const outBefore = raw.chords.filter(c => !allowed.includes(c.root)).length;
  console.log(`  power chords, no guard (${raw.segments.length}): ` + raw.segments.map(s => `${s.name}@${s.start.toFixed(1)}`).join(' '));
  console.log(`  power chords, key guard (${guarded.segments.length}, ${guarded.guard.replacedBeats} of ${analysis.chords.length} beats replaced; `
    + `allowed roots ${allowed.map(r => chordName({ root: r, minor: false })).join(' ')}): `
    + guarded.segments.map(s => `${s.name}@${s.start.toFixed(1)}`).join(' '));
  const guardOk = outOfKey === 0;

  // Manual corrections must stay on the same pulse grid.
  const corrections = [0.5, 2, 1.5, 2 / 3].map(factor => {
    const corrected = retime(analysis, { factor });
    return `×${+factor.toFixed(3)} → ${corrected.bpm.toFixed(1)} BPM, ${(100 * alignment(corrected.beats, grid, 1, analysis.duration - 1)).toFixed(0)}% on grid`;
  });
  console.log(`  manual: ${corrections.join('; ')}`);

  ok = ok && guardOk;
  if (!ok) failed++;
  table.push({
    song: song.file,
    BPM: analysis.bpm.toFixed(2),
    'beat ms': beatMs.toFixed(1),
    'pulse ms': (analysis.pulse * 1000).toFixed(1),
    'on pulse grid ±40ms': `${(100 * aligned).toFixed(1)}%`,
    'bar s': analysis.barSeconds.toFixed(3),
    key: chordName(analysis.key),
    segments: analysis.segments.length,
    'power segs (guarded)': `${raw.segments.length} (${guarded.segments.length})`,
    'out-of-key beats': `${outBefore} → ${outOfKey}`,
    'time ms': ms.toFixed(0),
    ok: ok ? 'PASS' : 'FAIL',
  });
}
if (table.length) console.table(table);
if (failed) { console.error(`${failed} sample(s) failed`); process.exit(1); }
console.log(ran ? 'sample tests passed' : 'sample tests skipped (no WAV files)');
