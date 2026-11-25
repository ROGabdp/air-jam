// Which pedals can be used yet. A UI-level flag, separate from the model and the DSP: a pedal
// without sound is drawn dimmed with "即將推出" and cannot be switched or turned (its stored
// settings are kept). Flip an entry to true when its effect is connected to the audio engine.
export const PEDAL_AVAILABLE = {
  wah: true,
  overdrive: true,
  distortion: true,
  chorus: true,
  delay: false,
  reverb: false,
};

export const isPedalAvailable = id => PEDAL_AVAILABLE[id] === true;

// For the audio side (or the console) to switch pedals on as their DSP lands: { chorus: true, … }.
export function setPedalAvailability(map) {
  for (const [id, available] of Object.entries(map ?? {})) {
    if (id in PEDAL_AVAILABLE) PEDAL_AVAILABLE[id] = available === true;
  }
}
