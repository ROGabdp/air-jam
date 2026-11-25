// Time-indexed view of an analysis result: which chord, which beat, what comes next.
import { sameChord } from '../music/theory.js';

function lastAtOrBefore(times, time) {
  let lo = 0, hi = times.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

export function createSongMap(analysis) {
  const { beats, beatInBar, chords, segments, duration } = analysis;
  const segmentStarts = segments.map(s => s.start);

  function segmentIndexAt(time) {
    return Math.max(0, Math.min(segments.length - 1, lastAtOrBefore(segmentStarts, time)));
  }

  return {
    analysis,
    duration,
    bpm: analysis.bpm,
    key: analysis.key,
    beatCount: beats.length,
    beatTime: index => beats[index],

    chordAt: time => segments[segmentIndexAt(time)],

    // The next different chord and how many beats away it is.
    nextChord(time) {
      const next = segments[segmentIndexAt(time) + 1];
      if (!next) return null;
      const from = lastAtOrBefore(beats, time);
      const to = lastAtOrBefore(beats, next.start + 1e-6);
      const fraction = from >= 0 && from + 1 < beats.length
        ? (time - beats[from]) / (beats[from + 1] - beats[from]) : 0;
      return { chord: next, time: next.start, beatsAway: Math.max(0, to - from - fraction) };
    },

    // Index of the last beat at or before `time` (-1 before the first beat).
    beatIndexAt: time => lastAtOrBefore(beats, time),

    // Position inside the current beat, 0..1, and the bar position of that beat.
    beatPhase(time) {
      const index = lastAtOrBefore(beats, time);
      if (index < 0 || index + 1 >= beats.length) return { index, phase: 0, inBar: index >= 0 ? beatInBar[index] : 0 };
      return { index, phase: (time - beats[index]) / (beats[index + 1] - beats[index]), inBar: beatInBar[index] };
    },

    nearestBeat(time) {
      let index = lastAtOrBefore(beats, time);
      if (index < 0) index = 0;
      else if (index + 1 < beats.length && beats[index + 1] - time < time - beats[index]) index++;
      return {
        index,
        time: beats[index],
        delta: time - beats[index],
        inBar: beatInBar[index],
        chordChanged: index > 0 && !sameChord(chords[index], chords[index - 1]),
      };
    },
  };
}
