// Renderer for src/lab/metrics.js and the lab's level matching: the real engine and audio graph in
// an OfflineAudioContext (browser only). Same spec as tools/tone-lab/model.mjs.
import { createAudioEngine } from '../core/audio/engine.js';

/**
 * @param settings  SETTINGS (copied; the live settings are not touched)
 * @param {number} sampleRate
 */
export function offlineRenderer(settings, sampleRate) {
  return async ({ tone, events = [], chokes = [], duration, song = null, master = false, strings = true, trim = 1, limiterStep = 0.01, yieldWhile = null }) => {
    const length = Math.max(1, Math.ceil(duration * sampleRate));
    const ctx = new OfflineAudioContext(2, length, sampleRate);
    const local = { ...settings, stringVolume: strings ? settings.stringVolume : 0, songVolume: song ? settings.songVolume : 0 };
    const engine = createAudioEngine(local, { context: ctx, master });
    engine.setTone(tone, 'm');
    engine.setTrim(trim, 'm', { smooth: false });
    const items = [
      ...chokes.map(c => ({ ...c, type: 'choke' })),
      ...(strings ? events : []).map(e => ({ ...e, type: 'pluck' })),
    ].sort((a, b) => a.time - b.time || (a.type === 'choke' ? -1 : 1));
    let count = 0;
    for (const item of items) {
      // Rendering the Karplus buffers runs on the main thread; yield now and then so a live loop
      // (the lab keeps playing while it level-matches) can schedule its notes.
      if (yieldWhile?.() && ++count % 6 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      if (item.type === 'pluck') engine.pluck({ ...item, delay: item.time, part: 'm' });
      else if (item.all) engine.releasePart('m', item.fade, item.time);
      else engine.chokeChord(item.keep, { part: 'm', when: item.time });
    }
    if (song) {
      const buffer = ctx.createBuffer(2, Math.min(length, song.left.length), sampleRate);
      buffer.getChannelData(0).set(song.left.subarray(0, buffer.length));
      buffer.getChannelData(1).set(song.right.subarray(0, buffer.length));
      engine.playSong(buffer, null, 0);
    }
    let limiterDb = 0;
    if (master && limiterStep) {
      // Chrome's DynamicsCompressorNode.reduction starts at about −16 dB in a fresh context and
      // decays over ~2 s even in silence (measured: −4 dB at 0.5 s with no input), so the first
      // second of readings is skipped.
      for (let t = 1; t < duration; t += limiterStep) {
        ctx.suspend(Math.round(t * sampleRate / 128) * 128 / sampleRate).then(() => {
          limiterDb = Math.min(limiterDb, engine.limiterReduction);
          ctx.resume();
        }).catch(() => { /* two suspends rounded to the same render quantum */ });
      }
    }
    const rendered = await ctx.startRendering();
    return { sampleRate, left: rendered.getChannelData(0), right: rendered.getChannelData(1), limiterDb };
  };
}
