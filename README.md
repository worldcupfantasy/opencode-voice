# opencode-sensevoice-voice

OpenCode **V2** TUI 语音输入插件，后端使用**本地 SenseVoiceSmall**（通过 FunASR 的
OpenAI 兼容 `/v1/audio/transcriptions` 服务），全程离线，音频不出本机。

> 为什么是自己写：OpenCode V2 没有内置语音输入，社区插件 `@renjfk/opencode-voice`
> 是 V1 插件 API，在 V2 中无法直接运行（V1→V2 插件 API 是破坏性变更）。

## 工作方式

```
快捷键 / 点击输入框右下角的「○ 录音」按钮
      → 录音 (ffmpeg) → POST 本地 /v1/audio/transcriptions (model=sensevoice)
      → 转写文本 → 直接写入输入框（不弹窗、不自动发送）
```

V2 的 CLI 插件 API 本身没有“写入输入框”的接口，但渲染器有：
`context.renderer.currentFocusedEditor` 就是当前获得焦点的编辑缓冲（即输入框），
对它调用 `EditBufferRenderable.insertText(text)` 即可把转写结果直接打进输入框，
光标停在其后，你接着编辑/回车发送即可。所以**不会弹对话框**。

**按钮挂载位置**：V2 的槽位树里没有“输入框内那行模型信息”的槽位（只暴露了输入框下方
的 `prompt.footer*`）。所以插件改走渲染器树：`currentFocusedEditor` 的父节点同时持有
输入框和那行状态，而那一行是 `justifyContent: space-between`，追加第二个子节点就会贴到
右端 —— 正好是输入框右下角，且不多占一行（不挤下面的状态栏）。宿主重绘或切换会话时该行
可能被重建，插件每秒检查一次并按需重新挂载；想退回官方槽位可用 `button` 选项。

## 目录结构

```
opencodevoice/
├── package.json            # exports "." 与 "./tui"
├── index.ts                # 服务端入口（空实现，仅为让包/发现两种加载方式都能工作）
├── tui.tsx                 # V2 TUI 插件本体：快捷键 + 输入框内语音按钮、录音、转写、写入
├── scripts/serve-sensevoice.sh   # 用 uv 启动本地 SenseVoiceSmall 服务
└── README.md
```

## 一、启动本地 SenseVoice 服务

需要 `uv`（`~/.local/bin/uv` 已具备）和 Python 3.11（脚本用 uv 自动获取）。

```sh
cd /home/arch-xnn/项目/opencodevoice
./scripts/serve-sensevoice.sh          # 默认 127.0.0.1:8000, CPU
# GPU（RTX 3050，需另装 CUDA 版 torch）：
# FUNASR_DEVICE=cuda ./scripts/serve-sensevoice.sh
```

首次运行会：创建 `.venv`（Python 3.11）→ 安装 CPU 版 torch + funasr（约 1–2 GB）→
下载 SenseVoiceSmall + FSMN-VAD 权重（约 900 MB，缓存在 `~/.cache/modelscope`）→
在 `http://127.0.0.1:8000` 提供服务。

验证：

```sh
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/v1/models
```

## 二、启用插件

