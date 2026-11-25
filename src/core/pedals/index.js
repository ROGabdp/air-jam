// Entry point for the game shell: one call wires the pedalboard into the page.
//   model.js          pedal types, knobs, presets, modes, chain order, storage (pure)
//   gestures.js       pinch-tap / hold / drag, knob latch, lockout, region gates (pure)
//   layout.js         geometry shared by hit testing and drawing (pure)
//   pedalboard.js     controller: routes hands, applies gestures to the model
//   draw.js           2D canvas drawing (replaceable by another view)
//   audio-binding.js  the DSP seam (no effects connected yet) and the audition stub
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
  bindPedalAudio(board.model, getAudio);
  hud.setHelpExtra([t('help.pedals')]);
  return board;
}
