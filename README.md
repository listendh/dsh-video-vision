# dsh-video-vision

English | [简体中文](README.zh-CN.md)

> Gives [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) eyes for video.

Harness models already read images. They cannot open a video: no tool turns a clip into
something a text-and-image model can look at. **dsh-video-vision** adds the missing step —
one tool, `read_video`, that decodes a video, samples frames across it, and hands those
frames back as images the model can see.

Ask in plain language:

> 帮我看看这段视频讲了什么

> What happens at the 12 second mark?

> Read the slides in this screen recording. Can you summarize them?

> Does this clip show anyone picking up a red object?

---

## Before and after

| | Without this plugin | With this plugin |
|---|---|---|
| A video file | "I can only read text and images." | The model describes the scenes and answers questions about them |
| On-screen text | You retype the slides | The model reads the frames itself |
| "What happens at 0:12?" | Not possible | One call with `timestamps: [12]` |
| Spoken words | Not heard | Subtitle track or sidecar file, quoted with timestamps; audio transcription when a speech-to-text provider is mounted |
| When was it filmed | Unknown | Container metadata: recording date, device, location |

What it does **not** do: watch every frame in real time. It looks at N sampled stills
(8 by default), placed where the picture changes most, with the rest spaced evenly. A
moment shorter than the sampling interval can still be missed — pass `timestamps` when you
know where to look.

---

## Install

From the Harness plugin panel, type the package name; or use the CLI:

```sh
dsh plugin add dsh-video-vision
```

Then restart the Harness (a new plugin generation is loaded only at startup on profiles
without hot reload) and open a new session.

Straight from the source tree, to try an unreleased change or when the registry is
unreachable:

```sh
dsh plugin add github:listendh/dsh-video-vision
```

Repository: <https://github.com/listendh/dsh-video-vision>

The tool appears as `read_video`. Nothing else changes: models without a video request
keep working exactly as before.

### Requirements

1. **An image-capable model.** The current route must declare image input (DeepSeek V41
   Flash does). On a text-only model the tool refuses with a message naming the model,
   instead of uploading frames the provider would reject.
2. **An ffmpeg executable.** Resolved in this order, first working candidate wins:

   | # | Source | Notes |
   |---|---|---|
   | 1 | `ffmpegPath` plugin config | explicit path, no guessing |
   | 2 | decoder bundled by this package | `@ffmpeg-installer/ffmpeg` is an optional dependency; no install script runs |
   | 3 | `DSH_FFMPEG` environment variable | for people who keep ffmpeg in an unusual place |
   | 4 | system `PATH` | `winget install Gyan.FFmpeg`, `brew install ffmpeg`, `apt install ffmpeg` |
   | 5 | usual install locations | WinGet links, Chocolatey, Scoop, `/usr/local/bin`, Homebrew, … |
   | 6 | time-boxed directory scan | user app directories, result cached under `$DSH_HOME/cache/dsh-video-vision` |

   If none is found, the tool fails with the exact commands above rather than a stack trace.

---

## The `read_video` tool

| Parameter | Type | Meaning |
|---|---|---|
| `path` | string, **required** | Video file path, resolved by the filesystem backend (a relative path uses the session workspace) |
| `frames` | number | How many frames to sample, capped by config |
| `timestamps` | number[] | Explicit positions in seconds; overrides `frames`, sorted, clamped into the clip |
| `start` / `end` | number | Sampling window in seconds; defaults to the whole clip |
| `width` | number | Long edge of one frame in pixels; never upscales |
| `transcript` | boolean | Ask the mounted speech-to-text provider for a transcript |
| `subtitles` | boolean | Include subtitle text the file already carries |
| `layout` | `auto` \| `frames` \| `grid` | Contact sheet once the count reaches the config threshold, or one image per moment |
| `carry` | string | Summary of an earlier chunk; this read continues from it instead of starting over |
| `text` | boolean | Read on-screen text as the primary content (news, talking head, tutorial, screen recording) |
| `language` | string | Language hint for the transcript, and for choosing among subtitle tracks |

Moments follow the content, not the clock: slots go to shots that actually change, a still
shot is capped at one frame, and two samples showing the same picture are collapsed into one
(`sampling.deduped` says how many). Text-first reads the other way — an even sweep that keeps
every moment, because burned-in subtitles change while the picture does not.

What the model receives (contact-sheet layout):

```
<path>C:\clips\demo.mp4</path>
<type>video</type>
<content>
video, 25.68s, 1280x720 px, 56.6 fps, h264, audio aac
12 moments sampled across 9 of 9 detected shots; delivered as one contact sheet: 4 columns x 3 rows, read row by row; every cell is labelled "#n <second>s" and the cell map below repeats it.
decoded by ffmpeg N-92722-gf22fcd4483
</content>
<cells>#1=1.35s  #2=4.30s  #3=5.90s  #4=10.17s  …</cells>
<deltas>
what happens between neighbouring moments:
#5->#6 1 cut, steady cutting
#8->#9 8 cuts, steady cutting
#11->#12 no cuts, one continuous take
</deltas>
[image: one labelled contact sheet]
<how_to_read>
1. Go through the moments in order. For each one, say what changed compared with the previous one…
2. Before you look at the next moment, guess what it will show. When you get there, say whether the guess held…
3. Finish with one paragraph in time order…
</how_to_read>
```

