// node tests/post-fx.test.mjs
// The post-effects bus (src/core/audio/post-fx/): chorus → delay → reverb once per engine part,
// after both takes and the trim. Bypass is exact, the order is fixed, the engine passes pedal
// settings, tempo, chord changes and strums to the modules, and nothing is rebuilt on pedal changes.
import assert from 'node:assert/strict';
import { POST_FX_ORDER, POST_FX_MODULES, createPostFxBus, postFxParams, processPostFx } from '../src/core/audio/post-fx/index.js';
import { createAudioEngine, PEDAL_TAU } from '../src/core/audio/engine.js';
import { TONES } from '../src/core/audio/tones.js';
import { createPedalModel } from '../src/core/pedals/model.js';
import { renderPart } from '../tools/tone-lab/model.mjs';
import { SETTINGS } from '../src/settings.js';
import { FakeAudioContext } from './fake-audio-context.mjs';

const results = [];
function test(name, fn) {
  try { const note = fn(); results.push({ test: name, result: 'PASS', detail: note ?? '' }); }
  catch (error) { results.push({ test: name, result: 'FAIL', detail: error.message.split('\n')[0] }); }
}

// Every node reachable from `from` (fake graph).
function reachable(from) {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of node.outputs) stack.push(next);
  }
  return seen;
}
const paramCalls = node => Object.values(node).filter(v => v?.calls).flatMap(p => p.calls);

// Spy modules: bypass wiring plus a log of every call.
function spies() {
  const log = [];
  const modules = {};
  for (const id of POST_FX_ORDER) {
    modules[id] = {
      id,
      paramsFromSnapshot: POST_FX_MODULES[id].paramsFromSnapshot,
      create(ctx, { input, output, part }) {
        log.push({ id, call: 'create', part });
        input.connect(output);
        return {
          apply: (params, change, o) => log.push({ id, call: 'apply', params, change, ...o }),
          setTempo: (tempo, o) => log.push({ id, call: 'setTempo', tempo, ...o }),
          onChordChange: time => log.push({ id, call: 'onChordChange', time }),
          onStrum: (time, velocity) => log.push({ id, call: 'onStrum', time, velocity }),
          dispose: () => log.push({ id, call: 'dispose' }),
        };
      },
    };
  }
  return { log, modules, calls: (call, id = 'delay') => log.filter(e => e.call === call && e.id === id) };
}

function soundingSnapshot(on = { chorus: true, delay: true, reverb: true }) {
  const model = createPedalModel();
  const snapshot = structuredClone(model.snapshot());
  // The pedals have no sound yet (model.js PEDALS_WITH_SOUND); pretend they do.
  for (const id of POST_FX_ORDER) { snapshot.pedals[id].sound = true; snapshot.pedals[id].on = !!on[id]; }
  return snapshot;
}

test('order: chorus → delay → reverb, slot n output = slot n+1 input', () => {
  assert.deepEqual(POST_FX_ORDER, ['chorus', 'delay', 'reverb']);
  const ctx = new FakeAudioContext();
  const bus = createPostFxBus(ctx);
  assert.deepEqual(bus.slots.map(s => s.id), POST_FX_ORDER);
  assert.equal(bus.slots[0].input, bus.input);
  for (let i = 1; i < bus.slots.length; i++) assert.equal(bus.slots[i].input, bus.slots[i - 1].output);
  assert.equal(bus.slots.at(-1).output, bus.output);
});

test('bypass: every slot keeps input → output at unity; anything else into an output is a gain at exactly 0', () => {
  const ctx = new FakeAudioContext();
  const bus = createPostFxBus(ctx);
  bus.apply(postFxParams(soundingSnapshot({})), { type: 'load' });   // sounding pedals, all off
  bus.setTempo({ pulseSeconds: 0.286, beatSeconds: 0.571 });
  bus.onChordChange(1); bus.onStrum(1, 0.8);
  for (const slot of bus.slots) {
    assert.ok(slot.input.outputs.has(slot.output), `${slot.id}: dry path`);
    for (const n of [slot.input, slot.output]) {
      assert.equal(n.gain.value, 1);
      assert.equal(paramCalls(n).length, 0, 'no automation on the dry path');
    }
    const into = ctx.created.filter(n => n !== slot.input && n.outputs.has(slot.output));
    for (const n of into) {
      assert.equal(n.kind, 'gain', `${slot.id}: wet return is a gain`);
      assert.equal(n.gain.value, 0, `${slot.id}: wet return closed`);
      assert.equal(paramCalls(n).length, 0, `${slot.id}: wet return not automated while off`);
    }
  }
  bus.dispose();
  assert.equal(bus.input.outputs.size, 0);
});

test('bypass (Node model): processPostFx and renderPart with post are sample-exact when off', () => {
  const left = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 7) * 0.7);
  const right = Float32Array.from(left, x => -x * 0.5);
  const out = processPostFx(postFxParams(soundingSnapshot({})), { left, right }, { sampleRate: 48000 });
  assert.deepEqual(out.left, left); assert.deepEqual(out.right, right);
  const events = [0, 0.01, 0.02, 0.5].map((time, i) => ({ time, freq: 110 * (i + 1), velocity: 0.7 }));
  const tone = TONES.electric;
  const o = { duration: 1, settings: SETTINGS, chokes: [{ time: 0.5, keep: [9, 4] }] };
  const plain = renderPart(tone, events, o);
  const post = renderPart(tone, events, { ...o, post: postFxParams(null), tempo: { pulseSeconds: 0.3, beatSeconds: 0.6 } });
  assert.deepEqual(post.left, plain.left); assert.deepEqual(post.right, plain.right);
});

