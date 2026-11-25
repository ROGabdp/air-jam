// Rhythm judging shared by all instruments. There is no miss and no penalty: an off-beat hit
// simply scores nothing, and the combo only lapses after a long stretch without a scored hit.

export const POINTS = { perfect: 100, good: 50, chordChange: 100 };

export function createScorer(settings) {
  const state = {
    score: 0, combo: 0, maxCombo: 0, perfect: 0, good: 0,
    lastScoredBeat: -1,
    strum: null,          // { time, count, points, doubled }
  };

  const multiplier = () => 1 + Math.min(10, Math.floor(state.combo / 10)) * 0.1;

  function addCombo() {
    state.combo++;
    if (state.combo > state.maxCombo) state.maxCombo = state.combo;
  }

  /**
   * One sounding event (a single plucked string / drum hit) at song time `time` (seconds).
   * Events closer together than strumWindow belong to one strum and are judged once.
   * @returns {{ grade: 'perfect'|'good'|null, points: number, combo: number, chordChange: boolean, strum: boolean }}
   */
  function hit(time, songMap) {
    const result = { grade: null, points: 0, combo: state.combo, chordChange: false, strum: false };
    if (!songMap) return result;

    const strum = state.strum;
    if (strum && (time - strum.time) * 1000 <= settings.strumWindow) {
      strum.count++;
      strum.time = time;
      if (strum.count === 3 && strum.points > 0 && !strum.doubled) {
        strum.doubled = true;
        state.score += strum.points;
        result.points = strum.points;
        result.strum = true;
      }
      result.combo = state.combo;
      return result;
    }

    state.strum = { time, count: 1, points: 0, doubled: false };
    const beat = songMap.nearestBeat(time);
    const offset = Math.abs(beat.delta) * 1000;
    const grade = offset <= settings.perfectWindow ? 'perfect' : offset <= settings.goodWindow ? 'good' : null;
    // Each beat pays out once, so wiggling on a string around one beat cannot farm points.
    if (!grade || beat.index === state.lastScoredBeat) return result;

    state.lastScoredBeat = beat.index;
    addCombo();
    state[grade]++;
    let points = POINTS[grade] * multiplier();
    if (beat.inBar === 0 && beat.chordChanged) { points += POINTS.chordChange; result.chordChange = true; }
    points = Math.round(points);
    state.score += points;
    state.strum.points = points;
    Object.assign(result, { grade, points, combo: state.combo });
    return result;
  }

  // Called every frame: lets the combo lapse after comboIdleBeats without a scored hit.
  function tick(time, songMap) {
    if (!songMap || state.combo === 0) return;
    if (songMap.beatIndexAt(time) - state.lastScoredBeat > settings.comboIdleBeats) state.combo = 0;
  }

  function reset() {
    Object.assign(state, { score: 0, combo: 0, maxCombo: 0, perfect: 0, good: 0, lastScoredBeat: -1, strum: null });
  }

  return { state, hit, tick, reset };
}
