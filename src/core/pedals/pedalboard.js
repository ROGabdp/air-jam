// Pedalboard controller: owns the model, turns hands into pedal gestures, decides which hands the
// instrument may still see, and draws. The game shell calls route() every frame before the
// instrument and draw() after it.
//
// Who gets a hand: while the tuning screen is open, nobody but the pedalboard (strings are inert).
// Otherwise a hand is withheld from the instrument while it is in the footswitch zone, on the wah
// strip, or holding a press that started on the pedalboard. Withheld hands cannot stretch, pluck,
// delete or clear strings; when they come back the instrument sees them as new hands, so no stale
// position can pluck.
import { createPedalModel, knobOf, PEDAL_TYPES, AMP } from './model.js';
import { createPedalGestures, createLockout, createRegionGate, toPointers } from './gestures.js';
import { zoneRect, zoneTargets, tuningTargets, hitTarget, inRect, wahLayout, wahPositionAt, wahStripSide } from './layout.js';
import { drawZone, drawWahStrip, drawTuning } from './draw.js';
import { createAuditionStub } from './audio-binding.js';
import { isPedalAvailable } from './availability.js';
import { createWheelGlide, wheelNotches } from './wheel.js';

const WHEEL_STEP = 0.0008;   // knob travel per wheel delta pixel
const WHEEL_HINT_GAP = 3;    // seconds between "turn the wah on" hints from the wheel

