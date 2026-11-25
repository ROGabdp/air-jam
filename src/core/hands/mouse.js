// Mouse input expressed as hand states, so instruments need no special mouse code path:
// dragging = two pinching hands (drag start and cursor); hovering = one open hand whose index
// fingertip is the cursor. Right-click is reported through onCommand.

const PALM = 90;
const HISTORY_MS = 70;

export function createMouseInput(element, { onCommand }) {
  let enabled = false;
  let cursor = null;
  let dragStart = null;
  let justMoved = true;
  let pressPolled = false;     // a click shorter than a frame must still be seen pressed once
  let releasePending = false;
  const history = [];

  const local = event => {
    const rect = element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  function track(event) {
    cursor = local(event);
    const now = performance.now();
    history.push({ ...cursor, time: now });
    while (history.length > 2 && now - history[0].time > HISTORY_MS) history.shift();
  }

  function speed() {
    if (history.length < 2) return 0;
    let path = 0;
    for (let i = 1; i < history.length; i++) path += Math.hypot(history[i].x - history[i - 1].x, history[i].y - history[i - 1].y);
    const span = (history[history.length - 1].time - history[0].time) / 1000;
    return span > 0.004 ? path / span : 0;
  }

  const handlers = {
    mousedown(event) {
      if (!enabled || event.button !== 0) return;
      track(event);
      dragStart = { ...cursor };
      pressPolled = false;
      releasePending = false;
    },
    mousemove(event) { if (enabled) track(event); },
    mouseup(event) {
      if (!enabled || event.button !== 0) return;
      track(event);
      if (!pressPolled) { releasePending = true; return; }
      dragStart = null;
      justMoved = true;
    },
    mouseleave() { cursor = null; dragStart = null; releasePending = false; history.length = 0; justMoved = true; },
    contextmenu(event) {
      if (!enabled) return;
      event.preventDefault();
      onCommand({ type: 'deleteAt', ...local(event) });
    },
  };
  for (const [type, handler] of Object.entries(handlers)) element.addEventListener(type, handler);

  const hand = (id, extra) => ({
    id, source: 'mouse', palm: PALM, points: null, fist: false, pinching: false,
    tip: { ...cursor }, pinchPoint: { ...cursor }, center: { ...cursor }, tipSpeed: 0, fresh: false, ...extra,
  });

  return {
    setEnabled(value) { enabled = value; cursor = null; dragStart = null; history.length = 0; },
    // Hand states for this frame.
    poll() {
      if (!enabled || !cursor) { justMoved = true; return []; }
      if (dragStart) {
        pressPolled = true;
        const start = dragStart;
        if (releasePending) { dragStart = null; releasePending = false; justMoved = true; }
        return [
          hand('mouse-anchor', { pinching: true, tip: { ...start }, pinchPoint: { ...start }, center: { ...start } }),
          hand('mouse-drag', { pinching: true }),
        ];
      }
      const fresh = justMoved;
      justMoved = false;
      if (history.length && performance.now() - history[history.length - 1].time > HISTORY_MS) history.length = 0;
      return [hand('mouse', { tipSpeed: speed(), fresh })];
    },
    dispose() {
      for (const [type, handler] of Object.entries(handlers)) element.removeEventListener(type, handler);
    },
  };
}
