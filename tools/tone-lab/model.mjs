// Node model of what src/core/audio/engine.js plays, for measurements without a browser:
// voices (Karplus buffers, voice gains, per-string pan, chokes, the voice limit, strum choke,
// double-tracking) → part bus → the tone's stages (stages.js) → trim, then optionally the master
// bus (string gain → glue compressor, song gain, limiter, ceiling). With `post` the part also runs
// the post-effects bus (chorus → delay → reverb, post-fx/index.js processPostFx).
//
// Exact: Karplus buffers, voice parameters, release envelopes, biquads (Web Audio formulas),
// waveshaper curves, stereo panner law. Approximate: the waveshaper runs without 4× oversampling,
// and the two DynamicsCompressorNodes are a textbook soft-knee compressor with Chrome-style
// automatic make-up gain, not Chrome's exact algorithm. The tone lab's browser measurement
// (airJam.lab.measure()) runs the same metrics on the real audio graph to check the model.
import { renderPluck } from '../../src/core/audio/karplus.js';
import { releaseTimeConstant, ceilingCurve, shapeSample } from '../../src/core/audio/distortion.js';
import { processStages } from '../../src/core/audio/stages.js';
import { voiceParams } from '../../src/core/audio/voice-params.js';
import { processPostFx } from '../../src/core/audio/post-fx/index.js';

export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pitchClassOf = freq => ((Math.round(69 + 12 * Math.log2(freq / 440)) % 12) + 12) % 12;
// StereoPannerNode with a mono input (equal power).
const panGains = pan => {
  const x = (Math.max(-1, Math.min(1, pan)) + 1) / 2;
  return [Math.cos(x * Math.PI / 2), Math.sin(x * Math.PI / 2)];
};

/**
 * Renders one engine part at the output of its chain (after the trim, before stringGain).
 * @param tone
 * @param {Array<{ time, freq, velocity?, position?, pan?, key? }>} events
 * @param {object} o
 * @param {number} o.duration   seconds
 * @param {Array<{ time, keep?: number[], all?: boolean, fade?: number }>} [o.chokes]
 *        keep: chord change (engine.chokeChord); all: engine.releasePart with `fade`
 * @param {number} [o.sampleRate]
 * @param {object} o.settings   SETTINGS
 * @param {number} [o.seed]
 * @param {number} [o.trim]
 * @param {number|Float32Array} [o.wah]  wah position: fixed, or a per-sample track (wah.js simulateParam)
 * @param {object} [o.post]   post-effects params (postFxParams(snapshot)); null = no post bus (bypass)
 * @param {{ pulseSeconds, beatSeconds }} [o.tempo]  for the post-effects (delay sync)
 * @returns {{ sampleRate: number, left: Float32Array, right: Float32Array }}
 */
