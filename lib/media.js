/**
 * ffmpeg-backed media probing and frame/audio extraction for the `read_video` tool.
 *
 * Nothing here imports a Harness package: the module only needs Node builtins so it
 * loads in a plain profile-launched Host and in a standalone script.
 * @module dsh-video-vision/media
 */

import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bounded capture of one child process's stdout. */
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
/** Bounded capture of one child process's stderr diagnostics. */
const MAX_STDERR_BYTES = 512 * 1024;
/** Directories never descended into while looking for an ffmpeg install. */
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', '.gradle', '.idea', '.vscode', '.cache', 'cache', 'caches',
  'temp', 'tmp', 'logs', 'log', 'crashpad', 'code cache', 'gpucache', 'dawncache',
  '$recycle.bin', 'system volume information', 'windows', 'winsxs', 'driverstore',
]);

/**
 * One captured child process.
 * @typedef {{ code: number | null, signal: string | null, stdout: Buffer, stderr: string, timedOut: boolean }} RunResult
 */

/**
 * Supervise one already-spawned child: enforce the deadline and caller cancellation,
 * and settle exactly once when it closes.
 * @param {import('node:child_process').ChildProcess} child - the running process.
 * @param {{ signal?: AbortSignal, timeoutMs: number }} options - cancellation and deadline.
 * @returns {Promise<{ code: number | null, signal: string | null, timedOut: boolean }>} the exit outcome.
 */
function supervise(child, options) {
  const { signal, timeoutMs } = options;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs)
      : undefined;
    timer?.unref?.();
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    child.on('error', (error) => settle(reject, error));
    child.on('close', (code, sig) => settle(resolve, { code, signal: sig, timedOut }));
  });
}

/**
 * Capture stdout and stderr through pipes: the fast path.
 * @param {string} command - executable name or absolute path.
 * @param {readonly string[]} args - argv after the executable.
 * @param {{ signal?: AbortSignal, timeoutMs: number, cwd?: string }} options - resolution options.
 * @returns {Promise<RunResult>} the settled process.
 */
