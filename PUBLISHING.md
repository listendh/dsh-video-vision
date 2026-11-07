# 发布清单（把 dsh-video-vision 变成"输入名字就能装"）

只做一次的事情在前三节，之后每次升级只需第 4 节。

---

## 1. 改掉三个占位符

`package.json` 里现在写着 `your-account`，发布前必须换成你的：

| 字段 | 换成 |
|---|---|
| `repository.url` | 你的 GitHub 仓库地址（没有仓库就先留着，npm 允许缺省） |
| `bugs.url` | 同上 + `/issues` |
| `homepage` | 同上 + `#readme` |
| `author` | 你的名字或昵称 |

没有 GitHub 仓库也能发 npm，但这三个字段空着会显得不专业，别人也不敢装。

## 2. 确认名字没被占

```sh
npm view dsh-video-vision version
```

- 返回版本号 → **已被占**，跳到下面「名字被占怎么办」
- 报 `E404` → 可用，继续第 3 节

### 名字被占怎么办

改成带作用域的名字，例如 `@yourname/dsh-video-vision`（`@` 后是你自己的 npm 用户名）。
作用域内的名字永远可用，不需要抢。

改完之后有**两处必须同时改**，否则装上了也用不了：

1. `package.json` 的 `"name"`
2. `cordis.patch.yml` 里那一行的 `name:` —— 它必须等于包名

## 3. 发布

```sh
npm login          # 第一次需要，浏览器里授权
npm publish        # 公开包免费；如果用了作用域名，加 --access public
```

发布前先看一眼会发出去什么（不会真的上传）：

```sh
npm pack --dry-run
```

应当只看到 11 个文件、约 22 KB：`index.js`、`lib/media.js`、`cordis.patch.yml`、
`locale/*.json`、`icon.svg`、两个 README、`LICENSE`、`CHANGELOG.md`、`package.json`。
测试脚本和演示片**不会**被打包（`.gitignore` + `files` 白名单管着）。

## 4. 装一台干净机器验证

镜像同步通常几分钟（慢的半小时）。之后：

```sh
dsh plugin add dsh-video-vision
```

重启 Harness，开新会话，问一句"看看这个视频"。能看到它抽帧并描述画面，才算真的发成了。

装不上时的自查顺序：

| 现象 | 原因 |
|---|---|
| `not-found` | 镜像还没同步；换 `--registry https://registry.npmjs.org` 试 |
| `not-a-bundle` | `package.json` 里的 `dsh.bundle.patch` 丢了，或 patch 文件没进包 |
| 版本不兼容 | 你给 `@deepseek-ai/dsh-*` 写了 peer 声明且范围不匹配；本包故意不声明 |
| 插件行是禁用的 | 装包时被跳过，看面板提示 |

## 5. 以后每次升级

1. 改 `package.json` 的 `version`（已发布的版本号不能复用）
2. 在 `CHANGELOG.md` 里记一条
3. `npm publish`
4. 用户那边：`dsh plugin remove dsh-video-vision && dsh plugin add dsh-video-vision`
   （或者装带版本号的 `dsh-video-vision@0.2.0`）

## 6. 推 GitHub（可选，但值得）

```sh
git init
git add .
git commit -m "feat: read_video for DeepSeek Harness"
git branch -M main
git remote add origin https://github.com/your-account/dsh-video-vision.git
git push -u origin main
```

仓库里已经放好 `.github/workflows/test.yml`：在 Windows / macOS / Linux 三套系统上自动装
ffmpeg、跑自测、把抽出来的画面存成 artifact。别人提 PR 时，这就是"没改坏"的证据。

`.gitignore` 已经挡掉了 `node_modules/`、`.verify/`、`demo/font.ttc`（那是我从 Windows
字体目录拷出来做演示的，19 MB，不能进仓库）、`demo/build/`。

## 7. 想上「精选」列表

按名字安装只依赖 npm，发出去就通了。但想出现在市场/文档的推荐位置，得让官方收录——
那一步不在代码里，通常是在 DeepSeek Harness 的仓库里提 issue 或 PR 介绍这个插件。
本包已经把"能被收录"的东西都准备了：图标、双语说明、许可证、能一键验证的自测脚本。

## 8. 第一次真正发布时踩到的坑（写给未来的你）

这几条都是实际发生过的，不是理论。

**① 用"绕过 2FA 的 Granular Token"发布，只会进暂存区**

现象：`npm publish` 显示成功，但 `npm view` 看到的是 `0.0.0-stage`（一个 363 字节的空壳），
真正的版本不在列表里。

原因：npm 现在要求发布前"证明你本人在场"。绕过 2FA 的令牌只能**暂存**，必须有人用 2FA
去 `npm stage approve <id>` 批准。

顺带两个后果：

- 暂存版本会**占住版本号**，所以再发同一个版本号会报 `cannot publish over the previously
  published versions`
- 解决办法要么是 `npm stage approve`（需要验证器出码），要么把版本提一个 patch 号重发

**② 账号的"写操作强制 2FA"可以直接关掉**

npm 的 2FA 分两档：登录/改设置（关不掉）、写操作（可关）。关掉写操作那一档之后，普通
`npm publish` 就能直接发，不再需要 6 位数。代价是拿到你令牌的人也能发你的包——所以
那种 bypass 令牌用完就该删。

**③ `npm profile enable-2fa` 报 403 `/-/npm/v1/user`**

因为这个开关属于"账号操作"，而你配的 Granular Token 只有包权限。先 `npm login`（网页授权），
把令牌换成登录会话，再跑命令。

**④ 升级装在 profile 里的包时遇到 `ERR_PNPM_EPERM`**

原因：profile 的 `node_modules` 里还留着上一次"本地目录安装"的 **junction（目录链接）**，
pnpm 换不掉它。

处理：删掉那个链接，但**不要删它指向的源目录**：

```powershell
cmd /c rmdir "C:\Users\<你>\.dsh\profiles\<profile>\node_modules\dsh-video-vision"
```

**⑤ 装完插件后，包内自带的解码器"看不见"**

这是 0.2.2 修掉的 bug：插件用 `import('@ffmpeg-installer/ffmpeg')` 找自带的 ffmpeg，
而 Harness 的运行时解析器会接管所有"按名字导入"，表里没有这个第三方可选依赖 → 找不到，
静默退回系统 ffmpeg。现在改成从模块自身位置向上走 `node_modules` 找文件，绕开解析器。

**教训**：发布后一定要在**干净目录**里 `npm install` 一次，再跑一次真实调用。本机能用
不等于别人能用——上面第 ⑤ 条只在"装到别的 node_modules 里"时才暴露。
