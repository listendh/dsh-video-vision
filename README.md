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
| `language` | string | Language hint for the transcript, and for choosing among subtitle tracks |

What the model receives:

```
<path>C:\clips\demo.mp4</path>
<type>video</type>
<content>
video, 6.02s, 640x360 px, 30 fps, h264, audio aac
6 frames sampled from 0.50s to 5.52s, 2 of them placed where the picture changed most;
each image below is preceded by its own timestamp in the clip.
decoded by ffmpeg 6.1.1
</content>
<metadata>
creation_time: 2025-03-04T05:06:07Z
</metadata>

frame 1/6 @ 0.50s
[image]
frame 2/6 @ 1.51s
[image]
…
<subtitles source="embedded subtitle stream #2 (subrip, chi)" cues="3">
[0:00] 你好，欢迎使用这个视频工具
[0:02] 第二步：确认付款
[0:04] 好了，马上结束
</subtitles>
<transcript unavailable="the audio track was not transcribed; the subtitle text below is what the video says"/>
<warnings>- …</warnings>                           (when a frame had to be skipped)
```

Captions sit next to the images instead of inside a JSON blob, so the model can point at a
moment ("around 1.5s") instead of guessing which picture is which. Subtitle text keeps its
own timestamps, so it can quote what was said at 0:02 without any audio model.

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
