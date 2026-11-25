// 延遲 (delay) — post-effects slot 2 of 3 (chorus → delay → reverb), after the amp/cab and both takes.
// Interface and on/off rules: ./index.js; spec: docs/設計說明.md 15.1.6 (延遲).
//
// An analog-style (BBD-like) feedback delay: every repeat passes a 150 Hz high-pass and the 音色
// low-pass again, so repeats get darker and thinner (docs/效果器研究.md 4.3); a 0.3 Hz ±0.15 ms
// wobble on the delay time adds a little analog drift. Stereo: each echo loop has a left and a right
// line; 來回 (ping-pong) feeds the mono sum into the left line only and crosses the feedback, so
// repeats alternate left / right.
//
//   input ─► dry (1; level in advanced mode) ─────────────────────────────────────────► output
//     └─► send (on/off) ─► sendDuck ─┬─► inj A ─► loop A (L/R lines ⟲ hp ─ lp ─ fbDuck ─ fb) ─► retDuck A ─┬─► ret (mix) ─► output
//                                    └─► inj B ─► loop B (the same)                          ─► retDuck B ─┘
//
// Echo time (docs/效果器_設計挑戰.md M5): follows the song's *pulse*: pulse × 2^k that lands in
// 280–450 ms, or 1.5 × that when the octave of the pulse falls in 225–280 ms (dotted). Halving or
// doubling the tempo (慢一半／快一倍) keeps the pulse grid, so the echo time does not change.
// Without a song: 375 ms. Advanced mode: 短 ×½ / 中 ×1 / 長 ×2 of that, or 自由 (80–1200 ms).
//
// Time changes never bend echoes that are on their way: two identical loops (A, B). A new time goes
// to the idle loop (40 ms ramp; only its old trail can bend) and the send crossfades to it; the old
// loop's echoes ring out at the old time. While nothing sent to the active loop since it took over
// has come out yet, a change retimes it in place instead (so a knob drag needs no third loop).
//
// Chord change (onChordChange): old-chord echoes must be ≥ 20 dB down within one echo period. The
// send closes for 30 ms (the choked old voices' tail), and each loop's feedback and return close
// until one of its periods (+ 15 ms, still inside the send's gap) has passed: everything in its line
// then was played before the change. Then they reopen. 換和弦收 (duck) scales how far they close. The dry signal is never touched.
//
// On/off: off closes only the send, so echoes ring out (trails); return, feedback and tone keep
// their last settings. A new slot is off: send gain exactly 0, so the output is bit-exact x + 0.
// Feedback ≤ 0.6 and both loop filters are Butterworth (|H| ≤ 1): loop gain < 1, always stable.
export const id = 'delay';

