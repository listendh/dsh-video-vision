/**
 * `read_video` — video understanding for a text-and-image model.
 *
 * The tool decodes a video with ffmpeg, samples frames across the clip, commits each
 * frame as a durable image attachment, and returns them as `image` content blocks
 * beside a metadata envelope. The calling model then sees the clip as a timestamped
 * storyboard it can describe, read text from, and reason about, and it receives an
 * audio transcript when this profile mounts a speech-to-text provider.
 *
 * @module dsh-video-vision
 */

import { basename, resolve as resolvePath } from 'node:path';

import { pickChangeMoments, scanActivity } from './lib/activity.js';
import { composeGrid, planGrid } from './lib/grid.js';
import {
  extractSubtitleStream,
  findFfmpeg,
  findLabelFont,
  findSidecarSubtitles,
  grabAudioWav,
  grabFrameWithRetry,
  isRegularFile,
  planEvenTimestamps,
  probeMedia,
  readFileBounded,
} from './lib/media.js';
import { detectShots, planShotFrames } from './lib/shots.js';
import { decodeSubtitleBytes, parseCues, renderCues } from './lib/subtitles.js';

/** Cordis plugin name, also the id used by this package's patch row. */
export const name = 'video-vision';

/** The tool registry is the only required service. */
export const inject = ['tools'];

/** Effective defaults for every config field. */
const DEFAULTS = {
  ffmpegPath: '',
  defaultFrames: 8,
  maxFrames: 24,
  maxFrameWidth: 1024,
  jpegQuality: 3,
  layout: 'auto',
  gridColumns: 0,
  gridMaxColumns: 4,
  gridCellWidth: 320,
  gridWhenAtLeast: 6,
  maxAudioSeconds: 600,
  language: 'zh',
  transcript: true,
  subtitles: true,
  maxSubtitleChars: 6000,
  sampling: 'auto',
  motionScanMaxSeconds: 600,
  motionFps: 0,
  changeShare: 0.6,
  minChangeGapSeconds: 0.6,
  shotRatio: 3,
  shotFloor: 0.03,
  minShotSeconds: 0.5,
};

/** Model-facing parameter schema: raw JSON Schema, the form the tool registry forwards. */
const PARAMETERS = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Path to the video file, resolved by the filesystem backend; a relative path uses the session workspace.',
    },
    frames: {
      type: 'number',
      description: 'How many frames to sample across the clip (default 8, capped by the plugin config).',
    },
    timestamps: {
      type: 'array',
      items: { type: 'number' },
      description: 'Explicit sample positions in seconds. Overrides `frames`; use it to revisit one moment or to step through a short action.',
    },
    start: {
      type: 'number',
      description: 'Start of the sampling window in seconds; defaults to the beginning of the clip.',
    },
    end: {
      type: 'number',
      description: 'End of the sampling window in seconds; defaults to the end of the clip.',
    },
    width: {
      type: 'number',
      description: 'Long edge of one sampled frame in pixels; defaults to the plugin config.',
    },
    transcript: {
      type: 'boolean',
      description: 'Ask the mounted speech-to-text provider to transcribe the audio track. Defaults to the plugin config.',
    },
    subtitles: {
      type: 'boolean',
      description: 'Include subtitle text the file already carries (an embedded track or a .srt/.vtt file beside it). Defaults to the plugin config.',
    },
    layout: {
      type: 'string',
      enum: ['auto', 'frames', 'grid'],
      description: 'How sampled frames are delivered: `grid` sends one labelled contact sheet (cheap, wide coverage), `frames` sends each frame as its own image (more detail per moment), `auto` picks grid for larger frame counts.',
    },
    carry: {
      type: 'string',
      description: 'Summary of the part of the clip you already read. Pass the previous summary here when reading a long video in chunks, so this read continues from it instead of starting over.',
    },
    language: {
      type: 'string',
      description: 'Language hint for the transcript and for choosing among several subtitle tracks, such as zh or en.',
    },
  },
  required: ['path'],
};

