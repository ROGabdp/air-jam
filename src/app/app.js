// Game shell: screens, song loading and analysis, the frame loop, and the wiring between shared
// services (audio, pitch snapping, scoring, effects, hand input) and the active instrument.
import { SETTINGS, SNAP_MODES } from '../settings.js';
import { t, applyTranslations } from '../i18n/index.js';
import { createAudioEngine, mixToMono } from '../core/audio/engine.js';
import { TONES as GAME_TONES, TONE_ORDER } from '../core/audio/tones.js';
import { LAB_COMBOS } from '../core/audio/tone-lab.js';
import { toneVoicing } from '../core/audio/electric-rig.js';
import { analyzeAsync, retime } from '../core/analysis/analysis.js';
import { renderDemoSong, compareWithTruth } from '../core/song/demo-song.js';
import { createSongMap } from '../core/game/song-map.js';
import { createScorer } from '../core/game/scoring.js';
import { createPitchSnapper } from '../core/music/pitch-snap.js';
import { chordColor, chordName, chordPitchClasses, sameChord } from '../core/music/theory.js';
import { powerChordAnalysis } from '../core/music/power-chords.js';
import { createEffects } from '../core/fx/effects.js';
import { createGestureRecognizer } from '../core/hands/gestures.js';
import { createMouseInput } from '../core/hands/mouse.js';
import { drawHands } from '../core/hands/draw.js';
import { loadHandLandmarker, startCamera, stopCamera, createHandTracker, createCoverMapper } from '../core/hands/tracker.js';
import { INSTRUMENTS, DEFAULT_INSTRUMENT } from '../instruments/instrument.js';
import { createHud, keyName } from './hud.js';
import { attachPedalboard } from '../core/pedals/index.js';
import { createPrefs, prefSpec } from './prefs.js';
import { createMenu } from './menu.js';

const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
// The tone lab's combos can be played in the game with ?tone=labA..labD (testing only; T skips them).
const TONES = { ...GAME_TONES, ...LAB_COMBOS };
const safeStorage = () => { try { return window.localStorage; } catch { return null; } };

