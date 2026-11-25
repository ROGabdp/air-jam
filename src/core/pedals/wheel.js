// Mouse wheel → wah pedal position (mouse mode). With one pointer a player cannot strum and reach
// the wah strip at the same time, so in mouse mode the wheel rocks the pedal from anywhere on the
// stage (over a knob it still turns the knob). Pure: notches from a WheelEvent, and a glide that
// eases the strip's position to where the wheel sent it.

export const WAH_WHEEL = {
  notches: 12,          // wheel notches from heel to toe
  pixelsPerNotch: 100,  // Chrome / Edge / Safari report a notch as 100 px (deltaMode 0)
  linesPerNotch: 3,     // Firefox: 3 lines per notch (deltaMode 1)
  maxNotches: 3,        // per event: a flicked free-spinning wheel cannot jump the whole range at once
  tau: 0.06,            // glide time constant (s): a notch is heard as a short sweep, not a step
  settle: 0.002,        // closer than this to the target: arrived (and saved)
};

/**
 * Signed notches of a wheel event: positive = towards the toe (bright). The wheel rolled up (away
 * from you, deltaY < 0) opens the pedal, like pushing it up the strip. Shift + wheel (which browsers
 * report as deltaX) and sideways trackpad swipes count the same way; trackpads give fractions.
 */
export function wheelNotches(event, o = WAH_WHEEL) {
  const dx = Number(event?.deltaX) || 0, dy = Number(event?.deltaY) || 0;
  const delta = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
  if (!delta) return 0;
  const mode = event.deltaMode ?? 0;
  const notches = mode === 1 ? delta / o.linesPerNotch : mode === 2 ? delta * o.notches : delta / o.pixelsPerNotch;
  return -Math.max(-o.maxNotches, Math.min(o.maxNotches, notches));
}

/**
 * Glide of the wah position towards where the wheel sent it.
 *   nudge(current, notches)  moves the target (from the current target while gliding, else from
 *                            `current`, the position now: so the strip and the wheel take turns)
 *   step(dt)                 → { value, done } this frame, or null when not gliding
 *   cancel()                 the strip took over
 */
export function createWheelGlide(o = WAH_WHEEL) {
  let target = null, value = 0;
  const clamp01 = v => Math.max(0, Math.min(1, v));
  return {
    get target() { return target; },
    get active() { return target !== null; },
    nudge(current, notches) {
      if (!notches) return target;
      if (target === null) value = clamp01(current);
      target = clamp01((target ?? value) + notches / o.notches);
      return target;
    },
    step(dt) {
      if (target === null) return null;
      value += (target - value) * (1 - Math.exp(-Math.max(0, dt) / o.tau));
      if (Math.abs(target - value) < o.settle) {
        value = target;
        target = null;
        return { value, done: true };
      }
      return { value, done: false };
    },
    cancel() { target = null; },
  };
}
