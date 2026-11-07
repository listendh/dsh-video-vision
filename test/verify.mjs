/**
 * Self-contained verification for the read_video tool.
 *
 * Generates its own test clips with the discovered ffmpeg, runs the real plugin
 * through a fake Cordis context, and checks the projection the model would receive.
 * It needs nothing but Node and ffmpeg.
 *
 *   node test/verify.mjs                       structural checks (default)
 *   node test/verify.mjs --strict [dsh-tools]  also validate with the harness's own
 *                                              JSON Schema validator, when an
 *                                              installed @deepseek-ai/dsh-tools is
 *                                              available (package directory or a
 *                                              resolvable package name)
 * @module dsh-video-vision/test/verify
 */

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findFfmpeg, run } from '../lib/media.js';

const pluginDir = dirname(fileURLToPath(new URL('../index.js', import.meta.url)));
const argv = process.argv.slice(2);
const strictFlag = argv.includes('--strict');
const toolsArgument = argv.find((value) => !value.startsWith('--'));
const workDir = resolve(process.env.DSH_VIDEO_VISION_WORKDIR ?? join(pluginDir, '.verify'));

mkdirSync(workDir, { recursive: true });

/**
 * Load the harness's validator when the caller asked for strict checks.
 * @returns {Promise<{ assertSupportedJsonSchema: Function, validateJsonSchemaValue: Function } | undefined>} the validator module.
 */
async function loadValidator() {
  if (!strictFlag) return undefined;
  const candidates = [...(toolsArgument === undefined ? [] : [toolsArgument]), '@deepseek-ai/dsh-tools'];
  for (const candidate of candidates) {
    try {
      const url = /^[A-Za-z]:[\\/]/u.test(candidate) || candidate.startsWith('/')
        ? pathToFileURL(join(candidate, 'lib', 'index.js')).href
        : candidate;
      const loaded = await import(url);
      if (typeof loaded.validateJsonSchemaValue === 'function' && typeof loaded.assertSupportedJsonSchema === 'function') {
        return loaded;
      }
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('--strict needs an installed @deepseek-ai/dsh-tools; pass its package directory as the argument');
}

const validator = await loadValidator();

/**
 * Validate one value against the schema subset this tool declares.
 * Mirrors the registry's checks closely enough that the default run still proves
 * the payload is legal, JSON-safe, schema-conforming data.
 * @param {Record<string, unknown>} schema - declared schema node.
 * @param {unknown} value - candidate value.
 * @param {string} path - diagnostic path.
 * @returns {string[]} violations; empty means valid.
 */
function validateSubset(schema, value, path) {
  const violations = [];
  if (schema === null || typeof schema !== 'object') return [`${path}: schema must be an object`];
  const typeOf = (candidate) => {
    if (candidate === null) return 'null';
    if (Array.isArray(candidate)) return 'array';
    return typeof candidate;
  };
  const { type } = schema;
  if (type !== undefined && typeOf(value) !== type) {
    violations.push(`${path}: expected ${type}, got ${typeOf(value)}`);
    return violations;
  }
  if (type === 'object' && value !== null && typeof value === 'object') {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`${path}.${key}: missing required property`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        violations.push(...validateSubset(properties[key], child, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        violations.push(`${path}.${key}: not declared`);
      }
    }
  }
  if (type === 'array' && Array.isArray(value) && schema.items !== undefined) {
    value.forEach((entry, index) => {
      violations.push(...validateSubset(schema.items, entry, `${path}[${index}]`));
    });
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(`${path}: not one of ${schema.enum.join('/')}`);
  return violations;
}

/**
 * Assert one value against the declared schema, using the strict validator when loaded.
 * @param {Record<string, unknown>} schema - declared schema.
 * @param {unknown} value - candidate value.
 * @param {string} label - diagnostic path.
 * @returns {void}
 */
function assertValue(schema, value, label) {
  if (validator !== undefined) {
    validator.assertSupportedJsonSchema(schema);
    assert.deepEqual(validator.validateJsonSchemaValue(schema, value, label), [], `${label} must satisfy the declared schema`);
    return;
  }
  assert.deepEqual(validateSubset(schema, value, label), [], `${label} must satisfy the declared schema`);
}

const plugin = await import(pathToFileURL(join(pluginDir, 'index.js')).href);
assert.equal(plugin.name, 'video-vision');
assert.ok(plugin.inject.includes('tools'), 'the plugin declares the tools service');

const ffmpeg = await findFfmpeg({});
console.log(`ffmpeg: ${ffmpeg.command} (${ffmpeg.version}, ${ffmpeg.origin})`);
console.log(`schema validation: ${validator === undefined ? 'built-in subset' : 'harness validator'}`);

/**
 * Build the test clips once, so repeated runs stay fast.
 * @returns {Promise<void>} completion after both clips exist.
 */
async function ensureClips() {
  const sample = join(workDir, 'sample.mp4');
  const silent = join(workDir, 'silent.mp4');
  if (!existsSync(sample)) {
    const made = await run(ffmpeg.command, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
      '-c:a', 'aac', '-shortest', sample,
    ]);
    assert.equal(made.code, 0, `sample clip generation failed: ${made.stderr}`);
  }
  if (!existsSync(silent)) {
    const made = await run(ffmpeg.command, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-an', silent,
    ]);
    assert.equal(made.code, 0, `silent clip generation failed: ${made.stderr}`);
  }
  await ensureCutsClip();
  await ensureSubtitleClips();
}

/** Three very different patterns joined by hard cuts at 2 s and 4 s. */
async function ensureCutsClip() {
  const output = join(workDir, 'cuts.mp4');
  if (existsSync(output)) return;
  const segments = [];
  const patterns = [
    'testsrc=size=480x270:rate=25:duration=2',
    'smptebars=size=480x270:rate=25:duration=2',
    'rgbtestsrc=size=480x270:rate=25:duration=2',
  ];
  for (const [index, pattern] of patterns.entries()) {
    const segment = join(workDir, `cut-${index}.mp4`);
    const made = await run(ffmpeg.command, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', pattern,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-an', segment,
    ]);
    assert.equal(made.code, 0, `cut segment ${index} failed: ${made.stderr}`);
    segments.push(segment);
  }
  const list = join(workDir, 'cuts.txt');
  writeFileSync(list, segments.map((segment) => `file '${segment.replaceAll('\\', '/')}'`).join('\n'), 'utf8');
  const made = await run(ffmpeg.command, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', output,
  ]);
  assert.equal(made.code, 0, `cut concat failed: ${made.stderr}`);
}

