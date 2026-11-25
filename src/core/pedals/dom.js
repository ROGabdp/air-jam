// The few DOM bits the pedalboard needs, kept here so the shared page files stay untouched:
// its stylesheet, a body class that lifts the bottom HUD above the footswitch zone (only while
// the board is shown), body classes that move the bottom corner text beside the wah strip, and a
// "pedals" button in the ready panel.

export function mountPedalDom({ settings, t, onOpen }) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./pedals.css', import.meta.url).href;
  document.head.append(link);

  const root = document.documentElement;
  const setZone = () => {
    root.style.setProperty('--pedal-zone', `${Math.round(window.innerHeight * settings.pedalZoneHeight)}px`);
    root.style.setProperty('--wah-strip', `${Math.round(window.innerWidth * settings.wahStripWidth)}px`);
  };
  setZone();
  window.addEventListener('resize', setZone);

  const start = document.getElementById('startButton');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary pedal-open';
  button.textContent = t('pedal.open');
  button.addEventListener('click', onOpen);
  start?.after(button);

  return {
    setTuning(open) { document.body.classList.toggle('pedal-tuning', open); },
    setVisible(on) { document.body.classList.toggle('pedals-on', on); },
    // The wah strip's edge ('left' | 'right' | null): the song info / status line moves beside it.
    setStrip(side) {
      document.body.classList.toggle('wah-strip-left', side === 'left');
      document.body.classList.toggle('wah-strip-right', side === 'right');
    },
  };
}