/** Structured result schema: enforced JSON Schema subset, validated before rendering. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
    media: {
      type: 'object',
      additionalProperties: false,
      properties: {
        durationSeconds: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        fps: { type: 'number' },
        videoCodec: { type: 'string' },
        audioCodec: { type: 'string' },
        tags: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['name', 'value'],
          },
        },
      },
      required: ['videoCodec'],
    },
    decoder: {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { type: 'string' },
        origin: { type: 'string' },
      },
    },
    frames: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'number' },
          seconds: { type: 'number' },
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          bytes: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          name: { type: 'string' },
        },
        required: ['seconds'],
      },
    },
    grid: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string' },
        mediaType: { type: 'string' },
        bytes: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        columns: { type: 'number' },
        rows: { type: 'number' },
        name: { type: 'string' },
      },
      required: ['attachmentId', 'columns', 'rows'],
    },
    shots: {
      type: 'object',
      additionalProperties: false,
      properties: {
        count: { type: 'number' },
        method: { type: 'string' },
        covered: { type: 'number' },
      },
      required: ['count', 'method', 'covered'],
    },
    deltas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'number' },
          to: { type: 'number' },
          delta: { type: 'number' },
          level: { type: 'string' },
        },
        required: ['from', 'to', 'delta', 'level'],
      },
    },
    bounds: {
      type: 'object',
      additionalProperties: false,
      properties: {
        start: { type: 'number' },
        end: { type: 'number' },
      },
    },
    sampling: {
      type: 'object',
      additionalProperties: false,
      properties: {
        strategy: { type: 'string' },
        changeFrames: { type: 'number' },
        scannedSeconds: { type: 'number' },
      },
      required: ['strategy'],
    },
    subtitles: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string' },
        language: { type: 'string' },
        cueCount: { type: 'number' },
        chars: { type: 'number' },
        truncated: { type: 'boolean' },
        text: { type: 'string' },
      },
      required: ['source', 'cueCount', 'text'],
    },
    subtitleNote: { type: 'string' },
    transcript: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        audioSeconds: { type: 'number' },
        language: { type: 'string' },
      },
      required: ['text'],
    },
    transcriptNote: { type: 'string' },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['source', 'media', 'frames'],
};

/**
 * Merge one config field with its default, tolerating a hand-edited patch.
 * @template T
 * @param {Record<string, unknown>} config - the resolved row config.
 * @param {string} key - config field name.
 * @param {T} fallback - value used when the field is absent or the wrong type.
 * @returns {T} the effective value.
 */
function pick(config, key, fallback) {
  const value = config[key];
  if (value === undefined || value === null) return fallback;
  if (typeof fallback === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return fallback;
  if (typeof fallback === 'boolean' && typeof value !== 'boolean') return fallback;
  if (typeof fallback === 'string' && typeof value !== 'string') return fallback;
  return /** @type {T} */ (value);
}

/**
 * Clamp a number into a positive integer range.
 * @param {number} value - candidate.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} the clamped integer.
 */
function clampInteger(value, min, max) {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return min;
  return Math.min(max, Math.max(min, rounded));
}

/**
 * Proxy sampling rate for the motion scan. Short clips get a finer signal because a cut
 * lasts a smaller fraction of them; long clips stay cheap because their cuts are coarser
 * relative to the whole.
 * @param {number} duration - clip length in seconds.
 * @returns {number} frames per second for the scan.
 */
function fpsForDuration(duration) {
  if (duration <= 60) return 10;
  if (duration <= 300) return 6;
  return 4;
}

/**
 * Decide how sampled moments reach the model.
 * @param {Record<string, unknown>} args - tool arguments.
 * @param {Record<string, unknown>} config - row config.
 * @param {number} count - number of sampled moments.
 * @returns {'grid' | 'frames'} the delivery mode.
 */
function resolveLayout(args, config, count) {
  const requested = typeof args.layout === 'string' ? args.layout : pick(config, 'layout', DEFAULTS.layout);
  if (requested === 'grid') return 'grid';
  if (requested === 'frames') return 'frames';
  const threshold = clampInteger(pick(config, 'gridWhenAtLeast', DEFAULTS.gridWhenAtLeast), 1, 48);
  return count >= threshold ? 'grid' : 'frames';
}

/**
 * Resolve the requested path through the filesystem service so relative paths and
 * sandbox mappings behave like every other read tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ agent?: { session?: { header?: { cwd?: string } } }, signal: AbortSignal }} exec - tool execution.
 * @param {string} requested - the model-supplied path.
 * @returns {Promise<{ hostPath: string, displayPath: string }>} the host path and its display form.
 */
async function resolveSource(ctx, exec, requested) {
  const fs = ctx.get('fs');
  const cwd = exec.agent?.session?.header?.cwd;
  if (fs !== undefined) {
    const target = await fs.resolve(requested, {
      ...(cwd === undefined ? {} : { cwd }),
      signal: exec.signal,
    });
    const info = await fs.stat(target, exec.signal);
    if (info === undefined) throw new Error(`cannot read "${target.displayPath}": not found`);
    if (info.type !== 'file') throw new Error(`cannot read "${target.displayPath}": not a regular file`);
    const hostPath = fs.processPath(target);
    if (typeof hostPath !== 'string' || hostPath === '') {
      throw new Error(`cannot read "${target.displayPath}": this filesystem backend has no host path for the decoder`);
    }
    return { hostPath, displayPath: target.displayPath ?? requested };
  }
  const hostPath = cwd === undefined ? resolvePath(requested) : resolvePath(cwd, requested);
  if (!isRegularFile(hostPath)) throw new Error(`cannot read "${requested}": not a regular file`);
  return { hostPath, displayPath: requested };
}

/**
 * Refuse a route that cannot accept image input, mirroring `read_image`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Parameters<typeof resolveSource>[1]} exec - tool execution.
 * @param {string} requested - path used in the refusal message.
 * @returns {Promise<void>} completion after the route declares image input.
 */
async function assertImageCapableRoute(ctx, exec, requested) {
  const routed = exec.agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? exec.agent?.options?.provider;
  const model = routed?.model ?? exec.agent?.options?.model;
  const llm = ctx.get('llm');
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error(`cannot read "${requested}" as a video: the current model route could not be resolved`);
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal);
  if (active?.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(`cannot read "${requested}" as a video: model "${model}" does not declare image input, and every sampled frame is sent to the model as an image; switch to an image-capable model`);
  }
}

