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
import { zoneRect, zoneTargets, tuningTargets, hitTarget, inRect, wahLayout, wahPositionAt } from './layout.js';
import { drawZone, drawWahStrip, drawTuning } from './draw.js';
import { createAuditionStub } from './audio-binding.js';
import { isPedalAvailable } from './availability.js';

const WHEEL_STEP = 0.0008;   // knob travel per wheel delta pixel

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
  let time = 0;
  let visible = false;
  let zoneActive = false, stripActive = false;
  let hovered = [];
  let lastToggle = null;               // { target, time }

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
    if ((target?.kind === 'switch' || target?.kind === 'knob') && target.pedal && !isAvailable(target.pedal)) {
      return { kind: 'locked', pedal: target.pedal, rect: target.rect, cx: target.cx, cy: target.cy, r: target.r };
    }
    if (target?.kind === 'knob') target.value = target.macro ? model.macro(target.macro) : model.param(target.pedal, target.knob);
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
    time = now;
    visible = gameState === 'ready' || gameState === 'playing';
    if (!visible || (tuningOpen && gameState !== 'ready')) {
      if (tuningOpen) closeTuning();
      if (!visible) { gestures.reset(); zoneGate.reset(); stripGate.reset(); zoneActive = stripActive = false; hovered = []; return hands; }
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
      if (steering.length) model.setParam('wah', 'position', wahPositionAt(wah, steering[0].probe.y), { commit: false });
      if (stripActive && !steering.length) model.setParam('wah', 'position', model.param('wah', 'position'), { commit: true });
      stripActive = steering.length > 0;
    } else {
      stripGate.reset();
      stripActive = false;
    }
    zoneActive = inZone.size > 0;

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

  // Mouse wheel over a knob nudges it (optional extra for mouse players).
  function onWheel(event) {
    if (!visible || !element) return;
    const rect = element.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const target = hitTest(targetsNow(), point);
    if (target?.kind !== 'knob') return;
    event.preventDefault();
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
    // For tests and the console: the current targets in stage pixels.
    targets: () => targetsNow(),
    knob: knobOf,
    isAvailable: id => isAvailable(id),
    dispose() { element?.removeEventListener('wheel', onWheel); },
  };
}
