/**
 * Grid (contact sheet) composition.
 *
 * Sending sixteen separate frames costs roughly 16 × 1000 vision tokens. Tiling the same
 * sixteen frames into one numbered image costs about 1000 tokens in total, so the grid is
 * how a small budget buys wide temporal coverage. Detail is not lost: every cell carries
 * its timestamp, and the caller can ask for any second again at full resolution.
 *
 * Cells arrive already labelled and encoded; this module only arranges them, because ffmpeg
 * does the JPEG composition without any image library.
 *
 * @module dsh-video-vision/grid
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { run } from './media.js';

/**
 * Pick a near-square grid that holds every cell.
 * @param {number} count - number of cells.
 * @param {number} [maxColumns] - widest allowed grid.
 * @returns {{ columns: number, rows: number }} grid shape.
 */
export function planGrid(count, maxColumns = 4) {
  const cells = Math.max(1, Math.round(count));
  const columns = Math.min(maxColumns, Math.max(1, Math.ceil(Math.sqrt(cells))));
  const rows = Math.ceil(cells / columns);
  return { columns, rows };
}

/**
 * Compose labelled cells into one contact sheet.
 * @param {{ command: string }} ffmpeg - the resolved decoder.
 * @param {readonly { data: Uint8Array }[]} cells - encoded cells in reading order.
 * @param {{ columns: number, rows: number, padding?: number, margin?: number, quality?: number, signal?: AbortSignal }} options - layout.
 * @returns {Promise<Uint8Array>} the composed JPEG.
 * @throws {Error} when ffmpeg cannot tile the cells.
 */
export async function composeGrid(ffmpeg, cells, options) {
  const { columns, rows, padding = 4, margin = 4, quality = 3, signal } = options;
  if (cells.length === 0) throw new Error('cannot compose a grid without frames');
  const directory = join(tmpdir(), `dsh-video-vision-grid-${process.pid}-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  try {
    cells.forEach((cell, index) => {
      writeFileSync(join(directory, `cell-${String(index).padStart(3, '0')}.jpg`), cell.data);
    });
    const output = join(directory, 'grid.jpg');
    const result = await run(ffmpeg.command, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-framerate', '1',
      '-i', join(directory, 'cell-%03d.jpg'),
      '-vf', `tile=${columns}x${rows}:padding=${padding}:margin=${margin}:color=black`,
      '-frames:v', '1',
      '-q:v', String(quality),
      output,
    ], { signal, timeoutMs: 120_000 });
    if (result.code !== 0) {
      const reason = result.stderr.trim().split('\n').slice(-2).join(' ').trim();
      throw new Error(`ffmpeg could not compose the grid${reason === '' ? '' : `: ${reason}`}`);
    }
    const { readFileSync } = await import('node:fs');
    return readFileSync(output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
