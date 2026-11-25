// node tests/electric-rig.test.mjs
// The game's electric guitar as a pedal rig (src/core/audio/electric-rig.js): pedal → DSP mapping,
// presets (搖滾 = the tone lab's 丁), auto-level, smoothing of pedal changes, the voicing rule, the
// engine's split pluck rendering (head now, tail later) and its pedal hook, with a fake AudioContext.
import assert from 'node:assert/strict';
import {
  rigFromSnapshot, rigStages, rigDriveDb, electricTone, toneVoicing, RANGES, AMP, BOOSTER, DING, DING_KNOBS,
  LONG_STRING, NEAR_BRIDGE, AUTO_LEVEL_DB, FUZZ,
} from '../src/core/audio/electric-rig.js';
import { stageNumbers, shapeOf, driveDb, processStages, buildSwitchableStages } from '../src/core/audio/stages.js';
import { createPluck, renderPluck, PEAK_WINDOW_SECONDS, sustainerSettings, sustainStretch } from '../src/core/audio/karplus.js';
import { TONES } from '../src/core/audio/tones.js';
import { LAB_COMBOS, LAB_AMP_THICK, BOOSTER as LAB_BOOSTER } from '../src/core/audio/tone-lab.js';
import { voiceParams } from '../src/core/audio/voice-params.js';
import { createAudioEngine, PLUCK_HEAD_SECONDS, PEDAL_TAU } from '../src/core/audio/engine.js';
import { createPedalModel, PRESETS, PEDAL_TYPES, PEDAL_IDS, PEDALS_WITH_SOUND, knobOf, knobValue } from '../src/core/pedals/model.js';
import { renderPart, renderMaster, seeded } from '../tools/tone-lab/model.mjs';
import { renderDemoSong } from '../src/core/song/demo-song.js';
import { loudnessDb, driveSnapshot } from '../tools/tone-lab/calibrate-level.mjs';
import { strum, A5, A5_EIGHT, rms, distortionProducts, levelAt, peakOf } from '../src/lab/metrics.js';
import { FakeAudioContext } from './fake-audio-context.mjs';
import { SETTINGS } from '../src/settings.js';

const results = [];
function test(name, fn) {
  try { const note = fn(); results.push({ test: name, result: 'PASS', detail: note ?? '' }); }
  catch (error) { results.push({ test: name, result: 'FAIL', detail: error.message.split('\n')[0] }); }
}
const db = x => 20 * Math.log10(x);
const presetSnapshot = id => { const m = createPedalModel(); m.applyPreset(id); return m.snapshot(); };
const sweep = (n = 11) => Array.from({ length: n }, (_, i) => i / (n - 1));

// ---------- mapping ----------
test('mapping: drive knobs raise the rig drive monotonically; every number is finite and bounded', () => {
  let previous = -Infinity;
  for (const v of sweep(21)) {
    const d = rigDriveDb(rigFromSnapshot(driveSnapshot(v, DING_KNOBS.distortion.drive)));
    assert.ok(d > previous, `overdrive ${v}: ${d}`); previous = d;
  }
  previous = -Infinity;
  for (const v of sweep(21)) {
    const rig = rigFromSnapshot(driveSnapshot(DING_KNOBS.overdrive.drive, v));
    const d = rigDriveDb(rig);
    assert.ok(d > previous, `distortion ${v}: ${d}`); previous = d;
    assert.ok(rig.distortion.fuzz >= 0 && rig.distortion.fuzz <= FUZZ.max);
    if (v <= FUZZ.from) assert.equal(rig.distortion.fuzz, 0);
  }
  // Physical ranges agree with the pedal model's knobs (the snapshot's display values).
  for (const pedal of ['overdrive', 'distortion']) {
    for (const [knob, [lo, hi]] of Object.entries(RANGES[pedal])) {
      const k = knobOf(pedal, knob);
      assert.ok(Math.abs(knobValue(k, 0) - lo) < 1e-9 && Math.abs(knobValue(k, 1) - hi) < 1e-9, `${pedal}.${knob}`);
    }
  }
  // Garbage in: missing pedals, NaN, out of range, strings.
  const random = seeded(4);
  const odd = [null, {}, { pedals: {} }, { autoLevel: false, pedals: { overdrive: { on: true, params: { drive: NaN, tone: 9, level: -3 } }, distortion: { on: true, params: { drive: '1', tone: null } } } }];
  for (let i = 0; i < 200; i++) {
    const r = () => (random() * 1.4) - 0.2;
    odd.push({ autoLevel: random() < 0.5, pedals: { overdrive: { on: random() < 0.5, params: { drive: r(), tone: r(), level: r() } }, distortion: { on: random() < 0.5, params: { drive: r(), tone: r(), level: r() } } } });
  }
  const shape = shapeOf(rigStages(rigFromSnapshot(null)));
  for (const snapshot of odd) {
    const rig = rigFromSnapshot(snapshot);
    for (const take of ['main', 'double']) {
      const stages = rigStages(rig, take);
      assert.equal(shapeOf(stages), shape, 'every rig has the same shape (update() never rebuilds)');
      const numbers = stageNumbers(stages).filter(v => v !== undefined);
      for (const v of numbers) assert.ok(Number.isFinite(v), JSON.stringify(snapshot));
      const drive = driveDb(stages);
      assert.ok(Number.isFinite(drive) && drive >= -15 && drive <= 95, `drive ${drive}`);
    }
    assert.ok(rig.levelDb >= -3 && rig.levelDb <= 22 && Math.abs(rig.tiltDb) <= 6 + 1e-9);
  }
  const range = [0, 1].map(v => rigDriveDb(rigFromSnapshot(driveSnapshot(v, v))).toFixed(1));
  return `drive range (both on) ${range.join(' → ')} dB; 丁 ${rigDriveDb(rigFromSnapshot(null)).toFixed(1)} dB`;
});

