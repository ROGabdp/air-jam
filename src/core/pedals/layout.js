// Where everything on the pedalboard sits, in stage pixels. Pure geometry shared by hit testing
// and drawing, so what you see is exactly what a pinch can hit.
import { AMP, MACROS, PRESETS, visibleKnobs } from './model.js';

export const inRect = (p, r, pad = 0) =>
  p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;

const rectAround = (cx, cy, w, h) => ({ x: cx - w / 2, y: cy - h / 2, w, h });

// Footswitch zone: a band along the bottom of the stage.
export function zoneRect(stage, settings) {
  const h = Math.round(stage.height * settings.pedalZoneHeight);
  return { x: 0, y: stage.height - h, w: stage.width, h };
}

// The wah strip is for the hand that does not strum: a right-handed player's left hand, which the
// mirrored video shows on the left of the screen. Left-handed players get it on the right.
export const wahStripSide = settings => (settings.handedness === 'left' ? 'right' : 'left');

// Below the HUD's top row (chord boxes on the left, score and settings on the right; fixed CSS
// pixels, about 118 px tall) and above the footswitch zone. The page moves the song info / status
// line beside it (dom.js), so nothing else sits on the strip.
export const WAH_STRIP_TOP = 128;

// Wah strip: one screen edge between the HUD and the footswitch zone.
export function wahStripRect(stage, settings) {
  const top = WAH_STRIP_TOP;
  const bottom = zoneRect(stage, settings).y - 34;
  const w = Math.round(stage.width * settings.wahStripWidth);
  const x = wahStripSide(settings) === 'left' ? 0 : stage.width - w;
  return { x, y: top, w, h: Math.max(40, bottom - top) };
}

function knobTarget(pedal, knob, model, cx, cy, r, rect) {
  return { kind: 'knob', pedal, knob: knob.id, def: knob, cx, cy, r, rect, value: model.param(pedal, knob.id) };
}

/**
 * Zone targets, left to right in chain order: per pedal a switch (big disc) and its simple knobs
 * (at most two, stacked on the right of the slot). A 'zone' target covers the rest of the band so
 * a pinch that starts anywhere in it belongs to the pedalboard.
 */
export function zoneTargets(stage, settings, model) {
  const zone = zoneRect(stage, settings);
  const order = model.pedalOrder();
  const slotW = Math.min(stage.width / order.length, 260);
  const x0 = (stage.width - slotW * order.length) / 2;
  const targets = [];
  order.forEach((pedal, i) => {
    const slot = { x: x0 + i * slotW, y: zone.y, w: slotW, h: zone.h };
    const switchW = slotW * 0.58;
    const r = Math.max(14, Math.min(zone.h * 0.36, switchW * 0.4));
    targets.push({ kind: 'switch', pedal, index: i, slot, cx: slot.x + switchW / 2, cy: zone.y + zone.h / 2, r,
      rect: { x: slot.x, y: zone.y, w: switchW, h: zone.h } });
    const knobs = visibleKnobs(pedal, 'simple');
    const colX = slot.x + switchW, colW = slotW - switchW;
    knobs.forEach((knob, k) => {
      const rect = { x: colX, y: zone.y + k * zone.h / knobs.length, w: colW, h: zone.h / knobs.length };
      const kr = Math.max(8, Math.min(rect.h * 0.27, rect.w * 0.26));
      targets.push(knobTarget(pedal, knob, model, rect.x + rect.w / 2, rect.y + rect.h * 0.42, kr, rect));
    });
  });
  targets.push({ kind: 'zone', rect: zone });
  return targets;
}

/**
 * Tuning screen targets for the current mode. ui = { selected } (advanced mode's open pedal).
 * Simple: preset buttons, two macro knobs, a row of pedal switches. Advanced: the chain (tap to
 * select), the selected pedal's switch, every knob, and move-left/right buttons. Both: mode
 * buttons at the top and a done button. Important targets stay in the middle band of the screen:
 * the very bottom is where tracking is worst (wrist out of view) and high up tires the arm.
 */
