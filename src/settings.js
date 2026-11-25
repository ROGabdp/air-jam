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
  metronome: false,        // tick on every detected beat while playing (K), to check the tempo by ear
  videoDim: 0.4,

  tone: 'steel',           // 'steel' | 'nylon' | 'electric' (T)
  // Power chords (electric tone): register and the in-key root guard (src/core/music/power-chords.js).
  powerLowestNote: 'E2',   // the lowest root sits in E2..D#3, like a guitar's two bottom strings
  powerSteps: 5,           // root, fifth, octave, fifth, octave: slots spread over these notes (2 octaves)
  keyGuard: true,          // replace roots outside the key's common rock degrees (owner to confirm)
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

  // Pedalboard (src/core/pedals/): shown by default, the player can hide it (settings panel). Which
  // pedals can be used yet: src/core/pedals/availability.js.
  pedals: true,
  pedalZoneHeight: 0.2,    // footswitch zone: fraction of the stage height along the bottom
  pedalTapTime: 400,       // ms: pinch on → off within this is a tap (toggle / select)
  pedalTapMove: 0.5,       // palm sizes the pinch point may wander during a tap
  pedalDragDeadband: 0.12, // palm sizes of vertical travel before a knob starts turning (~5% of its range)
  pedalKnobTravel: 2.5,    // palm sizes of vertical travel for a knob's full range
  pedalLatch: 100,         // ms: on release a knob keeps its value from this long before (camera)
  pedalLockout: 400,       // ms after a tap during which further taps are ignored
  pedalSettle: 150,        // ms a camera hand must be tracked before its pinch can press anything
  wahStripWidth: 0.12,     // wah strip at the right edge: fraction of the stage width
};

export const SNAP_MODES = ['chord', 'scale', 'free'];
