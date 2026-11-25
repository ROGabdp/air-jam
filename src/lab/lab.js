// Tone lab (?lab=1): loops a section of a song with a reproducible strum performance and switches
// between the candidate electric tones 甲乙丙丁 without restarting the loop (docs/效果器_設計挑戰.md
// 4.1, stage 0). Each combo is its own engine part with its own chain, built once; switching only
// changes which part the next notes go to (the old part's notes fade in 30 ms), so nothing is
// rebuilt while the song plays. Combos are level-matched against the song with offline renders of
// the real audio graph. DSP lives in core/audio; this file is UI and scheduling only.
import { SETTINGS } from '../settings.js';
import { t } from '../i18n/index.js';
import { createAudioEngine, mixToMono } from '../core/audio/engine.js';
import { LAB_COMBOS, LAB_ORDER, boosterStages } from '../core/audio/tone-lab.js';
import { analyzeAsync } from '../core/analysis/analysis.js';
import { renderDemoSong } from '../core/song/demo-song.js';
import { powerChordAnalysis } from '../core/music/power-chords.js';
import { createSongMap } from '../core/game/song-map.js';
import { chordName } from '../core/music/theory.js';
import { PERFORMANCES, buildPerformance, loopSection, barAtOrAfter } from './performances.js';
import { offlineRenderer } from './offline-render.js';
import { measureTone, rms, TARGETS } from './metrics.js';