The delta table counts the cuts that sit between two moments, using the same proxy the shot
detector uses. Counting beats measuring the peak change: past a few seconds every gap contains
a cut, so a peak-based table says "large" everywhere and tells the model nothing. Cut density
stays comparable across a 25-second edit and a 4-minute vlog — one cut in three seconds is fast
cutting in both. The protocol asks for difference → prediction → check, because one pass of
"summarise this video" misses cuts and invents continuity.

### Reading a long video in chunks

`read_video` returns one window at a time. To keep the later part coherent, hand the earlier
summary back as `carry`:

```
read_video { path: "talk.mp4", start: 0,  end: 60, frames: 12 }   → summary A
read_video { path: "talk.mp4", start: 60, end: 120, frames: 12, carry: "A" }  → summary B, corrected against A
```

Each call then starts by checking the carried claims against what the new moments show, so
mistakes from the beginning are fixed later instead of being repeated.

---

## Configuration

Every field is optional; the shipped values are the defaults. Set them on the
`video-vision` row of the plugin's config.

This build declares no config schema, so the plugin panel shows no settings form. To
change a field, add a patch row to the profile's `cordis.patch.yml`:

```yaml
- id: video-vision
  config:
    ffmpegPath: 'C:\tools\ffmpeg\bin\ffmpeg.exe'
    defaultFrames: 10
```

A patch replaces the whole `config`, so restate every field you want to keep. For the one
setting that matters most — which decoder to use — there is a cheaper route: set the
`DSH_FFMPEG` environment variable and leave the config alone.

| Key | Default | Meaning |
|---|---:|---|
| `ffmpegPath` | `''` | Absolute path to ffmpeg; empty means auto-detect |
| `defaultFrames` | `8` | Frames per call when the model does not ask |
| `maxFrames` | `16` | Hard cap for one call |
| `maxFrameWidth` | `1024` | Long edge of one frame; each provider image costs at most 1024 vision tokens |
| `jpegQuality` | `3` | ffmpeg JPEG quality (2 = best, 31 = worst) |
| `sampling` | `auto` | `auto` places frames on the biggest picture changes then fills evenly; `even` skips that pass |
| `motionScanMaxSeconds` | `600` | Longest clip the motion pass scans; longer clips fall back to even spacing with a note |
| `motionFps` | `4` | Proxy sampling rate for that pass (1–12) |
| `changeShare` | `0.6` | Share of the frame budget reserved for picture changes |
| `minChangeGapSeconds` | `0.6` | Least spacing between two motion-chosen frames |
| `maxAudioSeconds` | `600` | Audio prepared for transcription |
| `language` | `zh` | Default transcript language, and subtitle-track preference |
| `transcript` | `true` | Ask for an audio transcript at all |
| `subtitles` | `true` | Read subtitle text the file already carries |
| `maxSubtitleChars` | `6000` | Character budget for that subtitle text |

---

## Cost, size, and speed

- Frames are **N seeks**, not a full decode: roughly 100–200 ms per frame, so a 16-frame
  read of a two-hour recording stays seconds, not minutes.
- The motion pass is the exception: it decodes the whole clip once at 64×36. That is cheap
  per frame but adds up, which is why `motionScanMaxSeconds` bounds it at 10 minutes by
  default. Subtitles are read from the container or a sidecar file, not from audio.
- Each frame is a JPEG capped at `maxFrameWidth`. A 1024×576 frame is ~100 KB on disk and
  at most 1024 vision tokens to the model; eight of them is a small request, not a
  slide deck.
- Frames are committed through the attachment service, so they are deduplicated and
  reusable across turns of the same session.

---

## Troubleshooting

**"no ffmpeg executable was found"** — install one (see the table above) or set
`ffmpegPath`. The message repeats the per-system commands.

**"model … does not declare image input"** — switch the session to an image-capable model.

**The package installed but the entry is disabled** — some deployments ask before running
package install scripts. This package declares no install script; if your profile still
reports a pending build, approve or skip `@ffmpeg-installer/ffmpeg` and let the tool fall
back to a system ffmpeg.

**Frames look identical for a long static video** — that is the sampling, not a bug: the
picture genuinely does not change. Pass `timestamps` where the action is.

**No subtitles were found** — the file has no text subtitle track and no sidecar file. The
result names the reason, including the case of picture-based subtitles (PGS, VobSub) that
would need OCR.

**The audio was not transcribed** — the profile mounts no speech-to-text provider, and the
file carries no subtitles. The tool says so instead of inventing dialogue.

---

## Uninstall

```sh
dsh plugin remove dsh-video-vision
```

The tool disappears at the next start; no session data, cache, or config is left behind
except `$DSH_HOME/cache/dsh-video-vision/ffmpeg.json`, which is a discovery cache you can
delete at any time.

---

## Development

```sh
node test/verify.mjs                       # self-contained: node + ffmpeg only
node test/verify.mjs --strict <dir>        # also validates with @deepseek-ai/dsh-tools
```

The test synthesizes its own clips with ffmpeg — including a hard-cut clip, a muxed
subtitle track, and a sidecar file — drives the real plugin through a fake Cordis context,
and asserts the envelope, the captions, the image blocks, the motion placement, the
subtitle routes, the metadata tags, the failure modes, and the transcript paths. No
network, no model call.

Layout: `index.js` (tool definition, projection, speech integration), `lib/media.js`
(ffmpeg discovery, probing, frame/audio/subtitle extraction), `lib/activity.js` (motion
scan and frame placement), `lib/subtitles.js` (cue parsing and rendering),
`cordis.patch.yml` (the bundle's one Host row), `locale/*.json` (panel text).

## License

MIT. This package shells out to ffmpeg at runtime and does not redistribute it; the
binary carries its own license.
