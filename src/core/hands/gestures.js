// Turns raw 21-point hand landmarks (already in mirrored stage pixels) into stable hand states:
// identity across frames, pinch and fist with hysteresis, smoothed fingertip and pinch point.
// Pure logic, no DOM, so it can be exercised in Node.

const WRIST = 0, THUMB_TIP = 4, INDEX_TIP = 8, MIDDLE_MCP = 9;
const FINGER_TIPS = [8, 12, 16, 20];
const PALM_POINTS = [0, 5, 9, 13, 17];
const LOST_GRACE = 0.25;

const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// All ratios are divided by palm size (wrist to middle-finger knuckle) so distance to the camera cancels out.
export function measureHand(points) {
  const palm = Math.max(1, dist3(points[WRIST], points[MIDDLE_MCP]));
  let curl = 0;
  for (const tip of FINGER_TIPS) curl += dist3(points[tip], points[WRIST]) / palm / FINGER_TIPS.length;
  const center = { x: 0, y: 0 };
  for (const i of PALM_POINTS) { center.x += points[i].x / PALM_POINTS.length; center.y += points[i].y / PALM_POINTS.length; }
  return {
    palm,
    pinch: dist3(points[THUMB_TIP], points[INDEX_TIP]) / palm,
    curl,
    indexCurl: dist3(points[INDEX_TIP], points[WRIST]) / palm,
    center,
    pinchPoint: {
      x: (points[THUMB_TIP].x + points[INDEX_TIP].x) / 2,
      y: (points[THUMB_TIP].y + points[INDEX_TIP].y) / 2,
    },
    tip: { x: points[INDEX_TIP].x, y: points[INDEX_TIP].y },
  };
}

// Light smoothing when still, none when moving fast (keeps strums latency-free).
function follow(smoothed, raw, palm) {
  const alpha = Math.min(1, 0.4 + 3 * dist2(smoothed, raw) / palm);
  smoothed.x += (raw.x - smoothed.x) * alpha;
  smoothed.y += (raw.y - smoothed.y) * alpha;
}

export function createGestureRecognizer(settings) {
  let tracks = [];
  let nextId = 1;

  function newTrack(m, time) {
    return {
      id: `hand-${nextId++}`, source: 'camera', seen: time, lastTime: time,
      palm: m.palm, points: null, center: m.center,
      pinching: false, fist: false,
      pinchPoint: { ...m.pinchPoint }, tip: { ...m.tip }, tipSpeed: 0, fresh: true,
    };
  }

  /**
   * @param {{x:number,y:number,z?:number}[][]} rawHands
   * @param {number} time seconds
   */
  function update(rawHands, time) {
    const measured = rawHands.map(points => ({ points, m: measureHand(points) }));

    // Greedy nearest-centre matching keeps identities stable even when handedness labels flip.
    const pairs = [];
    measured.forEach((hand, h) => tracks.forEach((track, k) => {
      const d = dist2(hand.m.center, track.center);
      if (d < 4 * Math.max(hand.m.palm, track.palm)) pairs.push({ h, k, d });
    }));
    pairs.sort((a, b) => a.d - b.d);
    const handTrack = new Map();
    const usedTracks = new Set();
    for (const { h, k } of pairs) {
      if (handTrack.has(h) || usedTracks.has(k)) continue;
      handTrack.set(h, tracks[k]);
      usedTracks.add(k);
    }

    const visible = [];
    measured.forEach(({ points, m }, h) => {
      let track = handTrack.get(h);
      const isNew = !track;
      if (isNew) { track = newTrack(m, time); tracks.push(track); }
      const dt = Math.max(1e-3, time - track.lastTime);
      const reacquired = !isNew && time - track.seen > 0.12;

      if (track.fist) track.fist = m.curl < settings.fistOff;
      else track.fist = m.curl < settings.fistOn && m.indexCurl < settings.fistOn + 0.15;

      if (track.fist) track.pinching = false;
      else if (track.pinching) track.pinching = m.pinch < settings.pinchOff;
      else track.pinching = m.pinch < settings.pinchOn;

      if (isNew || reacquired) {
        track.tip = { ...m.tip };
        track.pinchPoint = { ...m.pinchPoint };
        track.tipSpeed = 0;
        track.fresh = true;
      } else {
        const before = { ...track.tip };
        follow(track.tip, m.tip, m.palm);
        follow(track.pinchPoint, m.pinchPoint, m.palm);
        track.tipSpeed = 0.5 * track.tipSpeed + 0.5 * dist2(before, track.tip) / dt;
        track.fresh = false;
      }
      track.palm = m.palm;
      track.center = m.center;
      track.points = points;
      track.seen = time;
      track.lastTime = time;
      visible.push(track);
    });

    tracks = tracks.filter(track => time - track.seen <= LOST_GRACE);
    return visible;
  }

  return { update, reset() { tracks = []; } };
}