test('mapping: the post-effects pedals change nothing in the rig; wah, overdrive and distortion have DSP here', () => {
  assert.deepEqual(PEDALS_WITH_SOUND.filter(id => !['chorus', 'delay', 'reverb'].includes(id)), ['wah', 'overdrive', 'distortion']);
  const model = createPedalModel();
  model.applyPreset('rock');
  const base = JSON.stringify(rigFromSnapshot(model.snapshot()));
  for (const id of ['chorus', 'delay', 'reverb']) {
    model.toggle(id, true);
    for (const knob of PEDAL_TYPES[id].knobs) model.setParam(id, knob.id, 0.9);
  }
  assert.equal(JSON.stringify(rigFromSnapshot(model.snapshot())), base);
  const snapshot = model.snapshot();
  for (const id of PEDAL_IDS) assert.equal(snapshot.pedals[id].sound, PEDALS_WITH_SOUND.includes(id), id);
});

// ---------- presets ----------
test('搖滾 is 丁: same constants, same drive, same output as the lab combo (Node model)', () => {
  for (const [key, value] of Object.entries(AMP)) assert.equal(LAB_AMP_THICK[key], value, `AMP.${key}`);
  assert.deepEqual(LAB_BOOSTER, BOOSTER);
  const ding = LAB_COMBOS.labD;
  assert.deepEqual(ding.string, LONG_STRING);
  assert.deepEqual(ding.pick, NEAR_BRIDGE);
  const rock = presetSnapshot('rock');
  const rockKnobs = PRESETS.find(p => p.id === 'rock').on;
  assert.ok(Math.abs(rockKnobs.overdrive.drive - DING_KNOBS.overdrive.drive) < 0.001);
  assert.ok(Math.abs(rockKnobs.distortion.drive - DING_KNOBS.distortion.drive) < 0.001);
  const tone = electricTone(rigFromSnapshot(rock));
  assert.ok(Math.abs(driveDb(tone.stages) - driveDb(ding.stages)) < 0.1, `${driveDb(tone.stages)} vs ${driveDb(ding.stages)}`);
  assert.ok(Math.abs(rigFromSnapshot(rock).levelDb) < 0.05, 'no auto-level change at 丁');
  const events = [...strum(A5, { velocity: 0.7 }), ...strum(A5.slice(0, 3), { time: 0.5, velocity: 0.4, position: 0.8 })];
  const a = renderPart(tone, events, { duration: 1, settings: SETTINGS, sampleRate: 44100, seed: 9 });
  const b = renderPart(ding, events, { duration: 1, settings: SETTINGS, sampleRate: 44100, seed: 9 });
  let diff = 0, sum = 0;
  for (let i = 0; i < a.left.length; i++) { diff += (a.left[i] - b.left[i]) ** 2 + (a.right[i] - b.right[i]) ** 2; sum += b.left[i] ** 2 + b.right[i] ** 2; }
  const error = 10 * Math.log10(diff / sum);
  assert.ok(error < -40, `搖滾 vs 丁: ${error.toFixed(1)} dB`);
  for (const key of ['chordChoke', 'strumChoke', 'panWidth']) assert.equal(tone[key], ding[key], key);
  assert.equal(tone.double.pan, ding.double.pan);
  assert.equal(tone.double.delay, ding.double.delay);
  assert.equal(tone.double.detuneCents, ding.double.detuneCents);
  return `difference ${error.toFixed(0)} dB (knob rounding)`;
});

