// node tools/tone-lab/measure.mjs [--set rig|lab|all|wah|sustain] [--repeats 6] [--combo labC] [--seconds 16]
// Offline measurements with the Node model (model.mjs), using the challenge doc's metrics
// (docs/效果器_設計挑戰.md 4.3) plus crunch indicators. --set rig (default): the game's electric rig
// with the pedalboard presets 清音／微破／搖滾／重金屬 and both ends of the drive range (overdrive and
// distortion on, knobs at 0 / at 1), next to 甲 and 丁 for reference; --set lab: 甲乙丙丁. Mix metrics
// use the owner's local songs (samples/s14.wav, s21.wav, 10–26 s; git-ignored, never committed)
// when present, else the built-in demo song.
// --set wah: the wah pedal (src/core/audio/wah.js): centre frequency, Q, compensation and the peak of
// the small-signal response at each position; level with the wah on minus off by position (presets,
// 範圍 0 / 0.5 / 1; five power chords); and peak / limiter reduction against the songs with the pedal
// held at heel, middle, toe, in auto mode (跟刷弦) and in 跟拍子.
// --set sustain: the amp's 延音 knob (karplus.js SUSTAINER): −10 / −20 dB decay times by knob for
// 清音／搖滾／重金屬, the chokes at 0 and max, ringing chords (one strum a bar) against the songs
// (peak, limiter), and main-thread time per 8-string strum (head render, fake context) by knob.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '../../src/settings.js';
import { LAB_COMBOS, LAB_ORDER, boosterStages } from '../../src/core/audio/tone-lab.js';
import { rigFromSnapshot, rigStages, electricTone, rigDriveDb } from '../../src/core/audio/electric-rig.js';
import { createPedalModel, PRESETS } from '../../src/core/pedals/model.js';
import { renderDemoSong } from '../../src/core/song/demo-song.js';
import { measureTone, measureSustain, TARGETS, strum, A5_EIGHT } from '../../src/lab/metrics.js';
import { createAudioEngine } from '../../src/core/audio/engine.js';
import { TONES } from '../../src/core/audio/tones.js';
import { sustainerSettings } from '../../src/core/audio/karplus.js';
import { FakeAudioContext } from '../../tests/fake-audio-context.mjs';
import { modelRenderer, seeded, renderPart, renderMaster } from './model.mjs';
import { wahFrequency, wahQ, createWahControl, simulateParam } from '../../src/core/audio/wah.js';
import { stagesResponse } from '../../src/core/audio/stages.js';
import { chug, A5, rms, peakOf } from '../../src/lab/metrics.js';
import { wahLevelRows } from './calibrate-level.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const repeats = Number(option('repeats', 6));
const seconds = Number(option('seconds', 16));
const only = option('combo', null);
const set = option('set', 'rig');
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

// Candidates: lab combos by id, and rig settings as pedalboard snapshots.
const CANDIDATES = {};
for (const id of LAB_ORDER) CANDIDATES[id] = { name: `${LAB_COMBOS[id].letter} ${id}`, tone: LAB_COMBOS[id], booster: LAB_COMBOS[id].stages?.[0]?.type === 'lowshelf' ? boosterStages() : null };
const presetLabel = { clean: '清音', crunch: '微破', rock: '搖滾', metal: '重金屬' };
const rigCandidate = (key, name, snapshot) => {
  const rig = rigFromSnapshot(snapshot);
  const od = rigStages(rig)[0].branches[1];
  CANDIDATES[key] = { name, tone: electricTone(rig), booster: rig.overdrive.on ? od.stages : null, rig };
};
for (const preset of PRESETS) {
  const model = createPedalModel();
  model.applyPreset(preset.id);
  rigCandidate(preset.id, presetLabel[preset.id] ?? preset.id, model.snapshot());
}
for (const [key, name, value] of [['driveMin', 'drive min', 0], ['driveMax', 'drive max', 1]]) {
  const model = createPedalModel();
  model.applyPreset('rock');
  model.setParam('overdrive', 'drive', value);
  model.setParam('distortion', 'drive', value);
  rigCandidate(key, name, model.snapshot());
}
const SETS = { rig: ['labA', 'labD', ...PRESETS.map(p => p.id), 'driveMin', 'driveMax'], lab: LAB_ORDER };
SETS.all = [...new Set([...SETS.lab, ...SETS.rig])];

