// Reproducible strum performances for the tone lab, following a song's analysed beats and power
// chords. Pure: given the beat grid, a chord lookup and a loop section, returns the plucks and the
// chord-change chokes, with times relative to the loop start. Every combo hears the same notes.
import { chordPitchClasses, powerChordNote, noteToMidi, midiToFreq } from '../core/music/theory.js';

export const PERFORMANCES = ['script', 'chug', 'ring'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bar starts (beat indices where beatInBar is 0) and a loop of `bars` bars from bar `fromBar`.
 * @returns {{ startBeat: number, endBeat: number, start: number, end: number, bar: number } | null}
 */
export function loopSection({ beats, beatInBar, duration }, fromBar, bars) {
  const starts = [];
  for (let i = 0; i < beats.length; i++) if (beatInBar[i] === 0) starts.push(i);
  if (starts.length < 2) return null;
  const last = starts.length - 1 - bars;
  const bar = Math.max(0, Math.min(fromBar, last));
  const startBeat = starts[bar];
  const endBeat = starts[Math.min(starts.length - 1, bar + bars)];
  const end = endBeat > startBeat ? beats[endBeat] : duration;
  return { startBeat, endBeat, start: beats[startBeat], end, bar, bars: Math.min(bars, starts.length - 1 - bar) };
}

/** First bar whose start is at or after `seconds` (the default lab section starts near 10 s). */
export function barAtOrAfter({ beats, beatInBar }, seconds) {
  let bar = -1;
  for (let i = 0; i < beats.length; i++) {
    if (beatInBar[i] !== 0) continue;
    bar++;
    if (beats[i] >= seconds) return bar;
  }
  return 0;
}

// Eighth-note grid of the loop: { time, beat (index in loop), eighth (0..7 in the bar), barIndex }.
function eighths(analysis, section) {
  const { beats, beatInBar } = analysis;
  const grid = [];
  let barIndex = -1;
  for (let b = section.startBeat; b < section.endBeat; b++) {
    if (beatInBar[b] === 0) barIndex++;
    const next = b + 1 < beats.length ? beats[b + 1] : section.end;
    for (let half = 0; half < 2; half++) {
      grid.push({ time: beats[b] + half * (next - beats[b]) / 2, eighth: beatInBar[b] * 2 + half, barIndex });
    }
  }
  return grid;
}

/**
 * @param {string} kind  'script' (a human-like rock pattern with seeded timing, velocity and crossing
 *                       variation), 'chug' (eighth-note downstrokes on 3 strings), 'ring' (one big
 *                       strum per bar, left to ring)
 * @param analysis       power-chord analysis (beats, beatInBar, duration)
 * @param {(time: number) => object} chordAt  power chord at a song time
 * @param section        from loopSection
 * @param settings       SETTINGS (powerLowestNote, strumGap)
 * @returns {{ events: Array<{ time, freq, velocity, position, key }>, chokes: Array<{ time, keep }>, length: number }}
 */
export function buildPerformance(kind, analysis, chordAt, section, settings, { seed = 21 } = {}) {
  const random = mulberry32(seed);
  const lowest = noteToMidi(settings.powerLowestNote);
  const gap = settings.strumGap / 1000;
  const events = [];
  const strum = (time, steps, velocity, position) => {
    const chord = chordAt(Math.max(section.start, time) + 0.02);
    if (!chord) return;
    steps.forEach((step, k) => {
      const t = time - section.start + k * gap;
      if (t < 0 || t >= section.end - section.start) return;
      events.push({
        time: t, freq: midiToFreq(powerChordNote(chord.root, lowest, step)),
        velocity: Math.max(0.1, Math.min(1, velocity)), position: Math.max(0.05, Math.min(0.95, position)), key: `s${step}`,
      });
    });
  };
  const DOWN = [0, 1, 2, 3], UP = [3, 2, 1];
  for (const { time, eighth, barIndex } of eighths(analysis, section)) {
    if (kind === 'chug') {
      strum(time, [0, 1, 2], eighth % 2 ? 0.55 : eighth === 0 ? 0.75 : 0.65, 0.5);
    } else if (kind === 'ring') {
      if (eighth === 0) strum(time, [0, 1, 2, 3, 4], 0.75, 0.42);
    } else {
      // D . D U . U D U, and every fourth bar a long strum on 1 left to ring before D . D U.
      const turn = barIndex % 4 === 3;
      const pattern = turn ? { 0: 'D', 4: 'D', 6: 'D', 7: 'U' } : { 0: 'D', 2: 'D', 3: 'U', 5: 'U', 6: 'D', 7: 'U' };
      const stroke = pattern[eighth];
      const jitter = (random() + random() - 1) * 0.012;
      const position = 0.5 + (random() - 0.5) * 0.4;
      if (stroke === 'D') strum(time + jitter, DOWN, (eighth === 0 ? 0.85 : 0.7) + (random() - 0.5) * 0.16, position);
      else if (stroke === 'U') strum(time + jitter, UP, 0.45 + (random() - 0.5) * 0.16, position);
    }
  }
  events.sort((a, b) => a.time - b.time);

  // Chord changes inside the loop, and at the loop point when the last chord differs from the first.
  const chokes = [];
  const length = section.end - section.start;
  let previous = chordAt(section.end - 0.01);
  for (let b = section.startBeat; b < section.endBeat; b++) {
    const chord = chordAt(analysis.beats[b] + 0.001);
    if (chord && previous && chord.root !== previous.root) {
      chokes.push({ time: analysis.beats[b] - section.start, keep: chordPitchClasses(chord, 'power') });
    }
    previous = chord;
  }
  return { events, chokes, length };
}
