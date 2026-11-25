// Shared "you can't play a wrong note" service. Instruments hand in a normalised position
// (0 = lowest, 1 = highest) and get back the pitch allowed by the current chord / key / mode.
import {
  C_MAJOR_PENTATONIC, chordPitchClasses, scalePitchClasses, ladderNote, powerChordNote,
  noteToMidi, midiToFreq, freqToMidi, midiToName,
} from './theory.js';

export function createPitchSnapper(settings) {
  let chord = null;
  let key = null;
  let voicing = 'triad';

  // The mode actually in force: without analysis data both snapping modes fall back to pentatonic.
  function effectiveMode() {
    if (settings.snapMode === 'free') return 'free';
    if (settings.snapMode === 'chord' && chord) return 'chord';
    if (key) return 'scale';
    return 'pentatonic';
  }

  function pitchClasses() {
    switch (effectiveMode()) {
      case 'chord': return chordPitchClasses(chord, voicing);
      case 'scale': return scalePitchClasses(key);
      default: return C_MAJOR_PENTATONIC;
    }
  }

  const slotFor = height => Math.round(Math.max(0, Math.min(1, height)) * (settings.slots - 1));

  return {
    setChord(next) { chord = next; },
    setKey(next) { key = next; },
    setVoicing(next) { voicing = next; },
    get voicing() { return voicing; },
    get chord() { return chord; },
    get key() { return key; },
    effectiveMode,
    pitchClasses,
    slotFor,
    // Normalised height (0..1) at the centre of each slot, for drawing fret-like ticks.
    slotHeights: () => Array.from({ length: settings.slots }, (_, i) => i / (settings.slots - 1)),

    /**
     * @param {number} height 0 (lowest) .. 1 (highest)
     * @param {number} [lengthRatio] longest/actual length, used by free mode (frequency ∝ 1/length)
     */
    note(height, lengthRatio = 1) {
      const lowest = noteToMidi(settings.lowestNote);
      if (effectiveMode() === 'free') {
        const freq = midiToFreq(lowest) * Math.max(1, lengthRatio);
        const midi = freqToMidi(freq);
        return { midi, freq, name: midiToName(midi), slot: null };
      }
      const slot = slotFor(height);
      if (effectiveMode() === 'chord' && voicing === 'power') {
        // Root–fifth–octave–… from a low register; the slots spread over powerSteps notes, so
        // neighbouring strings can double a note (as a strummed power chord does) instead of the
        // two-notes-per-octave ladder climbing five octaves.
        const steps = Math.max(2, settings.powerSteps);
        const step = Math.round(slot * (steps - 1) / Math.max(1, settings.slots - 1));
        const midi = powerChordNote(chord.root, noteToMidi(settings.powerLowestNote), step);
        return { midi, freq: midiToFreq(midi), name: midiToName(midi), slot };
      }
      const midi = ladderNote(pitchClasses(), lowest, slot);
      return { midi, freq: midiToFreq(midi), name: midiToName(midi), slot };
    },
  };
}
