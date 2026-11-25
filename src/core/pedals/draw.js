// Pedalboard drawing on the shared 2D canvas. Reads a view built by the controller and never
// changes state, so a 3D view can replace this file without touching the model or the gestures.
// Look: glowing discs with one colour and one icon per pedal type; no enclosures, brands or logos.
import { PEDAL_TYPES, MACROS, knobOf, knobValue, stepIndex, AMP } from './model.js';
import { zoneRect, wahLayout } from './layout.js';

const FONT = '"Segoe UI", "Microsoft JhengHei", sans-serif';
const TAU = Math.PI * 2;
const KNOB_FROM = Math.PI * 0.75, KNOB_SWEEP = Math.PI * 1.5;
const AMP_HUE = 30;

const hueOf = id => (id === AMP ? AMP_HUE : PEDAL_TYPES[id]?.hue ?? 200);
const hsla = (h, s, l, a = 1) => `hsla(${h}, ${s}%, ${l}%, ${a})`;

function text(g, value, x, y, { size = 13, weight = 600, color = 'rgba(244,246,255,0.95)', align = 'center', base = 'middle', outline = true } = {}) {
  g.font = `${weight} ${size}px ${FONT}`;
  g.textAlign = align;
  g.textBaseline = base;
  if (outline) {
    g.lineWidth = Math.max(2.5, size * 0.22);
    g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    g.lineJoin = 'round';
    g.strokeText(value, x, y);
  }
  g.fillStyle = color;
  g.fillText(value, x, y);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h);
}

