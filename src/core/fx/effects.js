// Shared canvas effects: particles, floating texts and the beat pulse around the stage edge.
import { hsl } from '../music/theory.js';

const MAX_PARTICLES = 900;

export function createEffects() {
  const particles = [];
  const texts = [];
  let pulse = 0;
  let pulseColor = { h: 45, s: 90, l: 62 };

  function spawn(particle) {
    if (particles.length >= MAX_PARTICLES) particles.shift();
    particles.push(particle);
  }

  return {
    // Radial burst, e.g. at a pluck point.
    burst(x, y, color, count = 12, speed = 220) {
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const v = speed * (0.25 + Math.random());
        spawn({
          x, y, vx: Math.cos(angle) * v, vy: Math.sin(angle) * v - 40,
          life: 0, ttl: 0.45 + Math.random() * 0.5, size: 1.5 + Math.random() * 2.5,
          color, shift: Math.random() * 24,
        });
      }
    },

    // Particles scattered along a segment, e.g. a string breaking apart.
    shatter(a, b, color, count = 40) {
      for (let i = 0; i < count; i++) {
        const u = Math.random();
        const angle = Math.random() * Math.PI * 2;
        const v = 40 + Math.random() * 160;
        spawn({
          x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u,
          vx: Math.cos(angle) * v, vy: Math.sin(angle) * v,
          life: 0, ttl: 0.5 + Math.random() * 0.6, size: 1.5 + Math.random() * 2.5,
          color, shift: Math.random() * 20,
        });
      }
    },

    popText(x, y, text, { color = '#fff', size = 22, ttl = 0.9, weight = 700 } = {}) {
      texts.push({ x, y, text, color, size, ttl, weight, life: 0 });
      if (texts.length > 40) texts.shift();
    },

    beat(strength, color) {
      pulse = Math.max(pulse, strength);
      if (color) pulseColor = color;
    },

    update(dt) {
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += dt;
        if (p.life >= p.ttl) { particles.splice(i, 1); continue; }
        p.vy += 260 * dt;
        p.vx *= 1 - 1.6 * dt;
        p.vy *= 1 - 1.6 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      for (let i = texts.length - 1; i >= 0; i--) {
        texts[i].life += dt;
        if (texts[i].life >= texts[i].ttl) texts.splice(i, 1);
      }
      pulse *= Math.exp(-dt * 7);
    },

    drawPulse(g, width, height) {
      if (pulse < 0.01) return;
      const edge = Math.min(width, height) * 0.16;
      const paint = (x0, y0, x1, y1, rect) => {
        const gradient = g.createLinearGradient(x0, y0, x1, y1);
        gradient.addColorStop(0, hsl(pulseColor, 0.5 * pulse, 8));
        gradient.addColorStop(1, hsl(pulseColor, 0));
        g.fillStyle = gradient;
        g.fillRect(...rect);
      };
      paint(0, 0, edge, 0, [0, 0, edge, height]);
      paint(width, 0, width - edge, 0, [width - edge, 0, edge, height]);
      paint(0, height, 0, height - edge, [0, height - edge, width, edge]);
    },

    draw(g) {
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (const p of particles) {
        const fade = 1 - p.life / p.ttl;
        g.fillStyle = hsl(p.color, fade, p.shift);
        g.beginPath();
        g.arc(p.x, p.y, p.size * (0.5 + 0.5 * fade), 0, Math.PI * 2);
        g.fill();
      }
      g.restore();

      g.save();
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const text of texts) {
        const k = text.life / text.ttl;
        const pop = k < 0.12 ? 0.6 + 0.4 * (k / 0.12) + 0.25 * Math.sin((k / 0.12) * Math.PI) : 1;
        g.globalAlpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
        g.font = `${text.weight} ${Math.round(text.size * pop)}px "Segoe UI", "Microsoft JhengHei", sans-serif`;
        g.lineWidth = 4;
        g.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        const y = text.y - 46 * k;
        g.strokeText(text.text, text.x, y);
        g.fillStyle = text.color;
        g.fillText(text.text, text.x, y);
      }
      g.restore();
    },

    clear() { particles.length = 0; texts.length = 0; pulse = 0; },
    get particleCount() { return particles.length; },
  };
}
