// node tests/analysis.test.mjs [--verbose]
// Synthesises backing tracks with known tempo/chords and checks what the analysis recovers.
import { analyzeSync } from '../src/core/analysis/analysis.js';
import { renderBacking } from '../src/core/song/backing-synth.js';
import { renderBand } from './realistic-song.mjs';
import { DEMO, compareWithTruth } from '../src/core/song/demo-song.js';
import { chordName, parseChord } from '../src/core/music/theory.js';

const verbose = process.argv.includes('--verbose');
const key = name => parseChord(name);

const CASES = [
  { name: 'demo  C-G-Am-F 100 BPM', song: { ...DEMO }, key: 'C', need: { bpm: 1, chords: 0.95, beats: 0.95 } },
  { name: 'demo at 48 kHz', song: { ...DEMO, sampleRate: 48000 }, key: 'C', need: { bpm: 1, chords: 0.95, beats: 0.95 } },
  {
    name: 'A-E-F#m-D 128 BPM, hats+melody+noise',
    song: { bpm: 128, progression: ['A', 'E', 'F#m', 'D'], bars: 24, leadIn: 0.37, hats: 1, melody: 1, noise: 0.02, key: key('A'), seed: 11 },
    key: 'A', need: { bpm: 2, chords: 0.8, beats: 0.9 },
  },
  {
    name: 'Dm-Bb-F-C 84 BPM, split bars, noisy',
    song: { bpm: 84, progression: ['Dm', 'Bb', ['F', 'C'], 'Dm', 'Gm', 'Bb', 'F', ['C', 'A']], bars: 16, leadIn: 1.1, hats: 0.8, melody: 0.8, noise: 0.04, key: key('Dm'), seed: 23 },
    key: 'Dm', need: { bpm: 2, chords: 0.75, beats: 0.9 },
  },
  {
    name: 'Em-C-G-D 152 BPM, loud drums',
    song: { bpm: 152, progression: ['Em', 'C', 'G', 'D'], bars: 32, leadIn: 0.2, drums: 1.6, hats: 1.2, melody: 0.6, noise: 0.03, key: key('Em'), seed: 5 },
    key: 'Em', need: { bpm: 3, chords: 0.75, beats: 0.9 },
  },
  {
    name: 'F#-C#-D#m-B 93 BPM, no drums',
    song: { bpm: 93, progression: ['F#', 'C#', 'D#m', 'B'], bars: 16, leadIn: 0.8, drums: 0, melody: 0.7, noise: 0.01, key: key('F#'), seed: 3 },
    key: 'F#', need: { bpm: 2, chords: 0.75, beats: 0.85 },
  },
  {
    name: 'G-Em-C-D 78 BPM, no drums, busy melody',
    song: { bpm: 78, progression: ['G', 'Em', 'C', 'D'], bars: 16, leadIn: 0.5, drums: 0, melody: 1, noise: 0.01, key: key('G'), seed: 9 },
    key: 'G', need: { bpm: 2, chords: 0.75, beats: 0.85 },
  },
  {
    name: 'Cm-Ab-Eb-Bb 172 BPM, drums+hats',
    song: { bpm: 172, progression: ['Cm', 'G#', 'D#', 'A#'], bars: 32, leadIn: 0.3, hats: 1, melody: 0.8, noise: 0.02, key: key('Cm'), seed: 4 },
    key: 'Cm', need: { bpm: 3, chords: 0.75, beats: 0.9 },
  },
];

// Closer to real recordings (tests/realistic-song.mjs): strummed/arpeggiated plucked guitar, seventh
// chords and inversions, a vibrato "vocal" holding non-chord tones, swing, tempo drift and a
// drums-only intro bar (no chord expected there). The thresholds are regression floors a little
// under what the analysis achieves today, not a claim that these results are good.
const POP = [['Cmaj7'], ['Am7'], ['Dm7'], ['G7'], ['C/E'], ['F'], ['Dm7'], ['G7'], ['Cmaj7'], ['Am7'], ['F', 'G'], ['C'], ['Am'], ['Em/G'], ['F'], ['G7']];
const POP_TRIADS = POP.map(bar => bar.map(name => name.replace(/maj7|m7|7|\/[A-G]#?/g, m => (m === 'm7' ? 'm' : ''))));
const POP_BAND = { bpm: 96, endBpm: 101, swing: 0.6, introBars: 1, seed: 3 };
const BALLAD = { bpm: 70, endBpm: 68, drums: false, guitar: 'arpeggio', introBars: 1, seed: 8,
  bars: [['C'], ['G/B'], ['Am'], ['Em/G'], ['F'], ['C/E'], ['Dm7'], ['G7'], ['C'], ['G/B'], ['Am'], ['Em/G'], ['F'], ['C/E'], ['Dm7', 'G7'], ['C']] };
CASES.push(
  {
    name: 'band: triads, swing, drift 96→101, drum intro, soft vocal',
    render: () => renderBand({ ...POP_BAND, bars: POP_TRIADS, vocal: 0.3 }),
    key: 'C', need: { bpm: 2, chords: 0.85, beats: 0.9 },
  },
  {
    name: 'band: 7ths + inversions, soft vocal',
    render: () => renderBand({ ...POP_BAND, bars: POP, vocal: 0.3 }),
    key: 'C', need: { bpm: 2, chords: 0.35, beats: 0.9 },
  },
  {
    name: 'band: 7ths + inversions, loud vocal',
    render: () => renderBand({ ...POP_BAND, bars: POP, vocal: 1 }),
    key: 'C', need: { bpm: 2, chords: 0.1, beats: 0.9 },
  },
  {
    name: 'ballad 70→68: arpeggios, slash chords, loud vocal',
    render: () => renderBand({ ...BALLAD, vocal: 1.6 }),
    key: 'C', need: { bpm: 2, octave: true, chords: 0.3, beats: 0.9 },
  },
);

let failed = 0;
const table = [];
for (const test of CASES) {
  const { samples, sampleRate, truth } = test.render ? test.render() : renderBacking(test.song);
  const started = performance.now();
  const analysis = analyzeSync(samples, sampleRate);
  const ms = performance.now() - started;
  const result = compareWithTruth(analysis, truth);
  const keyName = chordName(analysis.key);
  // Half or double tempo still lines up with every beat; some cases accept it (see README limits).
  const bpmOk = [1, ...(test.need.octave ? [2, 0.5] : [])]
    .some(factor => Math.abs(result.bpm - truth.bpm * factor) <= test.need.bpm * factor);
  const ok = bpmOk
    && result.chordAccuracy >= test.need.chords
    && result.beatRecall >= test.need.beats;
  if (!ok) failed++;
  table.push({
    case: test.name,
    'BPM (truth)': `${result.bpm.toFixed(2)} (${+truth.bpm.toFixed(2)})`,
    'key (truth)': `${keyName} (${test.key})`,
    'chords/beat': `${(100 * result.chordAccuracy).toFixed(0)}%`,
    'beats ±70ms': `${(100 * result.beatRecall).toFixed(0)}%`,
    'offset ms': `${result.beatOffsetMs.toFixed(1)} (|${result.beatAbsOffsetMs.toFixed(1)}|)`,
    downbeat: `${(100 * result.downbeatAccuracy).toFixed(0)}%`,
    'time ms': ms.toFixed(0),
    ok: ok ? 'PASS' : 'FAIL',
  });
  if (verbose || !ok) console.table(result.rows);
}
console.table(table);
if (failed) { console.error(`${failed} case(s) below threshold`); process.exit(1); }
console.log('analysis tests passed');