if (set === 'sustain') {
  await measureSustainKnob();
  process.exit(0);
}

async function measureSustainKnob() {
  const started = Date.now();
  const knobs = [0, 0.25, 0.5, 0.75, 1];
  const snapshotOf = (preset, sustain) => {
    const model = createPedalModel();
    model.applyPreset(preset);
    model.setParam('amp', 'sustain', sustain);
    return model.snapshot();
  };
  const toneOf = (preset, sustain) => electricTone(rigFromSnapshot(snapshotOf(preset, sustain)));
  const db = x => 20 * Math.log10(x);

  // 1. Decay times by knob (one 4-string A5 strum, velocity 0.6; 12 s so long tails are not cut).
  const decay = [];
  for (const preset of ['clean', 'rock', 'metal']) {
    const row = { preset: presetLabel[preset] };
    for (const k of knobs) {
      const r = await measureSustain({ render: modelRenderer(SETTINGS, SAMPLE_RATE), tone: toneOf(preset, k), repeats: 3, seconds: 12 });
      row[`延音 ${k}`] = `${r.sustain.toFixed(2)} / ${r.sustain20.toFixed(2)}`;
    }
    decay.push(row);
  }
  const max = sustainerSettings(1);
  console.log(`Sustain: seconds until 10 / 20 dB below the strum's peak (Node, ${SAMPLE_RATE} Hz; 延音 1 = ratio ${max.ratio}, make-up ≤ ${max.makeupDb} dB)`);
  console.table(decay);

  // 2. Chokes at 延音 0 and 1: chord change at 80 ms, new strum at 30 / 50 ms (8 strings, velocity 1).
  const render = modelRenderer(SETTINGS, SAMPLE_RATE);
  const chokes = [];
  for (const preset of ['clean', 'rock', 'metal']) for (const k of [0, 1]) {
    const tone = toneOf(preset, k);
    const hard = strum(A5_EIGHT, { velocity: 1 });
    const chord = await render({ tone, events: hard, chokes: [{ time: 0.4, keep: [] }], duration: 0.6 });
    const all = await render({ tone, events: hard, chokes: [{ time: 0.4, all: true, fade: tone.strumChoke }], duration: 0.6 });
    const at = (out, ms) => -db(rms(out, 0.4 + ms / 1000, 0.41 + ms / 1000) / rms(out, 0.38, 0.4));
    chokes.push({
      preset: presetLabel[preset], '延音': k, 'chord change 80 ms (dB, ≥ 40)': +at(chord, 80).toFixed(0),
      'new strum 30 ms (dB)': +at(all, 30).toFixed(0), 'new strum 50 ms (dB)': +at(all, 50).toFixed(0),
    });
  }
  console.log('Chokes with the knob at 0 and 1:');
  console.table(chokes);

  // 3. Ringing chords against the songs: one 8-string strum a bar, chord change on the bar.
  const rows = [];
  for (const song of songs) {
    const bar = 4 * 60 / song.bpm;
    const events = [], changes = [];
    for (let t = 0, i = 0; t < seconds - 0.5; t += bar, i++) {
      if (i) changes.push({ time: t, keep: [] });
      events.push(...strum(A5_EIGHT, { time: t, velocity: 0.8 }));
    }
    const row = { song: song.name };
    for (const preset of ['clean', 'rock', 'metal']) for (const k of [0, 1]) {
      const part = renderPart(toneOf(preset, k), events, { duration: seconds, chokes: changes, settings: SETTINGS, sampleRate: SAMPLE_RATE, seed: 5 });
      const mix = renderMaster(part, song.section, { sampleRate: SAMPLE_RATE, settings: SETTINGS });
      let limiter = 0;
      for (let i = SAMPLE_RATE; i < mix.reductionDb.length; i++) limiter = Math.min(limiter, mix.reductionDb[i]);
      row[`${presetLabel[preset]} ${k}`] = `${peakOf(mix).toFixed(3)} / ${(-limiter).toFixed(1)} / ${db(rms(part, 0.5)).toFixed(1)}`;
    }
    rows.push(row);
  }
  console.log(`Ringing chords against the songs (one 8-string strum a bar, ${seconds} s from 10 s) at 延音 0 and 1: `
    + 'mix peak / limiter reduction (dB) / guitar RMS (dB). Targets: peak ≤ 0.99, limiter ≲ 3 dB.');
  console.table(rows);

  // 4. Main-thread time per 8-string strum (the head render; tails come later in ≤ 4 ms slices).
  const timeStrum = k => {
    const ctx = new FakeAudioContext();
    const engine = createAudioEngine(SETTINGS, { context: ctx, streaming: true });
    engine.setTone(TONES.electric);
    engine.applyPedals(snapshotOf('rock', k));
    const times = [];
    for (let i = 0; i < 40; i++) {
      ctx.currentTime = i * 0.4;
      const t0 = performance.now();
      for (const freq of A5_EIGHT) engine.pluck({ freq, velocity: 0.7 });
      if (i >= 10) times.push(performance.now() - t0);
      if (i % 4 === 3) engine.flushTails();
    }
    times.sort((a, b) => a - b);
    return times;
  };
  for (const k of knobs) timeStrum(k);   // warm up
  const cpu = knobs.map(k => {
    const times = timeStrum(k);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    return { '延音': k, 'mean (ms)': +mean.toFixed(2), 'median (ms)': +times[times.length >> 1].toFixed(2), 'worst (ms)': +times.at(-1).toFixed(2) };
  });
  console.log('Main-thread time per 8-string strum, head only (Node, fake AudioContext; see 設計說明 15.1.5 for Chrome):');
  console.table(cpu);
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
}

