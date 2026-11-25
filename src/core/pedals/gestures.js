// Pedalboard gestures, pure and frame-driven so they can be tested with synthetic hands.
//   pinch-tap   pinch on → off within pedalTapTime, pinch point moving less than pedalTapMove
//   pinch-hold  pinched longer than that without moving: nothing happens (lets a player abort)
//   pinch-drag  on a knob, vertical travel past pedalDragDeadband turns it, relative to where the
//               drag started, pedalKnobTravel palm sizes for the full range; on release the knob
//               keeps the value it had pedalLatch ms earlier (camera only: the pinch point jumps
//               as thumb and index separate)
//               A footswitch (big disc) whose target carries a `knob` drags the same way (its main
//               amount), with a wider dead band (pedalDiscDeadband) so the drift of a pinch closing
//               does not eat a toggle; and a camera drag younger than pedalLatch at release (the
//               pinch point jumping as the fingers open) still counts as a tap, the value restored.
// A pinch only counts when it starts on a target, from an open hand that has been tracked for a
// moment: a hand that appears already pinched (rising into view from the bottom edge) never
// presses anything until it opens again.

const clamp01 = v => Math.max(0, Math.min(1, v));

/**
 * Hands (core/hands HandState) → pointers. The mouse reports a drag as two pinching hands
 * (anchor = press point, drag = cursor); here that becomes one pointer whose press started at
 * the anchor. Camera hands point with the pinch point while pinched and the index tip otherwise.
 * @returns {{id:string, source:string, palm:number, pinching:boolean, fist:boolean,
 *            point:{x:number,y:number}, probe:{x:number,y:number}, start?:{x:number,y:number}, handIds:string[]}[]}
 */
export function toPointers(hands) {
  const pointers = [];
  const anchor = hands.find(h => h.id === 'mouse-anchor');
  const drag = hands.find(h => h.id === 'mouse-drag');
  const mouseIds = hands.filter(h => h.source === 'mouse').map(h => h.id);
  if (anchor && drag) {
    pointers.push({ id: 'mouse', source: 'mouse', palm: drag.palm, pinching: true, fist: false,
      point: { ...drag.tip }, probe: { ...drag.tip }, start: { ...anchor.tip }, handIds: mouseIds });
  } else {
    const hover = hands.find(h => h.id === 'mouse');
    if (hover) pointers.push({ id: 'mouse', source: 'mouse', palm: hover.palm, pinching: false, fist: false,
      point: { ...hover.tip }, probe: { ...hover.tip }, handIds: mouseIds });
  }
  for (const hand of hands) {
    if (hand.source === 'mouse') continue;
    const point = hand.pinching ? hand.pinchPoint : hand.tip;
    pointers.push({ id: hand.id, source: hand.source, palm: hand.palm, pinching: hand.pinching, fist: hand.fist,
      point: { ...point }, probe: { ...(hand.fist ? hand.center : point) }, handIds: [hand.id] });
  }
  return pointers;
}

// Classifies a finished press. Exported for tests and for the drawing code's feedback.
export function classifyPress({ duration, travel, dragged }, settings, palm) {
  if (dragged) return 'drag';
  if (duration * 1000 <= settings.pedalTapTime && travel <= settings.pedalTapMove * palm) return 'tap';
  return 'hold';
}

/**
 * @param {object} settings  pedalTapTime, pedalTapMove, pedalDragDeadband, pedalKnobTravel, pedalLatch, pedalSettle
 * update(pointers, time, hitTest) → events:
 *   { type: 'press', pointerId, target }
 *   { type: 'tap', pointerId, target }                 (released quickly without moving)
 *   { type: 'knob', pointerId, target, value }         (while dragging)
 *   { type: 'knobEnd', pointerId, target, value }      (latched final value)
 *   { type: 'release', pointerId, target, kind }       (every press ends with one: 'tap'|'hold'|'drag'|'lost')
 * hitTest(point, pointer) returns a target object or null; a target with kind 'knob' (or a
 * 'switch' with a `knob`: its main amount) must carry its current normalised value as `value`.
 * A switch press ends in either a tap or a drag, never both.
 */
// Targets that turn while dragged: knobs, and footswitches that carry a main knob.
export const isDraggable = target => target?.kind === 'knob' || (target?.kind === 'switch' && !!target.knob);
const deadbandOf = (target, settings) =>
  (target.kind === 'switch' ? settings.pedalDiscDeadband ?? settings.pedalDragDeadband : settings.pedalDragDeadband);