async function runPiped(command, args, options) {
  const child = spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = [];
  let outBytes = 0;
  const err = [];
  let errBytes = 0;
  child.stdout?.on('data', (chunk) => {
    if (outBytes >= MAX_CAPTURE_BYTES) return;
    outBytes += chunk.length;
    out.push(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    if (errBytes >= MAX_STDERR_BYTES) return;
    errBytes += chunk.length;
    err.push(chunk);
  });
  const outcome = await supervise(child, options);
  return {
    ...outcome,
    stdout: Buffer.concat(out, outBytes),
    stderr: Buffer.concat(err, errBytes).toString('utf8'),
  };
}

/**
 * Read at most `cap` bytes from a file without trusting its recorded size.
 * @param {string} file - absolute path.
 * @param {number} cap - byte ceiling.
 * @returns {Buffer} the bounded bytes.
 */
function readBounded(file, cap) {
  const fd = openSync(file, 'r');
  try {
    const size = Math.min(cap, statSync(file).size);
    const buffer = Buffer.alloc(size);
    if (size > 0) readSync(fd, buffer, 0, size, 0);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

/**
 * Capture stdout and stderr through temporary files. Restricted hosts forbid pipe
 * stdio for child processes (Windows sandbox: `spawn EPERM`), while file descriptors
 * stay available, so this fallback keeps decoding possible there.
 * @param {string} command - executable name or absolute path.
 * @param {readonly string[]} args - argv after the executable.
 * @param {{ signal?: AbortSignal, timeoutMs: number, cwd?: string }} options - resolution options.
 * @returns {Promise<RunResult>} the settled process.
 */
async function runThroughFiles(command, args, options) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-video-'));
  try {
    const stdoutFile = join(directory, 'stdout');
    const stderrFile = join(directory, 'stderr');
    const stdoutFd = openSync(stdoutFile, 'w');
    const stderrFd = openSync(stderrFile, 'w');
    let child;
    try {
      child = spawn(command, [...args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        windowsHide: true,
        stdio: ['ignore', stdoutFd, stderrFd],
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
    const outcome = await supervise(child, options);
    return {
      ...outcome,
      stdout: readBounded(stdoutFile, MAX_CAPTURE_BYTES),
      stderr: readBounded(stderrFile, MAX_STDERR_BYTES).toString('utf8'),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Whether a spawn failure is the restricted-host pipe denial rather than a real error. */
function isPipeDenial(error) {
  return error instanceof Error && (error.code === 'EPERM' || /\bEPERM\b|spawn EPERM/u.test(error.message));
}

/**
 * Run one command to completion, capturing bounded output.
 * @param {string} command - executable name or absolute path.
 * @param {readonly string[]} args - argv after the executable.
 * @param {{ signal?: AbortSignal, timeoutMs?: number, cwd?: string }} [options] - cancellation and deadline.
 * @returns {Promise<RunResult>} the settled process; only spawn failures reject.
 */
export async function run(command, args, options = {}) {
  const { signal, timeoutMs = 120_000, cwd } = options;
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
  const resolved = { signal, timeoutMs, ...(cwd === undefined ? {} : { cwd }) };
  try {
    return await runPiped(command, args, resolved);
  } catch (error) {
    if (!isPipeDenial(error)) throw error;
    return await runThroughFiles(command, args, resolved);
  }
}

/**
 * Read the ffmpeg build line, which both validates an executable and names its version.
 * @param {string} command - candidate executable.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<string | undefined>} the version token, or undefined when the candidate is not ffmpeg.
 */
async function readVersion(command, signal) {
  let result;
  try {
    result = await run(command, ['-hide_banner', '-version'], { signal, timeoutMs: 15_000 });
  } catch {
    return undefined;
  }
  if (result.code !== 0) return undefined;
  const first = result.stdout.toString('utf8').split('\n', 1)[0] ?? '';
  const match = /ffmpeg version (\S+)/.exec(first);
  return match?.[1];
}

/** Candidate absolute paths derived from the platform's usual install locations. */
function staticCandidates() {
  const candidates = [];
  if (platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    const appData = process.env.APPDATA;
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    const programData = process.env.ProgramData;
    if (localAppData) {
      candidates.push(join(localAppData, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
      candidates.push(join(localAppData, 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe'));
    }
    if (programData) candidates.push(join(programData, 'chocolatey', 'bin', 'ffmpeg.exe'));
    if (appData) candidates.push(join(appData, 'scoop', 'shims', 'ffmpeg.exe'));
    if (programFiles) candidates.push(join(programFiles, 'ffmpeg', 'bin', 'ffmpeg.exe'));
    if (programFilesX86) candidates.push(join(programFilesX86, 'ffmpeg', 'bin', 'ffmpeg.exe'));
    const home = homedir();
    if (home) {
      candidates.push(join(home, 'scoop', 'shims', 'ffmpeg.exe'));
      candidates.push(join(home, 'ffmpeg', 'bin', 'ffmpeg.exe'));
    }
    candidates.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
  } else {
    candidates.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/snap/bin/ffmpeg');
    const home = homedir();
    if (home) candidates.push(join(home, '.local', 'bin', 'ffmpeg'));
  }
  return candidates;
}

/** Directories scanned when no known location holds an executable. */
function scanRoots() {
  const roots = [];
  const push = (value) => {
    if (value && existsSync(value)) roots.push(value);
  };
  if (platform() === 'win32') {
    push(process.env.APPDATA);
    push(process.env.LOCALAPPDATA);
    push(process.env.ProgramFiles);
    push(process.env['ProgramFiles(x86)']);
    push(join(homedir(), 'AppData', 'Local', 'Programs'));
    push(join(homedir(), 'scoop', 'apps'));
  } else {
    roots.push('/usr/local', '/opt');
  }
  return roots;
}

/** Cache path for a discovered executable, best effort. */
function cacheFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  if (!home) return undefined;
  return join(home, 'cache', 'dsh-video', 'ffmpeg.json');
}

/** Read the cached discovery record, ignoring any damaged file. */
function readCache() {
  const file = cacheFile();
  if (file === undefined || !existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed?.path === 'string' && existsSync(parsed.path)) return parsed;
  } catch {
    /* a damaged cache is simply ignored */
  }
  return undefined;
}

/** Persist one discovery record, ignoring unwritable caches. */
function writeCache(record) {
  const file = cacheFile();
  if (file === undefined) return;
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch {
    /* the cache is an optimization only */
  }
}

/**
 * Depth-first search for an ffmpeg executable inside the given roots.
 * @param {readonly string[]} roots - directories to descend.
 * @param {{ deadline: number, depth?: number }} options - absolute time budget and depth cap.
 * @returns {string | undefined} the first executable found.
 */
function scanForFfmpeg(roots, options) {
  const { deadline, depth = 4 } = options;
  const names = platform() === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
  const walk = (directory, remaining) => {
    if (Date.now() > deadline || remaining < 0) return undefined;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (Date.now() > deadline) return undefined;
      const name = entry.name.toLowerCase();
      if (entry.isFile() && names.includes(name)) return join(directory, entry.name);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      const hit = walk(join(directory, entry.name), remaining - 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  for (const root of roots) {
    const hit = walk(root, depth);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Packages that ship a prebuilt executable; any installed one is preferred over a system copy. */
const BUNDLED_PACKAGES = ['@ffmpeg-installer/ffmpeg', 'ffmpeg-static', 'ffmpeg-static-electron'];

/**
 * Collect executable paths from optional packages that ship their own ffmpeg.
 * Some of these are binary platform packages; release tags may also be a plain path.
 * @returns {Promise<string[]>} candidate paths in preference order.
 */
/** Directory of this module, the anchor for the filesystem search below. */
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

/** Platform package name published by @ffmpeg-installer for this machine. */
const INSTALLER_PLATFORM = (() => {
  const win = platform() === 'win32';
  const mac = platform() === 'darwin';
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'ia32' : 'x64';
  if (win) return `win32-${arch}`;
  if (mac) return `darwin-${arch}`;
  return `linux-${arch}`;
})();

/** Executable file name inside those packages. */
const BINARY_NAME = platform() === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

/**
 * Candidate executables that a package manager laid down next to this module, found by
 * walking up the directory tree instead of importing a bare specifier: the Harness
 * runtime resolves bare specifiers through its own table, which has no entry for an
 * optional third-party dependency, so `import('@ffmpeg-installer/ffmpeg')` misses a
 * decoder that is physically installed right next door.
 * @returns {string[]} absolute candidate paths, nearest install first.
 */
function filesystemCandidates() {
  const candidates = [];
  let directory = MODULE_DIRECTORY;
  for (let depth = 0; depth < 8; depth += 1) {
    const modules = join(directory, 'node_modules');
    candidates.push(join(modules, '@ffmpeg-installer', INSTALLER_PLATFORM, BINARY_NAME));
    candidates.push(join(modules, 'ffmpeg-static', BINARY_NAME));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return candidates;
}

/**
 * Collect executable paths from optional packages that ship their own ffmpeg. The bare
 * import is tried first because it also works in plain Node scripts; the filesystem walk
 * covers Hosts whose resolver intercepts bare specifiers.
 * @returns {Promise<string[]>} candidate paths in preference order.
 */
async function bundledCandidates() {
  const candidates = [];
  for (const specifier of BUNDLED_PACKAGES) {
    try {
      const loaded = await import(specifier);
      const value = loaded?.default ?? loaded;
      const path = typeof value === 'string' ? value : typeof value?.path === 'string' ? value.path : undefined;
      if (path !== undefined && path !== '') candidates.push(path);
    } catch {
      /* the package is optional: absence only means this candidate is unavailable */
    }
  }
  for (const candidate of filesystemCandidates()) {
    if (!candidates.includes(candidate) && existsSync(candidate)) candidates.push(candidate);
  }
  return candidates;
}

/**
 * Locate a usable ffmpeg executable.
 * @param {{ configuredPath?: string, signal?: AbortSignal, scanBudgetMs?: number }} options - explicit path and cancellation.
 * @returns {Promise<{ command: string, version?: string, origin: string }>} the executable and how it was found.
 * @throws {Error} when no candidate runs as ffmpeg.
 */
export async function findFfmpeg(options = {}) {
  const { configuredPath, signal, scanBudgetMs = 6_000 } = options;
  const tried = [];

  if (configuredPath && configuredPath.trim() !== '') {
    const version = await readVersion(configuredPath, signal);
    if (version !== undefined) return { command: configuredPath, version, origin: 'configured ffmpegPath' };
    throw new Error(`configured ffmpegPath "${configuredPath}" is not a runnable ffmpeg executable; fix the plugin config or clear it to auto-detect`);
  }

  for (const candidate of await bundledCandidates()) {
    if (!existsSync(candidate)) continue;
    const version = await readVersion(candidate, signal);
    if (version !== undefined) return { command: candidate, version, origin: 'bundled with the plugin' };
    tried.push(candidate);
  }

  const fromEnv = process.env.DSH_FFMPEG;
  if (fromEnv && fromEnv.trim() !== '') {
    const version = await readVersion(fromEnv, signal);
    if (version !== undefined) return { command: fromEnv, version, origin: 'DSH_FFMPEG' };
    tried.push(`DSH_FFMPEG=${fromEnv}`);
  }

  const onPath = platform() === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const pathVersion = await readVersion(onPath, signal);
  if (pathVersion !== undefined) return { command: onPath, version: pathVersion, origin: 'PATH' };

  for (const candidate of staticCandidates()) {
    if (!existsSync(candidate)) continue;
    const version = await readVersion(candidate, signal);
    if (version !== undefined) {
      writeCache({ path: candidate, version, origin: 'known install location' });
      return { command: candidate, version, origin: 'known install location' };
    }
    tried.push(candidate);
  }

  const cached = readCache();
  if (cached !== undefined) {
    const version = await readVersion(cached.path, signal);
    if (version !== undefined) {
      return { command: cached.path, version, origin: cached.origin ?? 'cached discovery scan' };
    }
  }

  const scanned = scanForFfmpeg(scanRoots(), { deadline: Date.now() + scanBudgetMs });
  if (scanned !== undefined) {
    const version = await readVersion(scanned, signal);
    if (version !== undefined) {
      writeCache({ path: scanned, version, origin: 'directory scan' });
      return { command: scanned, version, origin: 'directory scan' };
    }
    tried.push(scanned);
  }

  const detail = tried.length === 0 ? '' : ` Tried: ${tried.join(', ')}.`;
  throw new Error(
    'no ffmpeg executable was found, and read_video needs one to decode the video.'
    + ' Fix it with any ONE of these: reinstall the plugin (its bundled decoder was skipped or blocked),'
    + ' install ffmpeg for this system (Windows: "winget install Gyan.FFmpeg"; macOS: "brew install ffmpeg"; Debian/Ubuntu: "apt install ffmpeg"),'
    + ' set the DSH_FFMPEG environment variable, or set the "ffmpegPath" config field of the "video-vision" plugin entry to an ffmpeg executable.'
    + detail,
  );
}

/**
 * One parsed media description.
 * @typedef {{
 *   durationSeconds: number | undefined,
 *   video: { codec: string, width: number, height: number, fps: number | undefined } | undefined,
 *   audio: { codec: string } | undefined,
 *   bitrateKbps: number | undefined,
 *   tags: { name: string, value: string }[],
 *   subtitleStreams: { index: number, language: string | undefined, codec: string, text: boolean }[],
 * }} MediaInfo
 */

/** Container/stream metadata worth showing to the model, in display order. */
const INTERESTING_TAGS = [
  'creation_time',
  'date',
  'com.apple.quicktime.creationdate',
  'make',
  'model',
  'com.apple.quicktime.make',
  'com.apple.quicktime.model',
  'location',
  'com.apple.quicktime.location.ISO6709',
  'encoder',
  'title',
  'comment',
];

/** Subtitle codecs that are pictures of text; they need OCR, not a text decoder. */
const BITMAP_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'dvd_subtitle',
  'dvb_subtitle',
  'xsub',
]);

/**
 * Parse `ffmpeg -i <file>` diagnostics into a media description.
 * @param {string} stderr - the captured diagnostics.
 * @returns {MediaInfo} whatever the diagnostics described.
 */
export function parseProbeOutput(stderr) {
  /** @type {MediaInfo} */
  const info = {
    durationSeconds: undefined,
    video: undefined,
    audio: undefined,
    bitrateKbps: undefined,
    tags: [],
    subtitleStreams: [],
  };
  const duration = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (duration !== null) {
    const [, h, m, s] = duration;
    info.durationSeconds = Number(h) * 3600 + Number(m) * 60 + Number(s);
  }
  const bitrate = /bitrate:\s*(\d+)\s*kb\/s/.exec(stderr);
  if (bitrate !== null) info.bitrateKbps = Number(bitrate[1]);

  const seenTags = new Set();
  for (const line of stderr.split(/\r?\n/)) {
    if (line.includes('Stream #') && !line.includes('Metadata')) {
      if (info.video === undefined && line.includes('Video:')) {
        const codec = /Video:\s*([A-Za-z0-9_-]+)/.exec(line)?.[1];
        const size = /\b(\d{2,5})x(\d{2,5})\b/.exec(line.slice(line.indexOf('Video:')));
        const fps = /,\s*([\d.]+)\s*fps/.exec(line)?.[1];
        if (codec !== undefined && size !== null) {
          info.video = {
            codec,
            width: Number(size[1]),
            height: Number(size[2]),
            fps: fps === undefined ? undefined : Number(fps),
          };
        }
      } else if (info.audio === undefined && line.includes('Audio:')) {
        const codec = /Audio:\s*([A-Za-z0-9_-]+)/.exec(line)?.[1];
        if (codec !== undefined) info.audio = { codec };
      } else if (line.includes('Subtitle:')) {
        const stream = /Stream #(\d+):(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?/u.exec(line);
        const codec = /Subtitle:\s*([A-Za-z0-9_-]+)/.exec(line)?.[1];
        if (stream !== null && codec !== undefined) {
          info.subtitleStreams.push({
            index: Number(stream[2]),
            language: stream[3] === undefined || stream[3] === 'und' ? undefined : stream[3],
            codec,
            text: !BITMAP_SUBTITLE_CODECS.has(codec),
          });
        }
      }
      continue;
    }
    const tag = /^\s{2,}([A-Za-z_][\w.:-]*)\s*:\s*(.+?)\s*$/u.exec(line);
    if (tag === null) continue;
    const [, name, value] = tag;
    if (!INTERESTING_TAGS.includes(name) || seenTags.has(name)) continue;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === 'N/A' || trimmed.length > 200) continue;
    seenTags.add(name);
    info.tags.push({ name, value: trimmed });
  }
  return info;
}

/**
 * Probe a media file with ffmpeg's own diagnostics.
 * @param {{ command: string }} ffmpeg - the resolved executable.
 * @param {string} hostPath - absolute path of the media file.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<MediaInfo>} the parsed description.
 * @throws {Error} when ffmpeg cannot open the file.
 */
export async function probeMedia(ffmpeg, hostPath, signal) {
  const result = await run(ffmpeg.command, ['-hide_banner', '-nostdin', '-i', hostPath], { signal, timeoutMs: 60_000 });
  const info = parseProbeOutput(result.stderr);
  if (info.video === undefined && info.audio === undefined) {
    const reason = result.stderr.split('\n').find((line) => /No such file|Invalid data|moov atom|Permission denied|Error/i.test(line));
    throw new Error(`ffmpeg could not read "${hostPath}"${reason === undefined ? '' : `: ${reason.trim()}`}`);
  }
  return info;
}

/**
 * Decode one subtitle stream to SRT text.
 * @param {{ command: string }} ffmpeg - the resolved decoder.
 * @param {string} hostPath - absolute media path.
 * @param {number} index - stream index inside the first input.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<string | undefined>} the SRT text, or undefined when the stream has none.
 */
export async function extractSubtitleStream(ffmpeg, hostPath, index, signal) {
  const result = await run(ffmpeg.command, [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-i', hostPath,
    '-map', `0:${index}`,
    '-f', 'srt', 'pipe:1',
  ], { signal, timeoutMs: 120_000 });
  if (result.code !== 0 || result.stdout.length === 0) return undefined;
  return result.stdout.toString('utf8');
}

/** Sidecar subtitle extensions, in preference order. */
const SIDECAR_EXTENSIONS = ['.srt', '.vtt', '.ass', '.ssa'];

/**
 * Find subtitle files saved next to the video, which players and downloaders produce.
 * @param {string} hostPath - absolute media path.
 * @param {(path: string) => boolean} exists - existence probe supplied by the caller.
 * @returns {string[]} sidecar paths that exist, best candidate first.
 */
export function findSidecarSubtitles(hostPath, exists) {
  const withoutExtension = hostPath.replace(/\.[^./\\]+$/u, '');
  const candidates = [
    ...SIDECAR_EXTENSIONS.map((extension) => `${withoutExtension}${extension}`),
    ...SIDECAR_EXTENSIONS.map((extension) => `${withoutExtension}.zh${extension}`),
    ...SIDECAR_EXTENSIONS.map((extension) => `${withoutExtension}.en${extension}`),
  ];
  return candidates.filter((candidate) => exists(candidate));
}

/**
 * Decode one frame at a timestamp into JPEG bytes.
 * @param {{ command: string }} ffmpeg - the resolved executable.
 * @param {string} hostPath - absolute path of the media file.
 * @param {number} seconds - seek position.
 * @param {{ width: number, quality: number, signal?: AbortSignal }} options - target long edge, JPEG quality, cancellation.
 * @returns {Promise<Uint8Array>} the encoded frame.
 */
export async function grabFrame(ffmpeg, hostPath, seconds, options) {
  const { width, quality, signal } = options;
  const evenWidth = Math.max(2, Math.round(width / 2) * 2);
  const result = await run(ffmpeg.command, [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-ss', seconds.toFixed(3),
    '-i', hostPath,
    '-frames:v', '1',
    '-an', '-sn',
    '-vf', `scale=${evenWidth}:-2`,
    '-q:v', String(quality),
    '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
  ], { signal, timeoutMs: 90_000 });
  if (result.stdout.length === 0) {
    const reason = result.stderr.trim().split('\n').slice(-2).join(' ').trim();
    throw new Error(`ffmpeg produced no frame at ${seconds.toFixed(2)}s${reason === '' ? '' : `: ${reason}`}`);
  }
  return result.stdout;
}

/**
 * Decode one frame, retrying slightly earlier when a seek lands past the last frame.
 * @param {{ command: string }} ffmpeg - the resolved executable.
 * @param {string} hostPath - absolute path of the media file.
 * @param {number} seconds - intended seek position.
 * @param {{ width: number, quality: number, signal?: AbortSignal }} options - extraction options.
 * @returns {Promise<{ data: Uint8Array, seconds: number }>} the frame and the position that produced it.
 */
export async function grabFrameWithRetry(ffmpeg, hostPath, seconds, options) {
  const attempts = [seconds, Math.max(0, seconds - 0.5), Math.max(0, seconds - 2)];
  let lastError;
  for (const attempt of attempts) {
    if (attempt < 0) continue;
    try {
      const data = await grabFrame(ffmpeg, hostPath, attempt, options);
      return { data, seconds: attempt };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`could not decode a frame at ${seconds.toFixed(2)}s`);
}

/**
 * Decode the audio track to 16 kHz mono PCM WAV.
 * @param {{ command: string }} ffmpeg - the resolved executable.
 * @param {string} hostPath - absolute path of the media file.
 * @param {{ maxSeconds: number, signal?: AbortSignal }} options - duration cap and cancellation.
 * @returns {Promise<Uint8Array | undefined>} the WAV bytes, or undefined when the file has no decodable audio.
 */
export async function grabAudioWav(ffmpeg, hostPath, options) {
  const { maxSeconds, signal } = options;
  const result = await run(ffmpeg.command, [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-i', hostPath,
    '-vn', '-sn', '-dn',
    '-t', String(Math.max(1, Math.round(maxSeconds))),
    '-ac', '1', '-ar', '16000',
    '-acodec', 'pcm_s16le',
    '-f', 'wav', 'pipe:1',
  ], { signal, timeoutMs: 300_000 });
  if (result.code !== 0 || result.stdout.length < 64) return undefined;
  return result.stdout;
}

/**
 * Choose frame positions across a clip.
 * @param {{ duration: number | undefined, count: number, start?: number, end?: number }} options - window and count.
 * @returns {number[]} ascending positions in seconds.
 */
export function planEvenTimestamps(options) {
  const { duration, count, start, end } = options;
  const upper = end ?? (duration === undefined ? undefined : duration);
  if (upper === undefined) {
    return Array.from({ length: count }, (_, index) => index * 1.0);
  }
  const from = Math.max(0, start ?? 0);
  const to = Math.max(from, upper);
  const span = to - from;
  if (span <= 0.0001) return [from];
  const positions = [];
  for (let index = 0; index < count; index += 1) {
    const ratio = (index + 0.5) / count;
    positions.push(Math.round((from + span * ratio) * 1000) / 1000);
  }
  return [...new Set(positions)];
}

/**
 * Truthfully report whether a path names a regular file.
 * @param {string} path - candidate path.
 * @returns {boolean} whether the path exists and is a file.
 */
export function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Read at most `cap` bytes of an existing file.
 * @param {string} path - absolute path.
 * @param {number} cap - byte ceiling.
 * @returns {Buffer} the bounded content.
 */
export function readFileBounded(path, cap) {
  return readBounded(path, cap);
}
