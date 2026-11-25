// The only place where the pedalboard meets sound. Today it connects nothing: effects DSP is a
// later stage. To wire it, give the audio engine an applyPedals(snapshot, change) method (build the
// chain once; toggles cross-fade, knobs use setTargetAtTime; see docs/效果器_設計挑戰.md M4) and
// an audition source; nothing in the model, gestures or drawing has to change.
//
// snapshot (model.boardSnapshot): { mode, autoLevel, preset, order: ['wah', …, 'amp', …],
//   pedals: { [id]: { on, params: { knob: 0..1 }, values: { knob: physical units } } } }
// change: see createPedalModel (toggle / param / order / preset / mode / load).

/**
 * @param {{subscribe:Function, snapshot:Function}} model
 * @param {() => object|null} getEngine   the audio engine may be created later (first user gesture)
 * @returns {() => void} unsubscribe
 */
export function bindPedalAudio(model, getEngine) {
  let told = false;
  const apply = (snapshot, change) => {
    const engine = getEngine();
    if (typeof engine?.applyPedals === 'function') { engine.applyPedals(snapshot, change); return; }
    if (!told) {
      told = true;
      console.info('[Air Jam] pedalboard: effects DSP is not connected yet; the board only stores settings.');
    }
  };
  return model.subscribe(apply);
}

// Tuning screen audition (a looped song section plus a recorded strum, while the strings are
// inert). The audio part belongs to the tone lab; this stub keeps the screen's start/stop calls.
export function createAuditionStub() {
  return {
    running: false,
    start() { this.running = false; console.info('[Air Jam] pedalboard: audition loop not connected yet'); },
    stop() { this.running = false; },
  };
}