test('presets: 清音 clean (triads), 微破 light, 搖滾 = 丁, 重金屬 clearly more broken than 丁', () => {
  const m = Object.fromEntries(PRESETS.map(p => {
    const rig = rigFromSnapshot(presetSnapshot(p.id));
    return [p.id, { rig, drive: rigDriveDb(rig), ...distortionProducts(rigStages(rig)) }];
  }));
  assert.equal(m.clean.rig.engaged, false);
  assert.ok(m.clean.distortion < -38, `清音 distortion ${m.clean.distortion}`);
  assert.ok(m.crunch.distortion > m.clean.distortion + 5 && m.crunch.distortion < m.rock.distortion - 10, `微破 ${m.crunch.distortion}`);
  assert.ok(m.metal.drive > m.rock.drive + 15, `重金屬 drive ${m.metal.drive} vs ${m.rock.drive}`);
  assert.ok(m.metal.distortion > m.rock.distortion + 1 && m.metal.fizz > m.rock.fizz + 4, `重金屬 ${m.metal.distortion}/${m.metal.fizz} vs ${m.rock.distortion}/${m.rock.fizz}`);
  assert.ok(m.metal.rig.distortion.fuzz > 0.3);
  // Nothing without sound is switched on by a preset.
  for (const p of PRESETS) for (const id of Object.keys(p.on)) assert.ok(PEDALS_WITH_SOUND.includes(id), `${p.id}: ${id}`);
  return PRESETS.map(p => `${p.id} ${m[p.id].drive.toFixed(0)} dB, products ${m[p.id].distortion.toFixed(0)} / fizz ${m[p.id].fizz.toFixed(0)} dB`).join('; ');
});

test('auto-level: loudness stays within 1 dB of 丁 across presets and the whole drive macro', () => {
  const reference = loudnessDb(driveSnapshot(DING_KNOBS.overdrive.drive, DING_KNOBS.distortion.drive), { levelTable: AUTO_LEVEL_DB, seconds: 2 });
  const offsets = [];
  for (const id of ['clean', 'crunch', 'metal']) offsets.push([id, loudnessDb(presetSnapshot(id), { levelTable: AUTO_LEVEL_DB, seconds: 2 }) - reference]);
  for (const v of [0, 0.35, 0.65, 1]) offsets.push([`both ${v}`, loudnessDb(driveSnapshot(v, v), { levelTable: AUTO_LEVEL_DB, seconds: 2 }) - reference]);
  for (const [name, offset] of offsets) assert.ok(Math.abs(offset) < 1, `${name}: ${offset.toFixed(2)} dB`);
  // Advanced mode: the level knobs are offsets from the matched level.
  const loud = rigFromSnapshot({ autoLevel: false, pedals: { overdrive: { on: true, params: { drive: 0.3, level: 1 } }, distortion: { on: false, params: {} } } });
  assert.ok(Math.abs(loud.overdrive.level - 6) < 1e-9);
  return offsets.map(([n, o]) => `${n} ${o >= 0 ? '+' : ''}${o.toFixed(1)}`).join(', ');
});

test('chokes at the ends of the range: chord change ≥ 40 dB down at 80 ms (Node model)', () => {
  const notes = [];
  for (const [name, snapshot] of [['清音', presetSnapshot('clean')], ['重金屬', presetSnapshot('metal')], ['max', driveSnapshot(1, 1)]]) {
    const tone = electricTone(rigFromSnapshot(snapshot));
    const out = renderPart(tone, strum(A5_EIGHT, { velocity: 1 }), { duration: 0.6, chokes: [{ time: 0.4, keep: [] }], settings: SETTINGS, sampleRate: 44100, seed: 5 });
    const drop = db(rms(out, 0.48, 0.49) / rms(out, 0.38, 0.4));
    assert.ok(drop <= -40, `${name}: ${drop.toFixed(1)} dB`);
    for (const v of out.left) assert.ok(Number.isFinite(v) && Math.abs(v) < 4);
    notes.push(`${name} ${drop.toFixed(0)} dB`);
  }
  return notes.join(', ');
});

// ---------- voicing ----------
test('voicing rule: power chords only while overdrive or distortion is on', () => {
  const electric = TONES.electric;
  assert.equal(electric.voicing, 'auto');
  assert.equal(toneVoicing(electric, null), 'power', 'no pedalboard: 丁');
  assert.equal(toneVoicing(electric, presetSnapshot('clean')), 'triad');
  for (const id of ['crunch', 'rock', 'metal']) assert.equal(toneVoicing(electric, presetSnapshot(id)), 'power', id);
  const model = createPedalModel();
  model.applyPreset('clean');
  model.toggle('reverb', true); model.toggle('wah', true);
  assert.equal(toneVoicing(electric, model.snapshot()), 'triad', 'silent pedals do not count');
  model.toggle('distortion', true);
  assert.equal(toneVoicing(electric, model.snapshot()), 'power');
  for (const tone of [TONES.steel, TONES.nylon]) assert.equal(toneVoicing(tone, presetSnapshot('metal')), 'triad');
  assert.equal(toneVoicing(LAB_COMBOS.labA, presetSnapshot('clean')), 'power', 'lab tones keep their own voicing');
});