export function renderPart(tone, events, { duration, chokes = [], sampleRate = 48000, settings, seed = 1, trim = 1, wah = 0.5, post = null, tempo = null }) {
  const length = Math.round(duration * sampleRate);
  const random = seeded(seed);
  const double = !!tone.double;
  // Chain inputs: [main L, main R] (stereo after the per-string panner), or mono main + mono double.
  const mainL = new Float32Array(length), mainR = new Float32Array(length);
  const second = double ? new Float32Array(length) : null;

  const voices = [];
  let lastPluckWhen = -Infinity;
  const release = (voice, fade, when) => {
    const from = Math.max(when, voice.when);
    voice.released = true;
    voice.from = from;
    voice.tau = releaseTimeConstant(fade, voice.depthDb);
    voice.stop = Math.min(voice.stop, from + Math.max(fade * 1.5, voice.tau * 7));
  };
  const alive = when => voices.filter(v => !v.released && v.stop > when);

  const items = [
    ...chokes.map(c => ({ ...c, type: 'choke' })),
    ...events.map(e => ({ ...e, type: 'pluck' })),
  ].sort((a, b) => a.time - b.time || (a.type === 'choke' ? -1 : 1));

  for (const item of items) {
    const when = item.time;
    if (item.type === 'choke') {
      if (item.all) {
        for (const voice of voices) {
          if (voice.released || voice.stop <= when) continue;
          if (voice.when > when) { voice.released = true; voice.stop = voice.when; } else release(voice, item.fade, when);
        }
        lastPluckWhen = -Infinity;
      } else if (tone.chordChoke) {
        for (const voice of alive(when)) if (!item.keep.includes(voice.pitchClass)) release(voice, tone.chordChoke, when);
      }
      continue;
    }
    const { render, gain } = voiceParams(tone, item, settings);
    if (tone.strumChoke && when - lastPluckWhen > settings.strumWindow / 1000) {
      for (const other of alive(when)) if (other.when < when) release(other, tone.strumChoke, when);
    }
    lastPluckWhen = Math.max(lastPluckWhen, when);
    const takes = [{ data: renderPluck({ ...render, sampleRate, random }), start: when, target: 'main' }];
    if (double) {
      const detune = Math.pow(2, tone.double.detuneCents / 1200);
      takes.push({ data: renderPluck({ ...render, freq: render.freq * detune, sampleRate, random }), start: when + tone.double.delay, target: 'double' });
    }
    const end = Math.max(...takes.map(t => t.start + t.data.length / sampleRate));
    const voice = {
      takes, gain, when, key: item.key ?? null, pitchClass: pitchClassOf(item.freq), depthDb: tone.releaseDepthDb,
      pan: double ? null : panGains((item.pan ?? 0) * (tone.panWidth ?? 1)),
      released: false, from: Infinity, tau: 1, stop: end,
    };
    if (voice.key !== null) {
      for (const other of alive(when)) if (other.key === voice.key) release(other, 0.04, when);
    }
    voices.push(voice);
    const active = alive(when);
    for (let i = 0; i < active.length - settings.maxVoices; i++) release(active[i], 0.06, when);
  }

  for (const voice of voices) {
    for (const take of voice.takes) {
      const first = Math.round(take.start * sampleRate);
      const stop = Math.min(length, Math.round(voice.stop * sampleRate));
      const from = voice.from * sampleRate, tau = voice.tau * sampleRate;
      for (let i = Math.max(0, first); i < stop && i - first < take.data.length; i++) {
        const env = i < from ? voice.gain : voice.gain * Math.exp(-(i - from) / tau);
        const x = take.data[i - first] * env * 0.3;   // part bus
        if (take.target === 'double') second[i] += x;
        else if (voice.pan) { mainL[i] += x * voice.pan[0]; mainR[i] += x * voice.pan[1]; }
        else mainL[i] += x;
      }
    }
  }

  const left = new Float32Array(length), right = new Float32Array(length);
  if (double) {
    const a = processStages(tone.stages, mainL, sampleRate, { wah });
    const b = processStages(tone.double.stages, second, sampleRate, { wah });
    const [aL, aR] = panGains(-tone.double.pan), [bL, bR] = panGains(tone.double.pan);
    for (let i = 0; i < length; i++) {
      left[i] = (a[i] * aL + b[i] * bL) * trim;
      right[i] = (a[i] * aR + b[i] * bR) * trim;
    }
  } else {
    const l = processStages(tone.stages, mainL, sampleRate, { wah });
    const r = processStages(tone.stages, mainR, sampleRate, { wah });
    for (let i = 0; i < length; i++) { left[i] = l[i] * trim; right[i] = r[i] * trim; }
  }
  if (post) {
    // Same moments the engine calls onChordChange / onStrum.
    const chordChanges = chokes.filter(c => c.keep).map(c => c.time);
    const strums = [];
    let last = -Infinity;
    for (const e of [...events].sort((a, b) => a.time - b.time)) {
      if (e.time - last > settings.strumWindow / 1000) strums.push(e.time);
      last = Math.max(last, e.time);
    }
    return { sampleRate, ...processPostFx(post, { left, right }, { sampleRate, tempo, chordChanges, strums }) };
  }
  return { sampleRate, left, right };
}