export const DELAY_RANGES = {
  mix: [0, 40],          // % (回音量): wet return; the dry signal stays at unity
  feedback: [0, 60],     // % (重複): gain per repeat before the loop filters
  freeMs: [80, 1200],    // 自由 time
  toneHz: [1500, 6000],  // 音色: loop low-pass
  duck: [0, 100],        // % (換和弦收)
  level: [-12, 6],       // dB, advanced mode only (dry and wet)
};
// Normalised knob defaults (src/core/pedals/model.js PEDAL_TYPES.delay).
export const DELAY_DEFAULT_KNOBS = { mix: 0.5, feedback: 0.5, sync: 0, time: 0.5, free: 0.57, tone: 0.5, pingpong: 0, duck: 1 };
export const DELAY_SYNC = { minSeconds: 0.28, maxSeconds: 0.45, fallbackSeconds: 0.375, steps: [0.5, 1, 2] };
export const DELAY_DSP = {
  maxSeconds: 2,         // delay lines allocated at create (longest use: 自由 1.2 s)
  highpassHz: 150,
  filterQ: -3.01,        // dB (Web Audio lowpass / highpass Q): Butterworth, no peak
  modHz: 0.3,
  modSeconds: 0.00015,   // ±0.15 ms (≈ ±0.5 cent), left and right in opposite phase
  rampSeconds: 0.04,     // retime ramp
  crossfadeTau: 0.015,
  duckTau: 0.004,
  restoreTau: 0.008,
  sendHold: 0.03,        // send closed this long after a chord change
  returnHold: 0.015,     // return and feedback reopen this long after one period (still inside the send's gap)
  toggleTau: 0.012,      // engine PEDAL_TAU.toggle (the Node model's switch time)
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fromDb = db => Math.pow(10, db / 20);
const logKnob = ([lo, hi], v) => lo * Math.pow(hi / lo, v);

// Physical values at the knob defaults (simple mode uses them for the advanced-only knobs).
const DEFAULTS = {
  sync: 0, time: 1, pingpong: 0,
  free: logKnob(DELAY_RANGES.freeMs, DELAY_DEFAULT_KNOBS.free),
  tone: logKnob(DELAY_RANGES.toneHz, DELAY_DEFAULT_KNOBS.tone),
  duck: DELAY_RANGES.duck[1] * DELAY_DEFAULT_KNOBS.duck,
  mix: DELAY_RANGES.mix[1] * DELAY_DEFAULT_KNOBS.mix,
  feedback: DELAY_RANGES.feedback[1] * DELAY_DEFAULT_KNOBS.feedback,
};

/** Pure: the pedal's numbers from a board snapshot; off for null, an off pedal or one without sound. */
export function paramsFromSnapshot(snapshot) {
  const pedal = snapshot?.pedals?.delay;
  return {
    on: pedal?.on === true && pedal?.sound === true,
    simple: snapshot?.mode !== 'advanced',
    values: { ...(pedal?.values ?? {}) },
  };
}

/**
 * Pure: physical settings from params. Simple mode reads only 回音量 and 重複 (the rest at their
 * defaults: synced, 中, centred, full duck, no level change).
 */
export function delaySettings(params) {
  const v = params?.values ?? {};
  const simple = params?.simple !== false;
  const num = (k, d) => (Number.isFinite(v[k]) ? v[k] : d);
  const adv = (k, d) => (simple ? d : num(k, d));
  return {
    mix: clamp(num('mix', DEFAULTS.mix), ...DELAY_RANGES.mix) / 100,
    feedback: clamp(num('feedback', DEFAULTS.feedback), ...DELAY_RANGES.feedback) / 100,
    sync: adv('sync', DEFAULTS.sync) < 0.5,
    step: clamp(Math.round(adv('time', DEFAULTS.time)), 0, DELAY_SYNC.steps.length - 1),
    freeSeconds: clamp(adv('free', DEFAULTS.free), ...DELAY_RANGES.freeMs) / 1000,
    toneHz: clamp(adv('tone', DEFAULTS.tone), ...DELAY_RANGES.toneHz),
    pingpong: adv('pingpong', DEFAULTS.pingpong) >= 0.5 ? 1 : 0,
    duck: clamp(adv('duck', DEFAULTS.duck), ...DELAY_RANGES.duck) / 100,
    levelGain: simple ? 1 : fromDb(clamp(num('level', 0), ...DELAY_RANGES.level)),
  };
}

/**
 * Pure: the synced echo time for a pulse: pulse × 2^k in [max/2, max), kept if ≥ min, else × 1.5.
 * Scaling by 2 is exact in floating point, so pulse, 2·pulse and pulse/2 give the same number.
 */
export function syncSeconds(pulseSeconds, { minSeconds = DELAY_SYNC.minSeconds, maxSeconds = DELAY_SYNC.maxSeconds } = {}) {
  if (!(pulseSeconds > 0) || !Number.isFinite(pulseSeconds)) return DELAY_SYNC.fallbackSeconds;
  let x = pulseSeconds;
  while (x >= maxSeconds) x /= 2;
  while (x < maxSeconds / 2) x *= 2;
  return x >= minSeconds ? x : 1.5 * x;
}

/** Pure: echo time (s) for settings and tempo ({ pulseSeconds, beatSeconds } | null). */
export function echoSeconds(settings, tempo) {
  if (!settings.sync) return settings.freeSeconds;
  const base = tempo?.pulseSeconds > 0 ? syncSeconds(tempo.pulseSeconds) : DELAY_SYNC.fallbackSeconds;
  return base * DELAY_SYNC.steps[settings.step];
}

// ---------- control: the same automation for Web Audio params and the Node model ----------

// A group of AudioParam-likes that always get the same automation.
const group = (...params) => ({
  cancel(t) { for (const p of params) p.cancelScheduledValues(t); },
  set(v, t) { for (const p of params) p.setValueAtTime(v, t); },
  target(v, t, tau) { for (const p of params) p.setTargetAtTime(v, t, tau); },
  ramp(v, t) { for (const p of params) p.linearRampToValueAtTime(v, t); },
});

/**
 * @param P  param groups: dry, send, sendDuck, ret, fbStraight, fbCross, injLL, injRL, injRR, tone,
 *           and per loop [A, B]: inj, time, fbDuck, retDuck
 */
function createControl(P) {
  let settings = delaySettings(null);
  let tempo = null;
  let active = 0, lastSwitch = -Infinity, sent = false;
  const loopSeconds = [DELAY_SYNC.fallbackSeconds, DELAY_SYNC.fallbackSeconds];

  function rampLoop(k, seconds, now) {
    P.time[k].cancel(now);
    P.time[k].set(loopSeconds[k], now);
    P.time[k].ramp(seconds, now + DELAY_DSP.rampSeconds);
    loopSeconds[k] = seconds;
  }

  function retime(target, now) {
    const seconds = clamp(target, 0.02, DELAY_DSP.maxSeconds - 0.05);
    if (Math.abs(seconds - loopSeconds[active]) < 1e-6) return;
    if (!sent) {
      // Nothing was ever sent: both lines are silent, jump.
      for (const k of [0, 1]) { P.time[k].cancel(now); P.time[k].set(seconds, now); loopSeconds[k] = seconds; }
      return;
    }
    // Nothing sent to the active loop since it took over has come out yet: retime it in place.
    if (now - lastSwitch + DELAY_DSP.rampSeconds < Math.min(loopSeconds[active], seconds)) {
      rampLoop(active, seconds, now);
      return;
    }
    const idle = 1 - active;
    rampLoop(idle, seconds, now);
    P.inj[active].target(0, now, DELAY_DSP.crossfadeTau);
    P.inj[idle].target(1, now, DELAY_DSP.crossfadeTau);
    active = idle;
    lastSwitch = now;
  }

  // Knob-driven params glide to a new value only when it changed (a change of another pedal
  // automates nothing here).
  const last = { dry: 1, send: 0, ret: 0, fbStraight: 0, fbCross: 0, injLL: 1, injRL: 0, injRR: 1, tone: null };
  const follow = (name, value, now, tau) => {
    if (last[name] === value) return;
    last[name] = value;
    P[name].target(value, now, tau);
  };

  return {
    get state() { return { active, loopSeconds: [...loopSeconds], lastSwitch, settings }; },
    apply(params, change, { now, tau = DELAY_DSP.toggleTau } = {}) {
      const on = params?.on === true;
      const t = Math.max(1e-4, tau);
      follow('send', on ? 1 : 0, now, t);
      if (!on) {
        // Trails: only the send closes; echoes ring out with the last settings.
        follow('dry', 1, now, t);
        return;
      }
      const s = delaySettings(params);
      settings = s;
      follow('dry', s.levelGain, now, t);
      follow('ret', s.mix * s.levelGain, now, t);
      follow('fbStraight', s.feedback * (1 - s.pingpong), now, t);
      follow('fbCross', s.feedback * s.pingpong, now, t);
      follow('injLL', 1 - s.pingpong / 2, now, t);
      follow('injRL', s.pingpong / 2, now, t);
      follow('injRR', 1 - s.pingpong, now, t);
      follow('tone', s.toneHz, now, t);
      retime(echoSeconds(s, tempo), now);   // before `sent`: the first switch-on may still jump
      sent = true;
    },
    setTempo(next, { now }) {
      tempo = next && next.pulseSeconds > 0 ? { pulseSeconds: next.pulseSeconds, beatSeconds: next.beatSeconds } : null;
      retime(echoSeconds(settings, tempo), now);
    },
    onChordChange(time) {
      const floor = 1 - settings.duck;
      if (floor >= 1) return;
      P.sendDuck.cancel(time);
      P.sendDuck.target(floor, time, DELAY_DSP.duckTau);
      P.sendDuck.target(1, time + DELAY_DSP.sendHold, DELAY_DSP.restoreTau);
      for (const k of [0, 1]) {
        for (const g of [P.fbDuck[k], P.retDuck[k]]) {
          g.cancel(time);
          g.target(floor, time, DELAY_DSP.duckTau);
          g.target(1, time + loopSeconds[k] + DELAY_DSP.returnHold, DELAY_DSP.restoreTau);
        }
      }
    },
  };
}

// Initial values of every param (a new slot: off, both loops at the fallback time).
const INITIAL = {
  dry: 1, send: 0, sendDuck: 1, ret: 0, fbStraight: 0, fbCross: 0, injLL: 1, injRL: 0, injRR: 1,
  tone: DEFAULTS.tone, inj: [1, 0], time: [DELAY_SYNC.fallbackSeconds, DELAY_SYNC.fallbackSeconds], fbDuck: [1, 1], retDuck: [1, 1],
};

// ---------- Web Audio ----------

export function create(ctx, { input, output }) {
  const nodes = [];
  const gain = value => { const g = ctx.createGain(); g.gain.value = value; nodes.push(g); return g; };
  const filter = (type, frequency) => {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = frequency; f.Q.value = DELAY_DSP.filterQ;
    nodes.push(f);
    return f;
  };

  const dry = gain(INITIAL.dry);
  input.connect(dry);
  dry.connect(output);
  const send = gain(INITIAL.send), sendDuck = gain(INITIAL.sendDuck), ret = gain(INITIAL.ret);
  input.connect(send);
  send.connect(sendDuck);
  ret.connect(output);

  // 0.3 Hz wobble on every line's delay time (left +, right −).
  const lfo = ctx.createOscillator();
  lfo.frequency.value = DELAY_DSP.modHz;
  const modL = gain(DELAY_DSP.modSeconds), modR = gain(-DELAY_DSP.modSeconds);
  lfo.connect(modL); lfo.connect(modR);

  const loops = [0, 1].map(k => {
    const inj = gain(INITIAL.inj[k]);
    sendDuck.connect(inj);
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    nodes.push(split, merge);
    inj.connect(split);
    const injLL = gain(INITIAL.injLL), injRL = gain(INITIAL.injRL), injRR = gain(INITIAL.injRR);
    split.connect(injLL, 0); split.connect(injRL, 1); split.connect(injRR, 1);
    const lines = [0, 1].map(() => {
      const d = ctx.createDelay(DELAY_DSP.maxSeconds);
      d.delayTime.value = INITIAL.time[k];
      nodes.push(d);
      return d;
    });
    injLL.connect(lines[0]); injRL.connect(lines[0]); injRR.connect(lines[1]);
    modL.connect(lines[0].delayTime); modR.connect(lines[1].delayTime);
    const hp = lines.map(() => filter('highpass', DELAY_DSP.highpassHz));
    const lp = lines.map(() => filter('lowpass', INITIAL.tone));
    const fbDuck = lines.map(() => gain(INITIAL.fbDuck[k]));
    const straight = lines.map(() => gain(INITIAL.fbStraight));
    const cross = lines.map(() => gain(INITIAL.fbCross));
    for (const c of [0, 1]) {
      lines[c].connect(hp[c]); hp[c].connect(lp[c]); lp[c].connect(fbDuck[c]);
      fbDuck[c].connect(straight[c]); straight[c].connect(lines[c]);
      fbDuck[c].connect(cross[c]); cross[c].connect(lines[1 - c]);
      lp[c].connect(merge, 0, c);
    }
    const retDuck = gain(INITIAL.retDuck[k]);
    merge.connect(retDuck);
    retDuck.connect(ret);
    return { inj, injLL, injRL, injRR, lines, lp, fbDuck, straight, cross, retDuck };
  });
  lfo.start();

  const all = key => loops.flatMap(l => [].concat(l[key]).map(n => n.gain));
  const control = createControl({
    dry: group(dry.gain), send: group(send.gain), sendDuck: group(sendDuck.gain), ret: group(ret.gain),
    fbStraight: group(...all('straight')), fbCross: group(...all('cross')),
    injLL: group(...all('injLL')), injRL: group(...all('injRL')), injRR: group(...all('injRR')),
    tone: group(...loops.flatMap(l => l.lp.map(f => f.frequency))),
    inj: loops.map(l => group(l.inj.gain)),
    time: loops.map(l => group(...l.lines.map(d => d.delayTime))),
    fbDuck: loops.map(l => group(...l.fbDuck.map(g => g.gain))),
    retDuck: loops.map(l => group(l.retDuck.gain)),
  });

  return {
    control,
    nodes: { dry, send, sendDuck, ret, loops, lfo },
    apply(params, change, { now = ctx.currentTime, tau } = {}) { control.apply(params, change, { now, tau }); },
    setTempo(tempo, { now = ctx.currentTime } = {}) { control.setTempo(tempo, { now }); },
    onChordChange(time) { control.onChordChange(time); },
    dispose() {
      try { lfo.stop(); } catch { /* not started */ }
      lfo.disconnect();
      input.disconnect(dry);
      input.disconnect(send);
      for (const n of nodes) n.disconnect();
    },
  };
}

// ---------- Node model ----------

/** AudioParam stand-in: records automation like Web Audio and renders it per sample. */
export class ModelParam {
  constructor(value) { this.value = value; this.events = []; }
  cancelScheduledValues(time) { this.events = this.events.filter(e => e.time < time); return this; }
  setValueAtTime(value, time) { return this.#add({ type: 'set', value, time }); }
  setTargetAtTime(target, time, tau) { return this.#add({ type: 'target', target, time, tau }); }
  linearRampToValueAtTime(value, time) { return this.#add({ type: 'linear', value, time }); }
  #add(e) {
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].time > e.time) i--;
    this.events.splice(i, 0, e);
    return this;
  }
  render(length, sampleRate) {
    const out = new Float32Array(length);
    const ev = this.events;
    let v = this.value, idx = 0, seg = null, t0 = 0, v0 = v;
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      while (idx < ev.length) {
        const e = ev[idx];
        if (e.type === 'linear') {
          // A ramp runs from the previous event to its own time.
          if (t >= e.time) { v = e.value; seg = null; t0 = e.time; v0 = v; idx++; continue; }
          seg = { type: 'linear', t0, v0, t1: e.time, v1: e.value };
          break;
        }
        if (e.time > t) break;
        if (e.type === 'set') { v = e.value; seg = null; }
        else seg = { type: 'target', t0: e.time, v0: v, target: e.target, tau: e.tau };
        t0 = e.time; v0 = v;
        idx++;
      }
      if (seg?.type === 'linear') v = seg.v0 + (seg.v1 - seg.v0) * (t - seg.t0) / (seg.t1 - seg.t0);
      else if (seg?.type === 'target') v = seg.target + (seg.v0 - seg.target) * Math.exp(-(t - seg.t0) / seg.tau);
      out[i] = v;
    }
    return out;
  }
}