// ---------- smoothing ----------
// A knob dragged from 0 to 1 in one second, one update per 30 fps frame, each a setTargetAtTime with
// the knob time constant: per 128-frame block, how far does any number move?
test('smoothing: a knob drag glides — small steps per 128-frame block', () => {
  const sampleRate = 48000, block = 128, frames = 30;
  const numbersAt = v => stageNumbers(rigStages(rigFromSnapshot(driveSnapshot(v, v))));
  const kinds = [];
  const label = list => list.forEach(st => {
    if (st.kind === 'biquad') kinds.push('freq', 'q', 'db');
    else if (st.kind === 'gain') kinds.push('gain');
    else if (st.kind === 'wahFilter') kinds.push('freq', 'cents', 'qscale');
    else if (st.kind === 'wahGain') kinds.push('gain', 'slope');
    else if (st.kind === 'mix') st.branches.forEach(br => { kinds.push('weight'); label(br.stages); });
  });
  label(rigStages(rigFromSnapshot(null)));
  let current = numbersAt(0);
  const k = 1 - Math.exp(-block / sampleRate / PEDAL_TAU.knob);
  let worstGainDb = 0, worstWeight = 0, worstShelfDb = 0;
  const blocksPerFrame = sampleRate / frames / block;
  for (let b = 0; b < (frames + 10) * blocksPerFrame; b++) {
    const target = numbersAt(Math.min(1, Math.floor(b / blocksPerFrame) / frames));
    const next = current.map((v, i) => (v === undefined ? v : v + (target[i] - v) * k));
    next.forEach((v, i) => {
      if (v === undefined) return;
      if (kinds[i] === 'gain' && v > 1e-6 && current[i] > 1e-6) worstGainDb = Math.max(worstGainDb, Math.abs(db(v / current[i])));
      if (kinds[i] === 'weight') worstWeight = Math.max(worstWeight, Math.abs(v - current[i]));
      if (kinds[i] === 'db') worstShelfDb = Math.max(worstShelfDb, Math.abs(v - current[i]));
    });
    current = next;
  }
  assert.ok(worstGainDb < 1, `gain step ${worstGainDb.toFixed(2)} dB per block`);
  assert.ok(worstWeight < 0.02, `fuzz blend step ${worstWeight.toFixed(3)} per block`);
  assert.ok(worstShelfDb < 0.5, `filter gain step ${worstShelfDb.toFixed(2)} dB per block`);
  return `drive macro 0 → 1 in 1 s: gains ≤ ${worstGainDb.toFixed(2)} dB, blend ≤ ${worstWeight.toFixed(3)}, filter gains ≤ ${worstShelfDb.toFixed(2)} dB per block`;
});

test('smoothing: switching pedals cross-fades two settled sounds — no level spike, no dropout, no NaN', () => {
  const sampleRate = 44100, seconds = 1.6;
  const tone = electricTone(rigFromSnapshot(presetSnapshot('rock')));
  // The voices' sum at the chain input (Node model with an empty chain).
  const dry = renderPart({ ...tone, stages: [], double: null }, strum(A5.slice(0, 4), { velocity: 0.8 }), { duration: seconds, settings: SETTINGS, sampleRate, seed: 3 });
  const settled = id => processStages(rigStages(rigFromSnapshot(id === 'max' ? driveSnapshot(1, 1) : presetSnapshot(id))), dry.left, sampleRate);
  // Every 0.2 s another preset (or the whole drive range), cross-faded as buildSwitchableStages does
  // (silent copy set, 5 ms later both faders glide with the toggle time constant).
  const timeline = [[0, 'rock'], [0.2, 'clean'], [0.4, 'metal'], [0.6, 'crunch'], [0.8, 'rock'], [1.0, 'max'], [1.2, 'clean'], [1.4, 'rock']];
  const outs = timeline.map(([, id]) => settled(id));
  const out = new Float32Array(dry.left.length);
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    let k = 0;
    while (k + 1 < timeline.length && timeline[k + 1][0] <= t) k++;
    if (k === 0) { out[i] = outs[0][i]; continue; }
    const into = Math.max(0, t - timeline[k][0] - 0.005);
    const w = 1 - Math.exp(-into / PEDAL_TAU.toggle);
    out[i] = outs[k - 1][i] * (1 - w) + outs[k][i] * w;
  }
  for (const v of out) assert.ok(Number.isFinite(v));
  const env = (signal, t) => rms({ sampleRate, left: signal, right: signal }, t, t + 0.005);
  let over = -Infinity, under = Infinity;
  for (let k = 1; k < timeline.length; k++) {
    const t0 = timeline[k][0];
    for (let t = t0; t < t0 + 0.06; t += 0.0025) {
      const a = env(outs[k - 1], t), b = env(outs[k], t), mixed = env(out, t);
      over = Math.max(over, db(mixed / Math.max(a, b)));
      under = Math.min(under, db(mixed / Math.min(a, b)));
    }
  }
  assert.ok(over < 1, `overshoot ${over.toFixed(1)} dB`);
  assert.ok(under > -8, `dip ${under.toFixed(1)} dB`);
  return `during switches the 5 ms level stays within ${under.toFixed(1)} … +${Math.max(0, over).toFixed(1)} dB of the two settled sounds`;
});