// ---------- icons (unit size s ≈ the icon's half width) ----------
function drawIcon(g, icon, cx, cy, s, color) {
  g.save();
  g.translate(cx, cy);
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = Math.max(1.5, s * 0.16);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  switch (icon) {
    case 'overdrive':     // a sine pushed into soft, rounded tops
      for (let i = 0; i <= 24; i++) {
        const u = i / 24, x = -s + 2 * s * u;
        const y = -Math.tanh(2.2 * Math.sin(u * TAU)) * s * 0.55;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
      break;
    case 'distortion':    // flame
      g.moveTo(0, -s);
      g.bezierCurveTo(s * 0.9, -s * 0.2, s * 0.75, s * 0.85, 0, s * 0.9);
      g.bezierCurveTo(-s * 0.75, s * 0.85, -s * 0.9, -s * 0.05, -s * 0.25, -s * 0.45);
      g.bezierCurveTo(-s * 0.2, -s * 0.05, 0, 0, s * 0.05, -s * 0.2);
      g.closePath();
      g.fill();
      break;
    case 'wah':           // a resonant peak sweeping left and right
      g.moveTo(-s, s * 0.5);
      g.quadraticCurveTo(-s * 0.2, s * 0.45, 0, -s * 0.7);
      g.quadraticCurveTo(s * 0.2, s * 0.45, s, s * 0.5);
      g.stroke();
      g.beginPath();
      g.moveTo(-s * 0.55, s * 0.9); g.lineTo(s * 0.55, s * 0.9);
      g.moveTo(-s * 0.4, s * 0.75); g.lineTo(-s * 0.58, s * 0.9); g.lineTo(-s * 0.4, s * 1.05);
      g.moveTo(s * 0.4, s * 0.75); g.lineTo(s * 0.58, s * 0.9); g.lineTo(s * 0.4, s * 1.05);
      g.stroke();
      break;
    case 'chorus':        // two waves, slightly apart
      for (const [offset, alpha] of [[-0.28, 1], [0.28, 0.6]]) {
        g.globalAlpha = alpha;
        g.beginPath();
        for (let i = 0; i <= 20; i++) {
          const u = i / 20, x = -s + 2 * s * u;
          const y = offset * s - Math.sin(u * TAU + offset * 4) * s * 0.35;
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      }
      break;
    case 'delay':         // repeats getting smaller
      [[-0.65, 0.34], [0.05, 0.25], [0.62, 0.16]].forEach(([x, r]) => {
        g.beginPath();
        g.arc(x * s, 0, r * s, 0, TAU);
        g.fill();
      });
      break;
    case 'reverb':        // concentric arcs
      g.arc(-s * 0.7, 0, s * 0.12, 0, TAU);
      g.fill();
      for (const r of [0.55, 1.05, 1.55]) {
        g.beginPath();
        g.arc(-s * 0.7, 0, r * s, -0.75, 0.75);
        g.stroke();
      }
      break;
    case 'amp':           // speaker cone
      g.arc(0, 0, s * 0.85, 0, TAU);
      g.stroke();
      g.beginPath();
      g.arc(0, 0, s * 0.32, 0, TAU);
      g.fill();
      break;
  }
  g.restore();
}

// ---------- building blocks ----------
// soon: label for a pedal that cannot be used yet (drawn dimmed and off, with a badge).
function drawDisc(g, { cx, cy, r, hue, on, icon, label, hover, keyHint, soon }) {
  g.save();
  if (soon) { on = false; g.globalAlpha = 0.42; }
  if (on) {
    g.globalCompositeOperation = 'lighter';
    const halo = g.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 1.55);
    halo.addColorStop(0, hsla(hue, 95, 60, 0.45));
    halo.addColorStop(1, hsla(hue, 95, 60, 0));
    g.fillStyle = halo;
    g.beginPath(); g.arc(cx, cy, r * 1.55, 0, TAU); g.fill();
    g.globalCompositeOperation = 'source-over';
  }
  const body = g.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
  if (on) {
    body.addColorStop(0, hsla(hue, 95, 78, 0.97));
    body.addColorStop(1, hsla(hue, 80, 38, 0.95));
  } else {
    body.addColorStop(0, 'rgba(46, 52, 92, 0.88)');
    body.addColorStop(1, 'rgba(14, 17, 40, 0.88)');
  }
  g.fillStyle = body;
  g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
  g.lineWidth = hover ? 3 : 2;
  g.strokeStyle = on ? hsla(hue, 100, 88, 0.9) : hsla(hue, 70, 65, hover ? 0.95 : 0.6);
  g.stroke();

  drawIcon(g, icon, cx, cy - r * 0.18, r * 0.32, on ? 'rgba(20, 16, 40, 0.85)' : hsla(hue, 70, 72, 0.85));
  if (label) text(g, label, cx, cy + r * 0.45, { size: Math.max(11, Math.min(16, r * 0.3)), color: on ? 'rgba(20,16,40,0.92)' : 'rgba(244,246,255,0.85)', outline: false, weight: 700 });

  // Status light.
  const lx = cx + r * 0.72, ly = cy - r * 0.72, lr = Math.max(3, r * 0.1);
  if (on) {
    const glow = g.createRadialGradient(lx, ly, 0, lx, ly, lr * 3);
    glow.addColorStop(0, hsla(hue, 100, 75, 0.9));
    glow.addColorStop(1, hsla(hue, 100, 60, 0));
    g.fillStyle = glow;
    g.beginPath(); g.arc(lx, ly, lr * 3, 0, TAU); g.fill();
  }
  g.fillStyle = on ? hsla(hue, 100, 85) : 'rgba(80, 84, 110, 0.9)';
  g.beginPath(); g.arc(lx, ly, lr, 0, TAU); g.fill();
  if (keyHint) text(g, keyHint, cx - r * 0.78, cy - r * 0.78, { size: 11, color: 'rgba(244,246,255,0.6)' });
  g.restore();
  if (soon) {
    const size = Math.max(10, Math.min(13, r * 0.26));
    g.save();
    g.font = `700 ${size}px ${FONT}`;
    const w = g.measureText(soon).width + size * 1.2, h = size * 1.7;
    roundRect(g, cx - w / 2, cy + r * 0.78 - h / 2, w, h, h / 2);
    g.fillStyle = 'rgba(20, 24, 52, 0.92)';
    g.fill();
    g.lineWidth = 1;
    g.strokeStyle = hsla(hue, 60, 70, 0.6);
    g.stroke();
    g.restore();
    text(g, soon, cx, cy + r * 0.78, { size, color: 'rgba(244,246,255,0.85)', outline: false, weight: 700 });
  }
}

const soonOf = (view, pedal) => (view.available && !view.available(pedal) ? view.t('pedal.soon') : null);

function valueText(t, def, value) {
  if (!def) return `${Math.round(value * 100)}`;
  if (def.steps) return t(def.steps[stepIndex(def, value)]);
  const v = knobValue(def, value);
  if (def.unit === 'dB') return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
  if (def.unit === 'Hz') return v < 10 ? `${v.toFixed(2)} Hz` : `${Math.round(v)} Hz`;
  if (def.unit === 'ms') return v < 20 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`;
  if (def.unit === '%') return `${Math.round(v)}%`;
  if (def.unit === '×') return `×${v.toFixed(2)}`;
  if (def.unit === 'oct') return t('pedal.unit.octaves', { v: v.toFixed(1) });
  return `${Math.round(value * 100)}`;
}

function drawKnob(g, t, { cx, cy, r, value, hue, label, def, active, hover, dim }) {
  g.save();
  if (dim) g.globalAlpha = 0.45;
  if (def?.toggle) {
    // Two-way switch drawn as a pill showing the current step.
    const w = r * 3.2, h = r * 1.4;
    roundRect(g, cx - w / 2, cy - h / 2, w, h, h / 2);
    g.fillStyle = active || hover ? hsla(hue, 60, 40, 0.9) : 'rgba(14, 17, 40, 0.85)';
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = hsla(hue, 80, 70, 0.85);
    g.stroke();
    text(g, t(def.steps[stepIndex(def, value)]), cx, cy, { size: Math.max(11, r * 0.55), outline: false });
    if (label) text(g, t(label), cx, cy + h / 2 + Math.max(9, r * 0.45), { size: Math.max(10, Math.min(14, r * 0.42)), color: 'rgba(244,246,255,0.75)' });
    g.restore();
    return;
  }
  const angle = KNOB_FROM + KNOB_SWEEP * value;
  g.fillStyle = 'rgba(12, 15, 36, 0.88)';
  g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
  g.lineWidth = hover || active ? 2.5 : 1.5;
  g.strokeStyle = hover || active ? hsla(hue, 90, 80, 0.95) : 'rgba(255, 255, 255, 0.28)';
  g.stroke();
  // Track and value arc.
  const arcR = r * 1.22;
  g.lineCap = 'round';
  g.lineWidth = Math.max(3, r * 0.16);
  g.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  g.beginPath(); g.arc(cx, cy, arcR, KNOB_FROM, KNOB_FROM + KNOB_SWEEP); g.stroke();
  g.strokeStyle = hsla(hue, 95, active ? 75 : 65, 0.95);
  g.beginPath(); g.arc(cx, cy, arcR, KNOB_FROM, angle); g.stroke();
  if (def?.steps) {
    const n = def.steps.length - 1;
    g.fillStyle = 'rgba(255, 255, 255, 0.7)';
    for (let i = 0; i <= n; i++) {
      const a = KNOB_FROM + KNOB_SWEEP * i / n;
      g.beginPath(); g.arc(cx + Math.cos(a) * arcR, cy + Math.sin(a) * arcR, Math.max(1.5, r * 0.07), 0, TAU); g.fill();
    }
  }
  // Pointer.
  g.lineWidth = Math.max(2, r * 0.12);
  g.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  g.beginPath();
  g.moveTo(cx + Math.cos(angle) * r * 0.25, cy + Math.sin(angle) * r * 0.25);
  g.lineTo(cx + Math.cos(angle) * r * 0.85, cy + Math.sin(angle) * r * 0.85);
  g.stroke();
  const size = Math.max(10, Math.min(15, r * 0.42));
  if (label) text(g, t(label), cx, cy + arcR + size * 0.95, { size, color: 'rgba(244,246,255,0.8)' });
  if (active || hover || r >= 30) text(g, valueText(t, def, value), cx, cy + arcR + size * 2.15, { size: size - 1, color: hsla(hue, 90, 82, 0.95) });
  g.restore();
}

function drawButton(g, target, label, { selected = false, hover = false, hue = 45, dim = false } = {}) {
  const { x, y, w, h } = target.rect;
  g.save();
  if (dim) g.globalAlpha = 0.4;
  roundRect(g, x, y, w, h, Math.min(h / 2, 22));
  g.fillStyle = selected ? hsla(hue, 90, 66, 0.95) : hover ? 'rgba(255, 255, 255, 0.2)' : 'rgba(255, 255, 255, 0.1)';
  g.fill();
  g.lineWidth = hover ? 2.5 : 1.5;
  g.strokeStyle = selected ? hsla(hue, 100, 85, 0.95) : 'rgba(255, 255, 255, 0.35)';
  g.stroke();
  text(g, label, x + w / 2, y + h / 2, { size: Math.max(13, Math.min(19, h * 0.36)), weight: 700, color: selected ? '#1a1330' : 'rgba(244,246,255,0.95)', outline: !selected });
  g.restore();
}

// Ring on a pressed target: bright while a tap would still count, grey once it has become a hold;
// a shrinking arc while switches are locked after a toggle.
function drawFeedback(g, view, target) {
  const press = view.presses.find(p => sameTarget(p.target, target));
  const r = (target.r ?? Math.min(target.rect.w, target.rect.h) / 2) + 7;
  const cx = target.cx ?? target.rect.x + target.rect.w / 2, cy = target.cy ?? target.rect.y + target.rect.h / 2;
  if (press && target.kind !== 'knob') {
    const expired = view.time - press.since > view.settings.pedalTapTime / 1000;
    g.save();
    g.lineWidth = 3;
    g.strokeStyle = expired ? 'rgba(200, 200, 210, 0.5)' : 'rgba(255, 244, 200, 0.95)';
    if (expired) g.setLineDash([6, 6]);
    g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.stroke();
    g.restore();
  }
  if (view.lockout > 0 && view.lastToggle && sameTarget(view.lastToggle.target, target)) {
    g.save();
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    g.beginPath();
    g.arc(cx, cy, r + 3, -Math.PI / 2, -Math.PI / 2 + TAU * view.lockout / (view.settings.pedalLockout / 1000));
    g.stroke();
    g.restore();
  }
}

export function sameTarget(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.pedal === b.pedal && a.knob === b.knob && a.macro === b.macro && a.action === b.action
    && a.preset === b.preset && a.mode === b.mode && a.delta === b.delta;
}

const isHover = (view, target) => view.hovered.some(h => sameTarget(h, target));
const isActive = (view, target) => view.presses.some(p => sameTarget(p.target, target));

// ---------- footswitch zone ----------
export function drawZone(g, view) {
  const { stage, settings, model, t } = view;
  const zone = zoneRect(stage, settings);
  g.save();
  const fill = g.createLinearGradient(0, zone.y, 0, zone.y + zone.h);
  fill.addColorStop(0, view.zoneActive ? 'rgba(48, 60, 130, 0.5)' : 'rgba(8, 10, 30, 0.35)');
  fill.addColorStop(1, view.zoneActive ? 'rgba(30, 38, 96, 0.78)' : 'rgba(6, 8, 24, 0.66)');
  g.fillStyle = fill;
  g.fillRect(zone.x, zone.y, zone.w, zone.h);
  g.lineWidth = view.zoneActive ? 3 : 1.5;
  g.strokeStyle = view.zoneActive ? 'rgba(170, 200, 255, 0.9)' : 'rgba(255, 255, 255, 0.22)';
  g.beginPath(); g.moveTo(0, zone.y); g.lineTo(zone.w, zone.y); g.stroke();
  g.restore();

  for (const target of view.targets) {
    if (target.kind === 'switch') {
      drawDisc(g, {
        cx: target.cx, cy: target.cy, r: target.r, hue: hueOf(target.pedal), on: model.isOn(target.pedal),
        icon: PEDAL_TYPES[target.pedal].icon, label: t(PEDAL_TYPES[target.pedal].label),
        hover: isHover(view, target), keyHint: String(target.index + 4), soon: soonOf(view, target.pedal),
      });
      drawFeedback(g, view, target);
    } else if (target.kind === 'knob') {
      drawKnob(g, t, { ...target, hue: hueOf(target.pedal), label: target.def.label, def: target.def,
        active: isActive(view, target), hover: isHover(view, target), dim: !model.isOn(target.pedal) || !!soonOf(view, target.pedal) });
    }
  }
}

export function drawWahStrip(g, view) {
  const { stage, settings, model, t } = view;
  const { strip, track } = wahLayout(stage, settings);
  const hue = hueOf('wah');
  const auto = stepIndex(knobOf('wah', 'mode'), model.param('wah', 'mode')) === 1;
  g.save();
  roundRect(g, strip.x + 4, strip.y, strip.w - 8, strip.h, 16);
  g.fillStyle = view.stripActive ? hsla(hue, 60, 35, 0.45) : 'rgba(10, 12, 32, 0.38)';
  g.fill();
  g.lineWidth = view.stripActive ? 2.5 : 1.5;
  g.strokeStyle = hsla(hue, 80, 70, view.stripActive ? 0.9 : 0.45);
  g.stroke();
  const cx = strip.x + strip.w / 2;
  g.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(cx, track.y0); g.lineTo(cx, track.y1); g.stroke();
  // In auto mode the marker only shows the mode with a gentle sweep (the real sweep is the DSP's).
  const pos = auto ? 0.5 + 0.4 * Math.sin(view.time * 3) : model.param('wah', 'position');
  const y = track.y0 + (1 - pos) * (track.y1 - track.y0);
  g.fillStyle = hsla(hue, 95, 70, auto ? 0.4 : 0.95);
  roundRect(g, strip.x + 14, y - 5, strip.w - 28, 10, 5);
  g.fill();
  if (!auto) {
    text(g, t('pedal.wahBright'), cx, track.y0 - 6, { size: 11, color: 'rgba(244,246,255,0.6)' });
    text(g, t('pedal.wahDark'), cx, track.y1 + 16, { size: 11, color: 'rgba(244,246,255,0.6)' });
    text(g, t('pedal.wahHint'), cx, strip.y + strip.h - 8, { size: 11, color: 'rgba(244,246,255,0.65)' });
  }
  g.restore();
  for (const target of view.targets) {
    if (target.kind === 'button' && target.action === 'wahMode') {
      drawButton(g, target, t(auto ? 'pedal.wahAuto' : 'pedal.wahHand'), { selected: auto, hover: isHover(view, target), hue });
      drawFeedback(g, view, target);
    }
  }
}

// ---------- tuning screen ----------
export function drawTuning(g, view) {
  const { stage, model, t, ui } = view;
  const W = stage.width, H = stage.height;
  g.save();
  g.fillStyle = 'rgba(5, 7, 22, 0.78)';
  g.fillRect(0, 0, W, H);
  g.restore();

  text(g, t('pedal.title'), W / 2, H * 0.08, { size: Math.min(34, H * 0.05), weight: 800 });
  text(g, t(view.mouse ? 'pedal.tuningHintMouse' : 'pedal.tuningHint'), W / 2, H * 0.08 + Math.min(30, H * 0.045), { size: 13, color: 'rgba(244,246,255,0.65)' });

  for (const target of view.targets) {
    const hover = isHover(view, target);
    if (target.kind === 'button') {
      let label = t(target.label), selected = false, dim = false, hue = 45;
      if (target.action === 'mode') selected = model.mode === target.mode;
      if (target.action === 'preset') selected = model.preset === target.preset;
      if (target.action === 'move') {
        const order = model.board.order, i = order.indexOf(target.pedal);
        dim = i < 0 || (target.delta < 0 ? i === 0 : i === order.length - 1);
        label = target.delta < 0 ? '◀' : '▶';
      }
      if (target.action === 'done') hue = 140;
      drawButton(g, target, label, { selected, hover, dim, hue });
      drawFeedback(g, view, target);
    } else if (target.kind === 'switch') {
      drawDisc(g, { cx: target.cx, cy: target.cy, r: target.r, hue: hueOf(target.pedal), on: model.isOn(target.pedal),
        icon: PEDAL_TYPES[target.pedal].icon, label: t(PEDAL_TYPES[target.pedal].label), hover, soon: soonOf(view, target.pedal) });
      drawFeedback(g, view, target);
    } else if (target.kind === 'knob' && target.macro) {
      drawKnob(g, t, { ...target, hue: 20, label: MACROS[target.macro].label, def: null, active: isActive(view, target), hover });
    } else if (target.kind === 'knob') {
      drawKnob(g, t, { ...target, hue: hueOf(target.pedal), label: target.def.label, def: target.def,
        active: isActive(view, target), hover, dim: !model.isOn(target.pedal) || !!soonOf(view, target.pedal) });
      drawFeedback(g, view, target);
    } else if (target.kind === 'select') {
      const selected = ui.selected === target.pedal;
      const isAmp = target.pedal === AMP;
      if (selected) {
        g.save();
        roundRect(g, target.rect.x, target.rect.y, target.rect.w, target.rect.h, 14);
        g.fillStyle = 'rgba(255, 255, 255, 0.12)';
        g.fill();
        g.lineWidth = 2;
        g.strokeStyle = hsla(hueOf(target.pedal), 90, 75, 0.9);
        g.stroke();
        g.restore();
      }
      drawDisc(g, { cx: target.cx, cy: target.cy, r: target.r, hue: hueOf(target.pedal), on: isAmp || model.isOn(target.pedal),
        icon: isAmp ? 'amp' : PEDAL_TYPES[target.pedal].icon, label: null, hover, soon: isAmp ? null : soonOf(view, target.pedal) });
      text(g, t(isAmp ? 'pedal.amp' : PEDAL_TYPES[target.pedal].label), target.cx, target.cy + target.r + 16, { size: 13 });
      if (target.index > 0) {
        const prev = view.targets.find(x => x.kind === 'select' && x.index === target.index - 1);
        if (prev) text(g, '›', (prev.cx + target.cx) / 2, target.cy, { size: 20, color: 'rgba(244,246,255,0.4)', outline: false });
      }
    }
  }

  if (model.mode === 'simple') {
    text(g, model.preset ? t('pedal.presetLabel') : t('pedal.custom'), W / 2, H * 0.31 - Math.max(52, H * 0.09) / 2 - 14, { size: 12, color: 'rgba(244,246,255,0.6)' });
    text(g, t('pedal.autoLevel'), W / 2, H * 0.79, { size: 12, color: 'rgba(244,246,255,0.6)' });
  } else if (ui.selected === AMP) {
    text(g, t('pedal.ampNote'), W / 2, H * 0.6, { size: 15, color: 'rgba(244,246,255,0.8)' });
  } else {
    text(g, t('pedal.chainNote'), W / 2, H * 0.79, { size: 12, color: 'rgba(244,246,255,0.6)' });
  }
  text(g, view.audition ? t('pedal.auditionOn') : t('pedal.auditionOff'), W / 2, H * 0.95, { size: 12, color: 'rgba(244,246,255,0.5)' });
}