/** One clip with an embedded text subtitle track, one with a sidecar file. */
async function ensureSubtitleClips() {
  const srt = [
    '1',
    '00:00:00,400 --> 00:00:02,000',
    '你好，欢迎使用这个视频工具',
    '',
    '2',
    '00:00:02,100 --> 00:00:04,000',
    '第二步：确认付款',
    '',
    '3',
    '00:00:04,200 --> 00:00:05,900',
    '好了，马上结束',
    '',
  ].join('\n');
  // Deliberately not named sample.srt: a sidecar of that name would attach itself to sample.mp4.
  const srtPath = join(workDir, 'cues.srt');
  writeFileSync(srtPath, srt, 'utf8');

  const embedded = join(workDir, 'subtitled.mp4');
  if (!existsSync(embedded)) {
    const made = await run(ffmpeg.command, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-i', join(workDir, 'sample.mp4'),
      '-i', srtPath,
      '-map', '0', '-map', '1',
      '-c', 'copy', '-c:s', 'mov_text',
      '-metadata', 'creation_time=2025-03-04T05:06:07Z',
      embedded,
    ]);
    assert.equal(made.code, 0, `subtitle mux failed: ${made.stderr}`);
  }

  const sidecarVideo = join(workDir, 'sidecar.mp4');
  const sidecarText = join(workDir, 'sidecar.srt');
  if (!existsSync(sidecarVideo)) copyFileSync(join(workDir, 'sample.mp4'), sidecarVideo);
  if (!existsSync(sidecarText)) writeFileSync(sidecarText, srt, 'utf8');
  // Drop a stale sidecar from an earlier run, which would attach itself to sample.mp4.
  rmSync(join(workDir, 'sample.srt'), { force: true });
}

/**
 * Read the pixel size out of JPEG bytes so the fake attachment service stays honest.
 * @param {Uint8Array} bytes - encoded frame.
 * @returns {{ width: number, height: number }} decoded dimensions.
 */
