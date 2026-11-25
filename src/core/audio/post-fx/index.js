// Post-effects bus: the time-based pedals (合聲 chorus → 延遲 delay → 空間 reverb), one bus per
// engine part, after the part's takes are summed (main + double, stereo) and trimmed, before the
// part goes to the string gain / glue / limiter:
//
//   take chains (both switchable copies) ► panners ► trim ► [chorus] ► [delay] ► [reverb] ► stringGain
//
// So echoes and reverb tails are never duplicated per take or per switchable chain copy, and a
// tone change (setTone rebuilds the chains) does not rebuild the bus. The order is fixed here; the
// advanced mode's chain order does not reach the sound yet. Docs: docs/設計說明.md 15.1.6.
//
// A slot module (chorus.js, delay.js, reverb.js) exports:
//   id                                   'chorus' | 'delay' | 'reverb'
//   paramsFromSnapshot(snapshot) → params   pure; snapshot = model.boardSnapshot() or null.
//                                        Must return an "off" params object for null, for a pedal
//                                        that is off and for one without sound (sound: false).
//   create(ctx, { input, output, part }) → instance
//       input, output: unity GainNodes owned by the bus (slot n's output is slot n+1's input).
//       The module connects input → … → output and never touches nodes outside its slot.
//       instance.apply(params, change, { now, tau })   every pedal change (applyPedals) and every
//                                        setTone of the part; not at create: a new slot starts off.
//         change: the model's { type: 'toggle'|'param'|'order'|'preset'|'mode'|'load', … } or
//         { type: 'tone' } (the part's tone changed; non-rig tones get the "off" params).
//         tau: the smoothing time constant to use (knob glide for 'param', switch fade otherwise).
//       instance.setTempo?(tempo, { now })   tempo = { pulseSeconds, beatSeconds } | null (no song);
//                                        on creation (if a song is loaded), on every song load, tone
//                                        or key-guard change that rebuilds the song map, and manual
//                                        tempo corrections. Same numbers may come twice.
//       instance.onChordChange?(time)     the game's chord changed (AudioContext time of the change,
//                                        the same moment old-chord voices are choked). Every tone.
//       instance.onStrum?(time, velocity)  a new strum begins on this part (first pluck more than
//                                        settings.strumWindow after the previous one), at its start time.
//       instance.dispose()                 disconnect everything the module made.
//   process?(params, { left, right }, { sampleRate, tempo, chordChanges, strums }) → { left, right }
//       optional Node model for tests/measurements (Float32Arrays; chordChanges / strums: times in
//       seconds). Bypass returns its input unchanged.
//
// On/off without clicks (how a module should switch): keep the dry path input → output connected at
// unity forever and add the effect as a parallel wet path into `output`; switching only moves the
// wet (or send) gain with setTargetAtTime(target, now, tau). Off at creation = wet gain exactly 0, so
// the slot is bit-exact x + 0. For delay/reverb prefer closing the *send* into the echo line / IR, so
// tails ring out like a pedal's "trails" mode (the wet return stays up); closing the return cuts them.
// Never rebuild nodes on a pedal change; build the maximum delay line / IR size steps at create.
// No look-ahead, no added latency on the dry path.
import * as chorus from './chorus.js';
import * as delay from './delay.js';
import * as reverb from './reverb.js';

export const POST_FX_ORDER = ['chorus', 'delay', 'reverb'];
export const POST_FX_MODULES = { chorus, delay, reverb };

/** { chorus, delay, reverb } params for a pedalboard snapshot (null → everything off). */
export function postFxParams(snapshot, modules = POST_FX_MODULES) {
  return Object.fromEntries(POST_FX_ORDER.map(id => [id, modules[id].paramsFromSnapshot(snapshot ?? null)]));
}

/**
 * @param {BaseAudioContext} ctx
 * @param {object} [o]
 * @param {string} [o.part]     engine part name ('rhythm', a tone lab combo, later 'lead')
 * @param {object} [o.modules]  { chorus, delay, reverb } (tests swap in spies)
 */
export function createPostFxBus(ctx, { part = 'rhythm', modules = POST_FX_MODULES } = {}) {
  const input = ctx.createGain();
  let node = input;
  const slots = POST_FX_ORDER.map(id => {
    const slotInput = node;
    const slotOutput = ctx.createGain();
    const fx = modules[id].create(ctx, { input: slotInput, output: slotOutput, part });
    node = slotOutput;
    return { id, input: slotInput, output: slotOutput, fx };
  });
  let tempo = null;
  return {
    input,
    output: node,
    slots,
    get tempo() { return tempo; },
    apply(params, change, { now = ctx.currentTime, tau } = {}) {
      for (const slot of slots) slot.fx.apply(params[slot.id], change, { now, tau });
    },
    setTempo(next, { now = ctx.currentTime } = {}) {
      tempo = next && next.pulseSeconds > 0 && next.beatSeconds > 0
        ? { pulseSeconds: next.pulseSeconds, beatSeconds: next.beatSeconds } : null;
      for (const slot of slots) slot.fx.setTempo?.(tempo, { now });
    },
    onChordChange(time) { for (const slot of slots) slot.fx.onChordChange?.(time); },
    onStrum(time, velocity) { for (const slot of slots) slot.fx.onStrum?.(time, velocity); },
    dispose() {
      for (const slot of slots) slot.fx.dispose();
      for (const slot of slots) slot.output.disconnect();
      input.disconnect();
    },
  };
}

/**
 * Node model of the bus (same order). Modules without `process` pass the signal through.
 * @param params  postFxParams(snapshot)
 * @param {{ left: Float32Array, right: Float32Array }} signal
 */
export function processPostFx(params, signal, options = {}, modules = POST_FX_MODULES) {
  let out = signal;
  for (const id of POST_FX_ORDER) out = modules[id].process ? modules[id].process(params[id], out, options) : out;
  return out;
}
