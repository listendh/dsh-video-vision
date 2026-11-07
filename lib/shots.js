/**
 * Shot detection and representative-frame planning.
 *
 * A clip edited with frequent cuts defeats "put frames where the picture changes most":
 * every cut is a big change, so a fixed budget of frames lands on an arbitrary handful of
 * peaks. Shot detection instead groups the clip into contiguous shots and spends the
 * budget on *different shots*, which is what a viewer perceives as coverage.
 *
 * The detector runs on the low-resolution grayscale proxy produced by `scanActivity`, so
 * it needs no extra ffmpeg feature: some builds ship without the `scdet` filter, and this
 * module must work with whatever ffmpeg the user happens to have.
 *
 * @module dsh-video-vision/shots
 */

/**
 * One detected shot.
 * @typedef {{ index: number, start: number, end: number, representative: number }} Shot
 */

/**
 * Detect shot boundaries from a frame-to-frame change signal.
 *
 * A global threshold fails on both ends of the range: a busy action clip has change
 * everywhere, a static lecture has almost none. The detector therefore scores each sample
 * against the **median change in its own neighbourhood** — a cut spikes several times above
 * the motion around it, while ordinary camera movement sits near its own median.
 * @param {readonly { seconds: number, score: number }[]} changes - change samples, ascending.
 * @param {{ duration: number, fps?: number, ratio?: number, floor?: number, minShotSeconds?: number }} options - clip length and detector settings.
 * @returns {{ shots: Shot[], method: 'local-median' | 'no-change' }} detected shots, each with a representative time.
 */
export function detectShots(changes, options) {
  const { duration, fps = 10, ratio = 3, floor = 0.03, minShotSeconds = 0.5 } = options;
  const usable = changes.filter((change) => change.seconds > 0 && change.seconds < duration - 0.05);
  if (usable.length === 0) {
    return { shots: [{ index: 0, start: 0, end: duration, representative: roundSeconds(duration / 2) }], method: 'no-change' };
  }

  const scores = usable.map((change) => change.score);
  const windowRadius = Math.max(2, Math.round(fps));
  const boundaries = [];
  let lastBoundary = 0;
  for (let index = 0; index < usable.length; index += 1) {
    // Neighbourhood median: ±1 s of context, which is long enough to contain ordinary
    // motion and short enough to keep a run of fast cuts from hiding each other.
    const window = scores
      .slice(Math.max(0, index - windowRadius), Math.min(scores.length, index + windowRadius + 1))
      .slice()
      .sort((a, b) => a - b);
    const median = window[Math.floor(window.length / 2)] ?? 0;
    if (scores[index] < floor) continue;
    if (scores[index] / Math.max(median, 0.005) < ratio) continue;
    if (usable[index].seconds - lastBoundary < minShotSeconds) continue;
    boundaries.push(usable[index].seconds);
    lastBoundary = usable[index].seconds;
  }

  if (boundaries.length === 0) {
    return {
      shots: [{ index: 0, start: 0, end: duration, representative: roundSeconds(duration / 2) }],
      method: 'no-change',
    };
  }

  const edges = [0, ...boundaries, duration];
  const shots = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const start = edges[index];
    const end = edges[index + 1];
    if (end - start < 0.1) continue;
    shots.push({ index: shots.length, start, end, representative: roundSeconds(start + (end - start) / 2) });
  }
  return { shots, method: 'local-median' };
}

/**
 * Round one position to milliseconds, the precision the result reports.
 * @param {number} seconds - raw position.
 * @returns {number} rounded position.
 */
function roundSeconds(seconds) {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * Spend a frame budget on distinct shots.
 *
 * One frame per shot while the budget allows it; a shot longer than its neighbour gets the
 * extra slots, because a 6-second shot carries more than a 0.8-second one. When there are
 * more shots than frames, the longest shots win and the rest are named as unseen.
 * @param {{ shots: readonly Shot[], count: number, start?: number, end?: number }} options - detected shots and budget.
 * @returns {{ timestamps: number[], coveredShots: number, totalShots: number }} chosen positions and coverage.
 */
export function planShotFrames(options) {
  const { shots, count, start, end } = options;
  const from = Math.max(0, start ?? 0);
  const to = end ?? Number.POSITIVE_INFINITY;
  const inWindow = shots
    .map((shot) => ({
      ...shot,
      start: Math.max(shot.start, from),
      end: Math.min(shot.end, to),
    }))
    .filter((shot) => shot.end - shot.start > 0.05);

  if (inWindow.length === 0) return { timestamps: [], coveredShots: 0, totalShots: shots.length };

  const slots = new Map(inWindow.map((shot) => [shot.index, 1]));
  let used = inWindow.length;

  // Spare slots go round-robin over the longest shots: one extra to the longest, then one to
  // the next longest, and so on. Handing every spare slot to the single longest shot first
  // would spend eight frames inside one 2.5 s shot and none anywhere else.
  if (used < count) {
    const byDuration = [...inWindow].sort((a, b) => (b.end - b.start) - (a.end - a.start));
    let progressed = true;
    while (used < count && progressed) {
      progressed = false;
      for (const shot of byDuration) {
        if (used >= count) break;
        slots.set(shot.index, (slots.get(shot.index) ?? 1) + 1);
        used += 1;
        progressed = true;
      }
    }
  }

  // More shots than frames: keep the longest ones so the sample leans on what is actually
  // on screen, and report the rest as not seen rather than pretending coverage.
  let chosen = inWindow;
  if (inWindow.length > count) {
    chosen = [...inWindow].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, count);
  }

  const timestamps = [];
  for (const shot of chosen) {
    const wanted = slots.get(shot.index) ?? 1;
    const span = shot.end - shot.start;
    for (let index = 0; index < wanted; index += 1) {
      const ratio = wanted === 1 ? 0.5 : (index + 1) / (wanted + 1);
      timestamps.push(roundSeconds(shot.start + span * ratio));
    }
  }
  timestamps.sort((a, b) => a - b);
  return {
    timestamps,
    coveredShots: chosen.length,
    totalShots: shots.length,
  };
}
