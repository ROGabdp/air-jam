// Built-in demo: ~40 s, 100 BPM, C–G–Am–F. It goes through the same analysis as a user's file;
// the known answer is only used for the developer comparison printed to the console.
import { renderBacking } from './backing-synth.js';
import { chordName } from '../music/theory.js';

export const DEMO = {
  bpm: 100,
  progression: ['C', 'G', 'Am', 'F'],
  bars: 16,
  leadIn: 0.6,
};

export function renderDemoSong(sampleRate = 44100) {
  return renderBacking({ ...DEMO, sampleRate });
}

// Compares an analysis with ground truth beat by beat.
export function compareWithTruth(analysis, truth, toleranceSec = 0.07) {
  const chordAt = time => analysis.segments.find(s => time >= s.start && time < s.end);
  const beatSec = 60 / truth.bpm;
  let chordHits = 0, chordBeats = 0, beatHits = 0, offsetSum = 0, absSum = 0, downbeatHits = 0, downbeats = 0;
  const rows = [];
  truth.beats.forEach((time, i) => {
    const guess = chordAt(time + beatSec / 2);
    const answer = truth.chords[i];
    // A null answer (e.g. a drums-only intro) has no chord to get right.
    if (answer) {
      chordBeats++;
      if (guess && guess.root === answer.root && guess.minor === answer.minor) chordHits++;
    }
    let nearest = 0;
    for (let b = 1; b < analysis.beats.length; b++) {
      if (Math.abs(analysis.beats[b] - time) < Math.abs(analysis.beats[nearest] - time)) nearest = b;
    }
    const offset = analysis.beats[nearest] - time;
    if (Math.abs(offset) <= toleranceSec) { beatHits++; offsetSum += offset; absSum += Math.abs(offset); }
    if (i % 4 === 0) { downbeats++; if (analysis.beatInBar[nearest] === 0) downbeatHits++; }
    if (i % 4 === 0) rows.push({ bar: i / 4 + 1, answer: [], guess: [] });
    rows[rows.length - 1].answer.push(answer ? chordName(answer) : '·');
    rows[rows.length - 1].guess.push(guess ? guess.name : '?');
  });
  const count = truth.beats.length;
  return {
    bpm: analysis.bpm,
    bpmError: analysis.bpm - truth.bpm,
    chordAccuracy: chordBeats ? chordHits / chordBeats : NaN,
    beatRecall: beatHits / count,
    beatOffsetMs: beatHits ? 1000 * offsetSum / beatHits : NaN,
    beatAbsOffsetMs: beatHits ? 1000 * absSum / beatHits : NaN,
    downbeatAccuracy: downbeatHits / downbeats,
    rows: rows.map(r => ({ bar: r.bar, answer: r.answer.join(' '), guess: r.guess.join(' ') })),
  };
}