在全局 CLI 配置 `~/.config/opencode/cli.json`（**不是** `opencode.json`）中加入：

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "theme": { "name": "system" },
  "animations": true,
  "plugins": [
    {
      "package": "/home/arch-xnn/项目/opencodevoice",
      "options": {
        "endpoint": "http://127.0.0.1:8000/v1",
        "model": "sensevoice",
        "language": "auto",
        "spacePrefix": true,
        "toggleKey": "alt+r",
        "submitKey": "alt+shift+r"
      }
    }
  ]
}
```

或者用“发现目录”方式：把本目录软链到 `~/.config/opencode/plugins/sensevoice`
（目录内需有 `index.ts` 与 `tui.tsx`，本仓库已满足）：

```sh
ln -s /home/arch-xnn/项目/opencodevoice ~/.config/opencode/plugins/sensevoice
```

改完重启 TUI 生效。

## 三、用法

**输入框语音按钮**：按钮就长在**输入框内部右下角**，和左下角的模型信息同一行
（`Build · 模型` 右侧），不占用输入框下方那行状态栏。三种状态：

| 状态 | 显示 | 颜色 |
| --- | --- | --- |
| 空闲 | `○ 录音` | 灰色（muted） |
| 录音中 | `● 录音中` | 红色 |
| 转写中 | `● 转写中` | 常规前景色 |

点击开始录音，再点停止并转写；转写结果直接写进输入框。
录制过程中**不弹任何右上角提示**，状态只看这个按钮即可（按钮文字一律**不用 emoji**）。

**快捷键**：

| 快捷键 | 命令 | 作用 |
| --- | --- | --- |
| 点击 `○ 录音` / `alt+r` | `sensevoice.toggle` | 开始/停止录音；停止后转写并**直接写入输入框** |
| `alt+shift+r` | `sensevoice.submit` | 开始/停止录音；停止后写入输入框并回车发送 |
| `/voice` | 同上 | 斜杠命令，等价于 `alt+r` |

也可以在命令面板（`ctrl+p`）里搜索 “SenseVoice”。

> `ctrl+r` 默认被 `session.rename` 占用。想用 `ctrl+r` 发起录音，可在 `cli.json` 里
> 设置 `"keybinds": { "session.rename": "none" }`，并把上面的 `toggleKey` 改成
> `"ctrl+r"`。

## 配置项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `endpoint` | `http://127.0.0.1:8000/v1` | SenseVoice/FunASR 的 OpenAI 兼容 base URL |
| `model` | `sensevoice` | 请求的模型别名（FunASR 映射到 SenseVoiceSmall） |
| `language` | `auto` | 语言提示；`auto` 让服务端自动识别（支持 zh/en/ja/ko/yue） |
| `apiKeyEnv` | — | 可选的鉴权环境变量名（本地服务通常不需要） |
| `recorder` | ffmpeg 参数 | 录音命令 argv，输出 wav 路径自动追加到末尾 |
| `spacePrefix` | `true` | 输入框已有内容时，自动补一个空格再接转写文本 |
| `button` | `composer` | 语音按钮位置：`composer` 挂在输入框内右下角（默认）；也可用宿主暴露的槽位 `prompt.footer`、`prompt.footer.status`、`session.composer.top`；`false` 关闭按钮 |
| `toggleKey` | `alt+r` | 转写并写入输入框的键 |
| `submitKey` | `alt+shift+r` | 转写、写入并发送的键 |

录音默认用 **ffmpeg**（PulseAudio 默认输入源 → 16 kHz 单声道 WAV）。
如需换成其他命令，例如 ALSA `arecord` 或较轻量的 `parecord`：

```json
"recorder": ["arecord", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav"]
```

> 注意：`parecord --file-format=wav` 在本环境实测偶发只写 44 字节头（数据丢失），
> 故默认不用它。`arecord`、`ffmpeg`、`pw-record` 均可。

## 故障排查

- 提示 `转写失败: HTTP ...` 或连接被拒：确认服务已启动（`curl http://127.0.0.1:8000/health`），
  且端口与 `endpoint` 一致。
- 提示 `无法启动录音程序`：确认 `ffmpeg` 在 PATH 中，或改用 `arecord`。
- 提示 `没找到输入栏`：热键触发时输入框没有获得焦点（比如焦点在列表/弹窗上），
  点一下输入框再按热键即可。
- 没有设备：`pactl list short sources` 查看输入源；WSL2 需 WSLg。
- 插件未生效：检查 `~/.config/opencode/cli.json` 的 `plugins` 数组，并重启 TUI；
  日志在 `~/.local/share/opencode/log/opencode.log`。
- 按钮重复出现两个 / 一闪一闪：CLI 会在**同一个进程里把插件加载多次**（本机实测 3 次），
  而且改动插件文件会触发热重载，于是有多个实例同时往同一行画按钮。现在只有最后 `setup`
  的实例持有按钮：新实例先停掉上一个实例并摘掉它的按钮，行内已存在的按钮按 id 复用，
  稳定状态下也不再多写一次文字。重启 TUI 生效。
- 热键突然全部失灵：早期版本在 `setup` 里抛异常会让整个插件（含快捷键）失效 —— 现在
  `setup` 不会抛异常，按钮挂载失败会自动退回槽位挂载，快捷键不受影响。
- 按钮偶尔消失：宿主重建输入框（切换会话、热重载）后插件会在 1 秒内自动重新挂载。
- 想重新安装服务环境：删除 `.venv` 再运行脚本。

## 许可

GNU General Public License v3.0 or later（GPL-3.0-or-later），全文见 [LICENSE](LICENSE)。