/**
 * Soft-knee feed-forward compressor, stereo-linked, with automatic make-up gain
 * (1 / gain at full scale)^0.6 as Web Audio's DynamicsCompressorNode applies it.
 * @returns {{ left, right, reductionDb: Float32Array }}
 */
export function compress(left, right, sampleRate, { threshold, knee, ratio, attack, release }) {
  const curve = db => {
    const over = db - threshold;
    if (2 * over < -knee) return db;
    if (knee > 0 && 2 * Math.abs(over) <= knee) return db + (1 / ratio - 1) * Math.pow(over + knee / 2, 2) / (2 * knee);
    return threshold + over / ratio;
  };
  const makeupDb = -0.6 * curve(0);
  const a = Math.exp(-1 / (Math.max(1e-4, attack) * sampleRate));
  const r = Math.exp(-1 / (Math.max(1e-4, release) * sampleRate));
  const outL = new Float32Array(left.length), outR = new Float32Array(right.length);
  const reductionDb = new Float32Array(left.length);
  let reduction = 0;
  for (let i = 0; i < left.length; i++) {
    const level = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    const db = level > 1e-9 ? 20 * Math.log10(level) : -180;
    const target = curve(db) - db;                         // ≤ 0
    reduction = target < reduction ? a * reduction + (1 - a) * target : r * reduction + (1 - r) * target;
    reductionDb[i] = reduction;
    const g = Math.pow(10, (reduction + makeupDb) / 20);
    outL[i] = left[i] * g; outR[i] = right[i] * g;
  }
  return { left: outL, right: outR, reductionDb };
}

/**
 * Master bus of the engine: strings × stringGain → glue; song × songGain; both → limiter → ceiling.
 * @param {{ left, right } | null} strings  part output (renderPart)
 * @param {{ left, right } | null} song     song samples, same rate and length
 */
export function renderMaster(strings, song, { sampleRate, settings }) {
  const length = (strings ?? song).left.length;
  const zero = new Float32Array(length);
  const sv = Math.max(0, Math.min(1, settings.stringVolume)), gv = Math.max(0, Math.min(1, settings.songVolume)) * 0.85;
  let sl = zero, sr = zero;
  if (strings) {
    const glue = compress(strings.left.map(v => v * sv), strings.right.map(v => v * sv), sampleRate,
      { threshold: -16, knee: 10, ratio: 5, attack: 0.004, release: 0.18 });
    sl = glue.left; sr = glue.right;
  }
  const mixL = new Float32Array(length), mixR = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    mixL[i] = sl[i] + (song ? song.left[i] * gv : 0);
    mixR[i] = sr[i] + (song ? song.right[i] * gv : 0);
  }
  const limited = compress(mixL, mixR, sampleRate, { threshold: -2, knee: 0, ratio: 20, attack: 0.002, release: 0.12 });
  const ceiling = ceilingCurve();
  for (let i = 0; i < length; i++) {
    limited.left[i] = shapeSample(limited.left[i], ceiling);
    limited.right[i] = shapeSample(limited.right[i], ceiling);
  }
  return limited;
}

/**
 * Renderer for src/lab/metrics.js backed by this model.
 * @param settings SETTINGS
 */
export function modelRenderer(settings, sampleRate = 48000) {
  let seed = 1;
  return async ({ tone, events, chokes = [], duration, song = null, master = false, strings = true, trim = 1, wah = 0.5 }) => {
    const part = strings ? renderPart(tone, events, { duration, chokes, sampleRate, settings, seed: seed++, trim, wah }) : null;
    if (!master) return part;
    const songCut = song ? { left: song.left.subarray(0, part?.left.length ?? Math.round(duration * sampleRate)), right: song.right.subarray(0, part?.left.length ?? Math.round(duration * sampleRate)) } : null;
    const out = renderMaster(part, songCut, { sampleRate, settings });
    let limiterDb = 0;
    // Skip the first second, as the browser renderer does (Chrome's meter starts reduced).
    for (let i = sampleRate; i < out.reductionDb.length; i++) limiterDb = Math.min(limiterDb, out.reductionDb[i]);
    return { sampleRate, left: out.left, right: out.right, limiterDb };
  };
}
