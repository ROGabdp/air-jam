// 延遲 (delay) — post-effects slot 2 of 3 (chorus → delay → reverb), after the amp/cab and both takes.
// Interface and on/off rules: ./index.js. Until implemented this is a transparent bypass.
//
// TODO(delay): docs/效果器_設計挑戰.md M5 and stage 5 acceptance: echo time follows the *pulse*
// (setTempo), the multiple (or 1.5×) of the pulse that lands in 280–450 ms, so a tempo guessed at ×2
// or ×½ gives the same echo; knob 'time' steps short / dotted / long; re-time on every setTempo
// (manual corrections) without clicks. onChordChange: duck the send into the echo line so old-chord
// echoes are ≥ 20 dB down within one echo period. docs/效果器研究.md section 4 (delay row): DelayNode
// with max time given at create (e.g. 2 s), low-pass 2.5–4 kHz + high-pass 150 Hz inside the feedback
// loop, feedback 0–0.6, mix 0–40 %. Rhythm presets keep it off.
export const id = 'delay';

/** Pure: the pedal's numbers from a board snapshot; off for null, an off pedal or one without sound. */
export function paramsFromSnapshot(snapshot) {
  const pedal = snapshot?.pedals?.delay;
  return { on: pedal?.on === true && pedal?.sound === true, values: { ...(pedal?.values ?? {}) } };
}

export function create(ctx, { input, output }) {
  input.connect(output);
  return {
    apply() {},
    dispose() { input.disconnect(output); },
  };
}

/** Node model: bypass returns the signal unchanged. */
export function process(params, signal) {
  return signal;
}
