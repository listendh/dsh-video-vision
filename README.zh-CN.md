# dsh-video-vision

[English](README.md) | **简体中文**

> 让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 看懂视频。

Harness 里的模型早就会看图，但它打不开视频——没有任何工具把一段片子变成"模型能看的画面"。
**dsh-video-vision** 补的就是这一步：新增一个工具 `read_video`，把视频解码、等距离抽帧，
再把画面作为图片交给模型。

装上之后正常说人话就行：

> 帮我看看这段视频讲了什么

> 第 12 秒发生了什么？

> 这是录屏，帮我读一下里面的幻灯片，总结一下

> 这段视频里有人拿起红色的东西吗？

---

## 装之前 / 装之后

| | 没装 | 装了 |
|---|---|---|
| 给一个视频文件 | "我只能读文字和图片" | 它能描述画面，回答关于视频的问题 |
| 画面上的字 | 你自己照着敲一遍 | 它自己看 |
| "第 12 秒发生了什么" | 做不到 | 一次调用，指定第 12 秒 |
| 视频里说的话 | 听不到 | 有字幕轨/字幕文件就直接读出来（带时间轴）；挂了语音识别也能转 |
| 什么时候拍的 | 不知道 | 文件里的元数据：拍摄时间、设备、位置 |

它**不会**逐帧看完整段视频。默认取 8 张画面：先挑"画面变化最大"的时刻，剩下的均匀铺开。
比分帧间隔更短的动作仍可能漏掉——你知道该看哪一段时，直接给 `timestamps`。

---

## 安装

在 Harness 的插件面板里输入包名，或者用命令行：

```sh
dsh plugin add dsh-video-vision
```

然后重启 Harness（没有热重载的环境里，新插件只在启动时加载），再开一个新会话。

工具名是 `read_video`。其它什么都不变：不用视频的场景，行为和以前一模一样。

### 前提条件

1. **模型要能看图。** 当前模型必须声明支持图片输入（DeepSeek V41 Flash 支持）。
   换成纯文本模型时，工具会直接告诉你"这个模型不收图"，而不是先把画面传上去等报错。
2. **需要一个 ffmpeg 可执行文件。** 按下面的顺序找，第一个能跑的胜出：

   | # | 来源 | 说明 |
   |---|---|---|
   | 1 | 插件配置 `ffmpegPath` | 你指定的路径，不猜 |
   | 2 | 本包自带的解码器 | 可选依赖 `@ffmpeg-installer/ffmpeg`，安装时不跑脚本 |
   | 3 | 环境变量 `DSH_FFMPEG` | 装在奇怪位置时用 |
   | 4 | 系统 `PATH` | `winget install Gyan.FFmpeg` / `brew install ffmpeg` / `apt install ffmpeg` |
   | 5 | 常见安装位置 | WinGet、Chocolatey、Scoop、`/usr/local/bin`、Homebrew … |
   | 6 | 有限时间的目录扫描 | 扫用户应用目录，结果缓存在 `$DSH_HOME/cache/dsh-video-vision` |

   一个都找不到时，报错里直接给出上面各系统的安装命令，不甩一堆堆栈。

---

## `read_video` 工具参数

| 参数 | 类型 | 含义 |
|---|---|---|
| `path` | 字符串，**必填** | 视频路径，由文件系统后端解析（相对路径以会话工作目录为基准） |
| `frames` | 数字 | 抽几帧，受配置上限约束 |
| `timestamps` | 数字数组 | 精确指定第几秒，优先于 `frames`；自动排序并夹到片长内 |
| `start` / `end` | 数字 | 只在这段时间里抽，默认整段 |
| `width` | 数字 | 单帧长边像素；比原片大时不会放大 |
| `transcript` | 布尔 | 是否请求语音转写 |
| `subtitles` | 布尔 | 是否读取文件里已有的字幕 |
| `language` | 字符串 | 转写语言提示，也用来在多条字幕轨里挑一条 |

模型实际拿到的东西长这样：

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
[图片]
frame 2/6 @ 1.51s
[图片]
…
<subtitles source="embedded subtitle stream #2 (subrip, chi)" cues="3">
[0:00] 你好，欢迎使用这个视频工具
[0:02] 第二步：确认付款
[0:04] 好了，马上结束
</subtitles>
<transcript unavailable="音频没有转写；下面的字幕就是片子自己说的话"/>
<warnings>- ……</warnings>                          （某帧解码失败时的说明）
```

时间标签写在同一张图旁边，而不是塞进一段 JSON 里——这样模型能直接说"大约 1.5 秒那里"，
而不是猜哪张图是哪个时刻。字幕带自己的时间轴，所以它能引用"第 2 秒那句台词"。

---

## 配置

全部可选，下面是默认值。写在插件 `video-vision` 那一行的配置里。

本包没有声明配置结构，所以插件面板里暂时不显示设置表单。要改这些值，在 profile 的
`cordis.patch.yml` 里加一行：

```yaml
- id: video-vision
  config:
    ffmpegPath: 'C:\tools\ffmpeg\bin\ffmpeg.exe'
    defaultFrames: 10
