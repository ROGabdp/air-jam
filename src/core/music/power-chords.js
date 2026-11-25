// Rock chord mode: turn the triad tracker's chords into power chords (root + fifth) and keep the
// roots inside the key's common rock degrees.
//
// Why only the root: on distorted rock the third is weak and partly an overtone of the root, so
// major/minor is a coin toss (docs/搖滾獨奏_設計挑戰.md 2.3), while the triad tracker's *root* is
// steadier than a two-note power-chord template. Dropping the third makes a wrong major/minor
// guess inaudible; a wrong root is still audible, hence the key guard.
//
// Key guard rule (relative to the detected tonic, in semitones):
//   every key:  I 0, ♭III 3, IV 5, V 7, ♭VI 8, ♭VII 10   (rock's usual roots, incl. borrowed ones)
//   major key:  + ii 2, vi 9                            (I–V–vi–IV, ii–V: everyday major-key roots)
// Excluded: ♭II 1, III/iii 4, ♯IV 6, VII 11 in every key, and ii 2, VI 9 in a minor key.
// Blues-rock in a major key (A with a G riff) is covered by ♭VII and ♭III; the guard cannot tell
// a real vi from a boogie sixth heard as a vi chord (both have the same notes), so it keeps vi.
// An out-of-key root is replaced by the previous in-key root (a misheard chord is usually the
// same harmony with an added note: A6 → F#m, A7 → C#dim …); at the very start of a song, by the
// next in-key root; if none exists at all, by the tonic.
import { chordName, mod12 } from './theory.js';

export const ROCK_DEGREES = {
  common: [0, 3, 5, 7, 8, 10],
  major: [2, 9],
  minor: [],
};

export function allowedRoots(key) {
  if (!key) return null;
  const degrees = [...ROCK_DEGREES.common, ...(key.minor ? ROCK_DEGREES.minor : ROCK_DEGREES.major)];
  return degrees.map(d => mod12(key.root + d)).sort((a, b) => a - b);
}

/**
 * @param {number[]} roots  per-beat (or per-segment) roots
 * @param key               { root, minor } or null (no guard possible)
 * @returns {{ roots: number[], replaced: number }}
 */
export function guardRoots(roots, key) {
  const allowed = allowedRoots(key);
  if (!allowed) return { roots: roots.slice(), replaced: 0 };
  const ok = r => allowed.includes(mod12(r));
  const firstOk = roots.find(ok);
  let held = firstOk ?? key.root;
  let replaced = 0;
  const out = roots.map(r => {
    if (ok(r)) { held = r; return r; }
    replaced++;
    return held;
  });
  return { roots: out, replaced };
}

/**
 * A copy of an analysis whose chords and segments are power chords ({ root, minor: false,
 * power: true }, named "A5"), optionally key-guarded. Beats, bars and the key are shared with the
 * input; the input is not modified. `detected` on each segment lists the triad names it came from.
 * @param analysis  result of analyzeSync / analyzeAsync / retime
 * @param {{ guard?: boolean }} [o]
 */
export function powerChordAnalysis(analysis, { guard = true } = {}) {
  const { beats, chords, duration } = analysis;
  const raw = chords.map(c => c.root);
  const { roots, replaced } = guard ? guardRoots(raw, analysis.key) : { roots: raw, replaced: 0 };
  const power = roots.map(root => ({ root, minor: false, power: true }));
  const segments = [];
  for (let b = 0; b < power.length; b++) {
    const last = segments[segments.length - 1];
    const end = b + 1 < beats.length ? beats[b + 1] : duration;
    const detected = chordName(chords[b]);
    if (last && last.root === power[b].root) {
      last.end = end;
      if (!last.detected.includes(detected)) last.detected.push(detected);
    } else {
      segments.push({ start: b === 0 ? 0 : beats[b], end, ...power[b], name: chordName(power[b]), detected: [detected] });
    }
  }
  return { ...analysis, chords: power, segments, guard: { on: guard, replacedBeats: replaced } };
}