test('paramsFromSnapshot: off without snapshot, for pedals without sound, and when switched off', () => {
  for (const id of POST_FX_ORDER) {
    const read = POST_FX_MODULES[id].paramsFromSnapshot;
    assert.equal(read(null).on, false);
    const silent = createPedalModel().snapshot();
    silent.pedals[id].on = true; silent.pedals[id].sound = false;
    assert.equal(read(silent).on, false, 'no sound');
    assert.equal(read(soundingSnapshot({})).on, false);
    const on = read(soundingSnapshot());
    assert.equal(on.on, true);
    assert.deepEqual(on.values, soundingSnapshot().pedals[id].values);
  }
});

test('engine: rhythm takes → trim → post bus → string gain, built once per part', () => {
  const ctx = new FakeAudioContext();
  const { log, modules } = spies();
  const engine = createAudioEngine(SETTINGS, { context: ctx, postFx: modules });
  engine.setTone(TONES.electric);
  const bus = engine.postFx('rhythm');
  const panners = ctx.created.filter(n => n.kind === 'panner');
  assert.equal(panners.length, 2, 'main + double take');
  for (const p of panners) assert.ok(reachable(p).has(bus.input), 'take reaches the post bus');
  assert.ok(reachable(bus.output).has(ctx.destination));
  engine.setTone(TONES.steel);
  engine.setTone(TONES.electric);
  assert.equal(engine.postFx('rhythm'), bus, 'setTone keeps the bus');
  assert.equal(log.filter(e => e.call === 'create').length, 3, 'one create per slot');
  assert.ok(log.filter(e => e.call === 'create').every(e => e.part === 'rhythm'));
});

test('engine: pedal snapshot reaches the modules without rebuilding; rig parts only', () => {
  const ctx = new FakeAudioContext();
  const { log, modules, calls } = spies();
  const engine = createAudioEngine(SETTINGS, { context: ctx, postFx: modules });
  engine.setTone(TONES.electric);
  const nodes = ctx.created.length;
  const snapshot = soundingSnapshot({ delay: true });
  engine.applyPedals(snapshot, { type: 'toggle', id: 'delay', on: true });
  let last = calls('apply').at(-1);
  assert.equal(last.params.on, true);
  assert.equal(last.change.type, 'toggle');
  assert.equal(last.tau, PEDAL_TAU.toggle);
  assert.equal(calls('apply', 'reverb').at(-1).params.on, false);
  snapshot.pedals.delay.values.feedback = 0.42;
  engine.applyPedals(snapshot, { type: 'param', id: 'delay', knob: 'feedback' });
  last = calls('apply').at(-1);
  assert.equal(last.tau, PEDAL_TAU.knob);
  assert.equal(last.params.values.feedback, 0.42);
  assert.equal(ctx.created.length, nodes, 'no nodes created');
  // A non-rig tone gets everything off; back on the rig, the board's settings again.
  engine.setTone(TONES.steel);
  last = calls('apply').at(-1);
  assert.deepEqual([last.change.type, last.params.on], ['tone', false]);
  engine.applyPedals(snapshot, { type: 'param' });
  assert.equal(calls('apply').at(-1).params.on, false, 'steel stays bypassed');
  engine.setTone(TONES.electric);
  assert.equal(calls('apply').at(-1).params.on, true);
  assert.equal(log.filter(e => e.call === 'create').length, 3);
});

test('engine: setTempo, onChordChange and onStrum reach every slot with the right values', () => {
  const ctx = new FakeAudioContext();
  const { modules, calls } = spies();
  const engine = createAudioEngine(SETTINGS, { context: ctx, postFx: modules });
  engine.setTone(TONES.electric);
  const tempo = { pulseSeconds: 0.2857, beatSeconds: 0.5714 };
  engine.setTempo(tempo);
  for (const id of POST_FX_ORDER) assert.deepEqual(calls('setTempo', id).at(-1).tempo, tempo);
  engine.setTempo(null);
  assert.equal(calls('setTempo').at(-1).tempo, null);
  engine.setTempo(tempo);
  // A part created later gets the tempo when it is built.
  engine.setTone(TONES.electric, 'lead');
  assert.deepEqual(calls('setTempo').filter(e => e.tempo).length, 3, 'rhythm ×2, lead ×1');
  // Chord change: the choke time, for every tone (steel lets chords ring but the delay still ducks).
  engine.chokeChord([0, 4, 7], { when: 1.25 });
  assert.equal(calls('onChordChange').at(-1).time, 1.25);
  engine.setTone(TONES.steel);
  engine.chokeChord([0, 4, 7], { when: 2.5 });
  assert.equal(calls('onChordChange').at(-1).time, 2.5);
  engine.setTone(TONES.electric);
  // Strums: the first pluck of each strum (strumWindow apart), at its start time.
  const window = SETTINGS.strumWindow / 1000;
  for (const delay of [0.1, 0.11, 0.12, 0.12 + window + 0.01, 0.12 + window + 0.02]) engine.pluck({ freq: 110, velocity: 0.8, delay });
  const strums = calls('onStrum').map(e => e.time);
  assert.equal(strums.length, 2, `strums ${strums}`);
  assert.ok(Math.abs(strums[0] - 0.1) < 1e-9 && Math.abs(strums[1] - (0.13 + window)) < 1e-9, `strums ${strums}`);
  assert.equal(calls('onStrum')[0].velocity, 0.8);
  assert.equal(calls('onChordChange', 'chorus').length, 2);
  return `strumWindow ${SETTINGS.strumWindow} ms`;
});

console.table(results);
const failed = results.filter(r => r.result === 'FAIL').length;
if (failed) { console.error(`${failed} test(s) failed`); process.exit(1); }
console.log('post-fx tests passed');
