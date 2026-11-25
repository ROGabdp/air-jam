import { createApp } from './app/app.js';
import { createLab } from './lab/lab.js';

// ?lab=1 opens the tone lab (a listening bench for candidate tones) instead of the game.
const lab = new URLSearchParams(location.search).get('lab') === '1';
window.airJam = lab ? { lab: createLab() } : createApp();