test('switchable chain: a switch sets the silent copy at once and cross-fades; a second one during the fade glides', () => {
  const ctx = new FakeAudioContext();
  const a = rigStages(rigFromSnapshot(presetSnapshot('rock'))), b = rigStages(rigFromSnapshot(presetSnapshot('clean')));
  const chain = buildSwitchableStages(ctx, a);
  const faders = ctx.created.filter(n => n.kind === 'gain' && n.gain.value === 0 && [...n.outputs].includes(chain.output));
  assert.equal(chain.active, 0);
  ctx.currentTime = 2;
  assert.equal(chain.switchTo(b, { fade: PEDAL_TAU.toggle }), true);
  assert.equal(chain.active, 1);
  const calls = ctx.created.flatMap(n => Object.values(n).filter(v => v?.calls).flatMap(p => p.calls));
  assert.ok(calls.some(c => c.type === 'set' && c.time === 2), 'silent copy set instantly');
  assert.ok(faders.length === 1 && faders[0].gain.calls.some(c => c.type === 'target' && c.target === 1 && c.time > 2));
  ctx.currentTime = 2.02;
  assert.equal(chain.switchTo(a, { fade: PEDAL_TAU.toggle }), false, 'still fading: glide instead');
  assert.equal(chain.active, 1);
  ctx.currentTime = 3;
  assert.equal(chain.switchTo(a, { fade: PEDAL_TAU.toggle }), true);
  assert.throws(() => chain.update([{ kind: 'gain', value: 1 }]), /shape/);
});

// ---------- split pluck rendering (replaces a buffer cache) ----------
test('split pluck: head + tail rendered in pieces equal the one-shot render exactly', () => {
  let cases = 0;
  const sustained = electricTone({ ...rigFromSnapshot(null), sustain: 1 });
  for (const tone of [TONES.electric, TONES.steel, LAB_COMBOS.labA, sustained]) {
    for (const freq of [82.4, 110, 164.8, 440, 1318]) {
      for (const velocity of [0.1, 0.6, 1]) {
        const { render } = voiceParams(tone, { freq, velocity, position: 0.3 }, SETTINGS);
        const whole = renderPluck({ ...render, sampleRate: 48000, random: seeded(freq | 0) });
        const pluck = createPluck({ ...render, sampleRate: 48000, random: seeded(freq | 0) });
        const pieces = [];
        for (const size of [Math.round(PLUCK_HEAD_SECONDS * 48000), 1, 4095, 100000, Infinity]) pieces.push(pluck.next(size === Infinity ? pluck.length : size));
        const joined = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of pieces) { joined.set(p, o); o += p.length; }
        assert.equal(joined.length, whole.length);
        for (let i = 0; i < whole.length; i++) if (joined[i] !== whole[i]) throw new Error(`${tone.id} ${freq} Hz: sample ${i}`);
        // Normalised by the peak of the first PEAK_WINDOW_SECONDS (before the 1.5 ms attack ramp).
        let peak = 0;
        for (const v of whole) peak = Math.max(peak, Math.abs(v));
        assert.ok(peak <= 1 + 1e-6 && peak > 0.5, `${tone.id} ${freq}: peak ${peak}`);
        cases++;
      }
    }
  }
  return `${cases} plucks; peak window ${PEAK_WINDOW_SECONDS} s`;
});

// ---------- engine with a fake AudioContext ----------
function engineWith(o = {}) {
  const ctx = new FakeAudioContext();
  const engine = createAudioEngine({ ...SETTINGS, ...o }, { context: ctx, streaming: true });
  return { ctx, engine };
}

test('engine: pedal changes glide on the existing chain (no new nodes), and the choke depth follows the drive', () => {
  const { ctx, engine } = engineWith();
  engine.setTone(TONES.electric);
  const nodes = ctx.created.length;
  const shapers = ctx.created.filter(n => n.kind === "shaper" && n.oversample !== "none");   // not the master ceiling
  const curves = shapers.map(n => n.curve);
  const depthRock = engine.tone.releaseDepthDb;
  engine.applyPedals(presetSnapshot('metal'), { type: 'preset', id: 'metal' });
  engine.applyPedals(driveSnapshot(1, 1), { type: 'param', id: 'distortion', knob: 'drive', value: 1, commit: false });
  assert.equal(ctx.created.length, nodes, 'nothing rebuilt');
  assert.deepEqual(shapers.map(n => n.curve), curves, 'curves never swapped');
  const calls = ctx.created.flatMap(n => Object.values(n).filter(v => v?.calls).flatMap(p => p.calls));
  const targets = calls.filter(c => c.type === 'target');
  assert.ok(targets.some(c => c.tau === PEDAL_TAU.knob) && targets.some(c => c.tau === PEDAL_TAU.toggle));
  assert.ok(targets.every(c => c.tau === PEDAL_TAU.toggle || c.tau === PEDAL_TAU.knob));
  assert.ok(calls.some(c => c.type === 'set'), 'the preset set the silent copy');
  assert.ok(engine.tone.releaseDepthDb > depthRock + 30, `${engine.tone.releaseDepthDb} vs ${depthRock}`);
  // Oversampling is the same on every shaper, so bypass and clipper branches line up in time.
  assert.ok(shapers.every(n => n.oversample === '4x'));
  // A rebuilt tone picks up the current settings.
  engine.applyPedals(presetSnapshot('clean'));
  engine.setTone(TONES.steel);
  engine.setTone(TONES.electric);
  assert.equal(engine.rig.engaged, false);
  assert.ok(engine.tone.releaseDepthDb < depthRock);
  return `${nodes} nodes for two takes × two copies; choke depth follows the drive`;
});

