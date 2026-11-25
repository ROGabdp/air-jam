// How a pluck (frequency, velocity, where the finger crossed the string) becomes Karplus-Strong
// parameters and a voice gain for a given tone. Pure, shared by the engine and the Node
// measurements (tools/tone-lab/), so both play the same notes.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Decay shortens with pitch like a real string; settings.decay scales it (0.996 = neutral).
export function t60For(freq, tone, settings) {
  const sustain = clamp(0.004 / Math.max(1e-4, 1 - settings.decay), 0.2, 3);
  return clamp(tone.string.t60 * sustain * Math.pow(130 / freq, 0.45), 0.4, 6);
}

/**
 * @param tone      a tone from tones.js / tone-lab.js
 * @param {object} o
 * @param {number} o.freq
 * @param {number} [o.velocity]  0..1
 * @param {number} [o.position]  0..1 along the string where the finger crossed it
 * @param settings  SETTINGS (decay)
 * @returns {{ render: object, gain: number }}  renderPluck options (without sampleRate/random) and the voice gain
 */
export function voiceParams(tone, { freq, velocity = 0.6, position = 0.5 }, settings) {
  const v = clamp(velocity, 0, 1);
  const pick = tone.pick ?? { mode: 'follow' };
  let brightness, pickPosition;
  if (pick.mode === 'fixed') {
    // Electric strings are picked near the bridge whatever the finger crossed: keep the even
    // harmonics, and do not darken the source because the crossing was in the middle.
    pickPosition = clamp(pick.position, 0.06, 0.5);
    brightness = clamp(tone.string.brightness * (0.8 + 0.3 * v), 0.05, 1);
  } else {
    // Crossing the middle sounds mellow (and hollow), the ends bright.
    const edge = Math.min(1, Math.abs(position - 0.5) * 2);
    pickPosition = clamp(0.5 - 0.42 * edge, 0.06, 0.5);
    brightness = clamp(tone.string.brightness * (0.3 + 0.5 * edge + 0.3 * v), 0.05, 1);
  }
  const render = {
    freq: clamp(freq, 40, 4000),
    t60: t60For(freq, tone, settings),
    damping: tone.string.damping * clamp(Math.sqrt(330 / freq), 0.3, 1),
    brightness,
    pickPosition,
  };
  if (tone.string.maxSeconds) render.maxSeconds = tone.string.maxSeconds;
  return { render, gain: 0.22 + 0.78 * v * v };
}
