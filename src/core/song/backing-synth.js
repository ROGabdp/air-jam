// Pure-JS backing-track synthesiser (bass, pad, drums, optional hats/melody/noise).
// Used for the built-in demo song and, with harder settings, for analysis tests in Node.
import { parseChord, chordPitchClasses, scalePitchClasses, midiToFreq, mod12 } from '../music/theory.js';

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

const triangle = phase => 4 * Math.abs(phase - Math.floor(phase + 0.5)) - 1 + 0 * phase;

// Bass root in E1..D#2 register, pad triad voiced closely around middle C.
function voicing(chord) {
  let bass = 36 + chord.root;
  if (bass > 45) bass -= 12;
  const pad = chordPitchClasses(chord).map(pc => {
    let midi = 60 + pc;
    if (midi > 67) midi -= 12;
    return midi;
  });
  return { bass: midiToFreq(bass), pad: pad.map(midiToFreq) };
}

/**
 * @param {object} o
 * @param {(string|string[])[]} o.progression one entry per bar; an array splits the bar evenly
 * @returns {{ samples: Float32Array, sampleRate: number, truth: { bpm:number, beats:number[], chords:object[], key?:object } }}
 */
export function renderBacking({
  sampleRate = 44100, bpm = 100, progression, bars = 16, leadIn = 0.6, tail = 1,
  drums = 1, hats = 0, melody = 0, noise = 0, key = null, seed = 7,
}) {
  const random = mulberry32(seed);
  const beat = 60 / bpm;
  const length = Math.ceil((leadIn + bars * 4 * beat + tail) * sampleRate);
  const out = new Float32Array(length);
  const at = seconds => Math.round(seconds * sampleRate);

  const addTone = (wave, freq, start, seconds, envelope) => {
    const from = at(start), count = Math.min(at(seconds), length - from);
    const step = freq / sampleRate;
    for (let i = 0; i < count; i++) out[from + i] += wave(i * step) * envelope(i / sampleRate, seconds);
  };
  const sine = phase => Math.sin(2 * Math.PI * phase);

  const pad = (freq, start, seconds) => addTone(triangle, freq, start, seconds, (t, d) =>
    0.1 * Math.min(1, t / 0.05, (d - t) / 0.1));
  const bassNote = (freq, start) => addTone(triangle, freq, start, beat * 0.95, (t, d) =>
    0.32 * Math.min(1, t / 0.005) * Math.pow(0.0625, t / d) * Math.min(1, (d - t) / 0.02));
  const kick = start => {
    const from = at(start), count = Math.min(at(0.26), length - from);
    let phase = 0;
    for (let i = 0; i < count; i++) {
      const t = i / sampleRate;
      phase += 150 * Math.pow(45 / 150, Math.min(1, t / 0.12)) / sampleRate;
      out[from + i] += drums * 0.7 * Math.sin(2 * Math.PI * phase) * Math.exp(-t * 27);
    }
  };
  // Noise bursts: snare is band-limited around 1.8 kHz, hats are high-passed.
  const burst = (start, seconds, gain, highpass) => {
    const from = at(start), count = Math.min(at(seconds), length - from);
    let low = 0, band = 0, previous = 0;
    for (let i = 0; i < count; i++) {
      const white = random() * 2 - 1;
      let sample;
      if (highpass) { sample = white - previous; previous = white; }
      else { low += 0.35 * (white - low); band += 0.12 * (low - band); sample = (low - band) * 2.2; }
      out[from + i] += gain * sample * Math.exp(-(i / sampleRate) * (highpass ? 90 : 38));
    }
  };

  const truthBeats = [], truthChords = [];
  const scale = key ? scalePitchClasses(key) : null;
  let melodyDegree = 7;
  for (let bar = 0; bar < bars; bar++) {
    const entry = progression[bar % progression.length];
    const parts = (Array.isArray(entry) ? entry : [entry]).map(parseChord);
    const barStart = leadIn + bar * 4 * beat;
    parts.forEach((chord, i) => {
      const seconds = 4 * beat / parts.length;
      for (const freq of voicing(chord).pad) pad(freq, barStart + i * seconds, seconds);
    });
    for (let b = 0; b < 4; b++) {
      const t = barStart + b * beat;
      const chord = parts[Math.floor(b * parts.length / 4)];
      truthBeats.push(t);
      truthChords.push(chord);
      bassNote(voicing(chord).bass, t);
      if (drums > 0) {
        if (b % 2 === 0) kick(t); else burst(t, 0.2, drums * 0.35, false);
      }
      for (let eighth = 0; eighth < 2; eighth++) {
        const te = t + eighth * beat / 2;
        if (hats > 0) burst(te, 0.05, hats * (eighth ? 0.12 : 0.2), true);
        if (melody > 0 && scale && random() < 0.75) {
          // Random walk on the key's scale: plenty of non-chord tones, like a vocal line.
          melodyDegree = Math.max(0, Math.min(14, melodyDegree + Math.floor(random() * 5) - 2));
          const midi = 72 + scale[melodyDegree % 7] - scale[0] + 12 * Math.floor(melodyDegree / 7) + mod12(scale[0]) - 12;
          addTone(p => sine(p) + 0.3 * sine(2 * p) + 0.15 * sine(3 * p), midiToFreq(midi), te, beat * 0.45,
            (time, d) => melody * 0.16 * Math.min(1, time / 0.01, (d - time) / 0.04));
        }
      }
    }
  }

  if (noise > 0) for (let i = 0; i < length; i++) out[i] += noise * (random() * 2 - 1);

  let peak = 0;
  for (let i = 0; i < length; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
  if (peak > 0.89) for (let i = 0; i < length; i++) out[i] *= 0.89 / peak;

  return { samples: out, sampleRate, truth: { bpm, beats: truthBeats, chords: truthChords, key } };
}
