// Every tunable in one place so a settings menu can bind to it later.
export const SETTINGS = {
  snapMode: 'chord',       // 'chord' | 'scale' | 'free'
  slots: 10,               // pitch steps across the string-length range
  lowestNote: 'C3',        // the longest string starts around here
  maxStrings: 8,
  pinchOn: 0.35,           // thumb–index distance / palm size to start a pinch
  pinchOff: 0.5,           // ...and to release it (hysteresis)
  pluckCooldown: 120,      // ms before the same string can be plucked again
  songVolume: 0.8,
  stringVolume: 0.9,
  decay: 0.996,            // string sustain; closer to 1 rings longer
  perfectWindow: 70,       // ms
  goodWindow: 150,         // ms
  showHand: true,
  videoDim: 0.4,

  tone: 'steel',
  maxVoices: 16,
  minStringLength: 0.08,   // fraction of stage width
  maxStringLength: 0.9,
  releaseGrace: 150,       // ms a pinch may drop out while drawing a string
  newStringGuard: 250,     // ms a new string ignores plucks
  crossDeadband: 0.07,     // palm sizes the fingertip must clear on the far side to count as a crossing
  strumGap: 15,            // ms between strings crossed in the same frame
  strumWindow: 140,        // ms within which plucks count as one strum
  velocityFull: 9,         // fingertip speed (palm sizes per second) that gives full volume
  fistOn: 1.2,             // mean fingertip–wrist distance / palm size to close a fist
  fistOff: 1.45,
  fistReach: 0.55,         // palm sizes from fist centre to a string
  fistDeleteTime: 800,     // ms
  fistClearTime: 1000,     // ms
  cameraLatency: 60,       // ms from real motion to detection, compensated in judging
  mouseLatency: 12,
  chordLookahead: 40,      // ms the displayed/snapped chord leads the audio
  comboIdleBeats: 8,       // beats without a scored hit before the combo quietly resets
  maxSongMinutes: 15,      // longer files are refused (decoded audio is ~23 MB per stereo minute)
};

export const SNAP_MODES = ['chord', 'scale', 'free'];