export function createApp() {
  const settings = SETTINGS;
  // Choices made with the on-page buttons are remembered; developer URL flags (?mouse=1, ?tone=,
  // ?keyguard=off, ?pedals=0|1) override them for this visit only (prefs.js).
  const prefs = createPrefs({
    storage: safeStorage(),
    query: new URLSearchParams(location.search),
    allTones: Object.keys(TONES),
    spec: prefSpec({ tones: TONE_ORDER, snapModes: SNAP_MODES }),
    defaults: {
      tone: settings.tone, snapMode: settings.snapMode, metronome: settings.metronome, showHand: settings.showHand,
      keyGuard: settings.keyGuard, pedals: settings.pedals, handedness: settings.handedness, mouse: false,
    },
  });
  const { mouse: startInMouseMode, ...remembered } = prefs.values;
  Object.assign(settings, remembered);

  applyTranslations();
  const hud = createHud();
  const stageElement = document.getElementById('stage');
  const video = document.getElementById('camera');
  const canvas = document.getElementById('canvas');
  const g = canvas.getContext('2d');
  const stage = { width: 1, height: 1 };

  const fx = createEffects();
  const pitch = createPitchSnapper(settings);
  const scorer = createScorer(settings);
  const gestures = createGestureRecognizer(settings);
  const toStage = createCoverMapper(video, stage);

  let state = 'intro';
  let audio = null;
  let song = null;               // { title, buffer, analysis, map }
  let chord = null;
  let lastBeat = -1;
  let clickedBeat = -1;
  let mouseMode = startInMouseMode;
  let menu = null;               // on-page controls, created once the game's state exists
  let camera = { status: 'off', tracker: null, token: 0 };   // off | starting | ready | failed
  let cameraHands = [];
  let cameraHandsAt = 0;
  let hands = [];
  let lastFrame = performance.now();
  let loadToken = 0;

  const clock = () => (audio ? audio.now() : performance.now() / 1000);
  // Song position the player is hearing right now.
  const heardTime = () => audio.songTime() - audio.outputLatency();
  const inputLatency = () => (mouseMode ? settings.mouseLatency : settings.cameraLatency) / 1000;

  function judge(point) {
    if (state !== 'playing' || !song?.map) return { grade: null, points: 0, combo: scorer.state.combo };
    const result = scorer.hit(heardTime() - inputLatency(), song.map);
    if (result.grade === 'perfect') fx.popText(point.x, point.y - 30, t('judge.perfect'), { color: '#ffd76a', size: 36, weight: 800 });
    else if (result.grade === 'good') fx.popText(point.x, point.y - 30, t('judge.good'), { color: '#9fe8ff', size: 26 });
    if (result.chordChange) fx.popText(point.x, point.y - 72, t('judge.chordChange'), { color: '#b7ffb0', size: 20, ttl: 1.2 });
    if (result.strum) fx.popText(point.x, point.y - 72, t('judge.strum'), { color: '#ffb3f0', size: 22, ttl: 1.1 });
    return result;
  }

  const instrument = INSTRUMENTS[DEFAULT_INSTRUMENT]();
  instrument.init({
    settings, t, stage, pitch, fx, judge,
    combo: () => scorer.state.combo,
    audio: {
      pluck: options => audio?.pluck(options),
      ringTime: freq => (audio ? audio.ringTime(freq) : 0.6),
    },
  });

  const mouse = createMouseInput(stageElement, {
    onCommand: command => { if ((state === 'ready' || state === 'playing') && !pedals?.blocks(command)) instrument.onCommand?.(command); },
  });
  // Pedalboard: shown unless the player hid it (settings.pedals). It sees the hands before the
  // instrument and withholds the ones it is using; hidden, it is routed as if off stage.
  const pedals = attachPedalboard({ settings, t, stage, element: stageElement, hud, getAudio: () => audio, mouseMode: () => mouseMode });
  const pedalScreen = () => (settings.pedals ? state : 'hidden');

  // ---------- layout ----------
  function resize() {
    const rect = stageElement.getBoundingClientRect();
    const previous = { ...stage };
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    stage.width = Math.max(1, rect.width);
    stage.height = Math.max(1, rect.height);
    canvas.width = Math.round(stage.width * dpr);
    canvas.height = Math.round(stage.height * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (previous.width > 1) instrument.onResize?.(stage.width, stage.height, previous);
  }

  // ---------- input mode ----------
  function refreshMode() {
    stageElement.classList.toggle('mouse', mouseMode);
    mouse.setEnabled(mouseMode);
    hud.setModeHint(mouseMode);
    hud.setHelp(mouseMode);
    refreshInfo();
    menu?.refresh();
  }

  function fallBackToMouse(messageKey) {
    camera.status = 'failed';
    stopCamera(video);
    mouseMode = true;
    refreshMode();
    hud.toast(t(messageKey), 5);
  }

  async function ensureCamera() {
    if (camera.status === 'starting' || camera.status === 'ready') return;
    const token = ++camera.token;
    // The player may switch to mouse mode while the camera or the model is still loading.
    const stale = () => token !== camera.token || mouseMode;
    camera.status = 'starting';
    try {
      const stream = await startCamera(video);
      if (stale()) {
        for (const track of stream.getTracks()) track.stop();
        if (video.srcObject === stream) video.srcObject = null;
        return;
      }
    } catch (error) {
      if (stale()) return;
      console.warn('[Air Jam] camera unavailable:', error);
      fallBackToMouse('error.camera');
      return;
    }
    try {
      camera.tracker ??= createHandTracker(await loadHandLandmarker(2), video);
      if (!stale()) camera.status = 'ready';
    } catch (error) {
      if (stale()) return;
      console.warn('[Air Jam] hand tracker failed to load:', error);
      fallBackToMouse('error.tracker');
    }
  }

  function setMouseMode(next) {
    if (mouseMode === next) return;
    mouseMode = next;
    gestures.reset();
    cameraHands = [];
    refreshMode();
    if (mouseMode) {
      camera.token++;
      stopCamera(video);
      if (camera.status !== 'failed') camera.status = 'off';
    } else if (audio) {
      ensureCamera();
    }
  }

  function readHands(time) {
    if (mouseMode) return mouse.poll();
    if (camera.status !== 'ready') return [];
    const landmarks = camera.tracker.detect();
    if (landmarks) {
      cameraHands = gestures.update(landmarks.map(points => points.map(toStage)), time);
      cameraHandsAt = time;
    } else if (time - cameraHandsAt > 0.3) {
      cameraHands = [];
    }
    return cameraHands;
  }

  // ---------- HUD text ----------
  function snapLabel() {
    switch (pitch.effectiveMode()) {
      case 'chord': return t('hud.snap.chord');
      case 'scale': return t('hud.snap.scale', { key: keyName(pitch.key) });
      case 'free': return t('hud.snap.free');
      default: return t('hud.snap.fallback');
    }
  }

  function refreshInfo() {
    if (!song) return;
    const parts = [song.title];
    if (song.analysis) {
      const manual = song.analysis.manual.factor !== 1 || song.analysis.manual.shift !== 0;
      parts.push(t(manual ? 'hud.bpmManual' : 'hud.bpm', { bpm: Math.round(song.analysis.bpm) }));
    }
    parts.push(snapLabel(), t(`hud.tone.${settings.tone}`));
    hud.setSongInfo(parts.join('　·　'));
    menu?.refresh();
  }

  function statusText() {
    if (mouseMode) return t('status.mouse');
    if (camera.status === 'starting') return t(video.srcObject ? 'status.loadingTracker' : 'status.cameraStarting');
    if (camera.status === 'ready' && hands.length === 0) return t('status.noHands');
    return '';
  }

  function setChord(next) {
    if (sameChord(next, chord) || (!next && !chord)) return;
    chord = next;
    // Distorted tones: voices of the old chord fade out (~80 ms) instead of clashing with the new one.
    if (chord && audio) audio.chokeChord(chordPitchClasses(chord, pitch.voicing));
    pitch.setChord(chord);
    hud.setChord(chord);
    instrument.onChordChange(chord);
  }

  // Song map for the current tone: power-chord tones get power chords (root of the triad tracker,
  // key-guarded when settings.keyGuard), the others the triads as analysed.
  function mapFor(analysis) {
    if (!analysis) return null;
    if (voicingNow() !== 'power') return createSongMap(analysis);
    const power = powerChordAnalysis(analysis, { guard: settings.keyGuard });
    console.info(`[Air Jam] power chords (key guard ${settings.keyGuard ? 'on' : 'off'}, ${power.guard.replacedBeats} beat(s) replaced): `
      + power.segments.map(s => s.name).join(' '));
    return createSongMap(power);
  }

  // The post-effects (delay) follow the song's pulse; told whenever the map is (re)built.
  function syncTempo() {
    const a = song?.analysis;
    audio?.setTempo(a && a.bpm > 0 ? { pulseSeconds: a.pulse, beatSeconds: 60 / a.bpm } : null);
  }

  // Rebuild the map after a tone or guard change and show the chord at the current position.
  function refreshMap() {
    if (!song?.analysis) return;
    song.map = mapFor(song.analysis);
    syncTempo();
    const heard = state === 'playing' ? Math.max(0, heardTime()) : 0;
    setChord(song.map.chordAt(heard + (state === 'playing' ? settings.chordLookahead / 1000 : 0)));
    hud.setNext(song.map.nextChord(heard));
  }

  // The electric tone plays power chords only while the pedalboard has drive engaged (清音: triads).
  function voicingNow() { return toneVoicing(TONES[settings.tone], pedals?.model.snapshot() ?? null); }
  pedals?.model.subscribe(() => {
    if (voicingNow() === pitch.voicing) return;
    pitch.setVoicing(voicingNow());
    refreshMap();
  });

  function setTone(id) {
    settings.tone = id;
    audio?.setTone(TONES[id]);
    pitch.setVoicing(voicingNow());
    refreshMap();
    refreshInfo();
  }

  function setState(next) {
    state = next;
    hud.showScreen(state);
    menu?.setScreen(state);
  }

  // ---------- song flow ----------
  // Must run synchronously inside a click/key handler: browsers only let an AudioContext start
  // during a user gesture. The file picker's change event can arrive after the gesture has expired,
  // so the pick button unlocks audio before the dialog opens, and every later gesture resumes it
  // again (it can also be suspended by the OS or the browser while the tab is in the background).
  function unlockAudio() {
    if (!audio) {
      audio = createAudioEngine(settings);
      if (pedals) audio.applyPedals(pedals.model.snapshot());
      // The wah's 跟拍子 sweep follows the song's beat grid (re-derived when the tempo is corrected).
      audio.setWahClock(songSeconds => {
        const map = song?.map;
        if (!map || !(map.bpm > 0)) return null;
        const beat = map.beatPhase(songSeconds);
        // Counted from the bar line, so a sweep of 2 or 4 beats starts on a downbeat.
        return beat.index < 0 ? null : { beats: beat.inBar + beat.phase, beatSeconds: 60 / map.bpm };
      });
      audio.setTone(TONES[settings.tone]);
      syncTempo();
      pitch.setVoicing(voicingNow());
    }
    audio.resume().catch(error => console.warn('[Air Jam] audio resume failed:', error));
  }

  async function loadSong(source) {
    const token = ++loadToken;
    hud.setIntroMessage('');
    unlockAudio();
    if (!mouseMode) ensureCamera();

    setState('analyzing');
    let mono, buffer, title, truth = null;
    try {
      if (source.type === 'demo') {
        hud.setAnalyzeProgress(0, t('analyzing.synth'));
        await nextFrame();
        const demo = renderDemoSong(44100);
        mono = demo.samples;
        truth = demo.truth;
        buffer = audio.bufferFromMono(mono, demo.sampleRate);
        title = t('hud.demoTitle');
      } else {
        hud.setAnalyzeProgress(0, t('analyzing.decoding'));
        buffer = await audio.decode(await source.file.arrayBuffer());
        if (token !== loadToken) return;
        if (buffer.duration > settings.maxSongMinutes * 60) {
          setState('intro');
          hud.setIntroMessage(t('error.tooLong', { minutes: settings.maxSongMinutes }));
          return;
        }
        mono = mixToMono(buffer);
        title = source.file.name.replace(/\.[^.]+$/, '');
      }
    } catch (error) {
      console.warn('[Air Jam] could not decode audio:', error);
      if (token === loadToken) { setState('intro'); hud.setIntroMessage(t('error.decode')); }
      return;
    }

    let analysis = null;
    try {
      analysis = await analyzeAsync(mono, buffer.sampleRate, fraction => {
        if (token === loadToken) hud.setAnalyzeProgress(fraction, t('analyzing.listening'));
      });
    } catch (error) {
      console.warn('[Air Jam] analysis failed:', error);
    }
    if (token !== loadToken) return;

    if (analysis) {
      console.info(`[Air Jam] ${title}: ${analysis.bpm.toFixed(1)} BPM (pulse ${(1000 * analysis.pulse).toFixed(1)} ms × `
        + `${analysis.autoTempo.grouping}, ${analysis.meter}), key ${chordName(analysis.key)}, `
        + `${analysis.segments.length} chord segments:`, analysis.segments.map(s => s.name).join(' '));
      if (truth) {
        const report = compareWithTruth(analysis, truth);
        console.info(`[Air Jam] demo check: ${report.bpm.toFixed(2)} BPM (expected ${truth.bpm}), `
          + `chords right on ${(100 * report.chordAccuracy).toFixed(0)}% of beats, `
          + `beat offset ${report.beatOffsetMs.toFixed(1)} ms`);
        console.table(report.rows);
      }
    }
    song = { title, buffer, analysis, map: mapFor(analysis) };
    syncTempo();
    instrument.reset();
    fx.clear();
    enterReady();
    if (!analysis) hud.toast(t('error.analysis'), 6);
  }

  function enterReady() {
    audio.stopSong();
    scorer.reset();
    lastBeat = -1;
    clickedBeat = -1;
    pitch.setKey(song.analysis?.key ?? null);
    chord = song.map ? song.map.chordAt(0) : null;
    pitch.setChord(chord);
    hud.setChord(chord);
    instrument.onChordChange(chord);
    hud.setNext(song.map?.nextChord(0) ?? null);
    hud.setProgress(0);
    hud.setBeat(-1);
    hud.setScore(0, 0);
    refreshInfo();
    setState('ready');
  }

  // Manual tempo correction: halve/double/×1.5/÷1.5 the beat or move it by one pulse. The analysis
  // keeps its spectral features, so only the beat grid, bars and chords are re-derived.
  function adjustTempo(change) {
    if (!song?.analysis || (state !== 'ready' && state !== 'playing')) return;
    const { factor, shift } = song.analysis.manual;
    const next = change === 'reset' ? { factor: 1, shift: 0 }
      : change.factor ? { factor: factor * change.factor, shift: 0 }
        : { factor, shift: shift + change.shift };
    let analysis;
    try {
      analysis = retime(song.analysis, next);
    } catch (error) {
      console.warn('[Air Jam] tempo change failed:', error);
      hud.toast(t('tempo.failed'), 3);
      return;
    }
    song.analysis = analysis;
    song.map = mapFor(analysis);
    syncTempo();
    const heard = state === 'playing' ? Math.max(0, heardTime()) : 0;
    lastBeat = state === 'playing' ? song.map.beatIndexAt(heard) : -1;
    clickedBeat = state === 'playing' ? song.map.beatIndexAt(audio.songTime()) : -1;
    scorer.state.lastScoredBeat = song.map.beatIndexAt(heard);
    setChord(song.map.chordAt(heard + settings.chordLookahead / 1000));
    hud.setNext(song.map.nextChord(heard));
    refreshInfo();
    const bpm = Math.round(analysis.bpm);
    hud.toast(change === 'reset' ? t('tempo.toastReset', { bpm })
      : change.factor ? t('tempo.toastBpm', { bpm })
        : t(change.shift < 0 ? 'tempo.toastEarlier' : 'tempo.toastLater'), 2);
    console.info(`[Air Jam] tempo ×${analysis.manual.factor.toFixed(3)}, shift ${analysis.manual.shift} pulse(s): `
      + `${analysis.bpm.toFixed(1)} BPM, ${analysis.segments.length} chord segments:`, analysis.segments.map(s => s.name).join(' '));
  }

  function toggleMetronome() {
    settings.metronome = !settings.metronome;
    prefs.remember('metronome', settings.metronome);
    clickedBeat = song?.map && audio ? song.map.beatIndexAt(audio.songTime()) : -1;
    hud.setMetronome(settings.metronome);
    hud.toast(t(settings.metronome ? 'tempo.clickOn' : 'tempo.clickOff'), 1.5);
  }

  function beginSong() {
    if (state !== 'ready') return;
    unlockAudio();
    setState('playing');
    audio.playSong(song.buffer, finish);
  }

  function finish() {
    if (state !== 'playing') return;
    audio.stopSong();
    hud.showEnding(scorer.state, song);
    setState('ended');
  }

  function backToIntro() {
    loadToken++;
    audio?.stopSong();
    setState('intro');
  }

  // ---------- frame loop ----------
  function frame(timestamp) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (timestamp - lastFrame) / 1000);
    lastFrame = timestamp;
    const time = clock();
    const onStage = state === 'ready' || state === 'playing';

    hands = onStage ? readHands(time) : [];
    // Page buttons first (a camera hand over one is theirs), then the pedalboard, then the strings.
    const free = menu.routeHands(hands, time, { camera: onStage && !mouseMode });
    if (onStage) instrument.onHands(pedals.route(free, time, pedalScreen()), time);
    else pedals.route([], time, pedalScreen());

    if (state === 'playing' && song.map) {
      const heard = Math.max(0, heardTime());
      setChord(song.map.chordAt(heard + settings.chordLookahead / 1000));
      const beat = song.map.beatPhase(heard);
      if (beat.index !== lastBeat && beat.index >= 0) {
        lastBeat = beat.index;
        fx.beat(beat.inBar === 0 ? 1 : 0.45, chordColor(chord));
        hud.setBeat(beat.inBar);
      }
      scorer.tick(heard, song.map);
      if (settings.metronome) {
        // Schedule ticks a little ahead on the song clock (the song and the ticks share the output delay).
        const now = audio.songTime();
        for (let i = Math.max(clickedBeat + 1, song.map.beatIndexAt(now) + 1); i < song.map.beatCount && song.map.beatTime(i) <= now + 0.2; i++) {
          audio.click(song.map.beatTime(i), song.analysis.beatInBar[i] === 0);
          clickedBeat = i;
        }
      }
      hud.setNext(song.map.nextChord(heard));
      hud.setProgress(heard / song.map.duration);
    } else if (state === 'playing') {
      hud.setProgress(heardTime() / song.buffer.duration);
    }
    if (onStage) hud.setScore(scorer.state.score, scorer.state.combo);
    hud.setStatus(onStage ? statusText() : '');

    audio?.tickWah();
    instrument.update(dt);
    fx.update(dt);

    g.clearRect(0, 0, stage.width, stage.height);
    if (!mouseMode) {
      g.fillStyle = `rgba(4, 6, 20, ${settings.videoDim})`;
      g.fillRect(0, 0, stage.width, stage.height);
    }
    if (onStage) {
      fx.drawPulse(g, stage.width, stage.height);
      instrument.draw(g);
      pedals?.draw(g);
      drawHands(g, hands, { showSkeleton: settings.showHand });
      fx.draw(g);
    }
  }

  // ---------- controls ----------
  const fileInput = document.getElementById('fileInput');
  document.getElementById('pickButton').addEventListener('click', () => { unlockAudio(); fileInput.click(); });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (file) loadSong({ type: 'file', file });
  });
  document.getElementById('demoButton').addEventListener('click', () => loadSong({ type: 'demo' }));
  document.getElementById('startButton').addEventListener('click', beginSong);
  document.getElementById('againButton').addEventListener('click', () => { unlockAudio(); enterReady(); });
  document.getElementById('changeButton').addEventListener('click', backToIntro);
  const TEMPO_ACTIONS = {
    half: { factor: 0.5 }, double: { factor: 2 }, slower: { factor: 2 / 3 }, faster: { factor: 1.5 },
    earlier: { shift: -1 }, later: { shift: 1 }, reset: 'reset',
  };
  for (const button of document.querySelectorAll('[data-tempo]')) {
    button.addEventListener('click', () => {
      if (button.dataset.tempo === 'click') toggleMetronome();
      else adjustTempo(TEMPO_ACTIONS[button.dataset.tempo]);
    });
  }
  const TEMPO_KEYS = { '[': 'half', ']': 'double', ';': 'slower', "'": 'faster', ',': 'earlier', '.': 'later', '0': 'reset' };

  // ---------- player choices (buttons and keys share these; each one is remembered) ----------
  function chooseMouseMode(on) {
    setMouseMode(on);
    prefs.remember('mouse', on);
  }

  function chooseTone(id) {
    if (!TONES[id]) return;
    setTone(id);
    prefs.remember('tone', id);
    hud.toast(t(`hud.tone.${settings.tone}`), 1.5);
  }

  function chooseSnapMode(mode) {
    if (!SNAP_MODES.includes(mode)) return;
    settings.snapMode = mode;
    prefs.remember('snapMode', mode);
    refreshInfo();
    hud.toast(snapLabel(), 1.5);
  }

  function toggleHand() {
    settings.showHand = !settings.showHand;
    prefs.remember('showHand', settings.showHand);
  }

  function setKeyGuard(on) {
    settings.keyGuard = !!on;
    refreshMap();
    refreshInfo();
  }

  function chooseHandedness(side) {
    if (side !== 'right' && side !== 'left') return;
    settings.handedness = side;
    prefs.remember('handedness', side);
    hud.toast(t('pedal.wahHandHint', { side: t(side === 'right' ? 'pedal.side.left' : 'pedal.side.right') }), 2.5);
  }

  function setPedalsShown(on) {
    settings.pedals = !!on;
    prefs.remember('pedals', settings.pedals);
    pedals.setShown(settings.pedals);
    hud.setHelp(mouseMode);
  }

  function openTuning() {
    if (!settings.pedals) return;
    if (state === 'ready') pedals.openTuning();
    else hud.toast(t('menu.tuningOnlyReady'), 2.5);
  }

  menu = createMenu({
    t, settings,
    getState: () => ({
      screen: state,
      tone: settings.tone,
      tones: TONE_ORDER,
      toneName: t(`hud.tone.${settings.tone}`),
      snapMode: settings.snapMode,
      metronome: settings.metronome,
      showHand: settings.showHand,
      keyGuard: settings.keyGuard,
      pedalsShown: settings.pedals,
      handedness: settings.handedness,
      mouseMode,
      tempo: {
        available: !!song?.analysis,
        bpm: song?.analysis?.bpm ?? 0,
        manual: !!song?.analysis && (song.analysis.manual.factor !== 1 || song.analysis.manual.shift !== 0),
      },
    }),
    actions: {
      setTone: chooseTone,
      setSnapMode: chooseSnapMode,
      setMouseMode: chooseMouseMode,
      toggleHand,
      setPedalsShown,
      setHandedness: chooseHandedness,
      openTuning,
      setKeyGuard(on) {
        setKeyGuard(on);
        prefs.remember('keyGuard', settings.keyGuard);
        hud.toast(`${t('menu.keyGuard')}：${t(settings.keyGuard ? 'menu.on' : 'menu.off')}`, 1.5);
      },
      changeSong: backToIntro,
      openLab: () => { location.href = `${location.pathname}?lab=1`; },
    },
  });

  window.addEventListener('keydown', event => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (pedals.handleKey(key, pedalScreen())) {
      event.preventDefault();
      if (pedals.tuningOpen) menu.close();
      menu.refresh();
      return;
    }
    if (key === 'escape' && menu.isOpen) { menu.close(); return; }
    if (key === 'm') chooseMouseMode(!mouseMode);
    else if (key === 'h') toggleHand();
    else if (key === 'k') toggleMetronome();
    else if (TEMPO_KEYS[key]) adjustTempo(TEMPO_ACTIONS[TEMPO_KEYS[key]]);
    else if (key === ' ' && state === 'ready') { event.preventDefault(); beginSong(); }
    else if (key === 'escape' && state === 'playing') finish();
    else if (key === 'escape' && state === 'ready') backToIntro();
    else if (['1', '2', '3'].includes(key)) chooseSnapMode(SNAP_MODES[Number(key) - 1]);
    else if (key === 't') chooseTone(TONE_ORDER[(TONE_ORDER.indexOf(settings.tone) + 1) % TONE_ORDER.length]);
    else return;
    menu.refresh();
  });
  window.addEventListener('resize', resize);

  resize();
  refreshMode();
  hud.setMetronome(settings.metronome);
  setState('intro');
  requestAnimationFrame(frame);

  // Handle for the console and automated checks.
  return {
    settings, instrument, scorer, pitch, fx, pedals, menu, prefs,
    setTone,
    // In-key root guard for power chords (open question for the owner): airJam.setKeyGuard(false)
    setKeyGuard(on) { setKeyGuard(on); menu.refresh(); },
    get state() { return state; },
    get song() { return song; },
    get audio() { return audio; },
    get chord() { return chord; },
    get mouseMode() { return mouseMode; },
    get camera() { return camera.status; },
  };
}
