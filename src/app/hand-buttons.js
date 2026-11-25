// Page buttons pressed with the hands (camera mode): the same pinch-tap as the pedalboard's
// footswitches (core/pedals/gestures.js: from an open, settled hand, pinch and let go within
// pedalTapTime without moving), plus the rule that a hand over a button belongs to the buttons:
// it is withheld from the instrument, so aiming at or pressing a button never stretches, plucks,
// deletes or clears strings. Pure: targets are rectangles in stage pixels supplied by the caller.
import { createPedalGestures, createLockout, createRegionGate, toPointers } from '../core/pedals/gestures.js';
import { inRect } from '../core/pedals/layout.js';

/**
 * @param {object} settings  pedalTapTime, pedalTapMove, pedalSettle, pedalLockout (shared with the pedalboard)
 * @param {{pad?: number, exitMargin?: number}} options  pad: px around each button that still counts
 */
export function createHandButtons(settings, { pad = 10, exitMargin = 0.25 } = {}) {
  const gestures = createPedalGestures(settings);
  const lockout = createLockout(settings.pedalLockout);
  const gate = createRegionGate(exitMargin);

  /**
   * @param {object[]} hands   this frame's hands (camera or mouse)
   * @param {number} now       seconds
   * @param {{rect:{x,y,w,h}}[]} targets  pressable buttons, front-most first
   * @returns {{hands: object[], taps: object[], hovered: object[], pressed: object[]}}
   *   hands: the ones the pedalboard / instrument may still use; taps: targets to activate now
   */
  function route(hands, now, targets) {
    const pointers = toPointers(hands);
    const hit = point => targets.find(target => inRect(point, target.rect, pad)) ?? null;
    // The mouse presses page buttons with real clicks; only camera hands pinch-tap here.
    const handPointers = pointers.filter(p => p.source !== 'mouse');
    const taps = [];
    for (const event of gestures.update(handPointers, now, point => hit(point))) {
      if (event.type !== 'tap' || lockout.blocked(now)) continue;
      lockout.trigger(now);
      taps.push(event.target);
    }

    const over = targets.length
      ? gate.update(pointers, (p, margin) => targets.some(target => inRect(p, target.rect, pad + margin)))
      : (gate.reset(), new Set());
    const engaged = gestures.engaged();
    const withheld = new Set();
    for (const pointer of pointers) {
      if (over.has(pointer.id) || engaged.has(pointer.id)) for (const id of pointer.handIds) withheld.add(id);
    }
    return {
      hands: withheld.size ? hands.filter(hand => !withheld.has(hand.id)) : hands,
      taps,
      hovered: handPointers.filter(p => !p.pinching).map(p => hit(p.probe)).filter(Boolean),
      pressed: gestures.presses().map(p => p.target),
    };
  }

  return {
    route,
    reset() { gestures.reset(); gate.reset(); lockout.reset(); },
  };
}