export function tuningTargets(stage, model, ui) {
  const W = stage.width, H = stage.height;
  const targets = [];
  const button = (action, cx, cy, w, h, extra = {}) => targets.push({ kind: 'button', action, rect: rectAround(cx, cy, w, h), cx, cy, ...extra });

  const modeW = Math.min(150, W * 0.16), modeH = Math.max(40, H * 0.06);
  button('mode', W / 2 - modeW / 2 - 6, H * 0.17, modeW, modeH, { mode: 'simple', label: 'pedal.mode.simple' });
  button('mode', W / 2 + modeW / 2 + 6, H * 0.17, modeW, modeH, { mode: 'advanced', label: 'pedal.mode.advanced' });
  button('done', W / 2, H * 0.87, Math.min(240, W * 0.3), Math.max(48, H * 0.075), { label: 'pedal.done' });

  if (model.mode === 'simple') {
    const n = PRESETS.length, gap = 16;
    const w = Math.min(190, (W * 0.8 - gap * (n - 1)) / n), h = Math.max(52, H * 0.09);
    PRESETS.forEach((preset, i) => {
      button('preset', W / 2 + (i - (n - 1) / 2) * (w + gap), H * 0.31, w, h, { preset: preset.id, label: preset.label });
    });
    const r = Math.min(H * 0.085, 72);
    Object.keys(MACROS).forEach((name, i) => {
      const cx = W / 2 + (i === 0 ? -1 : 1) * r * 2.3, cy = H * 0.5;
      targets.push({ kind: 'knob', macro: name, cx, cy, r, rect: rectAround(cx, cy + r * 0.2, r * 3, r * 3), value: model.macro(name) });
    });
    const order = model.pedalOrder();
    const spacing = Math.min(W / (order.length + 1), 150);
    const pr = Math.min(H * 0.055, spacing * 0.34);
    order.forEach((pedal, i) => {
      const cx = W / 2 + (i - (order.length - 1) / 2) * spacing, cy = H * 0.7;
      targets.push({ kind: 'switch', pedal, index: i, cx, cy, r: pr, rect: rectAround(cx, cy + pr * 0.35, spacing * 0.92, pr * 3) });
    });
    return targets;
  }

  const chain = model.snapshot().order;
  const spacing = Math.min(W / (chain.length + 1), 140);
  const cr = Math.min(H * 0.045, spacing * 0.3);
  chain.forEach((id, i) => {
    const cx = W / 2 + (i - (chain.length - 1) / 2) * spacing, cy = H * 0.3;
    targets.push({ kind: 'select', pedal: id, index: i, cx, cy, r: cr, rect: rectAround(cx, cy + cr * 0.4, spacing * 0.92, cr * 3.2) });
  });

  const selected = ui.selected;
  const panelW = Math.min(W * 0.86, 980), panelX = (W - panelW) / 2;
  const cy = H * 0.6;
  const moveSize = Math.max(48, H * 0.075);
  button('move', panelX + panelW - moveSize * 1.7, cy, moveSize, moveSize, { delta: -1, label: 'pedal.moveLeft', pedal: selected });
  button('move', panelX + panelW - moveSize * 0.55, cy, moveSize, moveSize, { delta: 1, label: 'pedal.moveRight', pedal: selected });
  if (selected === AMP) return targets;

  const sr = Math.min(H * 0.085, 70);
  targets.push({ kind: 'switch', pedal: selected, cx: panelX + sr * 1.3, cy, r: sr, rect: rectAround(panelX + sr * 1.3, cy + sr * 0.2, sr * 2.6, sr * 3) });
  const knobs = visibleKnobs(selected, 'advanced');
  const left = panelX + sr * 2.8, right = panelX + panelW - moveSize * 2.4;
  const slot = (right - left) / Math.max(1, knobs.length);
  const kr = Math.min(H * 0.065, 54, slot * 0.3);
  knobs.forEach((knob, k) => {
    const kx = left + slot * (k + 0.5);
    targets.push(knobTarget(selected, knob, model, kx, cy, kr, rectAround(kx, cy + kr * 0.3, slot * 0.94, kr * 3.4)));
  });
  return targets;
}

// First target containing the point (switches and knobs before the catch-all zone).
export function hitTarget(targets, point) {
  for (const target of targets) if (target.kind !== 'zone' && inRect(point, target.rect)) return target;
  return targets.find(target => target.kind === 'zone' && inRect(point, target.rect)) ?? null;
}

// Wah strip parts: a mode button on top (hand / auto) and the track whose height is the pedal position.
export function wahLayout(stage, settings) {
  const strip = wahStripRect(stage, settings);
  const button = { x: strip.x + 8, y: strip.y + 6, w: strip.w - 16, h: Math.min(40, strip.h * 0.25) };
  const track = { y0: button.y + button.h + 18, y1: strip.y + strip.h - 36 };
  return { strip, button, track };
}

export const wahPositionAt = (layout, y) =>
  Math.max(0, Math.min(1, 1 - (y - layout.track.y0) / Math.max(1, layout.track.y1 - layout.track.y0)));
