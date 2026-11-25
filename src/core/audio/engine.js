// Web Audio engine: song playback, plucked voices in parts (each part has its own tone and
// effect-chain instance), voice limiting, chord-change chokes, the pedalboard's settings for the
// electric rig, and output protection. Everything is timed on AudioContext.currentTime.
import { createPluck, sustainStretch } from './karplus.js';
import { releaseTimeConstant, ceilingCurve } from './distortion.js';
import { voiceParams, t60For } from './voice-params.js';
import { rigFromSnapshot, electricTone } from './electric-rig.js';
import { createWahControl } from './wah.js';

// Live contexts render only the first part of a pluck when it is played and the rest a moment later,
// in small slices between frames (most of a long note is never heard: the next strum chokes it).
export const PLUCK_HEAD_SECONDS = 0.4;
const TAIL_SLICE_MS = 4;
// Pedal changes (setTargetAtTime time constants): knobs glide, switches cross-fade in ~3τ.
export const PEDAL_TAU = { toggle: 0.012, knob: 0.025 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pitchClassOf = freq => ((Math.round(69 + 12 * Math.log2(freq / 440)) % 12) + 12) % 12;

/**
 * @param settings SETTINGS
 * @param {object} [o]
 * @param {BaseAudioContext} [o.context]  e.g. an OfflineAudioContext for measurements
 * @param {boolean} [o.master]  false: strings and song go straight to the output, without the glue
 *                              compressor, limiter and ceiling (to measure a tone chain on its own)
 */
export function createAudioEngine(settings, { context = null, master = true, streaming = context === null } = {}) {
  const ctx = context ?? new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  // Electric rig settings from the pedalboard (null: no pedalboard, the rig is 丁 = 搖滾).
  let pedalSnapshot = null;
  // Song beat position for the wah's 跟拍子 sweep: (songSeconds) => { beats, beatSeconds } | null.
  let wahClock = null;

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
      p = { name, bus, trim, tone: null, chain: null, panner: null, double: null, lastPluckWhen: -Infinity, wah: null };
      parts.set(name, p);
    }
    return p;
  }

  let voices = [];
  // Fade a voice so it is its release depth down after `fadeSeconds`: the tone's depth when it was
  // plucked, or now if the pedals have added drive since.
  function release(voice, fadeSeconds, when = ctx.currentTime) {
    const from = Math.max(when, voice.when);
    voice.released = true;
    const depth = Math.max(voice.depthDb, parts.get(voice.part)?.tone?.releaseDepthDb ?? 0);
    const tau = releaseTimeConstant(fadeSeconds, depth);
    for (const gain of voice.gains) {
      gain.gain.cancelScheduledValues(from);
      gain.gain.setTargetAtTime(0, from, tau);
    }
    voice.stopAt = from + Math.max(fadeSeconds * 1.5, tau * 7);
    for (const source of voice.sources) {
      try { source.stop(voice.stopAt); } catch { /* already stopped */ }
    }
  }

  // ---------- pluck tails (live contexts) ----------
  // A pluck's first PLUCK_HEAD_SECONDS play from a buffer rendered on the spot; the rest is a queued
  // tail, rendered in ≤ TAIL_SLICE_MS slices and started exactly where the head ends (both on whole
  // sample frames). Tails of voices that are released before them are never rendered.
  const tails = [];
  let tailsQueued = false;
  const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
  if (channel) {
    channel.port1.onmessage = () => { tailsQueued = false; renderTails(); };
    channel.port1.unref?.();   // Node (tests with a fake context): do not keep the process alive
  }
  function queueTails() {
    if (tailsQueued || !tails.length) return;
    tailsQueued = true;
    if (channel) channel.port2.postMessage(0);
    else setTimeout(() => { tailsQueued = false; renderTails(); }, 0);
  }
  function renderTails(budgetMs = TAIL_SLICE_MS) {
    const started = performance.now();
    tails.sort((a, b) => a.start - b.start);
    while (tails.length && performance.now() - started < budgetMs) {
      const tail = tails.shift();
      const { voice } = tail;
      voice.pendingTails--;
      if (voice.released && voice.stopAt <= tail.start) { settle(voice); continue; }
      const data = tail.pluck.next(tail.pluck.length - tail.pluck.rendered);
      const source = startBuffer(data, tail.start, tail.gain);
      voice.sources.push(source);
      if (voice.released) { try { source.stop(voice.stopAt); } catch { /* past */ } }
      source.onended = () => settle(voice, true);
    }
    queueTails();
  }
  function startBuffer(data, when, destination) {
    const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buffer.getChannelData(0).set(data);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    const late = ctx.currentTime - when;
    // A tail rendered after its start time (a long stall) keeps its place: it starts part-way in.
    if (late > 0) source.start(ctx.currentTime, late);
    else source.start(when);
    return source;
  }
  // A voice is finished when all its sources ended and no tail is pending.
  function settle(voice, sourceEnded = false) {
    if (voice.done) return;
    if (sourceEnded) voice.ended++;
    if (voice.pendingTails > 0 || voice.ended < voice.sources.length) return;
    voice.done = true;
    voices = voices.filter(x => x !== voice);
    for (const s of voice.sources) s.disconnect();
    for (const g of voice.gains) g.disconnect();
    voice.panner?.disconnect();
  }

  // The electric rig's tone for the current pedal settings (other tones are used as they are).
  const resolveTone = tone => (tone?.rig ? electricTone(rigFromSnapshot(pedalSnapshot)) : tone);

  // ---------- wah position ----------
  // One position signal per rig part (a ConstantSourceNode both takes' wah stages read, wah.js);
  // the controller turns pedal settings, strums and frames into automation on it.
  function partWah(p) {
    if (!p.wah) {
      const source = ctx.createConstantSource();
      source.offset.value = 0.5;
      source.start();
      p.wah = { source, control: createWahControl({ strumWindow: settings.strumWindow / 1000 }) };
    }
    return p.wah;
  }
  function automateWah(p, calls) {
    const param = p.wah?.source.offset;
    if (!param) return;
    for (const call of calls) {
      if (call.type === 'cancel') param.cancelScheduledValues(call.time);
      else if (call.type === 'target') param.setTargetAtTime(call.value, call.time, call.tau);
      else if (call.type === 'set') param.setValueAtTime(call.value, call.time);
    }
  }
  const songClock = () => (wahClock && song ? at => wahClock(at - song.startTime) : null);

  function setTone(next, partName = 'rhythm') {
    next = resolveTone(next);
    const p = part(partName);
    p.rigKey = next?.rig ? JSON.stringify(next.stages) : null;
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
    const controls = next.rig ? { wah: partWah(p).source } : undefined;
    if (next.rig) automateWah(p, p.wah.control.configure(rigFromSnapshot(pedalSnapshot).wah, ctx.currentTime));
    p.chain = next.createChain(ctx, controls);
    p.bus.connect(p.chain.input);
    if (next.double && ctx.createStereoPanner) {
      // Double-tracking: a second, slightly different chain fed by its own take of every note.
      p.panner = ctx.createStereoPanner();
      p.panner.pan.value = -next.double.pan;
      p.chain.output.connect(p.panner).connect(p.trim);
      const bus = ctx.createGain();
      bus.gain.value = 0.3;
      const chain = next.double.createChain(ctx, controls);
      const panner = ctx.createStereoPanner();
      panner.pan.value = next.double.pan;
      bus.connect(chain.input);
      chain.output.connect(panner).connect(p.trim);
      p.double = { bus, chain, panner };
    } else {
      p.chain.output.connect(p.trim);
    }
  }

  /**
   * Pedalboard settings (src/core/pedals/audio-binding.js calls this with every model change, and
   * the game once when the engine is created). Parts playing the electric rig move their chains to
   * the new numbers without rebuilding them: toggles cross-fade, knobs glide, ringing notes go on.
   * Pedals without sound (snapshot.pedals[id].sound === false) are ignored.
   * @returns {object} the rig numbers now in use
   */
  function applyPedals(snapshot, change = { type: 'load' }) {
    pedalSnapshot = snapshot ?? null;
    const rig = rigFromSnapshot(pedalSnapshot);
    const tone = electricTone(rig);
    const key = JSON.stringify(tone.stages);
    // Knobs glide on the audible copy; anything that switches a pedal cross-fades to the other copy.
    const glide = change?.type === 'param';
    for (const p of parts.values()) {
      if (!p.tone?.rig) continue;
      automateWah(p, partWah(p).control.configure(rig.wah, ctx.currentTime));
      // Voice-side settings (the 延音 knob) take effect from the next pluck; the chains only move
      // when their stages changed.
      p.tone = tone;
      if (p.rigKey === key) continue;
      for (const [chain, stages] of [[p.chain, tone.stages], [p.double?.chain, tone.double.stages]]) {
        if (!chain) continue;
        if (glide) chain.update(stages, { tau: PEDAL_TAU.knob });
        else chain.switchTo(stages, { fade: PEDAL_TAU.toggle });
      }
      p.rigKey = key;
    }
    return rig;
  }

  /**
   * Every frame: the wah's 跟拍子 sweep follows the song's beat grid (set with setWahClock), or a
   * free 100 BPM pulse when no song is playing.
   */
  function tickWah() {
    const clock = songClock();
    for (const p of parts.values()) if (p.tone?.rig && p.wah) automateWah(p, p.wah.control.frame(ctx.currentTime, clock));
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
        voice.stopAt = voice.when;
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
    const sampleRate = ctx.sampleRate;
    // On a whole sample frame, so a streamed tail continues the head exactly.
    const when = streaming ? Math.round((ctx.currentTime + delay) * sampleRate) / sampleRate : ctx.currentTime + delay;
    const { render, gain: level } = voiceParams(tone, { freq, velocity, position }, settings);
    const voice = {
      sources: [], gains: [], key, when, released: false, part: partName, panner: null,
      pitchClass: pitchClassOf(freq), depthDb: tone.releaseDepthDb, stopAt: Infinity, pendingTails: 0, ended: 0, done: false,
    };
    const take = (options, start, destination) => {
      const pluck = createPluck({ ...options, sampleRate });
      const head = streaming ? Math.min(pluck.length, Math.round(PLUCK_HEAD_SECONDS * sampleRate)) : pluck.length;
      const gain = ctx.createGain();
      gain.gain.value = level;
      gain.connect(destination);
      const source = startBuffer(pluck.next(head), start, gain);
      voice.sources.push(source); voice.gains.push(gain);
      if (pluck.rendered < pluck.length) {
        voice.pendingTails++;
        tails.push({ voice, pluck, gain, start: start + head / sampleRate });
      }
    };

    // Strum choke (only tones that ask for it): a new strum, i.e. a pluck more than strumWindow
    // after the part's previous one, fades whatever is still ringing, as re-strumming a guitar does.
    if (tone.strumChoke && when - p.lastPluckWhen > settings.strumWindow / 1000) {
      for (const other of voices) {
        if (other.part === partName && !other.released && other.when < when) release(other, tone.strumChoke, when);
      }
    }
    p.lastPluckWhen = Math.max(p.lastPluckWhen, when);
    // Auto wah (跟刷弦): each strum opens the pedal (wah.js).
    if (tone.rig && p.wah) automateWah(p, p.wah.control.pluck(when, velocity));

    if (p.double) {
      // Double-tracked: no per-string pan (the two chains are panned apart). The second take has
      // its own excitation noise, a slight detune and a short delay, like a second recorded pass.
      const detune = Math.pow(2, tone.double.detuneCents / 1200);
      const delay2 = streaming ? Math.round(tone.double.delay * sampleRate) / sampleRate : tone.double.delay;
      take(render, when, p.bus);
      take({ ...render, freq: render.freq * detune }, when + delay2, p.double.bus);
    } else {
      let destination = p.bus;
      if (ctx.createStereoPanner) {
        voice.panner = ctx.createStereoPanner();
        voice.panner.pan.value = clamp(pan * (tone.panWidth ?? 1), -1, 1);
        voice.panner.connect(p.bus);
        destination = voice.panner;
      }
      take(render, when, destination);
    }
    // Re-plucking a string chokes its previous voice, and the voice limit fades the oldest, both
    // from the moment the new voice starts (strums are scheduled a little ahead).
    if (key !== null) {
      for (const other of voices) if (other.key === key && other.part === partName && !other.released) release(other, 0.04, when);
    }
    voices.push(voice);
    for (const source of voice.sources) source.onended = () => settle(voice, true);
    const active = voices.filter(x => !x.released);
    for (let i = 0; i < active.length - settings.maxVoices; i++) release(active[i], 0.06, when);
    queueTails();
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
    applyPedals,
    get tone() { return parts.get('rhythm')?.tone ?? null; },
    // Electric rig numbers for the current pedal settings (for the console and measurements).
    get rig() { return rigFromSnapshot(pedalSnapshot); },
    tickWah,
    // (songSeconds) => { beats, beatSeconds } | null: the beat grid the wah's 跟拍子 sweep follows.
    setWahClock(clock) { wahClock = typeof clock === 'function' ? clock : null; },
    // The rhythm part's wah position param (console and tests).
    get wahParam() { return parts.get('rhythm')?.wah?.source.offset ?? null; },
    pluck,
    chokeChord,
    applyVolumes,
    // Time constant (seconds) for visuals that should fade with the audible decay.
    ringTime: (freq, partName = 'rhythm') => {
      const tone = parts.get(partName)?.tone;
      return tone ? t60For(freq, tone, settings) / 4.5 * (tone.sustain > 0 ? sustainStretch(tone.sustain) : 1) : 0.6;
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
    get pendingTails() { return tails.length; },
    // Renders every queued tail now (tests and measurements).
    flushTails: () => renderTails(Infinity),
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