/**
 * Transcribe the audio track through the mounted speech-to-text provider.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ command: string }} ffmpeg - the resolved decoder.
 * @param {string} hostPath - absolute media path.
 * @param {{ language: string, maxAudioSeconds: number, enabled: boolean, signal: AbortSignal }} options - transcript settings.
 * @returns {Promise<{ transcript?: { text: string, audioSeconds?: number, language?: string }, note?: string }>} the transcript or the honest reason it is absent.
 */
async function transcribeAudio(ctx, ffmpeg, hostPath, options) {
  const { language, maxAudioSeconds, enabled, signal } = options;
  if (!enabled) return { note: 'the caller disabled the transcript' };
  const speech = ctx.get('speechToText');
  if (speech === undefined) return { note: 'this profile mounts no speech-to-text provider, so the audio track was not transcribed' };
  try {
    const snapshot = speech.snapshot();
    const providers = snapshot?.providers ?? [];
    if (providers.length === 0) return { note: 'this profile registers no speech-to-text provider, so the audio track was not transcribed' };
    const wav = await grabAudioWav(ffmpeg, hostPath, { maxSeconds: maxAudioSeconds, signal });
    if (wav === undefined) return { note: 'the video has no decodable audio track' };
    const spec = speech.resolve({ audio: wav, language });
    const transcript = await speech.transcribe(spec, signal);
    if (typeof transcript?.text !== 'string' || transcript.text.trim() === '') {
      return { note: `the speech-to-text provider returned no text for the audio track (${language})` };
    }
    return {
      transcript: {
        text: transcript.text.trim(),
        ...(typeof transcript.audioSeconds === 'number' ? { audioSeconds: transcript.audioSeconds } : {}),
        language,
      },
    };
  } catch (error) {
    return { note: `the speech-to-text provider could not transcribe the audio track: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Collect subtitle text the file already carries: a sidecar file beside it first, then
 * any text subtitle stream inside the container.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context (unused services are optional).
 * @param {{ command: string }} ffmpeg - the resolved decoder.
 * @param {string} hostPath - absolute media path.
 * @param {{ subtitleStreams: readonly { index: number, language?: string, codec: string, text: boolean }[] }} info - probe result.
 * @param {{ enabled: boolean, language: string, maxChars: number, signal: AbortSignal }} options - subtitle settings.
 * @returns {Promise<{ subtitles?: Record<string, unknown>, note?: string }>} rendered subtitle text or an honest reason.
 */
async function collectSubtitles(ctx, ffmpeg, hostPath, info, options) {
  const { enabled, language, maxChars } = options;
  if (!enabled) return { note: 'the caller disabled subtitles' };

  const sidecars = findSidecarSubtitles(hostPath, (candidate) => isRegularFile(candidate));
  for (const sidecar of sidecars) {
    try {
      const bytes = readFileBounded(sidecar, 4 * 1024 * 1024);
      const cues = parseCues(decodeSubtitleBytes(bytes));
      if (cues.length === 0) continue;
      const rendered = renderCues(cues, { maxChars });
      return {
        subtitles: {
          source: `subtitle file ${basename(sidecar)}`,
          cueCount: cues.length,
          chars: rendered.chars,
          truncated: rendered.truncated,
          text: rendered.text,
        },
      };
    } catch (error) {
      return { note: `the subtitle file ${basename(sidecar)} could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  const textStreams = info.subtitleStreams.filter((stream) => stream.text);
  const bitmapOnly = info.subtitleStreams.length > 0 && textStreams.length === 0;
  if (textStreams.length === 0) {
    if (bitmapOnly) {
      return { note: `the file carries ${info.subtitleStreams.length} picture-based subtitle track(s) (${info.subtitleStreams.map((stream) => stream.codec).join(', ')}), which need OCR instead of a text decoder` };
    }
    return { note: 'the file carries no subtitle track and no subtitle file sits beside it' };
  }

  const preferred = textStreams.find((stream) => stream.language !== undefined && language !== '' && stream.language.toLowerCase().startsWith(language.toLowerCase()))
    ?? textStreams[0];
  try {
    const raw = await extractSubtitleStream(ffmpeg, hostPath, preferred.index, options.signal);
    if (raw === undefined || raw.trim() === '') {
      return { note: `subtitle stream #${preferred.index} (${preferred.codec}) produced no text` };
    }
    const cues = parseCues(raw);
    if (cues.length === 0) return { note: `subtitle stream #${preferred.index} (${preferred.codec}) produced no readable cues` };
    const rendered = renderCues(cues, { maxChars });
    return {
      subtitles: {
        source: `embedded subtitle stream #${preferred.index} (${preferred.codec}${preferred.language === undefined ? '' : `, ${preferred.language}`})`,
        ...(preferred.language === undefined ? {} : { language: preferred.language }),
        cueCount: cues.length,
        chars: rendered.chars,
        truncated: rendered.truncated,
        text: rendered.text,
      },
    };
  } catch (error) {
    return { note: `subtitle stream #${preferred.index} could not be decoded: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Read one video and commit its sampled frames.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} config - row config.
 * @param {Record<string, unknown>} args - validated tool arguments.
 * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec - tool execution.
 * @returns {Promise<Record<string, unknown>>} the structured result.
 */
async function readVideo(ctx, config, args, exec) {
  const requested = String(args.path);
  const attachments = ctx.get('attachments');
  if (attachments === undefined) throw new Error(`cannot read "${requested}" as a video: no attachment service is mounted`);
  await assertImageCapableRoute(ctx, exec, requested);

  const source = await resolveSource(ctx, exec, requested);
  const warnings = [];
  const ffmpeg = await findFfmpeg({
    configuredPath: pick(config, 'ffmpegPath', DEFAULTS.ffmpegPath),
    signal: exec.signal,
  });
  const info = await probeMedia(ffmpeg, source.hostPath, exec.signal);
  if (info.video === undefined) throw new Error(`cannot read "${source.displayPath}" as a video: the file has no decodeable video stream`);

  const maxFrames = clampInteger(pick(config, 'maxFrames', DEFAULTS.maxFrames), 1, 20);
  const configuredFrames = clampInteger(pick(config, 'defaultFrames', DEFAULTS.defaultFrames), 1, maxFrames);
  const maxWidth = clampInteger(pick(config, 'maxFrameWidth', DEFAULTS.maxFrameWidth), 128, 2048);

  const explicit = Array.isArray(args.timestamps) ? args.timestamps.filter((value) => typeof value === 'number' && Number.isFinite(value)) : [];
  const lastFrame = info.durationSeconds === undefined ? undefined : Math.max(0, info.durationSeconds - 0.05);
  let positions;
  let sampling = { strategy: 'explicit' };
  let shotsInfo;
  /** Change samples from the scan, reused later for the between-cell delta table. */
  let scanChanges;
  if (explicit.length > 0) {
    let clamped = 0;
    positions = [...new Set(explicit.map((value) => Math.max(0, Math.round(value * 1000) / 1000)))].sort((a, b) => a - b);
    if (positions.length > maxFrames) {
      warnings.push(`only the first ${maxFrames} of ${positions.length} requested timestamps were sampled`);
      positions = positions.slice(0, maxFrames);
    }
    if (lastFrame !== undefined) {
      positions = [...new Set(positions.map((value) => {
        if (value <= lastFrame) return value;
        clamped += 1;
        return Math.round(lastFrame * 1000) / 1000;
      }))];
      if (clamped > 0) warnings.push(`${clamped} requested timestamp(s) fell outside the ${info.durationSeconds.toFixed(2)}s clip and were clamped to its last frame`);
    }
  } else {
    const count = clampInteger(typeof args.frames === 'number' ? args.frames : configuredFrames, 1, maxFrames);
    const start = typeof args.start === 'number' ? args.start : undefined;
    const end = typeof args.end === 'number' ? args.end : undefined;
    const strategy = pick(config, 'sampling', DEFAULTS.sampling);
    const scanLimit = clampInteger(pick(config, 'motionScanMaxSeconds', DEFAULTS.motionScanMaxSeconds), 0, 86_400);
    const canScan = strategy !== 'even'
      && info.durationSeconds !== undefined
      && info.durationSeconds <= scanLimit
      && count > 1;
    if (canScan) {
      try {
        const scanFps = clampInteger(pick(config, 'motionFps', DEFAULTS.motionFps), 0, 12) || fpsForDuration(info.durationSeconds);
        const scan = await scanActivity(ffmpeg, source.hostPath, {
          fps: scanFps,
          limitSeconds: Math.ceil(info.durationSeconds),
          signal: exec.signal,
        });
        scanChanges = scan.changes;
        const detected = detectShots(scan.changes, {
          duration: info.durationSeconds,
          fps: scanFps,
          ratio: Math.max(1.5, pick(config, 'shotRatio', DEFAULTS.shotRatio)),
          floor: Math.max(0.005, pick(config, 'shotFloor', DEFAULTS.shotFloor)),
          minShotSeconds: Math.max(0.2, pick(config, 'minShotSeconds', DEFAULTS.minShotSeconds)),
        });
        const scannedSeconds = Math.round(scan.sampledSeconds * 100) / 100;
        shotsInfo = { count: detected.shots.length, method: detected.method, covered: 0 };
        if (detected.shots.length >= 2) {
          // One frame per shot is how an edit with many cuts gets real coverage: the budget
          // buys different shots instead of several peaks inside the same one.
          const planned = planShotFrames({ shots: detected.shots, count, start, end });
          positions = planned.timestamps;
          shotsInfo.covered = planned.coveredShots;
          sampling = { strategy: 'shots', changeFrames: 0, scannedSeconds };
          if (planned.coveredShots < detected.shots.length) {
            warnings.push(`${detected.shots.length} shots detected but only ${planned.coveredShots} fit the frame budget; narrow the window or ask for more frames to see the rest`);
          }
        } else {
          // A single continuous shot has no cuts to distribute over, so fall back to the
          // change-aware placement: it is the case that placement was built for.
          const picked = pickChangeMoments({
            changes: scan.changes,
            duration: info.durationSeconds,
            count,
            start,
            end,
            changeShare: Math.min(1, Math.max(0, pick(config, 'changeShare', DEFAULTS.changeShare))),
            minGapSeconds: Math.max(0.2, pick(config, 'minChangeGapSeconds', DEFAULTS.minChangeGapSeconds)),
          });
          positions = picked.timestamps;
          sampling = { strategy: 'auto', changeFrames: picked.changeFrames, scannedSeconds };
        }
      } catch (error) {
        warnings.push(`motion scan failed, frames were spaced evenly instead: ${error instanceof Error ? error.message : String(error)}`);
        positions = planEvenTimestamps({ duration: info.durationSeconds, count, start, end });
        sampling = { strategy: 'even' };
      }
    } else {
      positions = planEvenTimestamps({ duration: info.durationSeconds, count, start, end });
      sampling = { strategy: 'even' };
      if (strategy !== 'even' && info.durationSeconds !== undefined && info.durationSeconds > scanLimit) {
        warnings.push(`this clip is ${Math.round(info.durationSeconds)}s long, past the ${scanLimit}s motion-scan budget, so frames were spaced evenly; pass timestamps to look at a specific moment`);
      }
    }
  }
  if (info.durationSeconds === undefined) warnings.push('ffmpeg reported no duration for this file, so sample positions are spaced one second apart');

  const frameWidth = Math.min(maxWidth, typeof args.width === 'number' && Number.isFinite(args.width) ? Math.round(args.width) : maxWidth, info.video.width);
  const quality = clampInteger(pick(config, 'jpegQuality', DEFAULTS.jpegQuality), 2, 20);

  const gridMode = resolveLayout(args, config, positions.length) === 'grid';
  const baseName = basename(source.displayPath).replace(/\.[^.]+$/u, '');
  const frames = [];
  let grid;

  if (gridMode) {
    // One contact sheet: the budget buys the same number of moments for a tenth of the
    // tokens, because the provider charges per image, not per tile inside it.
    const columns = clampInteger(pick(config, 'gridColumns', DEFAULTS.gridColumns), 0, 8);
    const shape = planGrid(positions.length, columns > 0 ? columns : DEFAULTS.gridMaxColumns);
    const cellWidth = clampInteger(pick(config, 'gridCellWidth', DEFAULTS.gridCellWidth), 160, 640);
    if (findLabelFont() === undefined) {
      warnings.push('no usable font was found, so contact-sheet cells are not labelled; use the cell map in this result to tell them apart');
    }
    const cells = [];
    for (const [index, seconds] of positions.entries()) {
      if (exec.signal.aborted) break;
      let grabbed;
      try {
        grabbed = await grabFrameWithRetry(ffmpeg, source.hostPath, seconds, {
          width: cellWidth,
          quality,
          label: `#${index + 1} ${seconds.toFixed(1)}s`,
          signal: exec.signal,
        });
      } catch (error) {
        warnings.push(`cell ${index + 1} at ${seconds.toFixed(2)}s could not be decoded: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      cells.push({ seconds: grabbed.seconds, data: grabbed.data });
    }
    if (cells.length > 0) {
      try {
        const composed = await composeGrid(ffmpeg, cells, {
          columns: shape.columns,
          rows: Math.ceil(cells.length / shape.columns),
          quality,
          signal: exec.signal,
        });
        const ref = await attachments.saveImage({ data: composed, mediaType: 'image/jpeg', name: `${baseName}-grid.jpg` });
        grid = {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          columns: shape.columns,
          rows: Math.ceil(cells.length / shape.columns),
          ...(ref.name === undefined ? {} : { name: ref.name }),
        };
        cells.forEach((cell, index) => {
          frames.push({ index: index + 1, seconds: cell.seconds });
        });
      } catch (error) {
        warnings.push(`the contact sheet could not be composed, frames were returned separately: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (!gridMode || grid === undefined) {
    for (const seconds of positions) {
      if (exec.signal.aborted) break;
      let grabbed;
      try {
        grabbed = await grabFrameWithRetry(ffmpeg, source.hostPath, seconds, {
          width: frameWidth,
          quality,
          signal: exec.signal,
        });
      } catch (error) {
        warnings.push(`frame at ${seconds.toFixed(2)}s could not be decoded: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const label = `${baseName}@${grabbed.seconds.toFixed(2)}s.jpg`;
      let ref;
      try {
        ref = await attachments.saveImage({ data: grabbed.data, mediaType: 'image/jpeg', name: label });
      } catch (error) {
        warnings.push(`frame at ${seconds.toFixed(2)}s was rejected by the attachment service: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      frames.push({
        index: frames.length + 1,
        seconds: grabbed.seconds,
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      });
    }
  }

  if (frames.length === 0) {
    const detail = warnings.length === 0 ? '' : ` (${warnings.join('; ')})`;
    throw new Error(`cannot read "${source.displayPath}" as a video: no frame could be decoded${detail}`);
  }

  // How much the picture moved between two sampled moments. A vision model can see that
  // cell 8 looks different from cell 7, but not that this gap is the biggest one in the
  // clip: that comparison needs the whole signal, which the scan already produced.
  const deltas = scanChanges === undefined ? [] : betweenDeltas(scanChanges, frames);

  const audio = await transcribeAudio(ctx, ffmpeg, source.hostPath, {
    language: typeof args.language === 'string' && args.language.trim() !== ''
      ? args.language.trim()
      : pick(config, 'language', DEFAULTS.language),
    maxAudioSeconds: clampInteger(pick(config, 'maxAudioSeconds', DEFAULTS.maxAudioSeconds), 5, 3_600),
    enabled: typeof args.transcript === 'boolean' ? args.transcript : pick(config, 'transcript', DEFAULTS.transcript),
    signal: exec.signal,
  });

  const subtitleResult = await collectSubtitles(ctx, ffmpeg, source.hostPath, info, {
    enabled: typeof args.subtitles === 'boolean' ? args.subtitles : pick(config, 'subtitles', DEFAULTS.subtitles),
    language: typeof args.language === 'string' && args.language.trim() !== ''
      ? args.language.trim()
      : pick(config, 'language', DEFAULTS.language),
    maxChars: clampInteger(pick(config, 'maxSubtitleChars', DEFAULTS.maxSubtitleChars), 500, 60_000),
    signal: exec.signal,
  });

  // Subtitle text is the file's own words: prefer it over an audio guess, and never
  // claim a transcript we did not produce.
  let transcript = audio.transcript;
  let transcriptNote = audio.note;
  if (subtitleResult.subtitles !== undefined) {
    transcript = undefined;
    transcriptNote = 'the audio track was not transcribed; the subtitle text below is what the video says';
  }

  const start = positions[0];
  const end = positions[positions.length - 1];
  return {
    source: { path: source.displayPath },
    media: {
      ...(info.durationSeconds === undefined ? {} : { durationSeconds: info.durationSeconds }),
      width: info.video.width,
      height: info.video.height,
      ...(info.video.fps === undefined ? {} : { fps: info.video.fps }),
      videoCodec: info.video.codec,
      ...(info.audio === undefined ? {} : { audioCodec: info.audio.codec }),
      ...(info.tags.length === 0 ? {} : { tags: info.tags }),
    },
    decoder: {
      ...(ffmpeg.version === undefined ? {} : { version: ffmpeg.version }),
      origin: ffmpeg.origin,
    },
    frames,
    bounds: { start, end },
    sampling,
    ...(shotsInfo === undefined ? {} : { shots: shotsInfo }),
    ...(grid === undefined ? {} : { grid }),
    ...(deltas.length === 0 ? {} : { deltas }),
    ...(subtitleResult.subtitles === undefined ? {} : { subtitles: subtitleResult.subtitles }),
    ...(subtitleResult.subtitles !== undefined || subtitleResult.note === undefined ? {} : { subtitleNote: subtitleResult.note }),
    ...(transcript === undefined ? {} : { transcript }),
    ...(transcriptNote === undefined ? {} : { transcriptNote }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/**
 * Format one second count for the model-facing envelope.
 * @param {number} seconds - elapsed seconds.
 * @returns {string} a fixed-precision label.
 */
function secondsLabel(seconds) {
  return `${seconds.toFixed(2)}s`;
}

/** Change magnitude at which a gap between two sampled moments is called large. */
const DELTA_BIG = 0.15;
/** Change magnitude at which a gap is called noticeable rather than still. */
const DELTA_MEDIUM = 0.06;

/**
 * Measure how much the picture moved between each pair of consecutive samples.
 * @param {readonly { seconds: number, score: number }[]} changes - change samples from the scan.
 * @param {readonly { seconds: number }[]} moments - the sampled positions, ascending.
 * @returns {{ from: number, to: number, delta: number, level: 'big' | 'medium' | 'small' }[]} per-gap peaks.
 */
function betweenDeltas(changes, moments) {
  const deltas = [];
  for (let index = 1; index < moments.length; index += 1) {
    const from = moments[index - 1].seconds;
    const to = moments[index].seconds;
    if (to - from < 0.05) continue;
    let peak = 0;
    for (const change of changes) {
      if (change.seconds <= from || change.seconds > to) continue;
      if (change.score > peak) peak = change.score;
    }
    if (peak === 0) continue;
    const level = peak >= DELTA_BIG ? 'big' : peak >= DELTA_MEDIUM ? 'medium' : 'small';
    deltas.push({ from: index, to: index + 1, delta: Math.round(peak * 1000) / 1000, level });
  }
  return deltas;
}

/**
 * Render one structured read as the model-facing envelope plus timestamped images.
 * @param {Record<string, unknown>} value - the validated result.
 * @returns {Array<Record<string, unknown>>} content blocks: text, then each frame's caption and image.
 */
function renderVideo(args, value) {
  const { source, media, frames, bounds, subtitles, subtitleNote, transcript, transcriptNote, sampling, shots, grid, deltas, warnings, decoder } = value;
  const carry = typeof args?.carry === 'string' && args.carry.trim() !== '' ? args.carry.trim() : undefined;
  const placement = sampling?.strategy === 'explicit'
    ? 'positions were requested explicitly'
    : sampling?.strategy === 'shots'
      ? `${frames.length} moment${frames.length === 1 ? '' : 's'} sampled across ${shots?.covered ?? frames.length} of ${shots?.count ?? frames.length} detected shots`
      : `${frames.length} frame${frames.length === 1 ? '' : 's'} sampled from ${secondsLabel(bounds.start)} to ${secondsLabel(bounds.end)}`
        + `${sampling?.changeFrames > 0 ? `, ${sampling.changeFrames} of them placed where the picture changed most` : ', evenly spaced'}`;
  const delivery = grid === undefined
    ? 'each image below is preceded by its own timestamp in the clip.'
    : `delivered as one contact sheet: ${grid.columns} columns x ${grid.rows} rows, read row by row; every cell is labelled "#n <second>s" and the cell map below repeats it.`;
  const lines = [
    `<path>${source.path}</path>`,
    '<type>video</type>',
    '<content>',
    `video, ${media.durationSeconds === undefined ? 'unknown duration' : secondsLabel(media.durationSeconds)}, ${media.width}x${media.height} px`
      + `${media.fps === undefined ? '' : `, ${media.fps} fps`}, ${media.videoCodec}`
      + `${media.audioCodec === undefined ? ', no audio track' : `, audio ${media.audioCodec}`}`,
    `${placement}; ${delivery}`,
    `decoded by ffmpeg${decoder?.version === undefined ? '' : ` ${decoder.version}`}`,
    '</content>',
  ];
  if (Array.isArray(media.tags) && media.tags.length > 0) {
    lines.push('<metadata>');
    for (const tag of media.tags) lines.push(`${tag.name}: ${tag.value}`);
    lines.push('</metadata>');
  }
  if (grid !== undefined) {
    lines.push(`<cells>${frames.map((frame) => `#${frame.index}=${frame.seconds.toFixed(2)}s`).join('  ')}</cells>`);
    if (shots !== undefined && shots.covered < shots.count) {
      lines.push(`(${shots.count - shots.covered} of the ${shots.count} detected shots were not shown; pass a narrower start/end or more frames to cover them)`);
    }
  }
  if (Array.isArray(deltas) && deltas.length > 0) {
    const marks = { big: 'large, usually a cut', medium: 'some change', small: 'almost still' };
    lines.push('<deltas>');
    lines.push('how much the picture moved between neighbouring moments:');
    for (const delta of deltas) {
      lines.push(`#${delta.from}->#${delta.to} ${delta.delta.toFixed(3)} (${marks[delta.level] ?? delta.level})`);
    }
    lines.push('</deltas>');
  }
  if (carry !== undefined) {
    lines.push('<carry>');
    lines.push(carry);
    lines.push('</carry>');
  }
  const blocks = [{ type: 'text', text: lines.join('\n') }];
  if (grid !== undefined) {
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: grid.attachmentId,
        mediaType: grid.mediaType,
        bytes: grid.bytes,
        width: grid.width,
        height: grid.height,
        ...(grid.name === undefined ? {} : { name: grid.name }),
      },
    });
  } else {
    frames.forEach((frame, index) => {
      if (frame.attachmentId === undefined) return;
      blocks.push({ type: 'text', text: `frame ${index + 1}/${frames.length} @ ${secondsLabel(frame.seconds)}` });
      blocks.push({
        type: 'image',
        attachment: {
          attachmentId: frame.attachmentId,
          mediaType: frame.mediaType,
          bytes: frame.bytes,
          width: frame.width,
          height: frame.height,
          ...(frame.name === undefined ? {} : { name: frame.name }),
        },
      });
    });
  }
  const tail = [];
  if (subtitles !== undefined) {
    tail.push(`<subtitles source="${subtitles.source}" cues="${subtitles.cueCount}"${subtitles.truncated === true ? ' truncated="true"' : ''}>`);
    tail.push(subtitles.text);
    tail.push('</subtitles>');
    if (subtitles.truncated === true) tail.push('(the subtitle text was cut to fit the length budget; ask for a time range if you need the rest)');
  } else if (subtitleNote !== undefined) {
    tail.push(`<subtitles unavailable="${subtitleNote}"/>`);
  }
  if (transcript !== undefined) {
    tail.push(`<transcript language="${transcript.language ?? 'unknown'}">`);
    tail.push(transcript.text);
    tail.push('</transcript>');
  } else if (transcriptNote !== undefined) {
    tail.push(`<transcript unavailable="${transcriptNote}"/>`);
  }
  // A reading protocol, not decoration: declaring a hypothesis, checking each prediction,
  // and comparing against the previous chunk are what turn "describe these stills" into a
  // readable line of reasoning. The protocol adapts to what the caller already knows.
  if (frames.length >= 3) {
    const steps = ['<how_to_read>'];
    if (carry === undefined) {
      steps.push(
        '0. Before describing anything, state what you think this is: the kind of clip, the setting, and the arc you expect — each backed by a cell. Say it as a hypothesis that can turn out wrong.',
        '1. Then go through the moments in order. For each one, say what changed compared with the previous one: what appeared, what left, what moved, which on-screen text changed.',
        Array.isArray(deltas) && deltas.length > 0
          ? 'Use <deltas> to see which gaps are the big ones; a large gap is usually a cut, and a small one means the camera stayed put.'
          : 'Judge the size of each change from the images themselves.',
        '2. Before you look at the next moment, guess what it will show. When you get there, say whether the guess held, and what it got wrong.',
        '3. Finish with one paragraph in time order: what the clip is, what happens, and what you could not see. Never invent dialogue or events the frames do not show.',
      );
    } else {
      steps.push(
        '1. Begin by comparing <carry> with what you now see: which earlier claims still hold, and which these moments contradict.',
        '2. Then write one line per moment as a ledger: expected X | saw Y | held or broken. Keep the expectation and the observation separate — that difference is the point of this read.',
        '3. Name the cells where the clip most sharply broke your expectation; a deliberate edit usually sits exactly there.',
        '4. Finish with an updated paragraph in time order that replaces the carried summary. Never invent dialogue or events the frames do not show.',
      );
    }
    steps.push('</how_to_read>');
    tail.push(steps.join('\n'));
  }
  if (warnings !== undefined && warnings.length > 0) {
    tail.push('<warnings>');
    for (const warning of warnings) tail.push(`- ${warning}`);
    tail.push('</warnings>');
  }
  if (tail.length > 0) blocks.push({ type: 'text', text: tail.join('\n') });
  return blocks;
}

/**
 * Register the `read_video` tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, unknown>} [rawConfig] - the resolved row config.
 * @returns {() => void} the tool registration disposer.
 */
export function apply(ctx, rawConfig) {
  const config = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {};
  return ctx.tools.register({
    name: 'read_video',
    description:
      'Look at a video file. Samples frames across the clip with ffmpeg and returns them as images you can see, '
      + 'each preceded by its timestamp, together with duration, resolution, codec, container metadata such as the '
      + 'recording date, any subtitle text the file already carries, and — when this profile mounts a speech-to-text '
      + 'provider — a transcript of the audio track. Frames are placed one per detected shot (or on the biggest '
      + 'picture changes when the clip has no cuts), so a brief moment is likely to be captured. Larger frame counts '
      + 'come back as one labelled contact sheet, which is far cheaper than separate images. Use it to describe what '
      + 'happens in a video, read on-screen text, identify '
      + 'people, objects, or actions, quote what is said, or answer questions about specific moments. Positions and '
      + 'durations are in seconds; to inspect one moment closely, pass explicit timestamps.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => renderVideo(args, value),
      presentationMeta: (_args, value) => ({ path: value.source.path }),
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Read video ${args.path}`,
        kind: 'read',
        locations: [{ path: args.path }],
      };
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (typeof args.path !== 'string' || args.path.trim() === '') throw new Error('path must be a non-empty string');
      return readVideo(ctx, config, args, exec);
    },
  });
}