test('engine: a pluck renders only its head now; the tail starts exactly where the head ends', () => {
  const { ctx, engine } = engineWith();
  engine.setTone(TONES.electric);
  ctx.currentTime = 1.23456;
  engine.pluck({ freq: 110, velocity: 0.6, delay: 0.0101 });
  const heads = ctx.sources.slice();
  assert.equal(heads.length, 2, 'two takes (double-tracking)');
  const headLength = Math.round(PLUCK_HEAD_SECONDS * ctx.sampleRate);
  for (const s of heads) {
    assert.equal(s.buffer.length, headLength);
    assert.ok(Number.isInteger(Math.round(s.startedAt * ctx.sampleRate * 1e6) / 1e6), 'starts on a sample frame');
  }
  assert.equal(engine.pendingTails, 2);
  engine.flushTails();
  assert.equal(engine.pendingTails, 0);
  const tails = ctx.sources.slice(2);
  assert.equal(tails.length, 2);
  tails.forEach((tail, i) => {
    assert.ok(Math.abs(tail.startedAt - (heads[i].startedAt + headLength / ctx.sampleRate)) < 1e-9);
    assert.equal(tail.offset, 0);
    const { render } = voiceParams(engine.tone, { freq: 110, velocity: 0.6 }, SETTINGS);
    assert.equal(heads[i].buffer.length + tail.buffer.length, createPluck({ ...render, freq: i ? render.freq * Math.pow(2, 4 / 1200) : 110, sampleRate: ctx.sampleRate }).length);
  });
});

test('engine: tails of choked voices are never rendered; voices clean up when their sources end', () => {
  const { ctx, engine } = engineWith();
  engine.setTone(TONES.electric);
  const strumOnce = time => { ctx.currentTime = time; for (const freq of A5.slice(0, 4)) engine.pluck({ freq, velocity: 0.7 }); };
  strumOnce(1);
  strumOnce(1.3);                       // a new strum: strum choke (30 ms) on the first one
  strumOnce(1.6);
  assert.equal(engine.pendingTails, 24);
  engine.flushTails();
  const tails = ctx.sources.filter(s => s.buffer.length !== Math.round(PLUCK_HEAD_SECONDS * ctx.sampleRate));
  assert.equal(tails.length, 8, 'only the last strum keeps its tails');
  assert.ok(tails.every(t => t.startedAt > 1.6));
  // End every source: all voices go away.
  for (const s of ctx.sources) s.end();
  assert.equal(engine.voiceCount, 0);
});

test('engine: main-thread time per 8-string strum, whole buffers vs head only (Node, fake context)', () => {
  const time = streaming => {
    const ctx = new FakeAudioContext();
    const engine = createAudioEngine(SETTINGS, { context: ctx, streaming });
    engine.setTone(TONES.electric);
    const freqs = A5_EIGHT;
    let total = 0;
    for (let k = 0; k < 12; k++) {
      ctx.currentTime = k * 0.4;
      const t0 = performance.now();
      for (const freq of freqs) engine.pluck({ freq, velocity: 0.7 });
      if (k >= 2) total += performance.now() - t0;
    }
    return total / 10;
  };
  const whole = time(false), head = time(true);
  assert.ok(head < whole * 0.5, `head ${head.toFixed(2)} ms vs whole ${whole.toFixed(2)} ms`);
  return `whole ${whole.toFixed(1)} ms → head ${head.toFixed(1)} ms per strum (tails later, ≤ 4 ms slices, most never rendered)`;
});

// ---------- 延音 (sustain knob) ----------
const sustainSnapshot = (preset, sustain) => { const m = createPedalModel(); m.applyPreset(preset); m.setParam('amp', 'sustain', sustain); return m.snapshot(); };
const sustainTone = (preset, sustain) => electricTone(rigFromSnapshot(sustainSnapshot(preset, sustain)));
// −10 / −20 dB times of one 4-string A5 strum (velocity 0.6), as src/lab/metrics.js measureSustain.
function decayTimes(tone, seconds = 9) {
  const out = renderPart(tone, strum(A5.slice(0, 4), { velocity: 0.6 }), { duration: seconds, settings: SETTINGS, sampleRate: 44100, seed: 3 });
  let ref = -Infinity;
  for (let t = 0.05; t <= 0.3; t += 0.01) ref = Math.max(ref, levelAt(out, t, 0.025));
  const below = drop => { for (let t = 0.1; t < seconds - 0.05; t += 0.01) if (levelAt(out, t, 0.025) < ref - drop) return t; return seconds - 0.05; };
  return [below(10), below(20)];
}

