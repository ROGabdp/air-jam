// The only place where the pedalboard meets sound. The audio engine's applyPedals(snapshot, change)
// (src/core/audio/engine.js) moves the electric rig to the board's settings: knobs glide, switches
// cross-fade between two copies of the chain, nothing is rebuilt while playing. Wah, overdrive and
// distortion have sound (model.js PEDALS_WITH_SOUND; snapshot.pedals[id].sound); chorus, delay and
// reverb are stored but silent. The wah's position (strip, strums, beat) moves its own signal in
// the engine, not the chain (src/core/audio/wah.js). The game also calls applyPedals once when it
// creates the engine (first user gesture), so settings made before that are heard.
//
// snapshot (model.boardSnapshot): { mode, autoLevel, preset, order: ['wah', …, 'amp', …],
//   pedals: { [id]: { on, sound, params: { knob: 0..1 }, values: { knob: physical units } } } }
// change: see createPedalModel (toggle / param / order / preset / mode / load).
// The chain order is not applied to the sound yet (fixed: wah → overdrive → distortion → amp).

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
      console.info('[Air Jam] pedalboard: no audio engine yet; the settings are applied when it starts.');
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
