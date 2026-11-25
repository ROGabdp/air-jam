// node tools/tone-lab/measure.mjs [--repeats 6] [--combo labC] [--seconds 16]
// Offline measurements of the tone lab combos 甲乙丙丁 with the Node model (model.mjs), using the
// challenge doc's metrics (docs/效果器_設計挑戰.md 4.3). Mix metrics use the owner's local songs
// (samples/s14.wav, s21.wav, 10–26 s; git-ignored, never committed) when present, else the
// built-in demo song. Prints one table per song plus the song-independent rows.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '../../src/settings.js';
import { LAB_COMBOS, LAB_ORDER, boosterStages } from '../../src/core/audio/tone-lab.js';
import { renderDemoSong } from '../../src/core/song/demo-song.js';
import { measureTone, TARGETS } from '../../src/lab/metrics.js';
import { modelRenderer, seeded } from './model.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const repeats = Number(option('repeats', 6));
const seconds = Number(option('seconds', 16));
const only = option('combo', null);
const SAMPLE_RATE = 44100;

function readWavStereo(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: not a WAV file`);
  let o = 12, fmt = null, data = null;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') data = b.subarray(o + 8, Math.min(b.length, o + 8 + size));
    o += 8 + size + (size & 1);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error(`${path}: expected 16-bit PCM`);
  const frames = Math.floor(data.length / 2 / fmt.channels);
  const left = new Float32Array(frames), right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = data.readInt16LE(i * 2 * fmt.channels) / 32768;
    right[i] = data.readInt16LE((i * fmt.channels + (fmt.channels > 1 ? 1 : 0)) * 2) / 32768;
  }
  return { left, right, sampleRate: fmt.rate };
}

function section(song, from, length) {
  const a = Math.round(from * song.sampleRate), b = a + Math.round(length * song.sampleRate);
  return { left: song.left.slice(a, b), right: song.right.slice(a, b), sampleRate: song.sampleRate };
}

const songs = [];
for (const [file, bpm] of [['s14.wav', 160], ['s21.wav', 104.9]]) {
  const path = join(process.env.AIRJAM_SAMPLES ?? join(root, 'samples'), file);
  if (!existsSync(path)) continue;
  const song = readWavStereo(path);
  if (song.sampleRate !== SAMPLE_RATE) { console.warn(`${file}: ${song.sampleRate} Hz, expected ${SAMPLE_RATE}; skipped`); continue; }
  songs.push({ name: file, bpm, section: section(song, 10, seconds) });
}
if (!songs.length) {
  const demo = renderDemoSong(SAMPLE_RATE);
  songs.push({ name: 'demo', bpm: 100, section: section({ left: demo.samples, right: demo.samples, sampleRate: SAMPLE_RATE }, 10, seconds) });
}

const ids = only ? [only] : LAB_ORDER;
const results = {};
const started = Date.now();
for (const id of ids) {
  const tone = LAB_COMBOS[id];
  results[id] = {};
  for (const song of songs) {
    results[id][song.name] = await measureTone({
      render: modelRenderer(SETTINGS, SAMPLE_RATE), tone, settings: SETTINGS, song: song.section,
      repeats, mixSeconds: seconds, bpm: song.bpm, booster: tone.stages?.[0]?.type === 'lowshelf' ? boosterStages() : null,
      random: seeded(7),
    });
  }
}

const f = (v, digits = 1) => (v === null || v === undefined || Number.isNaN(v) ? '–' : v.toFixed(digits));
const name = id => `${LAB_COMBOS[id].letter} ${id}`;
const first = id => results[id][songs[0].name];
const rows = [
  ['drive (dB, gains × clipper slopes)', '甲 24 → 乙 ~46', id => f(first(id).drive)],
  ['choke depth setting (dB at the voice)', '', id => f(first(id).releaseDepthDb, 0)],
  ['level drop 0.03→0.5 s (dB)', `≤ ${TARGETS.levelDrop}`, id => f(first(id).levelDrop)],
  ['velocity 0.1 vs 1.0 at 0.25 s (dB)', `≤ ${TARGETS.velocitySpread}`, id => f(first(id).velocitySpread)],
  ['2nd harmonic, worst crossing (dB)', `≥ ${TARGETS.secondHarmonic}`, id => f(first(id).secondHarmonicWorst)],
  ['  at 0.5 / 0.3 / 0.1', '', id => [0.5, 0.3, 0.1].map(p => f(first(id).secondHarmonic[p])).join(' / ')],
  ['chord choke at 80 ms, 8 strings vel 1 (dB)', `≥ ${TARGETS.chokeDepth}`, id => f(first(id).chokeDepth)],
  ['strum choke at its fade time (dB)', '', id => f(first(id).strumChokeDepth)],
  ['sustain, −10 / −20 dB points (s)', '1 bar: s21 2.29, s14 1.5', id => `${f(first(id).sustain, 2)} / ${f(first(id).sustain20, 2)}`],
  ['60–300 Hz share (%)', `≥ ${TARGETS.lowShare} if "thick"`, id => f(first(id).lowShare)],
  ['booster notch 100 Hz–5 kHz (dB)', `≤ ${TARGETS.boosterNotch}`, id => f(first(id).boosterNotch)],
];
for (const song of songs) {
  rows.push([`[${song.name}] guitar vs song RMS (dB)`, '≈ 0 after matching', id => f(results[id][song.name].guitarVsSong)]);
  rows.push([`[${song.name}] mix peak`, `≤ ${TARGETS.peak}`, id => f(results[id][song.name].peak, 3)]);
  rows.push([`[${song.name}] limiter reduction (dB)`, `≤ ${TARGETS.limiter}`, id => f(-results[id][song.name].limiterDb)]);
  rows.push([`[${song.name}] level-matched: peak / limiter (dB)`, `≤ ${TARGETS.peak} / ≤ ${TARGETS.limiter}`,
    id => `${f(results[id][song.name].matched.peak, 3)} / ${f(-results[id][song.name].matched.limiterDb)}`]);
}
const table = rows.map(([metric, target, value]) => {
  const row = { metric, target };
  for (const id of ids) row[name(id)] = value(id);
  return row;
});
console.log(`Tone lab measurements (Node model, ${SAMPLE_RATE} Hz, ${repeats} repeats, mix ${seconds} s of ${songs.map(s => s.name).join(', ')} from 10 s; `
  + `eighth notes at the song's tempo)`);
console.table(table);
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s. Model limits: no 4× oversampling; compressors approximate (see model.mjs).`);
