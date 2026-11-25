// On-page controls: the intro's camera/mouse switch and lab entry, the gear button and its
// settings panel, and the ready panel's settings button. The markup is static in index.html
// (data-menu / data-mode / data-snap / data-tempo attributes); this file wires clicks to the
// game's actions, shows every setting's current state, and lets camera hands press the buttons
// with a pinch-tap (hand-buttons.js). Tempo buttons ([data-tempo]) are wired by app.js.
import { createHandButtons } from './hand-buttons.js';

const $ = id => document.getElementById(id);

/**
 * @param {object} options
 * @param {Function} options.t
 * @param {object} options.settings      for the pinch-tap thresholds
 * @param {() => object} options.getState
 *   { screen, tone, tones, toneName, snapMode, metronome, showHand, keyGuard, pedalsShown,
 *     handedness, mouseMode, tempo: { available, bpm, manual } }
 * @param {object} options.actions
 *   setTone(id), setSnapMode(mode), setMouseMode(bool), toggleHand(), setPedalsShown(bool),
 *   setHandedness('right' | 'left'), openTuning(), setKeyGuard(bool), changeSong(), openLab()
 */
export function createMenu({ t, settings, getState, actions }) {
  const gear = $('gearButton');
  const panel = $('menuPanel');
  const tones = $('menuTones');
  let open = false;
  let screen = 'intro';
  const handButtons = createHandButtons(settings);
  let feedback = { hover: new Set(), press: new Set() };

  // Tone buttons come from the game's tone list, so a new tone only needs a label.
  for (const id of getState().tones) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mini secondary';
    button.dataset.tone = id;
    button.textContent = t(`menu.tone.${id}`) === `menu.tone.${id}` ? t(`hud.tone.${id}`) : t(`menu.tone.${id}`);
    tones.append(button);
  }

  const onStage = () => screen === 'ready' || screen === 'playing';

  function setOpen(next) {
    open = next && onStage();
    panel.hidden = !open;
    gear.setAttribute('aria-expanded', String(open));
    gear.classList.toggle('on', open);
    document.body.classList.toggle('menu-open', open);
    if (open) refresh();
  }

  const press = (button, on) => {
    button.classList.toggle('on', on);
    if (button.hasAttribute('aria-pressed')) button.setAttribute('aria-pressed', String(on));
  };

  function refresh() {
    const s = getState();
    for (const button of document.querySelectorAll('[data-mode]')) press(button, (button.dataset.mode === 'mouse') === s.mouseMode);
    for (const button of tones.children) press(button, button.dataset.tone === s.tone);
    $('menuToneOther').textContent = s.tones.includes(s.tone) ? '' : t('menu.toneOther', { name: s.toneName });
    for (const button of panel.querySelectorAll('[data-snap]')) press(button, button.dataset.snap === s.snapMode);
    press(panel.querySelector('[data-menu=pedals]'), s.pedalsShown);
    panel.querySelector('[data-menu=tuning]').classList.toggle('dim', !s.pedalsShown || s.screen !== 'ready');
    press(panel.querySelector('[data-menu=hand]'), s.showHand);
    for (const button of panel.querySelectorAll('[data-handedness]')) press(button, button.dataset.handedness === s.handedness);
    const guard = panel.querySelector('[data-menu=keyGuard]');
    press(guard, s.keyGuard);
    guard.textContent = `${t('menu.keyGuard')}：${t(s.keyGuard ? 'menu.on' : 'menu.off')}`;
    guard.title = t('menu.keyGuardHint');
    for (const button of panel.querySelectorAll('[data-tempo]')) {
      if (button.dataset.tempo !== 'click') button.disabled = !s.tempo.available;
    }
    $('menuBpm').textContent = s.tempo.available
      ? t(s.tempo.manual ? 'hud.bpmManual' : 'hud.bpm', { bpm: Math.round(s.tempo.bpm) })
      : t('menu.tempoNone');
  }

  const handlers = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    pedals: () => actions.setPedalsShown(!getState().pedalsShown),
    tuning: () => {
      if (getState().pedalsShown && screen === 'ready') setOpen(false);
      actions.openTuning();
    },
    hand: () => actions.toggleHand(),
    keyGuard: () => actions.setKeyGuard(!getState().keyGuard),
    changeSong: () => { setOpen(false); actions.changeSong(); },
    lab: () => actions.openLab(),
  };

  document.addEventListener('click', event => {
    const button = event.target.closest?.('button');
    if (!button) return;
    if (button === gear) setOpen(!open);
    else if (button.dataset.menu) handlers[button.dataset.menu]?.();
    else if (button.dataset.mode) actions.setMouseMode(button.dataset.mode === 'mouse');
    else if (button.dataset.snap) actions.setSnapMode(button.dataset.snap);
    else if (button.dataset.handedness) actions.setHandedness(button.dataset.handedness);
    else if (button.dataset.tone) actions.setTone(button.dataset.tone);
    refresh();
    // A mouse click must not leave focus on an in-game button: Space would press it again.
    if (event.detail > 0 && button.closest('#hud, #ready, #menuPanel')) button.blur();
  });

  // ---------- camera hands ----------
  const visible = el => !el.disabled && (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0);

  // Pressable buttons, front-most first, in stage pixels (the stage fills the window).
  function targets() {
    if (!onStage() || document.body.classList.contains('pedal-tuning')) return [];
    const list = open ? [...panel.querySelectorAll('button'), gear] : [gear, ...$('ready').querySelectorAll('button')];
    return list.filter(visible).map(el => {
      const r = el.getBoundingClientRect();
      return { kind: 'button', el, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
    });
  }

  function showFeedback(next) {
    for (const [name, set] of [['hand-hover', next.hover], ['hand-press', next.press]]) {
      const old = name === 'hand-hover' ? feedback.hover : feedback.press;
      for (const el of old) if (!set.has(el)) el.classList.remove(name);
      for (const el of set) if (!old.has(el)) el.classList.add(name);
    }
    feedback = next;
  }

  /**
   * Called every frame before the pedalboard and the instrument. Returns the hands they may use:
   * a camera hand over a button (or pressing one) is the buttons' alone.
   */
  function routeHands(hands, time, { camera }) {
    if (!camera || !hands.length) {
      handButtons.reset();
      if (feedback.hover.size || feedback.press.size) showFeedback({ hover: new Set(), press: new Set() });
      return hands;
    }
    const current = targets();
    const result = handButtons.route(hands, time, current);
    for (const target of result.taps) {
      if (target.el.isConnected && current.some(c => c.el === target.el) && visible(target.el)) target.el.click();
    }
    showFeedback({ hover: new Set(result.hovered.map(x => x.el)), press: new Set(result.pressed.map(x => x.el)) });
    return result.hands;
  }

  return {
    refresh,
    routeHands,
    setScreen(next) {
      screen = next;
      if (!onStage()) setOpen(false);
      refresh();
    },
    open: () => setOpen(true),
    close: () => setOpen(false),
    get isOpen() { return open; },
  };
}