```

注意：这种覆盖会**整段替换** `config`，想保留的字段要一起写上。如果你只是想指定用哪个解码器，
更省事的办法是设环境变量 `DSH_FFMPEG`，配置一个字都不用改。

| 键 | 默认 | 含义 |
|---|---:|---|
| `ffmpegPath` | `''` | ffmpeg 的绝对路径；空表示自动找 |
| `defaultFrames` | `8` | 模型没指定时抽几帧 |
| `maxFrames` | `16` | 单次调用的硬上限 |
| `maxFrameWidth` | `1024` | 单帧长边；一张图最多算 1024 个视觉 token |
| `jpegQuality` | `3` | 交给 ffmpeg 的 JPEG 质量（2 最好，31 最差） |
| `sampling` | `auto` | `auto` = 先挑画面变化最大的时刻，再均匀补满；`even` = 不跑变化扫描，纯均匀 |
| `motionScanMaxSeconds` | `600` | 变化扫描最多覆盖多长；超长的片子自动退回均匀取帧并给出提示 |
| `motionFps` | `4` | 变化扫描的采样率（每秒几张，1–12） |
| `changeShare` | `0.6` | 帧预算里留给"画面变化"的比例 |
| `minChangeGapSeconds` | `0.6` | 两个"变化帧"之间的最小间隔 |
| `maxAudioSeconds` | `600` | 送去转写的音频最长多少秒 |
| `language` | `zh` | 默认转写语言，也是字幕轨的首选语言 |
| `transcript` | `true` | 是否默认请求语音转写 |
| `subtitles` | `true` | 是否读取文件里已有的字幕 |
| `maxSubtitleChars` | `6000` | 字幕文本的字数上限 |

---

## 速度、体积、花费

- 取帧是 **N 次定位**，不会把整个文件从头解到尾：每帧大约 100–200 毫秒，
  所以两小时的录屏取 16 帧也只是几秒，不是几分钟。
- "变化扫描"是唯一的例外：它会用 64×36 的缩略图把整片过一遍。单帧很便宜，但架不住长，
  所以默认用 `motionScanMaxSeconds` 把它限在 10 分钟。字幕是直接读出来的，不走音频。
- 每帧是一张受 `maxFrameWidth` 限制的 JPEG。1024×576 大约 100 KB，对模型来说最多 1024 个视觉
  token；八张也就是一个小请求。
- 帧会经过附件服务落盘去重，同一会话里可复用。

---

## 出问题时

**提示 "no ffmpeg executable was found"** —— 按上面的表装一个，或配置 `ffmpegPath`。
报错里已经写明各系统的命令。

**提示 "model … does not declare image input"** —— 把会话切到能看图的模型。

**装上了但插件行是禁用状态** —— 有些环境在跑安装脚本前会先问。本包本身没有安装脚本；
如果仍然提示有 pending build，同意或跳过 `@ffmpeg-installer/ffmpeg`，工具会退回用系统 ffmpeg。

**长视频抽出来的画面几乎一样** —— 那是采样，不是 bug：画面本来就没变。把 `timestamps`
指到有动作的地方。

**没读到字幕** —— 文件里没有文本字幕轨，旁边也没有字幕文件。结果里会说明原因，其中也包括
"这是图片型字幕（PGS、VobSub），需要 OCR 才能读"这种情况。

**声音没有转成文字** —— 当前环境没挂语音识别，文件里也没有字幕。工具会在结果里如实写原因，
不会编对话。

---

## 卸载

```sh
dsh plugin remove dsh-video-vision
```

下次启动工具就消失了。除了 `$DSH_HOME/cache/dsh-video-vision/ffmpeg.json` 这个"上次在哪找到
ffmpeg"的缓存（可以随手删），什么都不留。

---

## 开发

```sh
node test/verify.mjs                       # 自测：只需要 node + ffmpeg
node test/verify.mjs --strict <dir>        # 再用 @deepseek-ai/dsh-tools 做一次严格校验
```

自测脚本会用 ffmpeg 自己合成测试片（包括带硬切的片子、内嵌字幕、字幕文件），用假上下文驱动
真插件，检查信封、时间标签、图片块、变化取帧、两条字幕通路、元数据、各种失败路径和转写分支。
不联网，不调模型。

目录：`index.js`（工具定义、结果投影、语音对接）、`lib/media.js`（ffmpeg 发现、探测、抽帧/取音/取字幕）、
`lib/activity.js`（变化扫描与选帧）、`lib/subtitles.js`（字幕解析与渲染）、`cordis.patch.yml`（bundle 里那一行）、
`locale/*.json`（面板文案）。

## 许可

MIT。本包只调用运行时环境里的 ffmpeg，不重分发它；那个可执行文件遵守它自己的许可。
