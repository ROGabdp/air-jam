// Detects a fingertip crossing string segments. A crossing needs the tip to move from clearly one
// side of the string to clearly the other (beyond a dead band), with the path actually passing
// through the segment, so a finger trembling on a string cannot re-trigger it. Pure geometry.

// Signed perpendicular distance from p to the line a→b (positive on the left of a→b).
export function signedDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  return (dx * (p.y - a.y) - dy * (p.x - a.x)) / length;
}

// Where segment p→q crosses line a→b: u along a→b and s along p→q, or null if parallel.
export function crossing(p, q, a, b) {
  const rx = q.x - p.x, ry = q.y - p.y;
  const sx = b.x - a.x, sy = b.y - a.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const s = ((a.x - p.x) * sy - (a.y - p.y) * sx) / denom;
  const u = ((a.x - p.x) * ry - (a.y - p.y) * rx) / denom;
  return { s, u };
}

// Distance from p to segment a→b, and the closest position u (0..1) along it.
export function distanceToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return { distance: Math.hypot(p.x - (a.x + dx * u), p.y - (a.y + dy * u)), u };
}

const END_MARGIN = 0.02;

export class PluckDetector {
  #hands = new Map();   // handId → Map(stringId → { side, anchor })

  constructor(deadband) {
    this.deadband = deadband;   // in palm sizes
  }

  // Forget a hand's history (after pinching, a fist, or re-acquisition) so stale positions can't pluck.
  reset(handId) { this.#hands.delete(handId); }

  // Forget every hand (e.g. after the stage is resized and the strings moved under the fingertips).
  clear() { this.#hands.clear(); }

  forgetString(stringId) {
    for (const sides of this.#hands.values()) sides.delete(stringId);
  }

  retainHands(ids) {
    for (const id of this.#hands.keys()) if (!ids.has(id)) this.#hands.delete(id);
  }

  /**
   * @param {{id:*, a:{x,y}, b:{x,y}}[]} strings
   * @returns {{ string: object, u: number }[]} crossings in the order the fingertip passed them
   */
  detect(handId, tip, palm, strings) {
    let sides = this.#hands.get(handId);
    if (!sides) { sides = new Map(); this.#hands.set(handId, sides); }
    const band = this.deadband * palm;
    const hits = [];
    for (const string of strings) {
      const d = signedDistance(tip, string.a, string.b);
      if (Math.abs(d) <= band) continue;
      const side = Math.sign(d);
      const state = sides.get(string.id);
      if (!state) { sides.set(string.id, { side, anchor: { ...tip } }); continue; }
      if (state.side !== side) {
        const hit = crossing(state.anchor, tip, string.a, string.b);
        if (hit && hit.u >= -END_MARGIN && hit.u <= 1 + END_MARGIN) {
          const u = Math.max(0, Math.min(1, hit.u));
          const remaining = Math.hypot(tip.x - (string.a.x + (string.b.x - string.a.x) * u),
            tip.y - (string.a.y + (string.b.y - string.a.y) * u));
          hits.push({ string, u, remaining });
        }
        state.side = side;
      }
      state.anchor = { ...tip };
    }
    // The crossing farthest behind the fingertip happened first.
    hits.sort((p, q) => q.remaining - p.remaining);
    return hits.map(({ string, u }) => ({ string, u }));
  }
}