const LOOKAHEAD = 0.15;      // seconds of notes scheduled ahead
const TICK_MS = 25;
const LEVEL_STEPS = [-3, 0, 3];
const db = x => 20 * Math.log10(Math.max(1e-12, x));
const formatTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function createLab() {
  const settings = SETTINGS;
  const query = new URLSearchParams(location.search);
  for (const id of ['intro', 'hud', 'songInfo', 'help', 'ready', 'analyzing', 'ending']) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  document.title = t('lab.title');

  const SETTINGS_DEFAULTS = { songVolume: settings.songVolume, stringVolume: settings.stringVolume };
  // Offline renders (level matching, measurements) use the normal volumes, whatever is muted live.
  const unmuted = () => ({ ...settings, ...SETTINGS_DEFAULTS });
  const audio = createAudioEngine(settings);
  for (const id of LAB_ORDER) audio.setTone(LAB_COMBOS[id], id);

  const state = {
    combo: LAB_ORDER.includes(query.get('combo')) ? query.get('combo') : 'labA',
    performance: 'script',
    bars: 8,
    bar: 0,
    level: 1,                 // index in LEVEL_STEPS
    songMuted: false,
    guitarMuted: false,
    playing: false,
    song: null,               // { title, buffer, analysis, map }
    section: null,
    perf: null,               // { events, chokes, length }
    trims: Object.fromEntries(LAB_ORDER.map(id => [id, 1])),
    matched: false,
    calibration: 0,           // token
    loading: 0,
  };
  let loopStart = 0;          // AudioContext time of the first loop pass
  let cursor = 0;             // AudioContext time scheduled up to
  let timer = 0;

  // ---------- DOM ----------
  const root = document.createElement('section');
  root.id = 'lab';
  root.className = 'lab';
  root.innerHTML = `
    <button data-act="back" class="mini secondary lab-back">${t('lab.back')}</button>
    <h1>${t('lab.title')}<small>${t('lab.subtitle')}</small></h1>
    <div class="lab-row">
      <button data-act="demo" class="secondary">${t('lab.demo')}</button>
      <button data-act="pick" class="secondary">${t('lab.pick')}</button>
      <input type="file" accept="audio/*" hidden>
      <span class="lab-song"></span>
    </div>
    <div class="lab-row lab-section">
      <button data-act="prev" class="mini secondary" aria-keyshortcuts="ArrowLeft">◀</button>
      <span class="lab-where"></span>
      <button data-act="next" class="mini secondary" aria-keyshortcuts="ArrowRight">▶</button>
      <button data-act="bars" class="mini secondary" aria-keyshortcuts="L"></button>
      <span class="lab-chords"></span>
    </div>
    <div class="lab-row">
      <button data-act="play" class="lab-play" aria-keyshortcuts="Space"></button>
      <button data-act="songMute" class="mini secondary" aria-keyshortcuts="S">${t('lab.songMute')}</button>
      <button data-act="guitarMute" class="mini secondary" aria-keyshortcuts="G">${t('lab.guitarMute')}</button>
      <span class="lab-label">${t('lab.level')}</span>
      ${LEVEL_STEPS.map((v, i) => `<button data-act="level" data-index="${i}" class="mini secondary">${v > 0 ? '+' : ''}${v} dB</button>`).join('')}
    </div>
    <div class="lab-progress"><div></div><span class="lab-now"></span></div>
    <div class="lab-combos">
      ${LAB_ORDER.map((id, i) => `<button data-act="combo" data-combo="${id}" aria-keyshortcuts="${i + 1}"><b>${LAB_COMBOS[id].letter}</b><span>${t(`lab.combo.${id}.name`)}</span><kbd>${i + 1}</kbd></button>`).join('')}
    </div>
    <p class="lab-desc"></p>
    <div class="lab-row">
      <span class="lab-label">${t('lab.performance')}</span>
      ${PERFORMANCES.map(id => `<button data-act="perf" data-perf="${id}" class="mini secondary" aria-keyshortcuts="P">${t(`lab.perf.${id}`)}</button>`).join('')}
    </div>
    <p class="lab-perf-desc hint"></p>
    <div class="lab-row">
      <button data-act="copy" class="mini secondary">${t('lab.copy')}</button>
      <a class="lab-self" target="_blank" rel="noopener">${t('lab.playSelf')}</a>
      <button data-act="measure" class="mini secondary">${t('lab.measure')}</button>
      <span class="lab-status"></span>
    </div>
    <p class="hint">${t('lab.keys')}</p>
    <p class="hint">${t('lab.note')}</p>`;
  document.body.appendChild(root);
  const $ = selector => root.querySelector(selector);
  const fileInput = $('input[type=file]');

  function render() {
    const combo = LAB_COMBOS[state.combo];
    for (const button of root.querySelectorAll('[data-combo]')) button.classList.toggle('on', button.dataset.combo === state.combo);
    for (const button of root.querySelectorAll('[data-perf]')) button.classList.toggle('on', button.dataset.perf === state.performance);
    for (const button of root.querySelectorAll('[data-act=level]')) button.classList.toggle('on', Number(button.dataset.index) === state.level);
    $('[data-act=songMute]').classList.toggle('on', state.songMuted);
    $('[data-act=guitarMute]').classList.toggle('on', state.guitarMuted);
    $('.lab-desc').innerHTML = `<b>${combo.letter}</b>　${t(`lab.combo.${state.combo}.desc`)}`;
    $('.lab-perf-desc').textContent = t(`lab.perf.${state.performance}.desc`);
    $('.lab-play').textContent = state.playing ? t('lab.stop') : t('lab.play');
    $('.lab-play').disabled = !state.perf;
    $('[data-act=bars]').textContent = t('lab.bars', { n: state.bars });
    $('.lab-self').href = `?tone=${state.combo}&mouse=1`;
    const song = state.song;
    $('.lab-song').textContent = song ? `${song.title}　·　${Math.round(song.analysis.bpm)} BPM` : t('lab.noSong');
    if (state.section) {
      const s = state.section;
      $('.lab-where').textContent = t('lab.where', { from: s.bar + 1, to: s.bar + s.bars, start: formatTime(s.start), end: formatTime(s.end) });
      const names = [];
      for (const segment of song.map.analysis.segments) {
        if (segment.end > s.start + 0.01 && segment.start < s.end - 0.01 && names.at(-1) !== segment.name) names.push(segment.name);
      }
      $('.lab-chords').textContent = names.join(' ');
    } else {
      $('.lab-where').textContent = '';
      $('.lab-chords').textContent = '';
    }
  }

  function setStatus(text) { $('.lab-status').textContent = text; }

  // ---------- audio levels ----------
  function applyLevels() {
    settings.songVolume = state.songMuted ? 0 : SETTINGS_DEFAULTS.songVolume;
    settings.stringVolume = state.guitarMuted ? 0 : SETTINGS_DEFAULTS.stringVolume;
    audio.applyVolumes();
    const offset = Math.pow(10, LEVEL_STEPS[state.level] / 20);
    for (const id of LAB_ORDER) audio.setTrim(id === state.combo ? state.trims[id] * offset : 0, id);
  }

  // ---------- scheduling ----------
  function schedule() {
    if (!state.playing || !state.perf) return;
    const now = audio.now();
    const until = now + LOOKAHEAD;
    const { events, chokes, length } = state.perf;
    // Walk loop passes overlapping [cursor, until): chokes first at equal times, then plucks.
    for (let pass = Math.max(0, Math.floor((cursor - loopStart) / length)); loopStart + pass * length < until; pass++) {
      const base = loopStart + pass * length;
      for (const choke of chokes) {
        const when = base + choke.time;
        if (when >= cursor && when < until) audio.chokeChord(choke.keep, { part: state.combo, when });
      }
      for (const event of events) {
        const when = base + event.time;
        if (when < cursor || when >= until) continue;
        audio.pluck({ ...event, delay: Math.max(0, when - now), part: state.combo });
      }
    }
    cursor = until;
  }

  function play() {
    if (!state.perf || state.playing) return;
    audio.resume();
    const { start, end } = state.section;
    audio.playSong(state.song.buffer, null, 0.12, { loop: { start, end } });
    loopStart = audio.now() + 0.12;
    cursor = loopStart;
    state.playing = true;
    applyLevels();
    clearInterval(timer);
    timer = setInterval(schedule, TICK_MS);
    schedule();
    render();
  }

  function stop() {
    if (!state.playing) return;
    state.playing = false;
    clearInterval(timer);
    audio.stopSong();
    for (const id of LAB_ORDER) audio.releasePart(id, 0.05);
    render();
  }

  function restartIfPlaying() {
    if (!state.playing) return;
    stop();
    play();
  }

  function setCombo(id) {
    if (!LAB_COMBOS[id] || id === state.combo) { render(); return; }
    const previous = state.combo;
    state.combo = id;
    if (state.playing) {
      // The old part's notes fade (notes scheduled ahead are dropped); re-schedule the lookahead
      // window on the new part so no note goes missing.
      const now = audio.now();
      audio.releasePart(previous, 0.03, now);
      cursor = now + 0.005;
      schedule();
    }
    applyLevels();
    render();
  }

  // ---------- song and section ----------
  async function loadSong(source) {
    const token = ++state.loading;
    stop();
    audio.resume();
    setStatus(t('lab.loading'));
    let buffer, mono, title;
    try {
      if (source.type === 'demo') {
        const demo = renderDemoSong(44100);
        mono = demo.samples;
        buffer = audio.bufferFromMono(mono, demo.sampleRate);
        title = t('hud.demoTitle');
      } else {
        const data = source.type === 'url' ? await (await fetch(source.url)).arrayBuffer() : await source.file.arrayBuffer();
        buffer = await audio.decode(data);
        mono = mixToMono(buffer);
        title = source.type === 'url' ? decodeURIComponent(source.url.split('/').pop()).replace(/\.[^.]+$/, '') : source.file.name.replace(/\.[^.]+$/, '');
      }
    } catch (error) {
      console.warn('[Air Jam lab] could not load the song:', error);
      if (token === state.loading) setStatus(t('error.decode'));
      return;
    }
    let analysis;
    try {
      analysis = await analyzeAsync(mono, buffer.sampleRate, fraction => {
        if (token === state.loading) setStatus(t('lab.analyzing', { percent: Math.round(fraction * 100) }));
      });
    } catch (error) {
      console.warn('[Air Jam lab] analysis failed:', error);
    }
    if (token !== state.loading) return;
    if (!analysis) { setStatus(t('error.analysis')); return; }
    const power = powerChordAnalysis(analysis, { guard: settings.keyGuard });
    state.song = { title, buffer, analysis: power, map: createSongMap(power) };
    state.bar = barAtOrAfter(power, buffer.duration > 30 ? 10 : 2);
    console.info(`[Air Jam lab] ${title}: ${power.bpm.toFixed(1)} BPM, power chords:`, power.segments.map(s => s.name).join(' '));
    setStatus('');
    prepare();
  }

  function prepare() {
    const song = state.song;
    if (!song) return;
    state.section = loopSection(song.analysis, state.bar, state.bars);
    if (!state.section) { setStatus(t('error.analysis')); return; }
    state.bar = state.section.bar;
    state.perf = buildPerformance(state.performance, song.analysis, time => song.map.chordAt(time), state.section, settings);
    restartIfPlaying();
    render();
    calibrate();
  }

  // ---------- level matching ----------
  // Renders the loop's performance for every combo through the real graph (offline), then sets
  // each combo's trim so its RMS equals the song section's (two passes, as the glue compressor is
  // level-dependent). Plays unmatched until it finishes.
  async function calibrate() {
    const token = ++state.calibration;
    state.matched = false;
    setStatus(t('lab.matching'));
    const { section, perf, song } = state;
    const renderOffline = offlineRenderer(unmuted(), audio.ctx.sampleRate);
    const songSection = sectionOf(song.buffer, section.start, section.end, audio.ctx.sampleRate);
    const start = performance.now();
    try {
      const yieldWhile = () => state.playing;
      const songOut = await renderOffline({ tone: LAB_COMBOS.labA, duration: perf.length, song: songSection, master: true, strings: false, limiterStep: 0 });
      const target = rms(songOut);
      const trims = { ...state.trims };
      for (const id of LAB_ORDER) trims[id] = 1;
      for (let pass = 0; pass < 2; pass++) {
        for (const id of LAB_ORDER) {
          if (token !== state.calibration) return;
          const out = await renderOffline({
            tone: LAB_COMBOS[id], events: perf.events, chokes: perf.chokes, duration: perf.length, master: true, trim: trims[id], limiterStep: 0, yieldWhile,
          });
          trims[id] *= target / Math.max(1e-9, rms(out));
        }
      }
      if (token !== state.calibration) return;
      state.trims = trims;
      state.matched = true;
      applyLevels();
      const summary = LAB_ORDER.map(id => `${LAB_COMBOS[id].letter} ${db(trims[id]) >= 0 ? '+' : ''}${db(trims[id]).toFixed(1)}`).join('　');
      setStatus(t('lab.matched', { summary }));
      console.info(`[Air Jam lab] level match (trim dB) ${summary}; ${((performance.now() - start) / 1000).toFixed(1)} s`);
    } catch (error) {
      console.warn('[Air Jam lab] level matching failed:', error);
      if (token === state.calibration) setStatus(t('lab.matchFailed'));
    }
  }

  function sectionOf(buffer, from, to, sampleRate) {
    // Song section as stereo arrays at the context rate (decodeAudioData already resampled to it;
    // the demo is rendered at 44.1 kHz and resampled by nearest sample if the context differs).
    const ratio = buffer.sampleRate / sampleRate;
    const length = Math.round((to - from) * sampleRate);
    const channel = c => buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
    const take = data => {
      const out = new Float32Array(length);
      const offset = Math.round(from * buffer.sampleRate);
      for (let i = 0; i < length; i++) out[i] = data[Math.min(data.length - 1, offset + Math.round(i * ratio))] ?? 0;
      return out;
    };
    return { left: take(channel(0)), right: take(channel(1)), sampleRate };
  }

  // ---------- measurement on the real graph ----------
  async function measure({ repeats = 2 } = {}) {
    if (!state.song) { setStatus(t('lab.measureNeedsSong')); return null; }
    setStatus(t('lab.measuring'));
    const sampleRate = audio.ctx.sampleRate;
    const { section } = state;
    const mixSeconds = Math.min(16, section.end - section.start);
    const song = sectionOf(state.song.buffer, section.start, section.start + mixSeconds, sampleRate);
    const results = {};
    const start = performance.now();
    for (const id of LAB_ORDER) {
      const tone = LAB_COMBOS[id];
      results[id] = await measureTone({
        render: offlineRenderer(unmuted(), sampleRate), tone, settings: unmuted(), song, repeats, mixSeconds,
        bpm: state.song.analysis.bpm, booster: tone.stages?.[0]?.type === 'lowshelf' ? boosterStages() : null,
      });
    }
    const f = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '–' : v.toFixed(d));
    const rows = {
      'level drop 0.03→0.5 s (dB)': [`≤ ${TARGETS.levelDrop}`, r => f(r.levelDrop)],
      'velocity 0.1 vs 1.0 at 0.25 s (dB)': [`≤ ${TARGETS.velocitySpread}`, r => f(r.velocitySpread)],
      '2nd harmonic, worst crossing (dB)': [`≥ ${TARGETS.secondHarmonic}`, r => f(r.secondHarmonicWorst)],
      'chord choke at 80 ms (dB)': [`≥ ${TARGETS.chokeDepth}`, r => f(r.chokeDepth)],
      'strum choke (dB)': ['', r => f(r.strumChokeDepth)],
      'sustain −10 / −20 dB (s)': ['', r => `${f(r.sustain, 2)} / ${f(r.sustain20, 2)}`],
      '60–300 Hz share (%)': [`≥ ${TARGETS.lowShare}`, r => f(r.lowShare)],
      'booster notch (dB)': [`≤ ${TARGETS.boosterNotch}`, r => f(r.boosterNotch)],
      'guitar vs song RMS (dB)': ['', r => f(r.guitarVsSong)],
      'mix peak': [`≤ ${TARGETS.peak}`, r => f(r.peak, 3)],
      'limiter reduction (dB)': [`≤ ${TARGETS.limiter}`, r => f(-r.limiterDb)],
      'level-matched: mix peak': [`≤ ${TARGETS.peak}`, r => f(r.matched?.peak, 3)],
      'level-matched: limiter (dB)': [`≤ ${TARGETS.limiter}`, r => f(-r.matched?.limiterDb)],
    };
    const table = Object.entries(rows).map(([metric, [target, value]]) => ({
      metric, target, ...Object.fromEntries(LAB_ORDER.map(id => [`${LAB_COMBOS[id].letter} ${id}`, value(results[id])])),
    }));
    console.info(`[Air Jam lab] measurements on the real audio graph (OfflineAudioContext ${sampleRate} Hz, ${repeats} repeats, `
      + `mix: ${state.song.title} ${formatTime(section.start)}–${formatTime(section.start + mixSeconds)}), ${((performance.now() - start) / 1000).toFixed(1)} s`);
    console.table(table);
    setStatus(t('lab.measured'));
    return { results, table };
  }

  function copySettings() {
    const s = state.section;
    const line = [
      `Air Jam 音色實驗室：${LAB_COMBOS[state.combo].letter}（${state.combo}）`,
      `刷法 ${t(`lab.perf.${state.performance}`)}`,
      state.song ? `${state.song.title} 第 ${s.bar + 1}–${s.bar + s.bars} 小節` : '',
      `吉他 ${LEVEL_STEPS[state.level] > 0 ? '+' : ''}${LEVEL_STEPS[state.level]} dB`,
    ].filter(Boolean).join('，');
    navigator.clipboard?.writeText(line).then(() => setStatus(t('lab.copied')), () => setStatus(line));
    return line;
  }

  // ---------- controls ----------
  const actions = {
    back: () => { stop(); location.href = location.pathname; },
    demo: () => loadSong({ type: 'demo' }),
    pick: () => { audio.resume(); fileInput.click(); },
    prev: () => { if (state.song) { state.bar = Math.max(0, state.bar - 1); prepare(); } },
    next: () => { if (state.song) { state.bar += 1; prepare(); } },
    bars: () => { state.bars = state.bars === 8 ? 4 : 8; prepare(); },
    play: () => (state.playing ? stop() : play()),
    songMute: () => { state.songMuted = !state.songMuted; applyLevels(); render(); },
    guitarMute: () => { state.guitarMuted = !state.guitarMuted; applyLevels(); render(); },
    level: button => { state.level = Number(button.dataset.index); applyLevels(); render(); },
    combo: button => setCombo(button.dataset.combo),
    perf: button => { state.performance = button.dataset.perf; prepare(); },
    copy: copySettings,
    measure: () => measure(),
  };
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    audio.resume();
    actions[button.dataset.act]?.(button);
    button.blur();
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (file) loadSong({ type: 'file', file });
  });
  window.addEventListener('keydown', event => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    audio.resume();
    if (['1', '2', '3', '4'].includes(key)) setCombo(LAB_ORDER[Number(key) - 1]);
    else if (key === ' ') { event.preventDefault(); actions.play(); }
    else if (key === 'p') { state.performance = PERFORMANCES[(PERFORMANCES.indexOf(state.performance) + 1) % PERFORMANCES.length]; prepare(); render(); }
    else if (key === 's') actions.songMute();
    else if (key === 'g') actions.guitarMute();
    else if (key === 'arrowleft') actions.prev();
    else if (key === 'arrowright') actions.next();
    else if (key === 'l') actions.bars();
    else if (key === '-') { state.level = Math.max(0, state.level - 1); applyLevels(); render(); }
    else if (key === '=' || key === '+') { state.level = Math.min(LEVEL_STEPS.length - 1, state.level + 1); applyLevels(); render(); }
  });

  // Loop position and the chord being heard.
  function frame() {
    requestAnimationFrame(frame);
    if (!state.playing || !state.perf) return;
    const elapsed = audio.now() - loopStart - audio.outputLatency();
    const length = state.perf.length;
    const position = ((elapsed % length) + length) % length;
    $('.lab-progress div').style.width = `${(100 * position / length).toFixed(2)}%`;
    const chord = state.song.map.chordAt(state.section.start + position);
    $('.lab-now').textContent = chord ? chordName(chord) : '';
  }
  requestAnimationFrame(frame);

  render();
  // Optional: ?song=<relative path> loads a song served next to the game (e.g. a local sample).
  const songUrl = query.get('song');
  if (songUrl && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(songUrl)) loadSong({ type: 'url', url: songUrl });
  else if (query.get('song') === null) setStatus(t('lab.start'));

  return {
    settings, audio, combos: LAB_COMBOS,
    get state() { return state; },
    setCombo, play, stop, measure, copySettings,
    loadDemo: () => loadSong({ type: 'demo' }),
  };
}
