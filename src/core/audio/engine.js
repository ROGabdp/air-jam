// Web Audio engine: song playback, plucked voices in parts (each part has its own tone and
// effect-chain instance), voice limiting, chord-change chokes and output protection. Everything is
// timed on AudioContext.currentTime.
import { renderPluck } from './karplus.js';
import { releaseTimeConstant, ceilingCurve } from './distortion.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pitchClassOf = freq => ((Math.round(69 + 12 * Math.log2(freq / 440)) % 12) + 12) % 12;

/**
 * @param settings SETTINGS
 * @param {object} [o]
 * @param {BaseAudioContext} [o.context]  e.g. an OfflineAudioContext for measurements
 */
export function createAudioEngine(settings, { context = null } = {}) {
  const ctx = context ?? new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });

  // song ───────────────────────────────────────────────► songGain ─┐
  // voices ► part bus ► part's tone chain ─┐                         │
  //   (one part per role: 'rhythm' now,    ├► stringGain ► glue comp ─┴► limiter ► ceiling ► destination
  //    a 'lead' part later)               ─┘
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20;
  limiter.attack.value = 0.002; limiter.release.value = 0.12;
  // The compressor adds make-up gain and lets attack transients through (measured peaks ~1.02 with
  // heavy strumming over a loud song); a static soft ceiling keeps the output below 0.99.
  const ceiling = ctx.createWaveShaper();
  ceiling.curve = ceilingCurve();
  ceiling.oversample = 'none';   // oversampling filters could ring past the ceiling
  limiter.connect(ceiling).connect(ctx.destination);

  const songGain = ctx.createGain();
  songGain.connect(limiter);

  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -16; glue.knee.value = 10; glue.ratio.value = 5;
  glue.attack.value = 0.004; glue.release.value = 0.18;
  glue.connect(limiter);
  const stringGain = ctx.createGain();
  stringGain.connect(glue);

  function applyVolumes() {
    songGain.gain.value = clamp(settings.songVolume, 0, 1) * 0.85;
    stringGain.gain.value = clamp(settings.stringVolume, 0, 1);
  }
  applyVolumes();

  // A part has its own voice bus, tone and chain instance. Distortion is per part, so a lead line
  // added later gets its own clipper instead of intermodulating with the rhythm chords.
  const parts = new Map();
  function part(name) {
    let p = parts.get(name);
    if (!p) {
      const bus = ctx.createGain();
      bus.gain.value = 0.3;
      p = { name, bus, tone: null, chain: null };
      parts.set(name, p);
    }
    return p;
  }

  let voices = [];
  // Fade a voice so it is `voice.depthDb` down after `fadeSeconds` (the tone's release depth).
  function release(voice, fadeSeconds, when = ctx.currentTime) {
    const from = Math.max(when, voice.when);
    voice.released = true;
    const tau = releaseTimeConstant(fadeSeconds, voice.depthDb);
    voice.gain.gain.cancelScheduledValues(from);
    voice.gain.gain.setTargetAtTime(0, from, tau);
    try { voice.source.stop(from + Math.max(fadeSeconds * 1.5, tau * 7)); } catch { /* already stopped */ }
  }

  function setTone(next, partName = 'rhythm') {
    const p = part(partName);
    // Voices of the old tone would otherwise ring on through the new chain.
    for (const voice of voices) if (voice.part === partName && !voice.released) release(voice, 0.03);
    p.bus.disconnect();
    p.chain?.output.disconnect();
    p.chain?.dispose();
    p.tone = next;
    p.chain = next.createChain(ctx);
    p.bus.connect(p.chain.input);
    p.chain.output.connect(stringGain);
  }

  /**
   * Chord change: voices of a part whose pitch class is not in `keep` fade out within the tone's
   * `chordChoke` time. No-op for tones that let the old chord ring (acoustic strings).
   * @param {number[]} keep  pitch classes of the new chord ([] = choke everything)
   * @param {object} [o]
   * @param {string} [o.part]
   * @param {number} [o.when]  AudioContext time (default: now)
   * @returns {number} voices choked
   */
  function chokeChord(keep, { part: partName = 'rhythm', when = ctx.currentTime } = {}) {
    const seconds = parts.get(partName)?.tone?.chordChoke;
    if (!seconds) return 0;
    let count = 0;
    for (const voice of voices) {
      if (voice.part !== partName || voice.released || keep.includes(voice.pitchClass)) continue;
      release(voice, seconds, when);
      count++;
    }
    return count;
  }

  // Decay shortens with pitch like a real string; settings.decay scales it (0.996 = neutral).
  function t60For(freq, tone) {
    const sustain = clamp(0.004 / Math.max(1e-4, 1 - settings.decay), 0.2, 3);
    return clamp(tone.string.t60 * sustain * Math.pow(130 / freq, 0.45), 0.4, 6);
  }

  /**
   * @param {object} o
   * @param {number} o.freq
   * @param {number} [o.velocity]  0..1
   * @param {number} [o.position]  0..1 along the string (0.5 = middle, mellow; ends = bright)
   * @param {number} [o.pan]       -1..1, scaled by the tone's panWidth
   * @param {number} [o.delay]     seconds from now
   * @param {*} [o.key]            voices sharing a key choke each other (re-plucking one string)
   * @param {string} [o.part]      engine part, 'rhythm' by default
   */
  function pluck({ freq, velocity = 0.6, position = 0.5, pan = 0, delay = 0, key = null, part: partName = 'rhythm' }) {
    const p = part(partName);
    const tone = p.tone;
    if (!tone) return;
    const v = clamp(velocity, 0, 1);
    const edge = Math.min(1, Math.abs(position - 0.5) * 2);
    const data = renderPluck({
      freq: clamp(freq, 40, 4000),
      sampleRate: ctx.sampleRate,
      t60: t60For(freq, tone),
      damping: tone.string.damping * clamp(Math.sqrt(330 / freq), 0.3, 1),
      brightness: clamp(tone.string.brightness * (0.3 + 0.5 * edge + 0.3 * v), 0.05, 1),
      pickPosition: clamp(0.5 - 0.42 * edge, 0.06, 0.5),
    });
    const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buffer.getChannelData(0).set(data);

    const when = ctx.currentTime + delay;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.22 + 0.78 * v * v;
    source.connect(gain);
    let panner = null;
    if (ctx.createStereoPanner) {
      panner = ctx.createStereoPanner();
      panner.pan.value = clamp(pan * (tone.panWidth ?? 1), -1, 1);
      gain.connect(panner).connect(p.bus);
    } else {
      gain.connect(p.bus);
    }
    source.start(when);

    const voice = {
      source, gain, key, when, released: false, part: partName,
      pitchClass: pitchClassOf(freq), depthDb: tone.releaseDepthDb,
    };
    // Re-plucking a string chokes its previous voice, and the voice limit fades the oldest, both
    // from the moment the new voice starts (strums are scheduled a little ahead).
    if (key !== null) {
      for (const other of voices) if (other.key === key && other.part === partName && !other.released) release(other, 0.04, when);
    }
    voices.push(voice);
    source.onended = () => {
      voices = voices.filter(x => x !== voice);
      source.disconnect(); gain.disconnect(); panner?.disconnect();
    };
    const active = voices.filter(x => !x.released);
    for (let i = 0; i < active.length - settings.maxVoices; i++) release(active[i], 0.06, when);
  }

  let song = null;
  function playSong(buffer, onEnded, leadSeconds = 0.12) {
    stopSong();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(songGain);
    const startTime = ctx.currentTime + leadSeconds;
    source.start(startTime);
    song = { source, startTime };
    source.onended = () => {
      if (song?.source !== source) return;
      song = null;
      onEnded?.();
    };
  }

  // Metronome tick at a song position (seconds), on the song's own clock so it lines up with what
  // is heard. Used to check the detected beat by ear.
  function click(songSeconds, accent = false) {
    if (!song) return;
    const when = song.startTime + songSeconds;
    if (when < ctx.currentTime) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1320;
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(accent ? 0.45 : 0.3, when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
    osc.connect(gain).connect(limiter);
    osc.start(when);
    osc.stop(when + 0.06);
    osc.onended = () => gain.disconnect();
  }

  function stopSong() {
    if (!song) return;
    const { source } = song;
    song = null;
    try { source.stop(); } catch { /* not started yet */ }
    source.disconnect();
  }

  return {
    ctx,
    setTone,
    get tone() { return parts.get('rhythm')?.tone ?? null; },
    pluck,
    chokeChord,
    applyVolumes,
    // Time constant (seconds) for visuals that should fade with the audible decay.
    ringTime: (freq, partName = 'rhythm') => {
      const tone = parts.get(partName)?.tone;
      return tone ? t60For(freq, tone) / 4.5 : 0.6;
    },
    playSong,
    stopSong,
    click,
    get playing() { return song !== null; },
    songTime: () => (song ? ctx.currentTime - song.startTime : 0),
    now: () => ctx.currentTime,
    outputLatency: () => ctx.outputLatency || ctx.baseLatency || 0,
    resume: () => ctx.resume(),
    decode: arrayBuffer => new Promise((resolve, reject) => {
      const promise = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      promise?.catch?.(reject);
    }),
    bufferFromMono(samples, sampleRate) {
      const buffer = ctx.createBuffer(1, samples.length, sampleRate);
      buffer.getChannelData(0).set(samples);
      return buffer;
    },
    get voiceCount() { return voices.length; },
  };
}

export function mixToMono(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const mono = new Float32Array(audioBuffer.length);
  for (let c = 0; c < channels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / channels;
  }
  return mono;
}
