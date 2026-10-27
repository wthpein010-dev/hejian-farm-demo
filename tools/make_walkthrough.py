#!/usr/bin/env python3
"""Build a silent 24-second H5 screenshot walkthrough; this is not a screen recording."""

from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import sys
import tempfile

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont, ImageOps


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WIDTH, HEIGHT = 720, 1280
FPS = 24
SECONDS_PER_SCENE = 4
BACKGROUND = "#f8f8f6"
INK = "#292720"
FONT_PATH = Path("C:/Windows/Fonts/msyh.ttc")
SCENES = (
    ("01-farm.png", "我的农场：查看种养，按需照料"),
    ("02-shop.png", "农场商城：当季认养与积分物资"),
    ("03-home.png", "合耕小舍：每日签到与田园动态"),
    ("04-community.png", "田园社区：发帖、交流与分享"),
    ("05-profile.png", "我的：资产与每日签到"),
    ("06-pig-pov.png", "猪的第一视角：静态场景体验"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="把六张 H5 截图制作为 24 秒竖屏讲解 MP4（非连续实机录屏）。"
    )
    parser.add_argument(
        "--screenshots",
        type=Path,
        default=PROJECT_ROOT / ".scratch" / "ui-polish" / "screenshots",
        help="六张 PNG 截图所在目录。默认：项目 .scratch/ui-polish/screenshots",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=PROJECT_ROOT / "prototype" / "video" / "walkthrough.mp4",
        help="输出 MP4。默认：prototype/video/walkthrough.mp4",
    )
    return parser.parse_args()


def fit_caption(draw: ImageDraw.ImageDraw, caption: str) -> ImageFont.FreeTypeFont:
    """Keep the requested caption on exactly one line within the video safe area."""
    for size in range(34, 23, -1):
        font = ImageFont.truetype(str(FONT_PATH), size=size)
        if draw.textlength(caption, font=font) <= WIDTH - 56:
            return font
    raise ValueError("字幕过长，无法在安全范围内保持单行。")


def make_frame(screenshot: Path, caption: str) -> Image.Image:
    frame = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    with Image.open(screenshot) as source:
        # Preserve the complete UI. No crop, stretching, pan, or zoom is applied.
        source = ImageOps.exif_transpose(source).convert("RGBA")
        fitted = ImageOps.contain(source, (WIDTH - 40, 1148), Image.Resampling.LANCZOS)
        x = (WIDTH - fitted.width) // 2
        y = 20 + (1148 - fitted.height) // 2
        frame.paste(fitted, (x, y), fitted)

    draw = ImageDraw.Draw(frame)
    font = fit_caption(draw, caption)
    draw.line((40, 1194, WIDTH - 40, 1194), fill="#ebe8df", width=1)
    # One line of added text is present in each frame; no stacked labels or counters.
    draw.text((WIDTH // 2, 1230), caption, font=font, fill=INK, anchor="mm")
    return frame


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args()
    screenshots = args.screenshots.expanduser().resolve()
    output = args.output.expanduser().resolve()

    missing = [name for name, _ in SCENES if not (screenshots / name).is_file()]
    if missing:
        print("截图尚未齐全，未开始编码：" + "、".join(missing), file=sys.stderr)
        print("截图目录：" + str(screenshots), file=sys.stderr)
        return 2
    if not FONT_PATH.is_file():
        print("找不到中文字幕字体：" + str(FONT_PATH), file=sys.stderr)
        return 2
    if output.suffix.lower() != ".mp4":
        print("--output 必须使用 .mp4 扩展名。", file=sys.stderr)
        return 2

    output.parent.mkdir(parents=True, exist_ok=True)
    duration = len(SCENES) * SECONDS_PER_SCENE
    try:
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        with tempfile.TemporaryDirectory(prefix=".walkthrough-", dir=output.parent) as work_dir:
            work = Path(work_dir)
            manifest = []
            first_frame = None
            for index, (filename, caption) in enumerate(SCENES, start=1):
                frame = make_frame(screenshots / filename, caption)
                frame_name = f"frame-{index:02d}.png"
                frame.save(work / frame_name, format="PNG", optimize=False)
                manifest.extend((f"file '{frame_name}'", f"duration {SECONDS_PER_SCENE}"))
                if first_frame is None:
                    first_frame = frame
            # Repeat the final still so concat honors its duration; -t fixes total length.
            manifest.append(f"file 'frame-{len(SCENES):02d}.png'")
            manifest_path = work / "frames.txt"
            manifest_path.write_text("\n".join(manifest) + "\n", encoding="utf-8")
            staged_output = work / "walkthrough.mp4"
            command = [
                ffmpeg,
                "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                "-f", "concat", "-safe", "0", "-i", str(manifest_path),
                "-t", str(duration), "-an",
                "-vf", f"fps={FPS},format=yuv420p",
                "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                "-movflags", "+faststart",
                "-metadata", f"comment={duration}-second screenshot walkthrough of a simulated H5 demo; not a continuous screen recording.",
                str(staged_output),
            ]
            completed = subprocess.run(
                command, capture_output=True, text=True,
                encoding="utf-8", errors="replace", check=False,
            )
            if completed.returncode:
                diagnostic = completed.stderr.strip()[-2400:] or "FFmpeg 未返回诊断。"
                print("视频编码失败：\n" + diagnostic, file=sys.stderr)
                return 1
            if not staged_output.is_file() or staged_output.stat().st_size == 0:
                print("FFmpeg 未产生有效 MP4。", file=sys.stderr)
                return 1
            staged_output.replace(output)
            if first_frame is not None:
                first_frame.save(output.with_name("poster.webp"), format="WEBP", quality=91)
    except (OSError, ValueError, RuntimeError) as error:
        print("制作失败：" + str(error), file=sys.stderr)
        return 1

    print(f"已生成：{output}")
    print(f"规格：{WIDTH}×{HEIGHT} / {duration} 秒 / {FPS} fps / H.264 / yuv420p / faststart")
    print(f"形式：{len(SCENES)} 张截图各停留 {SECONDS_PER_SCENE} 秒，单行字幕，无音频；不是连续实机录屏。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
