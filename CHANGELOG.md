# Changelog

## 0.3.5

- **Fixed: repeat detection compared motion instead of pictures.** A talking head keeps moving
  (blinking, fingers, breathing), so summing the motion between two moments made every pair
  look different: a 28-second clip of one person got twelve nearly identical cells and
  "0 repeats dropped". The scan now also keeps a 16x9 thumbnail per sample, and repeats are
  decided by the distance between thumbnails — the same face lands around 0.04-0.08, a real
  cut around 0.13 and up. Measured on that clip: 12 cells became 5, and a fast-cut AMV kept
  all 12, so the change does not touch edited footage.
- Selection is farthest-point first: the ends are kept and the moment furthest from everything
  already kept is added until nothing is distinct enough. Walking the list in order kept the
  first four seconds and dropped the other twenty-four.
- **Fixed: a single-shot clip reported "1 of the 1 detected shots were not shown"**, which
  contradicted the frames it had just returned.
- A dropped moment is always accounted for: `frames.length + sampling.deduped` equals the
  number requested, and the tests assert it.

## 0.3.4

- **Fixed: the gap table said "large" everywhere on long clips.** It used to report the peak
  picture change between two moments, so once moments sit thirteen seconds apart every gap
  contains a cut and every row read `large (usually a cut)`. On a 4-minute vlog that was eleven
  identical lines — a table that costs tokens and says nothing. Gaps now report **how many
  cuts sit inside them** plus the cut density, so `#8->#9 8 cuts, steady cutting` stands out
  next to `#1->#2 1 cut, a few cuts`, and "one cut in three seconds" means fast cutting whether
  the clip is 25 seconds or four minutes. Found by testing a real 233-second phone vlog.

## 0.3.3

- **Still shots no longer soak up the budget.** Slots are allocated by how much is happening
  inside a shot, not by how long it is; a shot whose picture barely moves is capped at one
  frame. Measured on the talking-head screen recording: 10 requested moments became 7 useful
  ones, with three copies of an unchanged picture dropped.
- **Repeated moments are dropped.** Two samples with almost no motion between them show the
  same thing, so the later one goes and the budget stays on different pictures. Reported as
  `sampling.deduped` and stated in the envelope, never silently.
- **`text` parameter (text-first reads).** For news clips, talking heads, tutorials and
  screen recordings the content lives in the words on screen. Text-first switches to an even
  sweep (burned-in subtitles change on their own schedule, not where the picture moves),
  skips repeat-dropping so no subtitle line is lost, and replaces the reading protocol with a
  transcription task: write every on-screen string cell by cell, write a line that persists
  once and list the cells it covers, keep the original characters, never invent text.
- Config: `textFirst`, `staticShotFloor`, `minCellNovelty`.

## 0.3.2

- **The reading protocol adapts to what the caller already knows.** A first read now opens
  with a hypothesis (kind of clip, setting, expected arc, each backed by a cell) before
  describing anything; a continuation read that carries a previous summary opens with a
  ledger instead: expected X | saw Y | held or broken, then names the cells that broke the
  expectation most sharply. The point is to expose the reasoning, not just the conclusion.

## 0.3.1

- **Gap deltas.** Every pair of consecutive moments now reports how much the picture moved
  between them (`<deltas>`, levels big / some / little). A vision model can see that cell 8
  differs from cell 7; it cannot tell that this gap is the largest in the clip. This is the
  comparison the scan already had and the model did not.
- **Reading protocol.** Results carry a short `<how_to_read>` block: describe what changed,
  guess the next moment before looking, then say whether the guess held, and only then write
  the summary. One pass of "summarise this video" misses cuts and invents continuity.
- **`carry` parameter.** Pass the previous chunk's summary when reading a long video in
  windows; the next read starts by checking those claims against what it now sees, so early
  misreadings get corrected instead of repeated.
- New tests cover the delta table, the protocol block, and the carried summary.

## 0.3.0

- **Shot detection.** The clip is now grouped into shots from a low-resolution colour proxy.
  `scdet` is missing from several ffmpeg builds, so the detector is our own: each change
  sample is scored against the median change in its own neighbourhood, which separates a cut
  from ordinary motion without one magic threshold for every kind of clip. Frames go one per
  shot, so a fast edit spends its budget on different shots instead of several peaks inside
  one. Measured on a 26 s Douyin edit: 9 shots found, 12 frames covering all 9.