// Web Audio biquad coefficients (lowpass / highpass, Q in dB), normalised.
function lowHighCoefficients(type, frequency, qDb, sampleRate) {
  const w0 = 2 * Math.PI * clamp(frequency, 1, sampleRate * 0.49) / sampleRate;
  const cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * Math.pow(10, qDb / 20));
  const a0 = 1 + alpha;
  const b = type === 'lowpass' ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: -2 * cos / a0, a2: (1 - alpha) / a0 };
}

/**
 * Node model: the same control code, sample by sample. Options beyond the bus interface, for tests:
 *   events: [{ time, type: 'apply', params, tau? } | { time, type: 'tempo', tempo }], besides
 *   chordChanges; trace: true adds { trace: { time: [A, B], inj: [A, B], control } } (per sample).
 * Off (and no events switching it on) returns the signal unchanged.
 */
export function process(params, signal, { sampleRate = 48000, tempo = null, chordChanges = [], events = [], trace = false } = {}) {
  const on = params?.on === true;
  if (!on && !events.some(e => e.type === 'apply' && e.params?.on === true)) return signal;
  const length = signal.left.length;
  const mp = v => new ModelParam(v);
  const P = {
    dry: mp(INITIAL.dry), send: mp(INITIAL.send), sendDuck: mp(INITIAL.sendDuck), ret: mp(INITIAL.ret),
    fbStraight: mp(INITIAL.fbStraight), fbCross: mp(INITIAL.fbCross), injLL: mp(INITIAL.injLL), injRL: mp(INITIAL.injRL),
    injRR: mp(INITIAL.injRR), tone: mp(INITIAL.tone),
    inj: INITIAL.inj.map(mp), time: INITIAL.time.map(mp), fbDuck: INITIAL.fbDuck.map(mp), retDuck: INITIAL.retDuck.map(mp),
  };
  const asGroup = x => (Array.isArray(x) ? x.map(p => group(p)) : group(x));
  const control = createControl(Object.fromEntries(Object.entries(P).map(([k, x]) => [k, asGroup(x)])));
  control.setTempo(tempo, { now: 0 });
  const timeline = [
    ...(on ? [{ time: 0, type: 'apply', params, order: 0 }] : []),
    ...events.map((e, i) => ({ ...e, order: 1 + i })),
    ...chordChanges.map((time, i) => ({ time, type: 'chord', order: 1e6 + i })),
  ].sort((a, b) => a.time - b.time || a.order - b.order);
  for (const e of timeline) {
    if (e.type === 'apply') control.apply(e.params, { type: 'toggle' }, { now: e.time, tau: e.tau ?? DELAY_DSP.toggleTau });
    else if (e.type === 'tempo') control.setTempo(e.tempo, { now: e.time });
    else if (e.type === 'chord') control.onChordChange(e.time);
  }
  const render = x => (Array.isArray(x) ? x.map(p => p.render(length, sampleRate)) : x.render(length, sampleRate));
  const T = Object.fromEntries(Object.entries(P).map(([k, x]) => [k, render(x)]));

  const size = Math.ceil(DELAY_DSP.maxSeconds * sampleRate) + 4;
  const lines = [0, 1].map(() => [new Float32Array(size), new Float32Array(size)]);
  const hp = lowHighCoefficients('highpass', DELAY_DSP.highpassHz, DELAY_DSP.filterQ, sampleRate);
  const state = () => ({ x1: 0, x2: 0, y1: 0, y2: 0 });
  const hpState = [0, 1].map(() => [state(), state()]);
  const lpState = [0, 1].map(() => [state(), state()]);
  const run = (c, s, x) => {
    const y = c.b0 * x + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;
    s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y;
    return y;
  };
  const read = (buf, pos, delay) => {
    let r = pos - delay;
    while (r < 0) r += size;
    const i0 = Math.floor(r), f = r - i0;
    return buf[i0 % size] * (1 - f) + buf[(i0 + 1) % size] * f;
  };
  const left = new Float32Array(length), right = new Float32Array(length);
  let lp = null, lpHz = -1;
  const w = 2 * Math.PI * DELAY_DSP.modHz / sampleRate;
  for (let i = 0, pos = 0; i < length; i++, pos = (pos + 1) % size) {
    if ((i & 127) === 0 && T.tone[i] !== lpHz) { lpHz = T.tone[i]; lp = lowHighCoefficients('lowpass', lpHz, DELAY_DSP.filterQ, sampleRate); }
    const xL = signal.left[i], xR = signal.right[i];
    const s = T.send[i] * T.sendDuck[i];
    const uL = xL * s, uR = xR * s;
    const mod = DELAY_DSP.modSeconds * Math.sin(w * i) * sampleRate;
    let wetL = 0, wetR = 0;
    for (let k = 0; k < 2; k++) {
      const [bufL, bufR] = lines[k];
      const d = T.time[k][i] * sampleRate;
      let yL = read(bufL, pos, d + mod), yR = read(bufR, pos, d - mod);
      yL = run(lp, lpState[k][0], run(hp, hpState[k][0], yL));
      yR = run(lp, lpState[k][1], run(hp, hpState[k][1], yR));
      const g = T.inj[k][i], fd = T.fbDuck[k][i], fs = T.fbStraight[i], fc = T.fbCross[i];
      bufL[pos] = g * (T.injLL[i] * uL + T.injRL[i] * uR) + fd * (fs * yL + fc * yR);
      bufR[pos] = g * T.injRR[i] * uR + fd * (fs * yR + fc * yL);
      const r = T.retDuck[k][i];
      wetL += r * yL; wetR += r * yR;
    }
    left[i] = xL * T.dry[i] + T.ret[i] * wetL;
    right[i] = xR * T.dry[i] + T.ret[i] * wetR;
  }
  const out = { left, right };
  if (trace) out.trace = { time: T.time, inj: T.inj, control: control.state };
  return out;
}
