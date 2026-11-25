// 合聲 (chorus) — post-effects slot 1 of 3 (chorus → delay → reverb), after the amp/cab and both takes.
// Interface and on/off rules: ./index.js. Until implemented this is a transparent bypass.
//
// TODO(chorus): docs/效果器研究.md (CE-2 row: BBD, triangle LFO, wet low-passed = darker, warmer;
// 'DelayNode + OscillatorNode (LFO) + GainNode' in section 2; table row for chorus in section 4) and
// docs/效果器_設計挑戰.md stage 5. Knobs (model.js): depth 0–3 ms, mix 0–50 %, rate 0.1–3 Hz (advanced),
// level. Darkened wet (low-pass in the wet path). Dry stays at unity; mix moves the wet gain only.
export const id = 'chorus';

/** Pure: the pedal's numbers from a board snapshot; off for null, an off pedal or one without sound. */
export function paramsFromSnapshot(snapshot) {
  const pedal = snapshot?.pedals?.chorus;
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
