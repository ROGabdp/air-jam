// DOM side of the game: screens, HUD and status text. No game logic.
import { t } from '../i18n/index.js';
import { NOTE_NAMES, chordColor, chordName, hsl } from '../core/music/theory.js';

const $ = id => document.getElementById(id);

export function keyName(key) {
  return key ? t(key.minor ? 'key.minor' : 'key.major', { note: NOTE_NAMES[key.root] }) : '';
}

export function createHud() {
  const el = {
    hud: $('hud'), intro: $('intro'), analyzing: $('analyzing'), ending: $('ending'), ready: $('ready'),
    help: $('help'), status: $('status'), songInfo: $('songInfo'), toast: $('toast'),
    progress: $('progressFill'), chordNow: $('chordNow'), chordNext: $('chordNext'),
    chordNextBox: $('chordNextBox'), chordNextIn: $('chordNextIn'),
    dots: [...$('beatDots').children], score: $('score'), combo: $('combo'),
    analyzeFill: $('analyzeFill'), analyzeText: $('analyzeText'),
    modeHint: $('modeHint'), introMessage: $('introMessage'),
    finalScore: $('finalScore'), statCombo: $('statCombo'), statPerfect: $('statPerfect'),
    statGood: $('statGood'), endingSummary: $('endingSummary'), metronome: $('metronomeButton'),
  };
  const shown = { score: -1, combo: -1, chord: undefined, next: undefined, beatsLeft: -1, beat: -1 };
  let toastTimer = 0;

  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  return {
    el,

    showScreen(state) {
      el.intro.hidden = state !== 'intro';
      el.analyzing.hidden = state !== 'analyzing';
      el.ending.hidden = state !== 'ended';
      el.ready.hidden = state !== 'ready';
      const onStage = state === 'ready' || state === 'playing';
      el.hud.hidden = !onStage;
      el.help.hidden = !onStage;
      el.songInfo.hidden = !onStage;
    },

    setModeHint(mouse) { setText(el.modeHint, t(mouse ? 'intro.modeMouse' : 'intro.modeCamera')); },
    setIntroMessage(text) { setText(el.introMessage, text); },
    setHelp(mouse) { el.help.innerHTML = `${t(mouse ? 'help.mouse' : 'help.camera')}<br>${t('help.keys')}<br>${t('help.tempoKeys')}`; },
    setMetronome(on) { el.metronome.classList.toggle('on', on); el.metronome.setAttribute('aria-pressed', String(on)); },
    setStatus(text) { setText(el.status, text); },
    setSongInfo(text) { setText(el.songInfo, text); },

    toast(text, seconds = 3.5) {
      el.toast.textContent = text;
      el.toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { el.toast.hidden = true; }, seconds * 1000);
    },

    setAnalyzeProgress(fraction, text) {
      el.analyzeFill.style.width = `${Math.round(fraction * 100)}%`;
      if (text) setText(el.analyzeText, text);
    },

    setChord(chord) {
      if (shown.chord === chord) return;
      shown.chord = chord;
      setText(el.chordNow, chordName(chord));
      document.documentElement.style.setProperty('--chord', hsl(chordColor(chord)));
      el.chordNow.classList.remove('bump');
      void el.chordNow.offsetWidth;
      el.chordNow.classList.add('bump');
    },

    setNext(next) {
      const chord = next?.chord ?? null;
      if (shown.next !== chord) {
        shown.next = chord;
        setText(el.chordNext, chordName(chord));
        el.chordNext.style.color = chord ? hsl(chordColor(chord), 1, 8) : '';
      }
      const beatsLeft = next ? Math.max(1, Math.ceil(next.beatsAway - 0.02)) : -1;
      if (shown.beatsLeft !== beatsLeft) {
        shown.beatsLeft = beatsLeft;
        setText(el.chordNextIn, next ? t('hud.beatsLeft', { n: beatsLeft }) : '');
        el.chordNextBox.classList.toggle('soon', beatsLeft === 1);
      }
    },

    setBeat(inBar) {
      if (shown.beat === inBar) return;
      shown.beat = inBar;
      el.dots.forEach((dot, i) => dot.classList.toggle('on', i === inBar));
    },

    setProgress(fraction) { el.progress.style.width = `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(2)}%`; },

    setScore(score, combo) {
      if (shown.score !== score) { shown.score = score; setText(el.score, String(score)); }
      if (shown.combo !== combo) { shown.combo = combo; setText(el.combo, combo >= 2 ? t('hud.combo', { n: combo }) : ''); }
    },

    showEnding(stats, song) {
      setText(el.finalScore, String(stats.score));
      setText(el.statCombo, String(stats.maxCombo));
      setText(el.statPerfect, String(stats.perfect));
      setText(el.statGood, String(stats.good));
      setText(el.endingSummary, song.analysis
        ? t('ending.summary', { bpm: Math.round(song.analysis.bpm), key: keyName(song.analysis.key) })
        : t('ending.unscored'));
    },
  };
}
