// A minimal stand-in for BaseAudioContext, enough to run src/core/audio/engine.js in Node: nodes
// record their connections, AudioParams record their automation calls, buffer sources record when
// they start and stop. It makes no sound; tests check what the engine asks Web Audio to do.

class FakeParam {
  constructor(context, value = 0) { this.context = context; this.value = value; this.calls = []; this.outputs = new Set(); }
  setTargetAtTime(target, time, tau) { this.calls.push({ type: 'target', target, time, tau }); return this; }
  cancelScheduledValues(time) { this.calls.push({ type: 'cancel', time }); return this; }
  setValueAtTime(value, time) { this.calls.push({ type: 'set', value, time }); return this; }
  linearRampToValueAtTime(value, time) { this.calls.push({ type: 'linear', value, time }); return this; }
  exponentialRampToValueAtTime(value, time) { this.calls.push({ type: 'exp', value, time }); return this; }
}

class FakeNode {
  constructor(context, kind, params = {}) {
    this.context = context;
    this.kind = kind;
    this.outputs = new Set();
    for (const [name, value] of Object.entries(params)) this[name] = new FakeParam(context, value);
    context.created.push(this);
  }
  connect(node) { this.outputs.add(node); return node; }
  disconnect() { this.outputs.clear(); }
}

class FakeBufferSource extends FakeNode {
  constructor(context) {
    super(context, 'bufferSource', { playbackRate: 1 });
    this.buffer = null; this.startedAt = null; this.offset = 0; this.stoppedAt = null; this.onended = null;
  }
  start(when = 0, offset = 0) { this.startedAt = when; this.offset = offset; this.context.sources.push(this); }
  stop(when = 0) { this.stoppedAt = when; }
  end() { this.onended?.(); }
}

export class FakeAudioContext {
  constructor({ sampleRate = 48000 } = {}) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.created = [];
    this.sources = [];
    this.destination = new FakeNode(this, 'destination');
    this.outputLatency = 0;
    this.baseLatency = 0;
  }
  createGain() { return new FakeNode(this, 'gain', { gain: 1 }); }
  createBiquadFilter() { const n = new FakeNode(this, 'biquad', { frequency: 350, Q: 1, gain: 0, detune: 0 }); n.type = 'lowpass'; return n; }
  createWaveShaper() { const n = new FakeNode(this, 'shaper'); n.curve = null; n.oversample = 'none'; return n; }
  createStereoPanner() { return new FakeNode(this, 'panner', { pan: 0 }); }
  createDynamicsCompressor() {
    const n = new FakeNode(this, 'compressor', { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 });
    n.reduction = 0;
    return n;
  }
  createDelay(maxDelayTime = 1) { const n = new FakeNode(this, 'delay', { delayTime: 0 }); n.maxDelayTime = maxDelayTime; return n; }
  createChannelSplitter(outputs = 6) { const n = new FakeNode(this, 'splitter'); n.numberOfOutputs = outputs; return n; }
  createChannelMerger(inputs = 6) { const n = new FakeNode(this, 'merger'); n.numberOfInputs = inputs; return n; }
  createConvolver() { const n = new FakeNode(this, 'convolver'); n.buffer = null; return n; }
  createConstantSource() {
    const n = new FakeNode(this, 'constant', { offset: 1 });
    n.startedAt = null;
    n.start = (when = 0) => { n.startedAt = when; };
    n.stop = () => {};
    return n;
  }
  // Not a buffer source: `sources` lists only the voices' buffer sources.
  createOscillator() {
    const n = new FakeNode(this, 'oscillator', { frequency: 440, detune: 0 });
    n.type = 'sine'; n.startedAt = null; n.stoppedAt = null;
    n.start = (when = 0) => { n.startedAt = when; };
    n.stop = (when = 0) => { n.stoppedAt = when; };
    return n;
  }
  createBufferSource() { return new FakeBufferSource(this); }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: c => data[c] };
  }
  resume() { return Promise.resolve(); }
}
