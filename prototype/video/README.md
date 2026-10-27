# 合耕小舍截图讲解

2026-10-27本轮媒体以“合耕小舍”暖黄色版实际390×640页面截图为输入，包含农场、商城、主页签到、社区、我的资产与签到，以及猪视角。素材为AI生成摄影风格示意，非农场实拍；截图讲解非连续录屏。

本轮 `walkthrough.mp4` 的规格为 **24 秒的界面截图讲解，不是连续实机录屏**：六张实际 Demo 界面截图依次展示，每张 4 秒。没有模拟点击轨迹、伪造设备回执或声称实时监控；成片生成后仍须核对实际媒体信息和播放结果。

## 生成

在项目根目录运行：

```powershell
python tools/make_walkthrough.py
```

也可明确指定输入和输出：

```powershell
python tools/make_walkthrough.py --screenshots .scratch/warm-theme/screenshots --output prototype/video/walkthrough.mp4
```

依赖使用当前机器已安装的 Pillow 与 imageio_ffmpeg。脚本通过 `imageio_ffmpeg.get_ffmpeg_exe()` 查找现有 FFmpeg，不下载软件；中文字幕使用 `C:/Windows/Fonts/msyh.ttc`。

输入目录需包含：

| 截图 | 时间 | 单行字幕 |
| --- | --- | --- |
| `01-farm.png` | 00:00–00:04 | 我的农场：查看种养，按需照料 |
| `02-shop.png` | 00:04–00:08 | 农场商城：当季认养与积分物资 |
| `03-home.png` | 00:08–00:12 | 合耕小舍：每日签到与田园动态 |
| `04-community.png` | 00:12–00:16 | 田园社区：发帖、交流与分享 |
| `05-profile.png` | 00:16–00:20 | 我的：资产与每日签到 |
| `06-pig-pov.png` | 00:20–00:24 | 猪的第一视角：AI静态场景示意 |

默认输入目录为 `.scratch/warm-theme/screenshots`。脚本先检查六张截图是否齐全，缺图直接退出，不轮询、不自行截图。输入保持完整 UI，等比缩放置于 `#f8f8f6` 浅灰底中，四周按需要补边；字幕使用 `#292720`，分隔线为 `#ebe8df`。每一时刻只新增一行底部字幕，不缩放裁切 UI。构建用的临时帧在输出目录内创建并自动清理；`.scratch` 截图不属于发布包。

## 输出与播放

- `walkthrough.mp4`：720 × 1280、24 fps、24 秒、H.264 / yuv420p、faststart，无音频。
- `poster.webp`：与视频首帧一致的封面。
- `index.html`：使用原生视频控件的独立播放器，支持内联播放，默认只预加载元数据；可返回 H5 体验。

播放器的 MP4、后备直链、封面与样式带 `?v=20261027-warm1`，避免本轮更新继续使用旧缓存；文件本身仍用原文件名。

通过项目已有静态服务器打开 `prototype/video/`。当前 H5 中的设备、摄像头、广告、收益及履约数据均为模拟；生成视频不代表微信／抖音小程序已提交或上架。

## 验证真实媒体信息

无需额外安装 ffprobe，可使用现有 FFmpeg 读取成片：

```powershell
python -c "import imageio_ffmpeg,subprocess; subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-hide_banner','-i','prototype/video/walkthrough.mp4'],check=False)"
```

此命令只探测输入而没有指定输出，FFmpeg 可能返回非零退出码；以实际输出的时长、视频编码、分辨率和像素格式为准。发布前还需在浏览器点击播放，确认元数据、可暂停及跳转进度正常。