function jpegSize(bytes) {
  let index = 2;
  while (index + 9 < bytes.length) {
    if (bytes[index] !== 0xff) {
      index += 1;
      continue;
    }
    const marker = bytes[index + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (bytes[index + 5] << 8) | bytes[index + 6],
        width: (bytes[index + 7] << 8) | bytes[index + 8],
      };
    }
    index += 2 + ((bytes[index + 2] << 8) | bytes[index + 3]);
  }
  throw new Error('no SOF marker in JPEG');
}

/**
 * Build a fake Cordis context: it records registrations and stands in for the
 * attachment, filesystem, llm, and speech services.
 * @param {{ modalities?: string[], speech?: object }} [options] - overrides.
 * @returns {{ ctx: object, registered: object[], saved: object[] }} the fake context and its records.
 */
function createContext(options = {}) {
  const { modalities = ['text', 'image'], speech } = options;
  const registered = [];
  const saved = [];
  let counter = 0;
  const services = {
    fs: {
      async resolve(requested, resolverOptions) {
        const hostPath = resolve(resolverOptions?.cwd ?? workDir, requested);
        return { displayPath: hostPath, hostPath };
      },
      async stat(target) {
        return existsSync(target.hostPath) ? { type: 'file', version: 1 } : undefined;
      },
      processPath(target) {
        return target.hostPath;
      },
    },
    attachments: {
      imageLimits: {
        maxImageBytes: 20 * 1024 * 1024,
        maxImagesPerMessage: 20,
        maxMessageImageBytes: 40 * 1024 * 1024,
        maxImagePixels: 64e6,
        maxImageDimension: 8192,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      },
      async saveImage({ data, mediaType, name }) {
        const { width, height } = jpegSize(data);
        counter += 1;
        const ref = {
          attachmentId: `att-${counter}`,
          mediaType,
          bytes: data.byteLength,
          width,
          height,
          ...(name === undefined ? {} : { name }),
        };
        saved.push({ ref, data });
        return ref;
      },
    },
    llm: {
      async resolveModelInfo() {
        return { inputModalities: modalities };
      },
    },
    ...(speech === undefined ? {} : { speechToText: speech }),
  };
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    get(serviceName) {
      return services[serviceName];
    },
    inject(_names, fn) {
      fn(ctx);
    },
  };
  return { ctx, registered, saved };
}

/** Build the tool-execution context the tool needs. */
function createExec(cwd) {
  return {
    signal: new AbortController().signal,
    arguments: {},
    agent: {
      options: { provider: 'deepseek-account', model: 'deepseek-flash' },
      session: { header: { cwd }, requestHeader: () => undefined },
    },
    deferContext() {},
    concludeTurn() {},
  };
}

/** Install the plugin into a fake context and assert the registration contract. */
function install(options = {}, config = {}) {
  const created = createContext(options);
  plugin.apply(created.ctx, { ffmpegPath: ffmpeg.command, ...config });
  assert.equal(created.registered.length, 1, 'apply() registers exactly one tool');
  const definition = created.registered[0];
  assert.equal(definition.name, 'read_video');
  assert.ok(definition.description.length > 120, 'the description teaches the model when to use it');
  assert.equal(typeof definition.output.render, 'function');
  return { ...created, definition };
}

/** Run one call through the registered definition and validate the payload. */
async function callTool(definition, args, cwd) {
  assertValue(definition.parameters, args, 'arguments');
  const raw = await definition.execute(args, createExec(cwd));
  const value = JSON.parse(JSON.stringify(raw));
  assertValue(definition.output.schema, value, 'value');
  const blocks = definition.output.render(args, value);
  for (const block of blocks) {
    if (block.type === 'image') {
      assert.equal(typeof block.attachment.attachmentId, 'string');
      assert.ok(Number.isFinite(block.attachment.bytes) && block.attachment.bytes > 0);
      assert.ok(Number.isFinite(block.attachment.width) && block.attachment.width > 0);
    }
  }
  return { value, blocks };
}

