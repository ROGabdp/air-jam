export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const FLATS = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };

export const mod12 = n => ((n % 12) + 12) % 12;

export function chordName(chord) {
  return chord ? NOTE_NAMES[chord.root] + (chord.minor ? 'm' : '') : '–';
}

export function parseChord(name) {
  const match = /^([A-G](?:#|b)?)(m?)$/.exec(name);
  if (!match) throw new Error(`Unknown chord: ${name}`);
  const note = FLATS[match[1]] ?? match[1];
  return { root: NOTE_NAMES.indexOf(note), minor: match[2] === 'm' };
}

export function sameChord(a, b) {
  return !!a && !!b && a.root === b.root && a.minor === b.minor;
}

export function noteToMidi(name) {
  const match = /^([A-G]#?)(-?\d)$/.exec(name);
  if (!match) return 48;
  return NOTE_NAMES.indexOf(match[1]) + (Number(match[2]) + 1) * 12;
}

export function midiToName(midi) {
  const rounded = Math.round(midi);
  return NOTE_NAMES[mod12(rounded)] + (Math.floor(rounded / 12) - 1);
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

// voicing: 'triad' (root, third, fifth) or 'power' (root, fifth) for distorted tones.
export function chordPitchClasses(chord, voicing = 'triad') {
  const fifth = mod12(chord.root + 7);
  if (voicing === 'power') return [chord.root, fifth];
  return [chord.root, mod12(chord.root + (chord.minor ? 3 : 4)), fifth];
}

export function scalePitchClasses(key) {
  const steps = key.minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  return steps.map(step => mod12(key.root + step));
}

export const C_MAJOR_PENTATONIC = [0, 2, 4, 7, 9];

// Climb from lowestMidi stepping only on allowed pitch classes; return the note at `step`.
export function ladderNote(pitchClasses, lowestMidi, step) {
  let midi = lowestMidi;
  let count = -1;
  for (let guard = 0; guard < 240; guard++, midi++) {
    if (pitchClasses.includes(mod12(midi)) && ++count === step) return midi;
  }
  return lowestMidi;
}

// 12 roots around the hue wheel; minor chords a little darker.
export function chordColor(chord) {
  if (!chord) return { h: 45, s: 90, l: 62 };
  return { h: chord.root * 30, s: chord.minor ? 70 : 90, l: chord.minor ? 54 : 62 };
}

export function mixColor(a, b, t) {
  const dh = ((b.h - a.h + 540) % 360) - 180;
  return { h: (a.h + dh * t + 360) % 360, s: a.s + (b.s - a.s) * t, l: a.l + (b.l - a.l) * t };
}

export function hsl(color, alpha = 1, lightnessShift = 0) {
  const l = Math.max(0, Math.min(100, color.l + lightnessShift));
  return `hsla(${color.h.toFixed(1)}, ${color.s.toFixed(1)}%, ${l.toFixed(1)}%, ${alpha})`;
}
