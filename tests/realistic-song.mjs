// A harder synthetic "band" for analysis tests, closer to real recordings than backing-synth.js:
// strummed Karplus-Strong guitar with seventh chords and inversions, a bass that walks onto the
// chord's third, a loud vibrato "vocal" in the mid band that holds non-chord tones, swung hats,
// a tempo that drifts like a live band, and a drums-only intro bar. Test-only code.
import { renderPluck } from '../src/core/audio/karplus.js';
import { midiToFreq, mod12 } from '../src/core/music/theory.js';

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

const NOTE = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const QUALITY = {
  '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10],
  sus4: [0, 5, 7], add9: [0, 4, 7, 14],
};

// "G7/B" → pitch classes, bass pitch class, and the triad the analysis should report.
export function parseRichChord(name) {
  const match = /^([A-G](?:#|b)?)(maj7|m7|m|7|sus4|add9)?(?:\/([A-G](?:#|b)?))?$/.exec(name);
  if (!match) throw new Error(`Unknown chord: ${name}`);
  const root = NOTE[match[1]];
  const quality = match[2] ?? '';
  const tones = QUALITY[quality].map(i => mod12(root + i));
  const bass = match[3] ? NOTE[match[3]] : root;
  return { name, tones, bass, truth: { root, minor: quality === 'm' || quality === 'm7' } };
}

/**
 * @param {object} o
 * @param {string[][]} o.bars        chord names per bar (one or two per bar)
 * @param {number} o.bpm             tempo at the start
 * @param {number} [o.endBpm]        tempo at the end (linear drift)
 * @param {number} [o.introBars]     drums-only bars before the band comes in
 * @param {number} [o.swing]         0 = straight eighths, 1 = full triplet swing
 * @param {number} [o.vocal]         vocal level relative to the guitar
 * @param {boolean} [o.drums]
 * @param {'strum'|'arpeggio'} [o.guitar]
 */
export function renderBand({
  sampleRate = 44100, bars, bpm, endBpm = bpm, introBars = 1, swing = 0, vocal = 1,
  drums = true, guitar = 'strum', leadIn = 0.4, tail = 1.5, seed = 1,
}) {
  const random = mulberry32(seed);
  const totalBeats = (introBars + bars.length) * 4;
  // Beat times under a linear tempo ramp.
  const beatTimes = [];
  let t = leadIn;
  for (let b = 0; b < totalBeats; b++) {
    beatTimes.push(t);
    const tempo = bpm + (endBpm - bpm) * (b / (totalBeats - 1));
    t += 60 / tempo;
  }
  const end = t;
  const length = Math.ceil((end + tail) * sampleRate);
  const out = new Float32Array(length);
  const at = seconds => Math.round(seconds * sampleRate);
  const beatLen = b => (beatTimes[b + 1] ?? end) - beatTimes[b];
  const eighth = (b, half) => beatTimes[b] + (half ? beatLen(b) * (0.5 + swing / 6) : 0);

  const mix = (data, start, gain) => {
    const from = at(start);
    for (let i = 0; i < data.length && from + i < length; i++) out[from + i] += gain * data[i];
  };
  const pluck = (midi, start, gain, brightness = 0.7, t60 = 2.2) => mix(renderPluck({
    freq: midiToFreq(midi), sampleRate, t60, brightness, pickPosition: 0.18, damping: 0.45,
    maxSeconds: 2.2, random,
  }), start, gain);

  // Bass register E1..D#2.
  const bassNote = pc => { const midi = 24 + mod12(pc); return midi < 28 ? midi + 12 : midi; };

  // Guitar voicing: chord tones (sevenths included) stacked upward from about E3.
  const voicing = chord => {
    const notes = [];
    for (let midi = 52; notes.length < 5 && midi < 80; midi++) if (chord.tones.includes(mod12(midi))) notes.push(midi);
    return notes;
  };

  const kick = start => {
    const from = at(start), count = Math.min(at(0.3), length - from);
    let phase = 0;
    for (let i = 0; i < count; i++) {
      const s = i / sampleRate;
      phase += 140 * Math.pow(48 / 140, Math.min(1, s / 0.1)) / sampleRate;
      out[from + i] += 0.8 * Math.sin(2 * Math.PI * phase) * Math.exp(-s * 22);
    }
  };
  const noise = (start, seconds, gain, highpass, decay) => {
    const from = at(start), count = Math.min(at(seconds), length - from);
    let low = 0, band = 0, previous = 0;
    for (let i = 0; i < count; i++) {
      const white = random() * 2 - 1;
      let sample;
      if (highpass) { sample = white - previous; previous = white; }
      else { low += 0.4 * (white - low); band += 0.1 * (low - band); sample = (low - band) * 2.4; }
      out[from + i] += gain * sample * Math.exp(-(i / sampleRate) * decay);
    }
  };

  const chordAtBeat = [];
  for (let b = 0; b < introBars * 4; b++) chordAtBeat.push(null);
  bars.forEach(entry => {
    const parts = entry.map(parseRichChord);
    for (let i = 0; i < 4; i++) chordAtBeat.push(parts[Math.floor(i * parts.length / 4)]);
  });

  // Drums: kick on 1 and 3 (plus the "and" of 3), snare on 2 and 4, swung hats throughout.
  if (drums) {
    for (let b = 0; b < totalBeats; b++) {
      const inBar = b % 4;
      if (inBar === 0 || inBar === 2) kick(beatTimes[b]);
      if (inBar === 2) kick(eighth(b, 1));
      if (inBar === 1 || inBar === 3) noise(beatTimes[b], 0.22, 0.4, false, 30);
      noise(eighth(b, 0), 0.06, 0.14, true, 80);
      noise(eighth(b, 1), 0.05, 0.09, true, 90);
    }
  }

  for (let b = introBars * 4; b < totalBeats; b++) {
    const chord = chordAtBeat[b];
    const inBar = b % 4;
    const notes = voicing(chord);
    // Bass: chord bass note (inversions included) on 1 and 3, a passing approach on 4&.
    if (inBar === 0 || inBar === 2 || chord !== chordAtBeat[b - 1]) {
      const bassMidi = bassNote(chord.bass);
      pluck(bassMidi, beatTimes[b], 0.55, 0.35, 1.4);
    }
    if (inBar === 3 && b + 1 < totalBeats) {
      const next = chordAtBeat[b + 1];
      pluck(bassNote(next.bass + (random() < 0.5 ? -1 : 2)), eighth(b, 1), 0.35, 0.35, 0.6);
    }
    if (guitar === 'strum') {
      // D – D U – U D U pattern; downstrokes low→high, upstrokes high→low and softer.
      const strokes = [[0, 0, 'down'], [1, 0, 'down'], [1, 1, 'up'], [2, 1, 'up'], [3, 0, 'down'], [3, 1, 'up']];
      for (const [beat, half, dir] of strokes) {
        if (beat !== inBar) continue;
        const start = eighth(b, half);
        const order = dir === 'down' ? notes : [...notes].reverse().slice(0, 3);
        order.forEach((midi, i) => pluck(midi, start + i * 0.012, dir === 'down' ? 0.16 : 0.1, 0.75));
      }
    } else {
      // Arpeggio: one chord tone per eighth.
      for (let half = 0; half < 2; half++) {
        const midi = notes[(inBar * 2 + half) % notes.length];
        pluck(midi, eighth(b, half), 0.2, 0.55, 2.6);
      }
    }
  }

  // Vocal: long notes (1–3 beats) with vibrato and glides, mostly chord tones on the strong beats
  // but plenty of held passing tones and sevenths. Harmonics shaped by two formants.
  if (vocal > 0) {
    const scale = [0, 2, 4, 5, 7, 9, 11];
    const key = parseRichChord(bars[0][0]).truth.root;
    let degree = 9;
    let b = introBars * 4;
    let phase = 0, freq = 0;
    while (b < totalBeats - 1) {
      const beats = 1 + Math.floor(random() * 3);
      const chord = chordAtBeat[b];
      const strong = b % 2 === 0;
      degree = Math.max(5, Math.min(16, degree + Math.floor(random() * 5) - 2));
      let midi = 60 + key + scale[degree % 7] + 12 * Math.floor(degree / 7) - 12;
      if (strong && random() < 0.6) {
        // Land on the nearest chord tone.
        for (let d = 0; d < 6; d++) {
          if (chord.tones.includes(mod12(midi + d))) { midi += d; break; }
          if (chord.tones.includes(mod12(midi - d))) { midi -= d; break; }
        }
      }
      const start = beatTimes[b] + (random() < 0.3 ? beatLen(b) * 0.5 : 0);
      const stop = Math.min(beatTimes[Math.min(totalBeats - 1, b + beats)], end) - 0.04;
      const target = midiToFreq(midi);
      if (!freq) freq = target;
      const from = at(start), count = Math.max(0, at(stop) - from);
      for (let i = 0; i < count && from + i < length; i++) {
        const s = i / sampleRate;
        freq += (target - freq) * Math.min(1, 1 / (0.05 * sampleRate));                // ~50 ms glide
        const vib = 1 + 0.025 * Math.min(1, Math.max(0, s - 0.2) / 0.3) * Math.sin(2 * Math.PI * 5.6 * s);
        phase += freq * vib / sampleRate;
        let sample = 0;
        for (let h = 1; h <= 10; h++) {
          const hz = freq * h;
          const formant = Math.exp(-(((hz - 650) / 300) ** 2)) + 0.6 * Math.exp(-(((hz - 1300) / 400) ** 2)) + 0.15;
          sample += Math.sin(2 * Math.PI * h * phase) * formant / h;
        }
        const env = Math.min(1, s / 0.06, (count / sampleRate - s) / 0.08);
        out[from + i] += vocal * 0.1 * sample * env;
      }
      b += beats;
    }
  }

  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(out[i]));
  for (let i = 0; i < length; i++) out[i] *= 0.9 / peak;

  const meanBpm = 60 * (totalBeats - 1) / (beatTimes[totalBeats - 1] - beatTimes[0]);
  return {
    samples: out, sampleRate,
    truth: { bpm: meanBpm, beats: beatTimes, chords: chordAtBeat.map(c => c?.truth ?? null) },
  };
}