export function createPedalGestures(settings) {
  const pointers = new Map();   // id → { firstSeen, wasPinching, ignore, press }

  function latched(press, time, source) {
    if (source === 'mouse' || !press.history.length) return press.value;
    const cutoff = time - settings.pedalLatch / 1000;
    let value = press.startValue;
    for (const entry of press.history) if (entry.time <= cutoff) value = entry.value;
    return value;
  }

  function endPress(id, entry, time, events, lost) {
    const press = entry.press;
    entry.press = null;
    if (!press) return;
    const duration = time - press.since;
    let dragged = press.dragging;
    // A disc whose drag is only the last pedalLatch ms (camera): the release jump, not a drag. The
    // latch already gives back the start value; judge the press as if it had not moved.
    const cutoff = time - settings.pedalLatch / 1000;
    if (dragged && !lost && press.target.kind === 'switch' && press.source !== 'mouse'
      && !press.history.some(entry => entry.time <= cutoff)) dragged = false;
    const kind = lost ? 'lost' : classifyPress({ duration, travel: press.travel, dragged }, settings, press.palm);
    if (isDraggable(press.target) && press.dragging) {
      events.push({ type: 'knobEnd', pointerId: id, target: press.target, value: latched(press, time, press.source) });
    }
    if (kind === 'tap') events.push({ type: 'tap', pointerId: id, target: press.target });
    events.push({ type: 'release', pointerId: id, target: press.target, kind });
  }

  function update(list, time, hitTest) {
    const events = [];
    const seen = new Set();
    for (const pointer of list) {
      seen.add(pointer.id);
      let entry = pointers.get(pointer.id);
      if (!entry) {
        // Appearing already pinched: ignore that pinch until the hand opens.
        // (The mouse button is never pressed before the pointer exists, so a mouse press counts.)
        const mousePress = pointer.source === 'mouse' && pointer.pinching;
        entry = { firstSeen: time, wasPinching: pointer.pinching && !mousePress, ignore: pointer.pinching && !mousePress, press: null };
        pointers.set(pointer.id, entry);
        if (!mousePress) continue;
      }

      if (!pointer.pinching) {
        if (entry.press) endPress(pointer.id, entry, time, events, false);
        entry.ignore = false;
        entry.wasPinching = false;
        continue;
      }

      const onset = !entry.wasPinching;
      entry.wasPinching = true;
      if (onset && !entry.ignore) {
        const settled = pointer.source === 'mouse' || (time - entry.firstSeen) * 1000 >= settings.pedalSettle;
        const origin = pointer.start ?? pointer.point;
        const target = settled ? hitTest(origin, pointer) : null;
        if (!target) { entry.ignore = true; continue; }
        entry.press = {
          target, since: time, origin: { ...origin }, ref: { ...origin }, travel: 0, palm: pointer.palm,
          source: pointer.source, dragging: false, startValue: target.value ?? 0, value: target.value ?? 0, history: [],
        };
        events.push({ type: 'press', pointerId: pointer.id, target });
      }
      const press = entry.press;
      if (!press) continue;

      press.palm = pointer.palm;
      press.travel = Math.max(press.travel, Math.hypot(pointer.point.x - press.origin.x, pointer.point.y - press.origin.y));
      if (!isDraggable(press.target)) continue;
      const dy = pointer.point.y - press.ref.y;
      const band = deadbandOf(press.target, settings) * pointer.palm;
      if (!press.dragging && Math.abs(dy) > band) {
        press.dragging = true;
        // Turn from the edge of the dead band: no jump, and a fast first move still counts.
        press.ref = { x: press.ref.x, y: press.ref.y + Math.sign(dy) * band };
      }
      if (!press.dragging) continue;
      const value = clamp01(press.startValue - (pointer.point.y - press.ref.y) / (pointer.palm * settings.pedalKnobTravel));
      press.history.push({ time, value });
      while (press.history.length > 2 && time - press.history[1].time > 0.5) press.history.shift();
      if (value !== press.value) {
        press.value = value;
        events.push({ type: 'knob', pointerId: pointer.id, target: press.target, value });
      }
    }

    // A hand that vanished mid-press: keep the latched knob value, no tap.
    for (const [id, entry] of pointers) {
      if (seen.has(id)) continue;
      if (entry.press) endPress(id, entry, time, events, true);
      pointers.delete(id);
    }
    return events;
  }

  return {
    update,
    // Pointer ids currently holding a press (their hands belong to the pedalboard until release).
    engaged() { return new Set([...pointers].filter(([, e]) => e.press).map(([id]) => id)); },
    pressOf(id) { return pointers.get(id)?.press ?? null; },
    presses() { return [...pointers].filter(([, e]) => e.press).map(([id, e]) => ({ id, ...e.press })); },
    reset() { pointers.clear(); },
  };
}

// Switch lockout: after a gesture toggle, further toggles are ignored for pedalLockout ms.
export function createLockout(ms) {
  let until = -Infinity;
  return {
    blocked: time => time < until,
    trigger(time) { until = time + ms / 1000; },
    remaining: time => Math.max(0, until - time),
    reset() { until = -Infinity; },
  };
}

/**
 * Which pointers are inside a region at the bottom of the stage (y ≥ top), with hysteresis:
 * a pointer counts as inside once its probe point crosses `top`, and leaves only after rising
 * `exitMargin` palm sizes above it, so a hand resting on the edge does not flicker in and out.
 */
export function createRegionGate(exitMargin = 0.25) {
  const inside = new Set();
  return {
    update(list, contains) {
      const seen = new Set();
      for (const pointer of list) {
        seen.add(pointer.id);
        const now = contains(pointer.probe, inside.has(pointer.id) ? exitMargin * pointer.palm : 0);
        if (now) inside.add(pointer.id); else inside.delete(pointer.id);
      }
      for (const id of [...inside]) if (!seen.has(id)) inside.delete(id);
      return new Set(inside);
    },
    has: id => inside.has(id),
    reset() { inside.clear(); },
  };
}