test('sustain: the knob lengthens the decay monotonically (clean, 搖滾); 0 is the plain string', () => {
  const rows = [];
  for (const preset of ['clean', 'rock']) {
    let previous = 0;
    const times = [];
    for (const sustain of [0, 0.5, 1]) {
      const [ten, twenty] = decayTimes(sustainTone(preset, sustain));
      assert.ok(ten > previous + 0.3, `${preset} ${sustain}: −10 dB at ${ten.toFixed(2)} s after ${previous.toFixed(2)} s`);
      assert.ok(twenty > ten);
      previous = ten;
      times.push(`${ten.toFixed(2)}/${twenty.toFixed(2)}`);
    }
    rows.push(`${preset} ${times.join(' → ')} s`);
  }
  const [cleanMax] = decayTimes(sustainTone('clean', 1));
  assert.ok(cleanMax >= 2.4, `clean at max rings like 搖滾 at default: ${cleanMax.toFixed(2)} s`);
  return `−10/−20 dB at 延音 0 / 0.5 / 1: ${rows.join('; ')}`;
});

test('sustain: at the default (0) every preset is exactly what it was (stages, voice params, samples)', () => {
  const model = createPedalModel();
  assert.equal(model.param('amp', 'sustain'), 0, 'default off');
  for (const preset of PRESETS) {
    const before = presetSnapshot(preset.id);
    const old = { ...before }; delete old.amp;                    // a snapshot from before the amp had knobs
    const tone = electricTone(rigFromSnapshot(before));
    assert.equal(tone.sustain, 0);
    assert.deepEqual(rigStages(rigFromSnapshot(before)), rigStages(rigFromSnapshot(old)), preset.id);
    const { render } = voiceParams(tone, { freq: 110, velocity: 0.6 }, SETTINGS);
    assert.equal('sustain' in render, false, 'no sustain option at 0');
    const a = renderPluck({ ...render, sampleRate: 44100, random: seeded(9) });
    const b = renderPluck({ ...render, sustain: 0, sampleRate: 44100, random: seeded(9) });
    assert.deepEqual(a, b);
    // The knob only touches the strings, never the chain.
    assert.deepEqual(rigStages(rigFromSnapshot(sustainSnapshot(preset.id, 1))), rigStages(rigFromSnapshot(before)), `${preset.id}: chain unchanged`);
  }
  assert.equal(electricTone(rigFromSnapshot(null)).sustain, 0, 'no pedalboard: 丁 as before');
});

test('sustain: the attack passes untouched; the buffer never exceeds its peak; length stretches with the make-up', () => {
  for (const freq of [82.4, 196, 659]) {
    const base = { freq, t60: 4, damping: 0.15, brightness: 0.8, pickPosition: 0.15, maxSeconds: 6, sampleRate: 44100 };
    const plain = renderPluck({ ...base, random: seeded(4) });
    const held = renderPluck({ ...base, sustain: 1, random: seeded(4) });
    assert.ok(Math.abs(held.length / plain.length - sustainStretch(1)) < 0.01, `${freq}: length ×${(held.length / plain.length).toFixed(3)}`);
    let peak = 0;
    for (const v of held) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak <= 1 + 1e-6, `${freq}: peak ${peak}`);
    for (let i = 0; i < 441; i++) assert.ok(Math.abs(held[i] - plain[i]) < 0.02, `${freq}: first 10 ms changed at ${i}`);
  }
  const { ratio, makeupDb } = sustainerSettings(1);
  return `max: ratio ${ratio}, make-up ≤ ${makeupDb} dB, rendered ×${sustainStretch(1).toFixed(2)} longer`;
});

// The strum choke of a driven tone takes a few ms longer with 延音 (the clippers get a hotter, more
// fundamental-heavy signal and the amp's low filters ring out after it): checked at 50 ms, reported at 30.
test('sustain: at max the chord-change choke is still ≥ 40 dB at 80 ms; a new strum still clears it by 50 ms', () => {
  const rows = [];
  for (const preset of ['clean', 'rock', 'metal']) {
    const depth = sustain => {
      const tone = sustainTone(preset, sustain);
      const out = renderPart(tone, strum(A5_EIGHT, { velocity: 1 }), { duration: 0.6, chokes: [{ time: 0.4, keep: [] }], settings: SETTINGS, sampleRate: 44100, seed: 2 });
      const chord = -db(rms(out, 0.48, 0.49) / rms(out, 0.38, 0.4));
      const s = renderPart(tone, strum(A5_EIGHT, { velocity: 1 }), { duration: 0.6, chokes: [{ time: 0.4, all: true, fade: tone.strumChoke }], settings: SETTINGS, sampleRate: 44100, seed: 2 });
      const at = ms => -db(rms(s, 0.4 + ms / 1000, 0.41 + ms / 1000) / rms(s, 0.38, 0.4));
      return { chord, strumDepth: at(tone.strumChoke * 1000), at50: at(50) };
    };
    const off = depth(0), max = depth(1);
    assert.ok(max.chord >= 40, `${preset}: chord choke ${max.chord.toFixed(1)} dB`);
    assert.ok(max.at50 >= 40, `${preset}: strum choke at 50 ms ${max.at50.toFixed(1)} dB`);
    rows.push(`${preset} ${max.chord.toFixed(0)} dB (strum at 30 ms ${off.strumDepth.toFixed(0)} → ${max.strumDepth.toFixed(0)}, at 50 ms ${max.at50.toFixed(0)})`);
  }
  return `chord choke at 80 ms with 延音 max (strum choke default → max): ${rows.join(', ')}`;
});

