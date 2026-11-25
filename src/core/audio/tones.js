// A tone = Karplus-Strong parameters + an effect chain. Tones are independent of instruments:
// any instrument that plucks can use any tone. `voicing` lets a tone ask the pitch snapper for
// power chords (planned for distorted tones).

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

export const TONES = {
  steel: {
    id: 'steel',
    voicing: 'triad',
    string: { t60: 3.2, damping: 0.5, brightness: 0.85 },
    createChain: ctx => bodyAndRoom(ctx, { bodyHz: 190, bodyGain: 3, airGain: 2, wet: 0.16, roomSeconds: 1.3 }),
  },
  nylon: {
    id: 'nylon',
    voicing: 'triad',
    string: { t60: 2.2, damping: 0.5, brightness: 0.45 },
    createChain: ctx => bodyAndRoom(ctx, { bodyHz: 220, bodyGain: 4, airGain: -4, wet: 0.2, roomSeconds: 1.1 }),
  },
};

export const TONE_ORDER = ['steel', 'nylon'];
