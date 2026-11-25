// Web Audio engine: song playback, plucked voices in parts (each part has its own tone and
// effect-chain instance), voice limiting, chord-change chokes and output protection. Everything is
// timed on AudioContext.currentTime.
import { renderPluck } from './karplus.js';
import { releaseTimeConstant, ceilingCurve } from './distortion.js';
import { voiceParams, t60For } from './voice-params.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pitchClassOf = freq => ((Math.round(69 + 12 * Math.log2(freq / 440)) % 12) + 12) % 12;

/**
 * @param settings SETTINGS
 * @param {object} [o]
 * @param {BaseAudioContext} [o.context]  e.g. an OfflineAudioContext for measurements
 * @param {boolean} [o.master]  false: strings and song go straight to the output, without the glue
 *                              compressor, limiter and ceiling (to measure a tone chain on its own)
 */
export function createAudioEngine(settings, { context = null, master = true } = {}) {
  const ctx = context ?? new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });

  // song ────────────────────────────────────────────────────► songGain ─┐
  // voices ► part bus ► part's tone chain ► trim ─┐                       │
  //   (one part per role: 'rhythm' now,           ├► stringGain ► glue ──┴► limiter ► ceiling ► destination
  //    a 'lead' part later; the tone lab adds    ─┘
  //    one part per combo)
  // A tone with `double` gets a second bus and chain in its part (double-tracking), panned apart.
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
  songGain.connect(master ? limiter : ctx.destination);

  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -16; glue.knee.value = 10; glue.ratio.value = 5;
  glue.attack.value = 0.004; glue.release.value = 0.18;
  glue.connect(limiter);
  const stringGain = ctx.createGain();
  stringGain.connect(master ? glue : ctx.destination);

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
      const trim = ctx.createGain();
      trim.connect(stringGain);
      p = { name, bus, trim, tone: null, chain: null, panner: null, double: null, lastPluckWhen: -Infinity };
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
    for (const gain of voice.gains) {
      gain.gain.cancelScheduledValues(from);
      gain.gain.setTargetAtTime(0, from, tau);
    }
    for (const source of voice.sources) {
      try { source.stop(from + Math.max(fadeSeconds * 1.5, tau * 7)); } catch { /* already stopped */ }
    }
  }

  function setTone(next, partName = 'rhythm') {
    const p = part(partName);
    // Voices of the old tone would otherwise ring on through the new chain.
    for (const voice of voices) if (voice.part === partName && !voice.released) release(voice, 0.03);
    p.bus.disconnect();
    p.chain?.output.disconnect();
    p.chain?.dispose();
    p.panner?.disconnect();
    p.panner = null;
    if (p.double) {
      p.double.bus.disconnect();
      p.double.chain.output.disconnect();
      p.double.chain.dispose();
      p.double.panner.disconnect();
      p.double = null;
    }
    p.tone = next;
    p.chain = next.createChain(ctx);
    p.bus.connect(p.chain.input);
    if (next.double && ctx.createStereoPanner) {
      // Double-tracking: a second, slightly different chain fed by its own take of every note.
      p.panner = ctx.createStereoPanner();
      p.panner.pan.value = -next.double.pan;
      p.chain.output.connect(p.panner).connect(p.trim);
      const bus = ctx.createGain();
      bus.gain.value = 0.3;
      const chain = next.double.createChain(ctx);
      const panner = ctx.createStereoPanner();
      panner.pan.value = next.double.pan;
      bus.connect(chain.input);
      chain.output.connect(panner).connect(p.trim);
      p.double = { bus, chain, panner };
    } else {
      p.chain.output.connect(p.trim);
    }
  }

  // Level of a part after its chain (1 = as the tone is voiced). The tone lab level-matches with it.
  function setTrim(gain, partName = 'rhythm', { smooth = true } = {}) {
    const p = part(partName);
    p.trim.gain.cancelScheduledValues(ctx.currentTime);
    if (smooth) p.trim.gain.setTargetAtTime(Math.max(0, gain), ctx.currentTime, 0.01);
    else p.trim.gain.value = Math.max(0, gain);
  }

  /**
   * Fades every voice of a part within `fadeSeconds`; voices scheduled to start after `when` are
   * dropped without sounding. Used when another part takes over (the tone lab's combo switch).
   */
  function releasePart(partName, fadeSeconds = 0.03, when = ctx.currentTime) {
    for (const voice of voices) {
      if (voice.part !== partName || voice.released) continue;
      if (voice.when > when) {
        voice.released = true;
        for (const source of voice.sources) { try { source.stop(); } catch { /* already stopped */ } }
      } else {
        release(voice, fadeSeconds, when);
      }
    }
    const p = parts.get(partName);
    if (p) p.lastPluckWhen = -Infinity;
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
    const when = ctx.currentTime + delay;
    const { render, gain: level } = voiceParams(tone, { freq, velocity, position }, settings);
    const take = (options, start, destination) => {
      const data = renderPluck({ ...options, sampleRate: ctx.sampleRate });
      const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buffer.getChannelData(0).set(data);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = level;
      source.connect(gain).connect(destination);
      source.start(start);
      return { source, gain };
    };

    // Strum choke (only tones that ask for it): a new strum, i.e. a pluck more than strumWindow
    // after the part's previous one, fades whatever is still ringing, as re-strumming a guitar does.
    if (tone.strumChoke && when - p.lastPluckWhen > settings.strumWindow / 1000) {
      for (const other of voices) {
        if (other.part === partName && !other.released && other.when < when) release(other, tone.strumChoke, when);
      }
    }
    p.lastPluckWhen = Math.max(p.lastPluckWhen, when);

    const sources = [], gains = [];
    let panner = null;
    if (p.double) {
      // Double-tracked: no per-string pan (the two chains are panned apart). The second take has
      // its own excitation noise, a slight detune and a short delay, like a second recorded pass.
      const detune = Math.pow(2, tone.double.detuneCents / 1200);
      for (const [options, start, bus] of [[render, when, p.bus], [{ ...render, freq: render.freq * detune }, when + tone.double.delay, p.double.bus]]) {
        const t = take(options, start, bus);
        sources.push(t.source); gains.push(t.gain);
      }
    } else {
      let destination = p.bus;
      if (ctx.createStereoPanner) {
        panner = ctx.createStereoPanner();
        panner.pan.value = clamp(pan * (tone.panWidth ?? 1), -1, 1);
        panner.connect(p.bus);
        destination = panner;
      }
      const t = take(render, when, destination);
      sources.push(t.source); gains.push(t.gain);
    }

    const voice = {
      sources, gains, key, when, released: false, part: partName,
      pitchClass: pitchClassOf(freq), depthDb: tone.releaseDepthDb,
    };
    // Re-plucking a string chokes its previous voice, and the voice limit fades the oldest, both
    // from the moment the new voice starts (strums are scheduled a little ahead).
    if (key !== null) {
      for (const other of voices) if (other.key === key && other.part === partName && !other.released) release(other, 0.04, when);
    }
    voices.push(voice);
    let ended = 0;
    for (const source of sources) {
      source.onended = () => {
        if (++ended < sources.length) return;
        voices = voices.filter(x => x !== voice);
        for (const s of sources) s.disconnect();
        for (const g of gains) g.disconnect();
        panner?.disconnect();
      };
    }
    const active = voices.filter(x => !x.released);
    for (let i = 0; i < active.length - settings.maxVoices; i++) release(active[i], 0.06, when);
  }

  let song = null;
  /**
   * @param {AudioBuffer} buffer
   * @param {() => void} [onEnded]
   * @param {number} [leadSeconds]
   * @param {object} [o]
   * @param {{ start: number, end: number }} [o.loop]  play this section (seconds) in a loop until stopped
   */
  function playSong(buffer, onEnded, leadSeconds = 0.12, { loop = null } = {}) {
    stopSong();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(songGain);
    const startTime = ctx.currentTime + leadSeconds;
    if (loop) {
      source.loop = true;
      source.loopStart = loop.start;
      source.loopEnd = loop.end;
      source.start(startTime, loop.start);
    } else {
      source.start(startTime);
    }
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
      return tone ? t60For(freq, tone, settings) / 4.5 : 0.6;
    },
    setTrim,
    releasePart,
    // Current gain reduction of the output limiter (dB, ≤ 0), for measurements.
    get limiterReduction() { return limiter.reduction; },
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