test('sustain: ringing chords at max against the demo song stay safe (peak ≤ 0.99, limiter ≤ 3 dB)', () => {
  const rate = 44100, seconds = 8;
  const demo = renderDemoSong(rate).samples;
  const song = { left: demo.slice(rate * 4, rate * (4 + seconds)), right: demo.slice(rate * 4, rate * (4 + seconds)) };
  const rows = [];
  for (const preset of ['clean', 'rock', 'metal']) {
    // One 8-string strum per bar (100 BPM), chord changes on the bar, nothing kept.
    const events = [], chokes = [];
    for (let bar = 0; bar < 4; bar++) {
      const time = bar * 2.4;
      if (bar) chokes.push({ time, keep: [] });
      events.push(...strum(A5_EIGHT, { time, velocity: 0.8 }));
    }
    const part = renderPart(sustainTone(preset, 1), events, { duration: seconds, chokes, settings: SETTINGS, sampleRate: rate, seed: 6 });
    const mix = renderMaster(part, song, { sampleRate: rate, settings: SETTINGS });
    let limiter = 0;
    for (let i = rate; i < mix.reductionDb.length; i++) limiter = Math.min(limiter, mix.reductionDb[i]);
    const peak = peakOf(mix);
    assert.ok(peak <= 0.99, `${preset}: peak ${peak}`);
    assert.ok(-limiter <= 3, `${preset}: limiter ${(-limiter).toFixed(1)} dB`);
    rows.push(`${preset} ${peak.toFixed(3)} / ${(-limiter).toFixed(1)} dB`);
  }
  return `peak / limiter: ${rows.join(', ')}`;
});

test('sustain: the engine picks the knob up for the next pluck without touching the chain', () => {
  const { ctx, engine } = engineWith();
  engine.setTone(TONES.electric);
  const nodes = ctx.created.length;
  engine.applyPedals(presetSnapshot('rock'));
  assert.equal(engine.tone.sustain, 0);
  engine.applyPedals(sustainSnapshot('rock', 0.8), { type: 'param', id: 'amp', knob: 'sustain', value: 0.8, commit: true });
  assert.equal(engine.tone.sustain, 0.8);
  assert.equal(ctx.created.length, nodes, 'no node created or rebuilt');
  ctx.currentTime = 1;
  const before = ctx.sources.length;
  engine.pluck({ freq: 110, velocity: 0.6 });
  engine.flushTails();
  const lengths = ctx.sources.slice(before).reduce((n, s) => n + s.buffer.length, 0);
  const { render } = voiceParams(engine.tone, { freq: 110, velocity: 0.6 }, SETTINGS);
  assert.equal(render.sustain, 0.8);
  const plain = createPluck({ ...render, sustain: 0, sampleRate: ctx.sampleRate }).length * 2;
  assert.ok(lengths > plain * 1.2, `sustained notes render longer: ${lengths} vs ${plain} samples`);
});

test('sustain: main-thread time per 8-string strum at max stays near the default (Node, fake context)', () => {
  const time = sustain => {
    const ctx = new FakeAudioContext();
    const engine = createAudioEngine(SETTINGS, { context: ctx, streaming: true });
    engine.setTone(TONES.electric);
    engine.applyPedals(sustainSnapshot('rock', sustain));
    let total = 0;
    for (let k = 0; k < 14; k++) {
      ctx.currentTime = k * 0.4;
      const t0 = performance.now();
      for (const freq of A5_EIGHT) engine.pluck({ freq, velocity: 0.7 });
      if (k >= 4) total += performance.now() - t0;
    }
    return total / 10;
  };
  time(0); time(1);                       // warm up
  const off = time(0), max = time(1);
  assert.ok(max < off * 1.6 + 1, `max ${max.toFixed(2)} ms vs default ${off.toFixed(2)} ms`);
  return `head per strum: default ${off.toFixed(2)} ms, 延音 max ${max.toFixed(2)} ms (tails later in ≤ 4 ms slices)`;
});

console.table(results);
const failed = results.filter(r => r.result === 'FAIL').length;
if (failed) { console.error(`${failed} test(s) failed`); process.exit(1); }
console.log('electric rig tests passed');