if (set === 'wah') {
  await measureWah();
  process.exit(0);
}

async function measureWah() {
  const started = Date.now();
  const snapshotOf = (preset, params = {}, on = true) => {
    const model = createPedalModel();
    model.applyPreset(preset);
    model.toggle('wah', on);
    for (const [knob, value] of Object.entries(params)) model.setParam('wah', knob, value);
    return model.snapshot();
  };
  // 1. Frequency response by position (default 範圍; the clean amp after it).
  const rig = rigFromSnapshot(snapshotOf('clean', { mode: 0 }));
  const stages = rigStages(rig);
  const wahStages = stages[0].branches[1].stages;
  const freqs = Array.from({ length: 600 }, (_, i) => 60 * Math.pow(2, i / 75));
  const peakOfResponse = (list, w) => {
    const r = stagesResponse(list, freqs, SAMPLE_RATE, { wah: w });
    const i = r.indexOf(Math.max(...r));
    return { hz: freqs[i], db: 20 * Math.log10(r[i]) };
  };
  const sweep = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].map(w => {
    const alone = peakOfResponse(wahStages, w), chain = peakOfResponse(stages, w);
    return {
      w, 'centre (Hz)': Math.round(wahFrequency(rig.wah, w)), Q: +wahQ(rig.wah, w).toFixed(2),
      'compensation (dB)': +(rig.wah.compDb + rig.wah.compSlope * w).toFixed(1),
      'wah peak (Hz / dB)': `${Math.round(alone.hz)} / ${alone.db.toFixed(1)}`,
      'clean chain peak (Hz)': Math.round(chain.hz),
    };
  });
  console.log(`Wah frequency response (Node, ${SAMPLE_RATE} Hz; default 範圍 = ${Math.round(rig.wah.lowHz)}–${Math.round(rig.wah.highHz)} Hz; `
    + `compensation ${rig.wah.compDb.toFixed(1)} ${rig.wah.compSlope.toFixed(1)}·w dB)`);
  console.table(sweep);

  // 2. Level, wah on − off, by position.
  const levels = [];
  for (const preset of PRESETS) for (const range of [0, 0.5, 1]) {
    const rows = wahLevelRows(on => snapshotOf(preset.id, { mode: 0, range }, on), { seconds: 3 });
    levels.push({ preset: presetLabel[preset.id] ?? preset.id, '範圍': range, ...Object.fromEntries(rows.map((v, i) => [`w ${i / 4}`, +v.toFixed(1)])) });
  }
  console.log('Level with the wah on minus off (dB; eighth-note strums on E5 G5 A5 C5 D5, velocity 0.6, simple mode):');
  console.table(levels);

  // 3. Against the songs: peak and limiter, pedal held or moving.
  const rows = [];
  for (const song of songs) {
    const events = chug(A5.slice(0, 4), { bpm: song.bpm, seconds, velocity: 0.6 });
    for (const preset of ['clean', 'rock', 'metal']) {
      const cases = [['off', null], ['heel', 0], ['middle', 0.5], ['toe', 1], ['auto', 'strum'], ['跟拍子', 'beat']];
      const row = { song: song.name, preset: presetLabel[preset] };
      for (const [label, how] of cases) {
        const params = how === 'beat' ? { mode: 1, source: 1 } : how === 'strum' ? { mode: 1 } : { mode: 0 };
        const snapshot = snapshotOf(preset, params, how !== null);
        if (how === 'beat') snapshot.mode = 'advanced';
        const r = rigFromSnapshot(snapshot);
        let wah = typeof how === 'number' ? how : 0.5;
        if (typeof how === 'string') {
          const control = createWahControl();
          const calls = [...control.configure(r.wah, 0)];
          if (how === 'strum') for (const e of events) calls.push(...control.pluck(e.time, e.velocity));
          else for (let t = 0; t < seconds; t += 1 / 60) calls.push(...control.frame(t, at => ({ beats: at * song.bpm / 60, beatSeconds: 60 / song.bpm })));
          wah = simulateParam(calls, { sampleRate: SAMPLE_RATE, duration: seconds });
        }
        const part = renderPart(electricTone(r), events, { duration: seconds, settings: SETTINGS, sampleRate: SAMPLE_RATE, seed: 5, wah });
        const mix = renderMaster(part, song.section, { sampleRate: SAMPLE_RATE, settings: SETTINGS });
        let limiter = 0;
        for (let i = SAMPLE_RATE; i < mix.reductionDb.length; i++) limiter = Math.min(limiter, mix.reductionDb[i]);
        row[label] = `${peakOf(mix).toFixed(3)} / ${(-limiter).toFixed(1)} / ${(20 * Math.log10(rms(part, 0.5))).toFixed(1)}`;
      }
      rows.push(row);
    }
  }
  console.log(`Against the songs (${songs.map(s => s.name).join(', ')}, ${seconds} s from 10 s; eighth-note A5 at the song's tempo): `
    + 'mix peak / limiter reduction (dB) / guitar RMS (dB). Targets: peak ≤ 0.99, limiter ≲ 3 dB.');
  console.table(rows);
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s. The Node model has no 4× oversampling and approximate compressors (model.mjs).`);
}

const ids = only ? [only] : SETS[set] ?? SETS.rig;
const results = {};
const started = Date.now();
for (const id of ids) {
  const { tone, booster } = CANDIDATES[id];
  results[id] = {};
  for (const song of songs) {
    results[id][song.name] = await measureTone({
      render: modelRenderer(SETTINGS, SAMPLE_RATE), tone, settings: SETTINGS, song: song.section,
      repeats, mixSeconds: seconds, bpm: song.bpm, booster,
      random: seeded(7),
    });
  }
}

const f = (v, digits = 1) => (v === null || v === undefined || Number.isNaN(v) ? '–' : v.toFixed(digits));
const name = id => CANDIDATES[id].name;
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
  ['crunch: distortion products, two-tone (dB)', 'higher = more broken', id => f(first(id).distortion)],
  ['crunch: products above 1.5 kHz (dB)', 'higher = more fizz', id => f(first(id).fizz)],
  ['voicing', '', id => (CANDIDATES[id].rig ? (CANDIDATES[id].rig.engaged ? 'power' : 'triad') : CANDIDATES[id].tone.voicing)],
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
console.log(`Electric tone measurements (Node model, ${SAMPLE_RATE} Hz, ${repeats} repeats, mix ${seconds} s of ${songs.map(s => s.name).join(', ')} from 10 s; `
  + `eighth notes at the song's tempo)`);
console.table(table);
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s. Model limits: no 4× oversampling; compressors approximate (see model.mjs).`);
