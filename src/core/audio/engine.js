// Web Audio engine: song playback, the plucked-voice bus with a swappable tone chain,
// voice limiting and output protection. Everything is timed on AudioContext.currentTime.
import { renderPluck } from './karplus.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function createAudioEngine(settings) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioContextClass({ latencyHint: 'interactive' });

  // song ─────────────────────────────► songGain ─┐
  // voices ► tone chain ► stringGain ► glue comp ─┴► limiter ► destination
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20;
  limiter.attack.value = 0.002; limiter.release.value = 0.12;
  limiter.connect(ctx.destination);

  const songGain = ctx.createGain();
  songGain.connect(limiter);

  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -16; glue.knee.value = 10; glue.ratio.value = 5;
  glue.attack.value = 0.004; glue.release.value = 0.18;
  glue.connect(limiter);
  const stringGain = ctx.createGain();
  stringGain.connect(glue);
  const voiceBus = ctx.createGain();
  voiceBus.gain.value = 0.3;

  function applyVolumes() {
    songGain.gain.value = clamp(settings.songVolume, 0, 1) * 0.85;
    stringGain.gain.value = clamp(settings.stringVolume, 0, 1);
  }
  applyVolumes();

  let tone = null;
  let chain = null;
  function setTone(next) {
    voiceBus.disconnect();
    chain?.output.disconnect();
    chain?.dispose();
    tone = next;
    chain = tone.createChain(ctx);
    voiceBus.connect(chain.input);
    chain.output.connect(stringGain);
  }

  let voices = [];
  function release(voice, fadeSeconds) {
    const from = Math.max(ctx.currentTime, voice.when);
    voice.released = true;
    voice.gain.gain.cancelScheduledValues(from);
    voice.gain.gain.setTargetAtTime(0, from, fadeSeconds / 3);
    try { voice.source.stop(from + fadeSeconds * 2); } catch { /* already stopped */ }
  }

  // Decay shortens with pitch like a real string; settings.decay scales it (0.996 = neutral).
  function t60For(freq) {
    const sustain = clamp(0.004 / Math.max(1e-4, 1 - settings.decay), 0.2, 3);
    return clamp(tone.string.t60 * sustain * Math.pow(130 / freq, 0.45), 0.4, 6);
  }

  /**
   * @param {object} o
   * @param {number} o.freq
   * @param {number} [o.velocity]  0..1
   * @param {number} [o.position]  0..1 along the string (0.5 = middle, mellow; ends = bright)
   * @param {number} [o.pan]       -1..1
   * @param {number} [o.delay]     seconds from now
   * @param {*} [o.key]            voices sharing a key choke each other (re-plucking one string)
   */
  function pluck({ freq, velocity = 0.6, position = 0.5, pan = 0, delay = 0, key = null }) {
    if (!tone) return;
    const v = clamp(velocity, 0, 1);
    const edge = Math.min(1, Math.abs(position - 0.5) * 2);
    const data = renderPluck({
      freq: clamp(freq, 40, 4000),
      sampleRate: ctx.sampleRate,
      t60: t60For(freq),
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
      panner.pan.value = clamp(pan, -1, 1);
      gain.connect(panner).connect(voiceBus);
    } else {
      gain.connect(voiceBus);
    }
    source.start(when);

    const voice = { source, gain, key, when, released: false };
    if (key !== null) for (const other of voices) if (other.key === key && !other.released) release(other, 0.04);
    voices.push(voice);
    source.onended = () => {
      voices = voices.filter(x => x !== voice);
      source.disconnect(); gain.disconnect(); panner?.disconnect();
    };
    const active = voices.filter(x => !x.released);
    for (let i = 0; i < active.length - settings.maxVoices; i++) release(active[i], 0.06);
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
    get tone() { return tone; },
    pluck,
    applyVolumes,
    // Time constant (seconds) for visuals that should fade with the audible decay.
    ringTime: freq => t60For(freq) / 4.5,
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