export function createPedalboard({ settings, t, stage, storage = null, element = null, toast = () => {}, mouseMode = () => false, isAvailable = isPedalAvailable }) {
  const model = createPedalModel({ storage });
  const gestures = createPedalGestures(settings);
  const lockout = createLockout(settings.pedalLockout);
  const zoneGate = createRegionGate(0.25);
  const stripGate = createRegionGate(0.15);
  const macroBases = new Map();      // pointerId → base values captured when a macro drag starts
  const ui = { selected: 'overdrive' };
  let tuningOpen = false;
  let audition = createAuditionStub();
  let auditionRunning = false;
  let onTuningChange = () => {};
  let onStripChange = () => {};
  let stripShownAt = null;           // side the page was last told the strip is on (null: hidden)
  let time = 0;
  let visible = false;
  let zoneActive = false, stripActive = false;
  let hovered = [];
  let lastToggle = null;               // { target, time }
  const wheelGlide = createWheelGlide();
  let wheelHintAt = -Infinity;
  let discFlash = null;                // { pedal, until }: the disc's value label after a wheel turn

  const wahStripShown = () => isAvailable('wah') && model.isOn('wah') && model.param('wah', 'mode') < 0.5;
  const soon = id => toast(t('pedal.comingSoon', { name: t(PEDAL_TYPES[id].label) }));

  function targetsNow() {
    if (tuningOpen) return tuningTargets(stage, model, ui);
    const targets = zoneTargets(stage, settings, model);
    if (wahStripShown()) {
      const wah = wahLayout(stage, settings);
      targets.unshift({ kind: 'button', action: 'wahMode', rect: wah.button });
      targets.push({ kind: 'strip', rect: wah.strip });
    }
    return targets;
  }

  function hitTest(targets, point) {
    const target = hitTarget(targets, point);
    // A pedal without sound yet: its switch and knobs only answer "coming soon".
    if ((target?.kind === 'switch' || target?.kind === 'knob') && target.pedal && target.pedal !== AMP && !isAvailable(target.pedal)) {
      return { kind: 'locked', pedal: target.pedal, rect: target.rect, cx: target.cx, cy: target.cy, r: target.r };
    }
    if (target?.kind === 'knob') target.value = target.macro ? model.macro(target.macro) : model.param(target.pedal, target.knob);
    // The big disc: a tap toggles, a drag turns the pedal's main amount (model.mainKnob).
    if (target?.kind === 'switch') {
      const knob = model.mainKnob(target.pedal);
      if (knob) Object.assign(target, { knob, def: knobOf(target.pedal, knob), value: model.param(target.pedal, knob) });
    }
    return target;
  }

  function tap(target, now) {
    if (lockout.blocked(now)) return;
    switch (target.kind) {
      case 'switch': model.toggle(target.pedal); break;
      case 'select': ui.selected = target.pedal; break;
      case 'locked': soon(target.pedal); break;
      case 'knob':
        if (target.def?.steps) model.cycle(target.pedal, target.knob);
        else return;              // a tap on a continuous knob does nothing
        break;
      case 'button':
        if (target.action === 'mode') model.setMode(target.mode);
        else if (target.action === 'preset') model.applyPreset(target.preset);
        else if (target.action === 'move') model.move(target.pedal, target.delta);
        else if (target.action === 'wahMode') model.cycle('wah', 'mode');
        else if (target.action === 'done') closeTuning();
        break;
      default: return;
    }
    lockout.trigger(now);
    lastToggle = { target, time: now };
  }

  function handle(events, now) {
    for (const event of events) {
      const { target } = event;
      if (event.type === 'press' && target.macro) macroBases.set(event.pointerId, model.macroBase(target.macro));
      else if (event.type === 'press' && target.pedal === 'wah' && target.knob === 'position') settleWheel();
      else if (event.type === 'tap') tap(target, now);
      else if (event.type === 'knob' || event.type === 'knobEnd') {
        const commit = event.type === 'knobEnd';
        if (target.macro) model.setMacro(target.macro, event.value, macroBases.get(event.pointerId), { commit });
        else model.setParam(target.pedal, target.knob, event.value, { commit });
      } else if (event.type === 'release') macroBases.delete(event.pointerId);
    }
  }

  /**
   * @param {object[]} hands  this frame's hand states (camera or mouse)
   * @param {number} now      seconds
   * @param {string} gameState
   * @returns {object[]} the hands the instrument may use
   */
  function route(hands, now, gameState) {
    const dt = Math.max(0, Math.min(0.25, now - time));
    time = now;
    visible = gameState === 'ready' || gameState === 'playing';
    if (!visible || (tuningOpen && gameState !== 'ready')) {
      if (tuningOpen) closeTuning();
      if (!visible) {
        gestures.reset(); zoneGate.reset(); stripGate.reset(); zoneActive = stripActive = false; hovered = [];
        settleWheel();
        if (stripShownAt !== null) { stripShownAt = null; onStripChange(null); }
        return hands;
      }
    }

    const pointers = toPointers(hands);
    const targets = targetsNow();
    handle(gestures.update(pointers, now, point => hitTest(targets, point)), now);

    const zone = zoneRect(stage, settings);
    const inZone = tuningOpen ? new Set() : zoneGate.update(pointers, (p, margin) => p.y >= zone.y - margin);
    let inStrip = new Set();
    if (!tuningOpen && wahStripShown()) {
      const wah = wahLayout(stage, settings);
      inStrip = stripGate.update(pointers, (p, margin) => inRect(p, wah.strip, margin));
      const engaged = gestures.engaged();
      const steering = pointers.filter(p => inStrip.has(p.id) && !engaged.has(p.id) && !inRect(p.probe, wah.button));
      if (steering.length) {
        wheelGlide.cancel();
        model.setParam('wah', 'position', wahPositionAt(wah, steering[0].probe.y), { commit: false });
      }
      if (stripActive && !steering.length) model.setParam('wah', 'position', model.param('wah', 'position'), { commit: true });
      stripActive = steering.length > 0;
    } else {
      stripGate.reset();
      stripActive = false;
    }
    // The wheel's glide (mouse mode): the strip's marker and the sound follow it.
    if (!stripActive && wahStripShown()) {
      const glide = wheelGlide.step(dt);
      if (glide) model.setParam('wah', 'position', glide.value, { commit: glide.done });
    } else if (!wahStripShown()) {
      settleWheel();
    }
    zoneActive = inZone.size > 0;
    const stripSide = !tuningOpen && wahStripShown() ? wahStripSide(settings) : null;
    if (stripSide !== stripShownAt) { stripShownAt = stripSide; onStripChange(stripSide); }

    // Hover feedback: open hands over a target (helps aiming with the camera).
    hovered = pointers.filter(p => !p.pinching).map(p => hitTarget(targets, p.probe)).filter(x => x && x.kind !== 'zone' && x.kind !== 'strip');

    if (tuningOpen) return [];
    const withheld = new Set();
    const engaged = gestures.engaged();
    for (const pointer of pointers) {
      if (engaged.has(pointer.id) || inZone.has(pointer.id) || inStrip.has(pointer.id)) {
        for (const id of pointer.handIds) withheld.add(id);
      }
    }
    return withheld.size ? hands.filter(hand => !withheld.has(hand.id)) : hands;
  }

  function draw(g) {
    if (!visible) return;
    const view = {
      stage, settings, model, t, ui, time,
      targets: targetsNow(), hovered, presses: gestures.presses(), zoneActive, stripActive,
      lockout: lockout.remaining(time), lastToggle,
      mouse: mouseMode(),
      audition: auditionRunning,
      discFlash: discFlash && time < discFlash.until ? discFlash.pedal : null,
      available: isAvailable,
    };
    if (tuningOpen) { drawTuning(g, view); return; }
    if (wahStripShown()) drawWahStrip(g, view);
    drawZone(g, view);
  }

  function openTuning() {
    if (tuningOpen) return;
    tuningOpen = true;
    gestures.reset();
    macroBases.clear();
    try { audition.start(); auditionRunning = !!audition.running; } catch (error) { console.warn('[Air Jam] audition failed:', error); }
    onTuningChange(true);
  }

  function closeTuning() {
    if (!tuningOpen) return;
    tuningOpen = false;
    gestures.reset();
    macroBases.clear();
    try { audition.stop(); } catch (error) { console.warn('[Air Jam] audition stop failed:', error); }
    auditionRunning = false;
    onTuningChange(false);
  }

  // Keyboard backup. Returns true when the key was used (the shell then ignores it).
  function handleKey(key, gameState) {
    const onStage = gameState === 'ready' || gameState === 'playing';
    if (!onStage) return false;
    if (tuningOpen) {
      if (key === 'escape' || key === 'enter' || key === 'p') { closeTuning(); return true; }
      if (key === ' ') return true;             // no starting the song from the tuning screen
    } else if (key === 'p') {
      if (gameState === 'ready') openTuning();
      else toast(t('pedal.tuningOnlyReady'));
      return true;
    }
    if (key >= '4' && key <= '9') {
      const pedal = model.pedalOrder()[Number(key) - 4];
      if (!pedal) return false;
      if (!isAvailable(pedal)) { soon(pedal); return true; }
      const on = model.toggle(pedal);
      toast(t(on ? 'pedal.toastOn' : 'pedal.toastOff', { name: t(PEDAL_TYPES[pedal].label) }));
      return true;
    }
    if (key === 'w') {
      if (!isAvailable('wah')) { soon('wah'); return true; }
      if (!model.isOn('wah')) model.toggle('wah', true);
      const auto = model.cycle('wah', 'mode') >= 0.5;
      toast(t(auto ? 'pedal.wahAuto' : 'pedal.wahHand'));
      return true;
    }
    return false;
  }

  // A glide cut short (pedal switched off, auto mode, screen left) keeps where it got to.
  function settleWheel() {
    if (!wheelGlide.active) return;
    wheelGlide.cancel();
    model.setParam('wah', 'position', model.param('wah', 'position'), { commit: true });
  }

  /**
   * Wheel in mouse mode, not over a knob: the wah pedal (wheel.js). Wah in auto mode: the first
   * notch switches it to hand mode (and says so); wah off: only a hint, at most every few seconds.
   * @returns {boolean} the wheel was used for the wah
   */
  function wheelWah(notches) {
    if (!notches || !isAvailable('wah')) return false;
    if (!model.isOn('wah')) {
      if (time - wheelHintAt >= WHEEL_HINT_GAP) { wheelHintAt = time; toast(t('pedal.wheelWahOff')); }
      return false;
    }
    if (model.param('wah', 'mode') >= 0.5) {
      model.setParam('wah', 'mode', 0);
      toast(t('pedal.wheelWahHand'));
    }
    wheelGlide.nudge(model.param('wah', 'position'), notches);
    return true;
  }

  // Mouse wheel: over a knob it turns the knob, over a big disc its main amount (both modes); elsewhere on the stage in mouse mode
  // it moves the wah pedal. The page never scrolls under the stage in mouse mode.
  function onWheel(event) {
    if (!visible) return;
    const rect = element?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const target = hitTest(targetsNow(), point);
    // Over a big disc: its main amount, like the small knob it shares the value with.
    if (target?.kind === 'switch' && target.knob) {
      event.preventDefault?.();
      discFlash = { pedal: target.pedal, until: time + 1.2 };
      // The wah pedal glides the same as the wheel anywhere else; an off wah is still set directly.
      if (target.pedal === 'wah' && target.knob === 'position' && model.isOn('wah')) { wheelWah(wheelNotches(event)); return; }
      model.setParam(target.pedal, target.knob, target.value - event.deltaY * WHEEL_STEP);
      return;
    }
    if (target?.kind !== 'knob') {
      if (tuningOpen || !mouseMode()) return;
      event.preventDefault?.();
      wheelWah(wheelNotches(event));
      return;
    }
    event.preventDefault?.();
    const def = target.def;
    const step = def?.steps ? Math.sign(-event.deltaY) / (def.steps.length - 1) : -event.deltaY * WHEEL_STEP;
    if (target.macro) model.setMacro(target.macro, target.value + step);
    else model.setParam(target.pedal, target.knob, target.value + step);
  }
  element?.addEventListener('wheel', onWheel, { passive: false });

  return {
    model, route, draw, handleKey, openTuning, closeTuning,
    get tuningOpen() { return tuningOpen; },
    // Point commands (the mouse's right-click delete) must not reach the strings from the pedalboard.
    blocks(point) { return visible && (tuningOpen || point.y >= zoneRect(stage, settings).y); },
    get selected() { return ui.selected; },
    select(id) { if (id === AMP || PEDAL_TYPES[id]) ui.selected = id; },
    // The tone lab plugs its audition loop in here: { start(), stop(), running }.
    setAudition(source) { audition = source ?? createAuditionStub(); },
    onTuningChange(callback) { onTuningChange = callback; },
    // The page moves its edge text beside the wah strip: callback(side: 'left' | 'right' | null).
    onStripChange(callback) { onStripChange = callback; },
    // For tests and the console: the current targets in stage pixels.
    targets: () => targetsNow(),
    knob: knobOf,
    isAvailable: id => isAvailable(id),
    // The stage's wheel handler (tests call it with plain objects: clientX/Y, deltaX/Y, deltaMode).
    wheel: onWheel,
    dispose() { element?.removeEventListener('wheel', onWheel); },
  };
}
