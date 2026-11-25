// A tone = Karplus-Strong parameters + an effect chain. Tones are independent of instruments:
// any instrument that plucks can use any tone. Each engine part (the rhythm part now, a lead part
// later) builds its own chain instance from its tone, so a distorted tone never shares a clipper
// with another part. Per-tone fields:
//   voicing         'triad' or 'power' (root + fifth; the pitch snapper and the song map follow it)
//   panWidth        scales the per-string stereo position (distortion sits in the centre)
//   releaseDepthDb  how far a choked/released voice falls within its fade time, measured at the
//                   voice; distorted tones need their drive on top of the audible drop
//   chordChoke      seconds in which voices from the previous chord fade out on a chord change
//                   (null = let them ring, as acoustic strings do)
import { buildStages } from './stages.js';

// Old behaviour of every release: setTargetAtTime with τ = fade / 3, i.e. −26 dB at the fade time.
const NATURAL_RELEASE_DB = 60 / Math.LN10;

function impulseResponse(ctx, seconds, decay) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let low = 0;
    for (let i = 0; i < length; i++) {
      low += 0.45 * ((Math.random() * 2 - 1) - low);
      data[i] = low * Math.pow(1 - i / length, decay) * (i < 64 ? i / 64 : 1);
    }
  }
  return buffer;
}

// Dry path through a gentle body EQ plus a parallel reverb send.
function bodyAndRoom(ctx, { bodyHz, bodyGain, airGain, wet, roomSeconds }) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const rumble = ctx.createBiquadFilter();
  rumble.type = 'highpass'; rumble.frequency.value = 70;
  const body = ctx.createBiquadFilter();
  body.type = 'peaking'; body.frequency.value = bodyHz; body.Q.value = 0.9; body.gain.value = bodyGain;
  const air = ctx.createBiquadFilter();
  air.type = 'highshelf'; air.frequency.value = 3500; air.gain.value = airGain;
  const reverb = ctx.createConvolver();
  reverb.buffer = impulseResponse(ctx, roomSeconds, 2.6);
  const send = ctx.createGain();
  send.gain.value = wet;
  input.connect(rumble).connect(body).connect(air).connect(output);
  air.connect(send).connect(reverb).connect(output);
  return {
    input, output,
    dispose() { for (const node of [input, output, rumble, body, air, reverb, send]) node.disconnect(); },
  };
}

// Distortion amp: tighten the lows, push the mids into a soft clipper (4× oversampled), then a
// speaker-cabinet curve (no impulse response files): low thump, scooped low-mids, a mid-forward
// presence bump and a steep roll-off around 4.5 kHz, which is what keeps clipping from fizzing.
// Described as stages (stages.js) so Node measurements run the same chain.
export function ampStages(o) {
  const biquad = (type, frequency, Q, gain) => ({ kind: 'biquad', type, frequency, Q, ...(gain !== undefined ? { gain } : {}) });
  return [
    biquad('highpass', o.tightHz, 0.7),
    biquad('peaking', o.preMidHz, 0.8, o.preMidGain),
    { kind: 'gain', value: o.preGain },
    { kind: 'shaper', curve: { kind: o.clip ?? 'tanh', drive: o.drive, bias: o.bias, n: o.clipN ?? 4 }, oversample: '4x' },
    biquad('highpass', 75, 0.7),
    biquad('peaking', o.thumpHz, 1.1, o.thumpGain),
    biquad('peaking', o.mudHz, 1.0, o.mudGain),
    biquad('peaking', o.presenceHz, 0.9, o.presenceGain),
    biquad('lowpass', o.cabHz, 0.9),
    biquad('lowpass', o.cabHz * 1.25, 0.6),
    // Optional low shelf after the clipper (the tone lab's "thick" combo); off for the game's tone.
    ...(o.lowShelfGain ? [biquad('lowshelf', o.lowShelfHz, undefined, o.lowShelfGain)] : []),
    { kind: 'gain', value: o.level },
  ];
}

// Rhythm distortion settings, shared by the chain and the tests (tests/instrument.test.mjs).
export const RHYTHM_DISTORTION = {
  tightHz: 110, preMidHz: 750, preMidGain: 5, preGain: 6, drive: 4, bias: 0.08,
  thumpHz: 120, thumpGain: 2, mudHz: 420, mudGain: -4, presenceHz: 1700, presenceGain: 3,
  cabHz: 4500, level: 0.2,
};

const ELECTRIC_STAGES = ampStages(RHYTHM_DISTORTION);

export const TONES = {
  steel: {
    id: 'steel',
    voicing: 'triad',
    panWidth: 1,
    releaseDepthDb: NATURAL_RELEASE_DB,
    chordChoke: null,
    string: { t60: 3.2, damping: 0.5, brightness: 0.85 },
    createChain: ctx => bodyAndRoom(ctx, { bodyHz: 190, bodyGain: 3, airGain: 2, wet: 0.16, roomSeconds: 1.3 }),
  },
  nylon: {
    id: 'nylon',
    voicing: 'triad',
    panWidth: 1,
    releaseDepthDb: NATURAL_RELEASE_DB,
    chordChoke: null,
    string: { t60: 2.2, damping: 0.5, brightness: 0.45 },
    createChain: ctx => bodyAndRoom(ctx, { bodyHz: 220, bodyGain: 4, airGain: -4, wet: 0.2, roomSeconds: 1.1 }),
  },
  // Distorted rhythm guitar for rock: power chords, centred, short and dry so it does not smear
  // into the song's wide guitar wall. 90 dB release depth = 40 dB audible drop + up to ~50 dB of
  // drive and stacked voices before the clipper (checked in tests/instrument.test.mjs).
  electric: {
    id: 'electric',
    voicing: 'power',
    panWidth: 0.15,
    releaseDepthDb: 90,
    chordChoke: 0.08,
    string: { t60: 1.3, damping: 0.3, brightness: 0.8 },
    stages: ELECTRIC_STAGES,
    createChain: ctx => buildStages(ctx, ELECTRIC_STAGES),
  },
};

export const TONE_ORDER = ['steel', 'nylon', 'electric'];