/** Assert the projection every successful read must have. */
function assertProjection(value, blocks) {
  const images = blocks.filter((block) => block.type === 'image');
  assert.equal(blocks[0].type, 'text', 'the envelope leads the projection');
  assert.match(blocks[0].text, /<type>video<\/type>/u);
  assert.ok(value.frames.length > 0, 'a successful read reports at least one moment');
  if (value.grid !== undefined) {
    assert.equal(images.length, 1, 'a contact sheet is one image block');
    assert.equal(images[0].attachment.attachmentId, value.grid.attachmentId);
    assert.equal(value.grid.columns * value.grid.rows >= value.frames.length, true, 'the grid holds every moment');
    assert.match(blocks[0].text, /contact sheet/u);
    assert.match(blocks[0].text, /<cells>#1=/u);
    return;
  }
  assert.equal(images.length, value.frames.length, 'every frame becomes one image block');
  value.frames.forEach((frame, index) => {
    assert.ok(frame.bytes > 500, `frame ${index} carries bytes`);
    assert.ok(frame.width > 8 && frame.height > 8, `frame ${index} has a decoded size`);
    assert.equal(images[index].attachment.attachmentId, frame.attachmentId);
    assert.equal(blocks[index * 2 + 1].type, 'text', 'each image is preceded by its timestamp');
    assert.match(blocks[index * 2 + 1].text, /^frame \d+\/\d+ @ \d+\.\d{2}s$/u);
  });
}

await ensureClips();

const report = [];
const TEST_CONFIG = { defaultFrames: 6, maxFrames: 12, maxFrameWidth: 512 };
const scenario = async (label, args, check, config = TEST_CONFIG) => {
  const { definition } = install({}, config);
  const started = Date.now();
  const { value, blocks } = await callTool(definition, args, workDir);
  assertProjection(value, blocks);
  await check?.(value, blocks);
  report.push({
    label,
    frames: value.frames.length,
    seconds: value.frames.map((frame) => frame.seconds),
    elapsedMs: Date.now() - started,
  });
  return { value, blocks };
};

await scenario('even sampling over the whole clip', { path: 'sample.mp4' }, (value) => {
  assert.ok(Math.abs(value.media.durationSeconds - 6) < 0.4, `duration ≈ 6s, got ${value.media.durationSeconds}`);
  assert.equal(value.media.width, 640);
  assert.equal(value.media.height, 360);
  assert.equal(value.media.audioCodec, 'aac');
  // The fixture is a slowly changing test pattern, so repeats may be dropped — but every
  // dropped moment has to be accounted for, never silently missing.
  assert.equal(value.frames.length + (value.sampling.deduped ?? 0), 6, 'every requested moment is either shown or counted as a repeat');
  const seconds = value.frames.map((frame) => frame.seconds);
  assert.deepEqual(seconds, [...seconds].sort((a, b) => a - b));
  assert.ok(value.bounds.start > 0 && value.bounds.end < 6);
  assert.match(value.transcriptNote, /no speech-to-text provider/u);
  assert.ok(value.decoder.version.length > 0);
  assert.equal(value.sampling.strategy, 'auto');
  assert.equal(value.subtitleNote.includes('no subtitle track'), true);
});

await scenario('sampling follows the edit rather than blind spacing', { path: 'cuts.mp4', frames: 6 }, (value) => {
  // Either strategy is legitimate here: shots when cuts are detected, change peaks when
  // the clip is one continuous take. Blind even spacing is the one outcome that would mean
  // the scan did not run at all.
  const followed = value.sampling.strategy === 'shots' || value.sampling.changeFrames >= 1;
  assert.ok(followed, `sampling should react to the picture, got ${JSON.stringify(value.sampling)}`);
  // Frames sit *inside* shots rather than exactly on the cut, so require real spread across
  // the clip instead of a frame within 0.4 s of the boundary.
  const seconds = value.frames.map((frame) => frame.seconds);
  assert.ok(Math.min(...seconds) < 2, `a frame should come from the first shot, got ${seconds.join(', ')}`);
  assert.ok(Math.max(...seconds) > 4, `a frame should come from the last shot, got ${seconds.join(', ')}`);
  assert.ok(value.shots === undefined || value.shots.covered >= 2, 'at least two distinct shots should be represented');
});

await scenario('embedded subtitle track is read as text', { path: 'subtitled.mp4', frames: 2 }, (value) => {
  assert.match(value.subtitles.source, /embedded subtitle stream/u);
  assert.equal(value.subtitles.cueCount, 3);
  assert.match(value.subtitles.text, /你好，欢迎使用/u);
  assert.match(value.subtitles.text, /^\[0:00\] 你好，欢迎使用/u);
  assert.equal(value.subtitles.truncated, false);
  assert.match(value.transcriptNote, /subtitle text below is what the video says/u);
  const tags = value.media.tags ?? [];
  assert.ok(tags.some((tag) => tag.name === 'creation_time' && tag.value.startsWith('2025-03-04')), `creation_time should be reported, got ${JSON.stringify(tags)}`);
});

await scenario('a subtitle file beside the video is read as text', { path: 'sidecar.mp4', frames: 2 }, (value) => {
  assert.match(value.subtitles.source, /subtitle file sidecar\.srt/u);
  assert.equal(value.subtitles.cueCount, 3);
});

await scenario('caller can switch subtitles off', { path: 'subtitled.mp4', frames: 2, subtitles: false }, (value) => {
  assert.equal(value.subtitles, undefined);
  assert.match(value.subtitleNote, /disabled/u);
});

await scenario('explicit timestamps, sorted and clamped into the clip', { path: 'sample.mp4', timestamps: [5.5, 0.1, 99] }, (value) => {
  const seconds = value.frames.map((frame) => frame.seconds);
  assert.equal(seconds.length, 3);
  assert.equal(seconds[0], 0.1);
  assert.equal(seconds[1], 5.5);
  // The out-of-range request is clamped to the end of the clip. Where exactly that lands
  // depends on the decoder: a seek at the very end may need the backward retry, so only
  // require "inside the clip, within a second of the end".
  assert.ok(seconds[2] <= value.media.durationSeconds, `inside the clip, got ${seconds[2]}`);
  assert.ok(seconds[2] > value.media.durationSeconds - 1, `near the end of the clip, got ${seconds[2]}`);
  assert.ok(value.warnings.some((warning) => /clamped/u.test(warning)));
});

await scenario('one frame with a width cap', { path: 'sample.mp4', frames: 1, width: 200 }, (value) => {
  assert.equal(value.frames.length, 1);
  assert.equal(value.frames[0].width, 200);
});

await scenario('shot detection finds the hard cuts', { path: 'cuts.mp4', frames: 6, layout: 'frames' }, (value) => {
  assert.equal(value.shots.method, 'local-median');
  assert.ok(value.shots.count >= 2, `three joined patterns should expose at least two cuts, got ${value.shots.count}`);
  assert.equal(value.sampling.strategy, 'shots');
  assert.ok(value.shots.covered >= 2);
  const cutTimes = [2, 4];
  const nearCut = value.frames.filter((frame) => cutTimes.some((cut) => Math.abs(frame.seconds - cut) <= 1));
  assert.ok(nearCut.length >= 2, `frames should land inside the detected shots, got ${value.frames.map((frame) => frame.seconds).join(', ')}`);
});

await scenario('grid layout delivers one contact sheet', { path: 'cuts.mp4', frames: 12, layout: 'grid' }, (value, blocks) => {
  assert.notEqual(value.grid, undefined);
  // Still footage no longer absorbs the whole budget, so fewer than twelve moments survive;
  // the sheet must hold exactly the moments that were kept.
  assert.ok(value.frames.length >= 2 && value.frames.length <= 12, `got ${value.frames.length} moments`);
  assert.equal(value.grid.columns * value.grid.rows >= value.frames.length, true);
  const images = blocks.filter((block) => block.type === 'image');
  assert.equal(images.length, 1, 'one contact sheet, not twelve images');
  assert.ok(images[0].attachment.bytes > 5_000, 'the sheet holds real pixels');
  assert.ok(images[0].attachment.width >= 4 * 160, 'cells keep a usable width');
});

await scenario('gaps between moments report the cuts inside them', { path: 'cuts.mp4', frames: 6, layout: 'frames' }, (value, blocks) => {
  assert.ok(Array.isArray(value.deltas) && value.deltas.length >= 1, 'at least one gap is described');
  assert.equal(value.deltas.length, value.frames.length - 1, 'one row per gap, no more and no fewer');
  let totalCuts = 0;
  value.deltas.forEach((delta) => {
    assert.equal(delta.to, delta.from + 1, 'deltas describe neighbouring moments');
    assert.ok(['fast', 'steady', 'light', 'still'].includes(delta.level), `unexpected level ${delta.level}`);
    assert.ok(delta.cuts >= 0 && delta.rate >= 0);
    totalCuts += delta.cuts;
  });
  // The clip is three patterns joined by two hard cuts, so the sampled gaps must account for
  // them instead of reporting an identical "some change" everywhere.
  assert.ok(totalCuts >= 1, `at least one gap should contain a cut, got ${totalCuts}`);
  const text = blocks.map((block) => block.text ?? '').join('\n');
  assert.match(text, /<deltas>/u);
  assert.match(text, /cut/u);
  assert.match(text, /<how_to_read>/u, 'the reading protocol travels with the images');
  assert.match(text, /guess what it will show/u);
});

await scenario('a carried summary is echoed back for long clips', { path: 'sample.mp4', frames: 3, carry: '前一段：一个彩色测试图在缓慢变化' }, (value, blocks) => {
  const text = blocks.map((block) => block.text ?? '').join('\n');
  assert.match(text, /<carry>\n前一段：一个彩色测试图在缓慢变化\n<\/carry>/u);
  assert.match(text, /comparing <carry> with what you now see/u);
});

await scenario('a still shot does not soak up the budget', { path: 'cuts.mp4', frames: 9, layout: 'frames' }, (value) => {
  // The fixture is a generated test pattern, so it contains its own motion; the guarantee
  // under test is that a nine-frame request is not answered with nine near-identical cells.
  assert.ok(value.frames.length <= 6, `still shots should not soak up the budget, got ${value.frames.length}`);
  assert.equal(value.frames.length + (value.sampling.deduped ?? 0), 9, 'dropped moments are counted');
  assert.equal(value.shots.covered >= 2, true);
});

await scenario('text-first mode sweeps evenly and asks for the words', { path: 'sample.mp4', frames: 5, text: true }, (value, blocks) => {
  assert.equal(value.textFirst, true);
  assert.equal(value.sampling.strategy, 'even', 'text mode does not follow picture changes');
  const text = blocks.map((block) => block.text ?? '').join('\n');
  assert.match(text, /text-first read/u);
  assert.match(text, /Write down every piece of on-screen text/u);
  assert.match(text, /list the cells it covers/u);
});

await scenario('a video without an audio track', { path: 'silent.mp4', frames: 2 }, (value) => {
  assert.equal(value.media.audioCodec, undefined);
  assert.equal(value.frames.length, 2);
  assert.ok(value.frames[0].width <= 320, 'a small clip is never upscaled');
});

const main = install({}, TEST_CONFIG);
writeFileSync(join(workDir, 'not-a-video.mp4'), 'this is not a video');
await assert.rejects(() => callTool(main.definition, { path: 'not-a-video.mp4' }, workDir), /could not read|no decodeable/u);
await assert.rejects(() => callTool(main.definition, { path: 'nope.mp4' }, workDir), /not found/u);
await assert.rejects(() => callTool(main.definition, { path: '' }, workDir), /non-empty string/u);

const blind = install({ modalities: ['text'] });
await assert.rejects(() => callTool(blind.definition, { path: 'sample.mp4' }, workDir), /does not declare image input/u);

const noProvider = install({ speech: { snapshot: () => ({ providers: [], selection: {} }) } });
const degraded = await callTool(noProvider.definition, { path: 'sample.mp4', frames: 1 }, workDir);
assert.match(degraded.value.transcriptNote, /registers no speech-to-text provider/u);

const ready = install({
  speech: {
    snapshot: () => ({ providers: [{ id: 'local' }], selection: { providerId: 'local', language: 'zh' } }),
    resolve: ({ audio, language }) => ({ audio, language }),
    transcribe: async () => ({ text: '这是一段测试音轨', audioSeconds: 6, inferenceSeconds: 0.2 }),
  },
});
const transcribed = await callTool(ready.definition, { path: 'sample.mp4', frames: 1 }, workDir);
assert.equal(transcribed.value.transcript.text, '这是一段测试音轨');
assert.equal(transcribed.value.transcriptNote, undefined);
assert.match(transcribed.blocks.at(-1).text, /<transcript language="zh">/u);

const disabled = await callTool(ready.definition, { path: 'sample.mp4', frames: 1, transcript: false }, workDir);
assert.match(disabled.value.transcriptNote, /disabled/u);

const thumb = await callTool(main.definition, { path: 'sample.mp4', frames: 3 }, workDir);
assert.equal(thumb.value.frames.length + (thumb.value.sampling.deduped ?? 0), 3, 'a repeated moment is counted, not lost');
for (const [index, entry] of main.saved.slice(0, 3).entries()) {
  writeFileSync(join(workDir, `frame-${index}.jpg`), entry.data);
}

console.log(JSON.stringify({ ok: true, workDir, ffmpeg, report }, null, 2));
