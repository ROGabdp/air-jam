// 空中弦: pinch with both hands to stretch a string that stays in the air, cross it with the
// index fingertip to pluck. String length picks a pitch slot; the shared snapper turns the slot
// into a note of the current chord, so the strings retune themselves when the chord changes.
import { chordColor, mixColor, hsl } from '../../core/music/theory.js';
import { PluckDetector, distanceToSegment } from './pluck-detector.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, u) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
const COLOR_FADE = 0.3;
const DYING_FADE = 0.4;
const VIBRATION_HZ = 13;

export function createAirStrings() {
  let ctx, settings, detector;
  let strings = [];
  let draft = null;                 // string being stretched: { a, b, ids, lastBoth, source }
  let nextId = 1;
  let now = 0;
  let color = { from: chordColor(null), to: chordColor(null), at: -1 };
  const fistHolds = new Map();      // handId → { stringId, since, center }
  let clearHold = null;             // { since, centers }

  const minLength = () => settings.minStringLength * ctx.stage.width;
  const maxLength = () => settings.maxStringLength * ctx.stage.width;
  const lengthOf = s => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
  // 0 = longest/lowest … 1 = shortest/highest.
  const heightFor = length => 1 - clamp((length - minLength()) / (maxLength() - minLength()), 0, 1);
  const noteFor = length => ctx.pitch.note(heightFor(length), maxLength() / Math.max(length, 1));
  const currentColor = () => mixColor(color.from, color.to, clamp((now - color.at) / COLOR_FADE, 0, 1));
  const alive = () => strings.filter(s => s.dying === null);

  function addString(a, b) {
    const string = {
      id: nextId++, a: { ...a }, b: { ...b }, born: now, lastPluck: -1, dying: null,
      vibration: null, flash: 0, label: null,
    };
    strings.push(string);
    const living = alive();
    if (living.length > settings.maxStrings) living[0].dying = now;

    const note = noteFor(lengthOf(string));
    const middle = lerp(a, b, 0.5);
    ctx.audio.pluck({ freq: note.freq, velocity: 0.22, position: 0.5, pan: panFor(middle), key: string.id });
    string.vibration = { amp: 4, pos: 0.5, start: now, tau: 0.35 };
    string.flash = 0.8;
    string.label = { text: note.name, at: now };
    ctx.fx.burst(a.x, a.y, currentColor(), 6, 90);
    ctx.fx.burst(b.x, b.y, currentColor(), 6, 90);
    return string;
  }

  function removeString(string, shatter) {
    if (shatter) ctx.fx.shatter(string.a, string.b, currentColor(), clamp(Math.round(lengthOf(string) / 9), 16, 80));
    strings = strings.filter(s => s !== string);
    detector.forgetString(string.id);
  }

  const panFor = point => clamp((point.x / ctx.stage.width) * 2 - 1, -1, 1) * 0.7;

  function pluck(string, u, velocity, delay) {
    const length = lengthOf(string);
    const note = noteFor(length);
    const point = lerp(string.a, string.b, u);
    ctx.audio.pluck({
      freq: note.freq, velocity, position: u, delay,
      pan: panFor(lerp(string.a, string.b, 0.5)), key: string.id,
    });
    string.lastPluck = now;
    string.vibration = {
      amp: Math.min(length * 0.07, 5 + 15 * velocity),
      pos: clamp(u, 0.08, 0.92), start: now + delay, tau: ctx.audio.ringTime(note.freq),
    };
    string.flash = 1;
    string.label = { text: note.name, at: now };

    const result = ctx.judge(point);
    const bonus = result.grade === 'perfect' ? 22 : result.grade === 'good' ? 9 : 0;
    const count = Math.round(7 + 10 * velocity + bonus + Math.min(30, result.combo) * 0.4);
    ctx.fx.burst(point.x, point.y, currentColor(), count, 160 + 180 * velocity);
  }

  function updateDraft(hands) {
    const pinchers = hands.filter(h => h.pinching);
    if (pinchers.length >= 2) {
      let pair = draft && draft.ids.map(id => pinchers.find(h => h.id === id));
      if (!pair || pair.includes(undefined)) pair = pinchers.slice(0, 2);
      draft = {
        a: { ...pair[0].pinchPoint }, b: { ...pair[1].pinchPoint },
        ids: pair.map(h => h.id), lastBoth: now, source: pair[0].source,
      };
      return;
    }
    if (!draft) return;
    const grace = draft.source === 'mouse' ? 0 : settings.releaseGrace / 1000;
    if (now - draft.lastBoth < grace) return;
    if (lengthOf(draft) >= minLength()) addString(draft.a, draft.b);
    draft = null;
  }

  function updatePlucks(hands) {
    const seen = new Set();
    const pluckable = strings.filter(s => s.dying === null);
    let order = 0;
    for (const hand of hands) {
      seen.add(hand.id);
      // A pinching hand is busy stretching a string and a fist is deleting: neither may pluck.
      if (hand.pinching || hand.fist) { detector.reset(hand.id); continue; }
      if (hand.fresh) detector.reset(hand.id);
      for (const { string, u } of detector.detect(hand.id, hand.tip, hand.palm, pluckable)) {
        if ((now - string.lastPluck) * 1000 < settings.pluckCooldown) continue;
        if ((now - string.born) * 1000 < settings.newStringGuard) continue;
        const speed = hand.tipSpeed / hand.palm;
        const velocity = clamp(speed / settings.velocityFull, 0.1, 1);
        pluck(string, u, velocity, order++ * settings.strumGap / 1000);
      }
    }
    detector.retainHands(seen);
  }

  function updateFists(hands) {
    const fists = hands.filter(h => h.fist);
    if (fists.length >= 2 && alive().length > 0) {
      fistHolds.clear();
      clearHold = { since: clearHold?.since ?? now, centers: fists.map(h => ({ ...h.center })) };
      if ((now - clearHold.since) * 1000 >= settings.fistClearTime) {
        for (const string of alive()) removeString(string, true);
        clearHold = null;
      }
      return;
    }
    clearHold = null;

    const active = new Set();
    for (const hand of fists) {
      let target = null, best = settings.fistReach * hand.palm;
      for (const string of alive()) {
        const { distance } = distanceToSegment(hand.center, string.a, string.b);
        if (distance < best) { best = distance; target = string; }
      }
      if (!target) continue;
      active.add(hand.id);
      const hold = fistHolds.get(hand.id);
      if (!hold || hold.stringId !== target.id) fistHolds.set(hand.id, { stringId: target.id, since: now, center: { ...hand.center } });
      else {
        hold.center = { ...hand.center };
        if ((now - hold.since) * 1000 >= settings.fistDeleteTime) {
          removeString(target, true);
          fistHolds.delete(hand.id);
        }
      }
    }
    for (const id of fistHolds.keys()) if (!active.has(id)) fistHolds.delete(id);
  }

  // Lengths (px) at which the snapped slot changes, like frets.
  function fretLengths() {
    if (ctx.pitch.effectiveMode() === 'free') return [];
    const slots = settings.slots;
    const lengths = [];
    for (let k = 0; k < slots - 1; k++) {
      lengths.push(minLength() + (1 - (k + 0.5) / (slots - 1)) * (maxLength() - minLength()));
    }
    return lengths;
  }

  function drawFrets(g, string, length, tint, alpha, beyond) {
    const dx = (string.b.x - string.a.x) / length, dy = (string.b.y - string.a.y) / length;
    g.lineWidth = 2;
    for (const fret of fretLengths()) {
      if (fret > length + beyond) continue;
      const x = string.a.x + dx * fret, y = string.a.y + dy * fret;
      g.strokeStyle = hsl(tint, fret > length ? alpha * 0.4 : alpha, 18);
      g.beginPath();
      g.moveTo(x - dy * 7, y + dx * 7);
      g.lineTo(x + dy * 7, y - dx * 7);
      g.stroke();
    }
  }

  function tracePath(g, string, length) {
    const v = string.vibration;
    const age = v ? now - v.start : 0;
    const amp = v && age >= 0 ? v.amp * Math.exp(-age / v.tau) : 0;
    g.beginPath();
    g.moveTo(string.a.x, string.a.y);
    if (amp < 0.3) {
      if (v && age > 0) string.vibration = null;
      g.lineTo(string.b.x, string.b.y);
      return;
    }
    // Decaying standing wave, bent most where the string was plucked.
    const nx = -(string.b.y - string.a.y) / length, ny = (string.b.x - string.a.x) / length;
    const swing = Math.cos(2 * Math.PI * VIBRATION_HZ * age);
    const overtone = 0.3 * Math.cos(2 * Math.PI * VIBRATION_HZ * 2.02 * age);
    const steps = clamp(Math.round(length / 14), 12, 48);
    for (let i = 1; i < steps; i++) {
      const u = i / steps;
      const shape = u < v.pos ? u / v.pos : (1 - u) / (1 - v.pos);
      const offset = amp * (shape * swing + Math.sin(2 * Math.PI * u) * overtone);
      g.lineTo(string.a.x + (string.b.x - string.a.x) * u + nx * offset,
        string.a.y + (string.b.y - string.a.y) * u + ny * offset);
    }
    g.lineTo(string.b.x, string.b.y);
  }

  function drawLabel(g, string, length, text, alpha, size) {
    const middle = lerp(string.a, string.b, 0.5);
    let nx = -(string.b.y - string.a.y) / length, ny = (string.b.x - string.a.x) / length;
    if (ny > 0) { nx = -nx; ny = -ny; }
    g.font = `600 ${size}px "Segoe UI", "Microsoft JhengHei", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 3;
    g.strokeStyle = `rgba(0, 0, 0, ${0.5 * alpha})`;
    g.strokeText(text, middle.x + nx * 22, middle.y + ny * 22);
    g.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    g.fillText(text, middle.x + nx * 22, middle.y + ny * 22);
  }

  function drawHoldRing(g, center, progress, label) {
    g.lineWidth = 5;
    g.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    g.beginPath();
    g.arc(center.x, center.y, 30, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = 'rgba(255, 120, 110, 0.95)';
    g.beginPath();
    g.arc(center.x, center.y, 30, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(progress, 0, 1));
    g.stroke();
    g.font = '600 13px "Segoe UI", "Microsoft JhengHei", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255, 255, 255, 0.9)';
    g.fillText(label, center.x, center.y - 44);
  }

  return {
    id: 'air-strings',

    init(context) {
      ctx = context;
      settings = ctx.settings;
      detector = new PluckDetector(settings.crossDeadband);
    },

    onHands(hands, time) {
      now = time;
      updateDraft(hands);
      updatePlucks(hands);
      updateFists(hands);
    },

    onCommand(command) {
      if (command.type !== 'deleteAt') return;
      let target = null, best = 16;
      for (const string of alive()) {
        const { distance } = distanceToSegment(command, string.a, string.b);
        if (distance < best) { best = distance; target = string; }
      }
      if (target) removeString(target, true);
    },

    onChordChange(chord) {
      color = { from: currentColor(), to: chordColor(chord), at: now };
    },

    onResize(width, height, previous) {
      const sx = width / previous.width, sy = height / previous.height;
      for (const string of strings) {
        for (const end of [string.a, string.b]) { end.x *= sx; end.y *= sy; }
      }
      draft = null;
      detector.clear();
    },

    update(dt) {
      for (const string of strings) string.flash = Math.max(0, string.flash - dt * 2.2);
      for (const string of strings.filter(s => s.dying !== null && now - s.dying > DYING_FADE)) removeString(string, false);
    },

    draw(g) {
      const tint = currentColor();
      const comboGlow = Math.min(1, ctx.combo() / 30);
      g.save();
      g.lineCap = 'round';
      g.lineJoin = 'round';

      for (const string of strings) {
        const length = lengthOf(string);
        const fade = string.dying === null ? Math.min(1, (now - string.born) / 0.15 + 0.4)
          : 1 - clamp((now - string.dying) / DYING_FADE, 0, 1);
        const lift = (heightFor(length) - 0.5) * 14;
        const shade = { ...tint, l: tint.l + lift };
        g.globalAlpha = fade;
        drawFrets(g, string, length, shade, 0.3 + 0.3 * string.flash, 0);

        // Soft halo in three additive passes, then a bright core.
        g.globalCompositeOperation = 'lighter';
        tracePath(g, string, length);
        const glow = 1 + 0.8 * comboGlow + 1.2 * string.flash;
        for (const [width, alpha] of [[26, 0.045], [14, 0.09], [6.5, 0.22]]) {
          g.strokeStyle = hsl(shade, Math.min(1, alpha * glow));
          g.lineWidth = width * (0.85 + 0.15 * glow);
          g.stroke();
        }
        g.globalCompositeOperation = 'source-over';
        g.strokeStyle = hsl(shade, 1, 20 + 14 * string.flash);
        g.lineWidth = 2.2;
        g.stroke();

        g.fillStyle = hsl(shade, 0.95, 20);
        for (const end of [string.a, string.b]) {
          g.beginPath();
          g.arc(end.x, end.y, 4.5, 0, Math.PI * 2);
          g.fill();
        }
        if (string.label) {
          const age = now - string.label.at;
          if (age > 1.2) string.label = null;
          else drawLabel(g, string, length, string.label.text, fade * (1 - clamp((age - 0.7) / 0.5, 0, 1)), 17);
        }
      }
      g.globalAlpha = 1;

      if (draft) {
        const length = lengthOf(draft);
        const valid = length >= minLength();
        g.setLineDash([10, 9]);
        g.strokeStyle = valid ? hsl(tint, 0.75, 16) : 'rgba(255, 255, 255, 0.35)';
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(draft.a.x, draft.a.y);
        g.lineTo(draft.b.x, draft.b.y);
        g.stroke();
        g.setLineDash([]);
        if (valid) {
          drawFrets(g, draft, length, tint, 0.85, (maxLength() - minLength()) / (settings.slots - 1));
          drawLabel(g, draft, length, noteFor(length).name, 1, 24);
        }
      }

      for (const hold of fistHolds.values()) {
        drawHoldRing(g, hold.center, (now - hold.since) * 1000 / settings.fistDeleteTime, ctx.t('gesture.delete'));
      }
      if (clearHold) {
        for (const center of clearHold.centers) {
          drawHoldRing(g, center, (now - clearHold.since) * 1000 / settings.fistClearTime, ctx.t('gesture.clear'));
        }
      }
      g.restore();
    },

    reset() {
      strings = [];
      draft = null;
      fistHolds.clear();
      clearHold = null;
    },

    dispose() {
      strings = [];
      draft = null;
    },

    // Read-only views for the HUD, tests and debugging.
    get strings() { return strings; },
    get drafting() { return draft !== null; },
    noteOf: string => noteFor(lengthOf(string)),
  };
}