- **Contact-sheet layout.** Larger frame counts are tiled into one labelled image instead of
  one image per frame. Sixteen moments cost roughly one thousand vision tokens instead of
  sixteen thousand, and every cell is burned with `#n <second>s` plus a cell map in the text.
  A full-resolution second look stays one `timestamps` call away.
- The proxy switched from grayscale to colour: a cut that only changes hue (navy to purple)
  was invisible in luma and is now detected.
- Labels survive stripped ffmpeg builds: a minimal fontconfig file is written once and passed
  through `FONTCONFIG_FILE`, because `drawtext` otherwise fails with "impossible to init
  fontconfig" even when `fontfile` is absolute.
- New tool parameter `layout` (auto / frames / grid) and config: `layout`, `gridColumns`,
  `gridMaxColumns`, `gridCellWidth`, `gridWhenAtLeast`, `shotRatio`, `shotFloor`,
  `minShotSeconds`, and `motionFps: 0` now means "pick a rate from the clip length".
- Tests cover shot detection on a hard-cut clip and the contact-sheet projection.

## 0.2.3

- The package now points at its public repository, so the registry page links to the
  source, issues, and README.
- Both READMEs document installing straight from the source tree
  (`dsh plugin add github:listendh/dsh-video-vision`) for an unreleased change or
  when the registry is unreachable.
- No runtime change.

## 0.2.2

Fixed a real-world installation bug. The decoder bundled by the optional
`@ffmpeg-installer/ffmpeg` package was only found through a bare `import()`, and the
Harness runtime resolves bare specifiers through its own table — which has no entry for a
third-party optional dependency. A profile install therefore silently fell back to a
system ffmpeg, or failed when there was none. Discovery now also walks up `node_modules`
from the module's own directory and prefers a decoder it finds there, verified against a
hoisted install layout.

## 0.2.1

First build available on the public registry. `0.2.0` was uploaded with a token that
bypassed two-factor authentication, so npm parked it in the staging area as a pending
publish; a staged version keeps its semver slot, so this build carries the next patch
number instead. No code changed.

## 0.2.0

- **Subtitle text.** `read_video` now reads the words the file already carries: an
  embedded text subtitle track, or a `.srt` / `.vtt` / `.ass` file saved beside the video
  (UTF-8 and GBK both decode). Cue timestamps are kept, the text is cut to a character
  budget, and a preferred language picks among several tracks. Picture-based subtitles
  (PGS, VobSub) are reported as needing OCR instead of being silently skipped.
- **Motion-aware frame placement.** A new `sampling: auto` mode reads a 64×36 grayscale
  proxy of the whole clip (about 2.3 KB per second of video), measures frame-to-frame
  change, and places frames on the biggest picture changes before filling the rest evenly.
  A visible cut is now likely to be captured even with a small frame budget. Long clips
  past `motionScanMaxSeconds` fall back to even spacing with an explicit note.
- **Container metadata.** Recording date, device make/model, location, and encoder tags
  are reported when the container carries them, so "when was this filmed" no longer
  needs an external tool.
- Subtitle text is preferred over an audio transcript: when subtitles exist, the result
  says so instead of running speech-to-text over the audio.
- Config: `sampling`, `motionScanMaxSeconds`, `motionFps`, `changeShare`,
  `minChangeGapSeconds`, `subtitles`, `maxSubtitleChars`.
- The tool result now carries `sampling`, `subtitles`, `subtitleNote`, and
  `media.tags`; the envelope gained `<metadata>` and `<subtitles>` sections.
- Tests: hard-cut clips prove frames land on cuts; a muxed subtitle track and a sidecar
  file prove both subtitle routes; a muxed `creation_time` proves metadata parsing.

## 0.1.0

First release.

- Adds the `read_video` tool: decodes a video with ffmpeg, samples frames across the clip
  (even spacing, a window, or explicit timestamps), commits each frame as a durable image
  attachment, and returns them as image content blocks with per-frame timestamps.
- Refuses to run when the calling route does not declare image input, naming the model.
- Includes an audio transcript when the profile mounts a speech-to-text provider, and
  states the reason when it does not; the transcript is never fabricated.
- ffmpeg discovery: plugin config, bundled optional package, `DSH_FFMPEG`, `PATH`, known
  install locations, then a time-boxed directory scan cached under the Harness home.
- Works where child processes cannot use pipe stdio (restricted hosts) by falling back to
  temporary-file capture.
- `node test/verify.mjs` runs the whole pipeline against synthesized clips with no network
  and no model call; `--strict` adds the harness's own JSON Schema validation.
