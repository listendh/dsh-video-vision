/**
 * Motion-aware frame placement.
 *
 * Even spacing answers "what is this clip about" but can spend all its frames on a
 * static screen and miss the one second where something moved. This module reads a
 * tiny grayscale proxy of the whole clip (64x36, a few frames per second), measures
 * how much the picture changed between consecutive samples, and places frames on the
 * biggest changes first, filling the remaining budget evenly.
 *
 * The proxy costs one decode pass and about 2.3 KB per second of video, so it is
 * bounded by a duration budget and skipped entirely beyond it.
 *
 * @module dsh-video-vision/activity
 */

import { run } from './media.js';

/** Proxy frame width in pixels. */
const PROXY_WIDTH = 64;
/** Proxy frame height in pixels. */
const PROXY_HEIGHT = 36;
/** Bytes occupied by one proxy frame: color, not grayscale. A cut that only changes hue
 * (navy to purple, day to dusk) is nearly invisible in luma but obvious in color. */
const PROXY_BYTES = PROXY_WIDTH * PROXY_HEIGHT * 3;

/**
 * One measured change between two consecutive proxy samples.
 * @typedef {{ seconds: number, score: number }} Change
 */

/**
 * Decode a low-resolution color proxy and measure frame-to-frame change.
 * @param {{ command: string }} ffmpeg - the resolved decoder.
 * @param {string} hostPath - absolute media path.
 * @param {{ fps: number, limitSeconds: number, signal?: AbortSignal }} options - sampling rate and duration budget.
 * @returns {Promise<{ changes: Change[], sampledSeconds: number, fps: number }>} the change signal.
 */
export async function scanActivity(ffmpeg, hostPath, options) {
  const { fps, limitSeconds, signal } = options;
  const result = await run(ffmpeg.command, [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-t', String(Math.max(1, Math.round(limitSeconds))),
    '-i', hostPath,
    '-an', '-sn', '-dn',
    '-vf', `fps=${fps},scale=${PROXY_WIDTH}:${PROXY_HEIGHT},format=rgb24`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { signal, timeoutMs: 300_000 });
  const frames = Math.floor(result.stdout.length / PROXY_BYTES);
  const changes = [];
  for (let index = 1; index < frames; index += 1) {
    const previous = result.stdout.subarray((index - 1) * PROXY_BYTES, index * PROXY_BYTES);
    const current = result.stdout.subarray(index * PROXY_BYTES, (index + 1) * PROXY_BYTES);
    let total = 0;
    for (let offset = 0; offset < PROXY_BYTES; offset += 1) {
      total += Math.abs(current[offset] - previous[offset]);
    }
    changes.push({
      seconds: Math.round((index / fps) * 1000) / 1000,
      score: Math.round((total / PROXY_BYTES / 255) * 10_000) / 10_000,
    });
  }
  return { changes, sampledSeconds: frames / fps, fps };
}

/**
 * Mean of the change scores, used as the noise floor for a mostly static clip.
 * @param {readonly Change[]} changes - measured changes.
 * @returns {number} the mean score.
 */
function meanScore(changes) {
  if (changes.length === 0) return 0;
  return changes.reduce((sum, change) => sum + change.score, 0) / changes.length;
}

/**
 * Place frames on the largest picture changes, then fill the rest evenly.
 * @param {{ changes: readonly Change[], duration: number | undefined, count: number, start?: number, end?: number, changeShare: number, minGapSeconds: number }} options - placement inputs.
 * @returns {{ timestamps: number[], changeFrames: number }} chosen positions and how many came from changes.
 */
export function pickChangeMoments(options) {
  const { changes, duration, count, changeShare, minGapSeconds } = options;
  const from = Math.max(0, options.start ?? 0);
  const to = Math.max(from, options.end ?? (duration ?? Number.POSITIVE_INFINITY));
  const inWindow = changes.filter((change) => change.seconds >= from && change.seconds <= to);
  const even = evenTimestamps({ ...options, from, to });

  if (inWindow.length === 0 || count <= 1) return { timestamps: even, changeFrames: 0 };

  // A static clip has a flat signal; without a real peak, keep plain even spacing.
  const peak = Math.max(...inWindow.map((change) => change.score));
  const floor = Math.max(meanScore(inWindow) * 2, 0.008);
  if (peak < floor) return { timestamps: even, changeFrames: 0 };

  const budget = Math.max(1, Math.min(count, Math.round(count * changeShare)));
  const ranked = [...inWindow].sort((a, b) => b.score - a.score);
  /** @type {number[]} */
  const accepted = [];
  for (const change of ranked) {
    if (accepted.length >= budget) break;
    if (change.score < floor) break;
    if (accepted.some((seconds) => Math.abs(seconds - change.seconds) < minGapSeconds)) continue;
    accepted.push(change.seconds);
  }
  if (accepted.length === 0) return { timestamps: even, changeFrames: 0 };

  // Fill the remaining slots from the even plan, skipping positions that collide.
  const timestamps = [...accepted];
  for (const seconds of even) {
    if (timestamps.length >= count) break;
    if (timestamps.some((chosen) => Math.abs(chosen - seconds) < minGapSeconds / 2)) continue;
    timestamps.push(seconds);
  }
  timestamps.sort((a, b) => a - b);
  return {
    timestamps: timestamps.map((seconds) => Math.round(seconds * 1000) / 1000),
    changeFrames: accepted.length,
  };
}

/**
 * Plain even spacing inside a window.
 * @param {{ from: number, to: number, count: number }} options - window and count.
 * @returns {number[]} ascending positions.
 */
function evenTimestamps(options) {
  const { from, to, count } = options;
  const span = Number.isFinite(to) ? Math.max(0, to - from) : 0;
  if (span <= 0.0001) return [from];
  const positions = [];
  for (let index = 0; index < count; index += 1) {
    positions.push(Math.round((from + (span * (index + 0.5)) / count) * 1000) / 1000);
  }
  return [...new Set(positions)];
}
