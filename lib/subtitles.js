/**
 * Subtitle handling: parse SRT/VTT cue text and render it inside a character budget.
 *
 * Spoken content has two honest sources: a speech-to-text provider, and subtitles the
 * file already carries. Subtitle tracks are text, so when they exist they beat any
 * audio route: exact wording, exact timing, no model required.
 *
 * @module dsh-video-vision/subtitles
 */

/** One parsed subtitle cue. */
const CUE_TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{3})/u;

/**
 * Convert one SRT/VTT timestamp group into seconds.
 * @param {string | undefined} hours - hours field.
 * @param {string} minutes - minutes field.
 * @param {string} seconds - seconds field.
 * @param {string} millis - milliseconds field.
 * @returns {number} seconds since the start.
 */
function toSeconds(hours, minutes, seconds, millis) {
  return (hours === undefined ? 0 : Number(hours) * 3600)
    + Number(minutes) * 60
    + Number(seconds)
    + Number(millis) / 1000;
}

/**
 * Strip the formatting a subtitle file may carry inside a cue.
 * @param {string} text - raw cue text.
 * @returns {string} plain text on one line.
 */
function plainCueText(text) {
  return text
    .replace(/<[^>]*>/gu, '')
    .replace(/\{\\[^}]*\}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Parse SRT or WebVTT content into cues. Tolerant by design: real files carry stray
 * blank lines, BOMs, and numbering that other tools get wrong.
 * @param {string} source - file content.
 * @returns {{ start: number, end: number, text: string }[]} parsed cues in file order.
 */
export function parseCues(source) {
  const text = source.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  const blocks = text.split(/\n{2,}/u);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex < 0) continue;
    const match = CUE_TIME.exec(lines[timeIndex]);
    if (match === null) continue;
    const body = lines.slice(timeIndex + 1).join('\n');
    const plain = plainCueText(body);
    if (plain === '') continue;
    cues.push({
      start: Math.round(toSeconds(match[1], match[2], match[3], match[4]) * 1000) / 1000,
      end: Math.round(toSeconds(match[5], match[6], match[7], match[8]) * 1000) / 1000,
      text: plain,
    });
  }
  return cues;
}

/**
 * Format one cue timestamp as `m:ss`.
 * @param {number} seconds - offset inside the clip.
 * @returns {string} the compact label.
 */
function stamp(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * Render cues as compact timestamped lines inside a character budget.
 * @param {readonly { start: number, end: number, text: string }[]} cues - parsed cues.
 * @param {{ maxChars: number }} options - budget.
 * @returns {{ text: string, chars: number, truncated: boolean, rendered: number }} the projection.
 */
export function renderCues(cues, options) {
  const { maxChars } = options;
  const lines = [];
  let chars = 0;
  let rendered = 0;
  for (const cue of cues) {
    const line = `[${stamp(cue.start)}] ${cue.text}`;
    const cost = line.length + 1;
    if (chars + cost > maxChars && rendered > 0) {
      return { text: lines.join('\n'), chars, truncated: true, rendered };
    }
    lines.push(line);
    chars += cost;
    rendered += 1;
  }
  return { text: lines.join('\n'), chars, truncated: rendered < cues.length, rendered };
}

/**
 * Decode a sidecar subtitle file that may be UTF-8 or GBK, as Chinese subtitle files
 * commonly are.
 * @param {Uint8Array} bytes - raw file content.
 * @returns {string} decoded text.
 */
export function decodeSubtitleBytes(bytes) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk', { fatal: false }).decode(bytes);
  } catch {
    return utf8;
  }
}
