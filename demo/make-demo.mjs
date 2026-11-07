/**
 * Build a demo clip that behaves like a screen recording: four consecutive steps with
 * Chinese titles, a running clock, a percentage, its own background color, and a tone.
 * Used to prove read_video sees genuine change between moments and can read on-screen
 * text at a chosen timestamp.
 *
 * Each step is encoded separately and concatenated, because ffmpeg's drawtext cannot
 * switch its own text over time.
 *
 *   node demo/make-demo.mjs
 * @module dsh-video-vision/demo
 */

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findFfmpeg, run } from '../lib/media.js';

const demoDir = fileURLToPath(new URL('.', import.meta.url));
const buildDir = join(demoDir, 'build');
const font = join(demoDir, 'font.ttc');
const fontSource = 'C:\\Windows\\Fonts\\msyh.ttc';

if (!existsSync(font)) {
  try {
    copyFileSync(fontSource, font);
  } catch (error) {
    console.error(`could not copy a CJK font (${fontSource}): ${error.message}`);
  }
}

const ffmpeg = await findFfmpeg({});
console.log(`ffmpeg: ${ffmpeg.command} (${ffmpeg.version})`);

/** One step of the fake flow. */
const STEPS = [
  { title: '第一步：登录账号', progress: 15, tone: 880, accent: '0x60a5fa', bg: '0x0f172a' },
  { title: '第二步：确认付款', progress: 40, tone: 660, accent: '0xfbbf24', bg: '0x1a1230' },
  { title: '第三步：等待到账', progress: 70, tone: 520, accent: '0xf472b6', bg: '0x0b2b26' },
  { title: '完成，再见', progress: 100, tone: 392, accent: '0x34d399', bg: '0x2b0f18' },
];
const STEP_SECONDS = 2.5;

/** Subtitle cues, one per step, so the demo also proves the subtitle route. */
const CUES = [
  { start: '00:00:00,300', end: '00:00:02,400', text: '第一步，先登录你的账号' },
  { start: '00:00:02,800', end: '00:00:04,900', text: '第二步，确认付款金额' },
  { start: '00:00:05,300', end: '00:00:07,400', text: '第三步，等待到账，通常几秒钟' },
  { start: '00:00:07,800', end: '00:00:09,900', text: '完成了，这就是整段流程' },
];

mkdirSync(buildDir, { recursive: true });
const segments = [];

for (const [index, step] of STEPS.entries()) {
  const segment = join(buildDir, `seg-${index}.mp4`);
  const clock = `第 %{eif\\:${index * STEP_SECONDS}+t\\:d} 秒`;
  const percent = `%{eif\\:min(100\\,${step.progress}+${Math.round((100 - step.progress) * 0.5)}*t)\\:d}`;
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${step.bg}:s=960x540:r=25:d=${STEP_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=${step.tone}:duration=${STEP_SECONDS}`,
    '-vf', [
      `drawtext=fontfile=font.ttc:text='${step.title}':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=(h-text_h)/2-30`,
      `drawtext=fontfile=font.ttc:text='${clock}':fontcolor=0x93a4c4:fontsize=24:x=(w-text_w)/2:y=h-70`,
      `drawtext=fontfile=font.ttc:text='进度 ${percent}':fontcolor=${step.accent}:fontsize=30:x=(w-text_w)/2:y=74`,
    ].join(','),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-g', '25',
    '-c:a', 'aac', '-shortest',
    segment,
  ];
  const made = await run(ffmpeg.command, args, { cwd: demoDir, timeoutMs: 120_000 });
  if (made.code !== 0) {
    console.error(`step ${index + 1} failed:\n${made.stderr}`);
    process.exitCode = 1;
  }
  segments.push(segment);
}

if (process.exitCode !== 1) {
  const listFile = join(buildDir, 'list.txt');
  writeFileSync(listFile, segments.map((segment) => `file '${segment.replaceAll('\\', '/')}'`).join('\n'), 'utf8');
  const output = join(demoDir, 'screen-recording.mp4');
  const joined = await run(ffmpeg.command, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', join(buildDir, 'joined.mp4'),
  ], { cwd: demoDir, timeoutMs: 120_000 });
  if (joined.code !== 0) {
    console.error(`concat failed:\n${joined.stderr}`);
    process.exitCode = 1;
  } else {
    // Second pass: mux the subtitle track that the demo is meant to prove, and give the
    // container a recording date so metadata parsing has something real to read.
    const srt = join(buildDir, 'demo.srt');
    writeFileSync(srt, CUES.map((cue, index) => [
      String(index + 1),
      `${cue.start} --> ${cue.end}`,
      cue.text,
      '',
    ].join('\n')).join('\n'), 'utf8');
    const muxed = await run(ffmpeg.command, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-i', join(buildDir, 'joined.mp4'),
      '-i', srt,
      '-map', '0', '-map', '1',
      '-c', 'copy', '-c:s', 'mov_text',
      '-metadata:s:s:0', 'language=chi',
      '-metadata', 'creation_time=2026-02-14T09:30:00Z',
      output,
    ], { cwd: demoDir, timeoutMs: 120_000 });
    if (muxed.code !== 0) {
      console.error(`subtitle mux failed:\n${muxed.stderr}`);
      process.exitCode = 1;
    } else {
      rmSync(buildDir, { recursive: true, force: true });
      console.log(`wrote ${output} (${STEPS.length * STEP_SECONDS}s, ${STEPS.length} steps, ${CUES.length} subtitle cues)`);
    }
  }
}
