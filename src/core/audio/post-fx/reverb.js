// 空間 (reverb) — post-effects slot 3 of 3 (chorus → delay → reverb), after the amp/cab and both takes.
// Interface and on/off rules: ./index.js. Until implemented this is a transparent bypass.
//
// TODO(reverb): docs/效果器研究.md (section 2 ConvolverNode, section 4 reverb row: 0.4–2.5 s,
// mix 0–35 %, pre-delay 15–30 ms) and docs/效果器_設計挑戰.md stage 5: a generated impulse response
// (like tones.js impulseResponse) in fixed size steps (knob 'size': small / medium / large),
// built at create — never regenerate the IR while playing; switching size cross-fades between
// convolvers. Knob 'tone' (advanced) darkens the wet. Steel/nylon have their own room in tones.js
// and get the 'off' params here (the engine only applies pedal params to rig parts).
export const id = 'reverb';

/** Pure: the pedal's numbers from a board snapshot; off for null, an off pedal or one without sound. */
export function paramsFromSnapshot(snapshot) {
  const pedal = snapshot?.pedals?.reverb;
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
