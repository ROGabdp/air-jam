// Entry point for the game shell: one call wires the pedalboard into the page.
//   model.js          pedal types, knobs, presets, modes, chain order, storage (pure)
//   gestures.js       pinch-tap / hold / drag, knob latch, lockout, region gates (pure)
//   layout.js         geometry shared by hit testing and drawing (pure)
//   pedalboard.js     controller: routes hands, applies gestures to the model
//   draw.js           2D canvas drawing (replaceable by another view)
//   audio-binding.js  the DSP seam (engine.applyPedals) and the audition stub
//   availability.js   which pedals can be used yet (the others are dimmed, "coming soon")
//   wheel.js          mouse wheel → wah position in mouse mode (pure)
//   dom.js, pedals.css  ready-panel button, HUD offsets
import { createPedalboard } from './pedalboard.js';
import { bindPedalAudio } from './audio-binding.js';
import { mountPedalDom } from './dom.js';

const safeStorage = () => { try { return window.localStorage; } catch { return null; } };

export function attachPedalboard({ settings, t, stage, element, hud, getAudio, mouseMode }) {
  const board = createPedalboard({
    settings, t, stage, element, mouseMode, storage: safeStorage(),
    toast: text => hud.toast(text, 1.5),
  });
  const dom = mountPedalDom({ settings, t, onOpen: () => board.openTuning() });
  board.onTuningChange(open => dom.setTuning(open));
  board.onStripChange(side => dom.setStrip(side));
  bindPedalAudio(board.model, getAudio);
  // Shown by default; the player can hide it (settings.pedals). Hidden, the shell routes it nothing.
  board.setShown = on => {
    dom.setVisible(on);
    hud.setHelpExtra(on ? [t('help.pedalsShort')] : []);
  };
  board.setShown(settings.pedals);
  return board;
}
