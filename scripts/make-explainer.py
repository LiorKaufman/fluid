#!/usr/bin/env python3
"""Render a narrated, captioned Fluid explainer from real reference-app captures.

Requires macOS `say`, Pillow, NumPy, and imageio-ffmpeg. No account or API needed.
Run: python scripts/make-explainer.py
"""
from pathlib import Path
from functools import lru_cache
import hashlib
import json
import math
import re
import subprocess
import wave

import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "media"
CACHE = ROOT / ".fluid/video-build"
OUT.mkdir(exist_ok=True)
CACHE.mkdir(parents=True, exist_ok=True)
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
W, H, FPS, SR = 1920, 1080, 24, 48000
BG = "#123c34"
PAPER = "#f8f7ef"
INK = "#173e35"
SAGE = "#c7dba9"
MUTED = "#acc8b9"
PEACH = "#f5d7be"
REGULAR = "/System/Library/Fonts/Supplemental/Arial.ttf"
BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"

STORY = [
    {
        "chapter": "The idea",
        "title": "Love the app.\nMake it yours.",
        "speech": "Ever liked an app, but wished it looked different? Or worked more like you do?",
        "kind": "intro",
    },
    {
        "chapter": "Same data",
        "title": "Keep what\nyou love.",
        "speech": "Fluid lets apps built for it keep their data and useful features, while you choose the experience.",
        "kind": "diagram",
    },
    {
        "chapter": "Your views",
        "title": "One app.\nThree ways.",
        "speech": "Take your tasks. View them as a list, a board, or one thing at a time.",
        "kind": "views",
    },
    {
        "chapter": "Your flow",
        "title": "A new view.\nYour same work.",
        "speech": "Change the view, and your work stays right there. No starting over. No copying everything into a new app.",
        "kind": "same",
    },
    {
        "chapter": "Ask an agent",
        "title": "Just ask for\nwhat you need.",
        "speech": "You can also ask your AI assistant: make this simpler, use bigger text, or show only what matters to me.",
        "kind": "ask",
    },
    {
        "chapter": "Review",
        "title": "A different\nexperience.\nThe same app.",
        "speech": "The assistant can build a different interface using the same app. You review it and choose its access.",
        "kind": "review",
    },
    {
        "chapter": "Data only",
        "title": "Sometimes,\njust the data.",
        "speech": "Just want the information? A connected assistant can work with the data directly, without using the app's screens.",
        "kind": "agent",
    },
    {
        "chapter": "Your control",
        "title": "You stay\nin control.",
        "speech": "You decide what it can read or change. See the available tools, and turn access off whenever you want.",
        "kind": "control",
    },
    {
        "chapter": "Your way",
        "title": "Your app.\nYour data.\nYour way.",
        "speech": "Fluid is the shared set of rules that makes this possible. Your app. Your data. Your way.",
        "kind": "outro",
    },
]


@lru_cache(maxsize=128)
def font(size, bold=False):
    return ImageFont.truetype(BOLD if bold else REGULAR, size)


def run(args):
    subprocess.run([str(a) for a in args], check=True, capture_output=True)


def prepare_audio():
    clips = []
    cursor = 0.0
    subtitles = []
    for index, scene in enumerate(STORY):
        key = hashlib.sha256((scene["speech"] + "Samantha-155").encode()).hexdigest()[:12]
        aiff, wav = CACHE / f"{key}.aiff", CACHE / f"{key}.wav"
        text = CACHE / f"{key}.txt"
        if not wav.exists():
            text.write_text(scene["speech"])
            run(["say", "-v", "Samantha", "-r", "155", "-f", text, "-o", aiff])
            run([FFMPEG, "-y", "-i", aiff, "-ar", str(SR), "-ac", "1", "-c:a", "pcm_s16le", wav])
        with wave.open(str(wav), "rb") as source:
            audio = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2")
        lead, tail = 0.4, 0.75
        duration = math.ceil((len(audio) / SR + lead + tail) * FPS) / FPS
        padded = np.zeros(round(duration * SR), dtype=np.int16)
        padded[round(lead * SR):round(lead * SR) + len(audio)] = audio
        clips.append(padded)
        scene["duration"] = duration
        scene["start"] = cursor
        scene["audio_duration"] = len(audio) / SR
        phrases = re.split(r"(?<=[.!?])\s+", scene["speech"])
        if scene["kind"] == "ask":
            phrases = ["You can also ask your AI assistant:",
                       "make this simpler, use bigger text, or show only what matters to me."]
        weights = [len(p.split()) + 0.8 for p in phrases]
        phrase_cursor = cursor + lead
        for phrase, weight in zip(phrases, weights):
            end = phrase_cursor + len(audio) / SR * weight / sum(weights)
            subtitles.append({"start": phrase_cursor, "end": end, "text": phrase})
            phrase_cursor = end
        cursor += duration
        print(f"Voice {index+1}/9: {duration:.2f}s — {scene['chapter']}", flush=True)
    all_audio = np.concatenate(clips)
    # Light normalization leaves headroom and preserves the natural voice dynamics.
    peak = int(np.max(np.abs(all_audio.astype(np.int32))))
    all_audio = np.clip(all_audio.astype(np.float64) * (29000 / max(1, peak)), -32768, 32767).astype("<i2")
    with wave.open(str(CACHE / "narration.wav"), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SR)
        output.writeframes(all_audio.tobytes())
    return cursor, subtitles


def rounded(draw, box, fill, radius=24, outline=None, width=1):
    draw.rounded_rectangle(tuple(round(x) for x in box), radius, fill=fill, outline=outline, width=width)


def text(draw, xy, value, size=36, color=PAPER, bold=False, spacing=12):
    draw.multiline_text(xy, value, font=font(size, bold), fill=color, spacing=spacing)


def wrap(draw, value, size, max_width, bold=False):
    result, line = [], ""
    for word in value.split():
        candidate = (line + " " + word).strip()
        if draw.textlength(candidate, font=font(size, bold)) > max_width and line:
            result.append(line)
            line = word
        else:
            line = candidate
    if line:
        result.append(line)
    return result


def centered(draw, value, y, size=36, color=PAPER, bold=False, x=W/2):
    width = draw.textlength(value, font=font(size, bold))
    text(draw, (x-width/2, y), value, size, color, bold)


def logo(draw, x=92, y=62, size=1):
    for i in range(3):
        xx = x + (2-i)*9*size
        yy = y + i*15*size
        rounded(draw, (xx, yy, xx+38*size, yy+19*size), SAGE, 8*size)
    text(draw, (x+68*size, y-7*size), "fluid.", round(52*size), PAPER, True)


def pill(draw, x, y, label, fill=SAGE, color=INK, size=25):
    width = draw.textlength(label, font=font(size, True)) + 42
    rounded(draw, (x, y, x+width, y+50), fill, 25)
    text(draw, (x+21, y+10), label, size, color, True)
    return width


IMAGES = {}
for name in ["workspace", "board", "focus", "exposed-tools"]:
    IMAGES[name] = Image.open(ROOT / f"docs/{name}.png").convert("RGB")


def image_card(canvas, source, box, crop=None, pan=0):
    x, y, width, height = map(round, box)
    image = IMAGES[source].crop(crop) if crop else IMAGES[source]
    scale = max(width/image.width, height/image.height)
    image = image.resize((round(image.width*scale), round(image.height*scale)), Image.Resampling.LANCZOS)
    extra_x, extra_y = image.width-width, image.height-height
    cx = round(extra_x/2)
    cy = round(extra_y * (0.35 + 0.25*pan))
    image = image.crop((cx, cy, cx+width, cy+height))
    mask = Image.new("L", (width, height))
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width, height), radius=22, fill=255)
    shadow = Image.new("RGBA", canvas.size)
    ImageDraw.Draw(shadow).rounded_rectangle((x, y+15, x+width, y+height+15), radius=25, fill=(0, 0, 0, 85))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(16)))
    canvas.paste(image, (x, y), mask)
    ImageDraw.Draw(canvas).rounded_rectangle((x, y, x+width, y+height), radius=22, outline="#739887", width=2)


def arrow(draw, start, end, color=SAGE, width=5):
    draw.line((start, end), fill=color, width=width)
    dx, dy = end[0]-start[0], end[1]-start[1]
    angle = math.atan2(dy, dx)
    points = [end,
              (end[0]-20*math.cos(angle-0.5), end[1]-20*math.sin(angle-0.5)),
              (end[0]-20*math.cos(angle+0.5), end[1]-20*math.sin(angle+0.5))]
    draw.polygon(points, fill=color)


def caption(canvas, value):
    draw = ImageDraw.Draw(canvas)
    lines = wrap(draw, value, 36, 1640)
    height = 30+len(lines)*47
    y = H-60-height
    rounded(draw, (106, y, W-106, H-60), "#092a25", 20)
    for i, line in enumerate(lines):
        centered(draw, line, y+15+i*47, 36)


def draw_scene(index, progress):
    scene = STORY[index]
    canvas = Image.new("RGBA", (W, H), BG)
    draw = ImageDraw.Draw(canvas)
    # Quiet geometric shapes give the film depth without competing with the demo.
    draw.ellipse((1350, -460, 2320, 450), fill="#18463b")
    draw.ellipse((-460, 700, 300, 1460), fill="#16453a")
    logo(draw)
    text(draw, (1450, 77), "THE FLUID APP PROTOCOL", 24, MUTED)
    text(draw, (96, 190), f"0{index+1}  /  {scene['chapter'].upper()}", 23, SAGE, True)
    kind = scene["kind"]
    if kind in ("intro", "outro"):
        if kind == "intro":
            text(draw, (96, 270), scene["title"], 100, PAPER, True, 14)
            text(draw, (103, 540), "The app you need.\nAn experience that fits you.", 39, MUTED, spacing=17)
            for j, (name, label, yy) in enumerate([
                ("workspace", "A list", 270), ("board", "A board", 435), ("focus", "A quiet view", 600)
            ]):
                xx = 1080 + (j % 2)*38
                image_card(canvas, name, (xx, yy, 625, 146), (250, 420 if j<2 else 290, 1130, 650 if j<2 else 555))
                draw = ImageDraw.Draw(canvas)
                pill(draw, xx+24, yy-17, label, fill=PAPER)
        else:
            text(draw, (96, 245), scene["title"], 108, PAPER, True, 12)
            rounded(draw, (1050, 285, 1795, 725), PAPER, 32)
            text(draw, (1110, 342), "The protocol is\nthe shared set of rules.", 47, INK, True, 15)
            text(draw, (1110, 520), "An app provides the data and actions.\nYou choose how to use them.", 31, "#557465", spacing=15)
            pill(draw, 1110, 635, "Open source. Built around choice.", size=24)
    else:
        size = 77 if kind != "review" else 70
        text(draw, (96, 270), scene["title"], size, PAPER, True, 17)
        if kind == "diagram":
            text(draw, (102, 570), "For apps built with Fluid", 31, MUTED)
            rounded(draw, (775, 350, 1160, 660), PAPER, 28)
            text(draw, (825, 406), "YOUR APP", 31, "#6b836e", True)
            text(draw, (825, 480), "Your data\nUseful actions", 40, INK, True, 24)
            for j, label in enumerate(["Your favorite view", "Your own interface", "Your AI assistant"]):
                y = 265+j*200
                arrow(draw, (1160, 505), (1380, y+65))
                rounded(draw, (1400, y, 1810, y+130), "#d7e6c6" if j<2 else PEACH, 22)
                text(draw, (1430, y+44), label, 33, INK, True)
        elif kind == "views":
            current = min(2, int(progress*3))
            names = ["workspace", "board", "focus"]
            labels = ["A familiar list", "A visual board", "One thing at a time"]
            pill(draw, 100, 530, labels[current], fill=PAPER)
            text(draw, (102, 625), "Same tasks.\nDifferent ways to work.", 36, MUTED, spacing=18)
            image_card(canvas, names[current], (748, 225, 1080, 688), (240, 145, 1150, 725), progress)
        elif kind == "same":
            text(draw, (102, 525), "Your tasks stay in the app.\nEvery view uses them.", 35, MUTED, spacing=19)
            image_card(canvas, "board", (748, 225, 1080, 688), (250, 280, 1150, 875), progress)
            draw = ImageDraw.Draw(canvas)
            pill(draw, 790, 254, "Same app. Same records.", fill=PEACH)
        elif kind == "ask":
            text(draw, (102, 535), "Tell your assistant\nhow you want it to work.", 35, MUTED, spacing=19)
            rounded(draw, (755, 235, 1822, 890), PAPER, 30)
            text(draw, (809, 280), "EXAMPLE REQUEST", 24, "#6b836e", True)
            rounded(draw, (809, 350, 1768, 618), "#e1ead6", 26)
            quote = "Make this simpler. Use bigger text. Show only what matters to me."
            shown = quote[:min(len(quote), round(len(quote)*min(1, progress*2.2)))]
            for j, line in enumerate(wrap(draw, shown, 48, 820)):
                text(draw, (850, 389+j*65), line, 48, INK, True)
            for j, label in enumerate(["A calmer layout", "Bigger text", "Your priorities"]):
                pill(draw, 809, 683+j*59, label, fill=PEACH if j==0 else "#e1ead6", size=25)
        elif kind == "review":
            text(draw, (102, 590), "Review the change.\nChoose what it can access.", 34, MUTED, spacing=19)
            image_card(canvas, "focus", (748, 225, 1080, 688), (280, 145, 1150, 725), progress)
            draw = ImageDraw.Draw(canvas)
            pill(draw, 790, 825, "Your choice to use it", fill=PAPER)
        elif kind == "agent":
            text(draw, (102, 535), "Use an assistant you connect.\nGive it only the access it needs.", 33, MUTED, spacing=19)
            rounded(draw, (755, 235, 1822, 890), PAPER, 30)
            text(draw, (809, 278), "EXAMPLE AGENT WORKFLOW", 24, "#6b836e", True)
            rounded(draw, (809, 345, 1768, 468), "#e1ead6", 24)
            text(draw, (849, 387), "What needs my attention today?", 40, INK, True)
            if progress > 0.22:
                text(draw, (815, 522), "Two tasks are due today.", 42, INK, True)
                for j, value in enumerate(["Explore the new homepage", "Sketch the welcome experience"]):
                    y = 610+j*91
                    rounded(draw, (815, y, 1768, y+74), "#eff2e8", 15)
                    draw.ellipse((838, y+27, 854, y+43), fill="#87a269")
                    text(draw, (879, y+22), value, 32, INK)
                text(draw, (815, 824), "Read from the same app, with permission.", 25, "#6b836e")
        elif kind == "control":
            text(draw, (102, 525), "Read. Change. Delete.\nEach is a separate choice.", 34, MUTED, spacing=19)
            image_card(canvas, "exposed-tools", (748, 225, 1080, 688), (240, 130, 1410, 875), progress)
            draw = ImageDraw.Draw(canvas)
            pill(draw, 790, 825, "See exactly what is available", fill=PEACH)
    return canvas


def timestamp(value):
    milliseconds = round(value*1000)
    return f"{milliseconds//3600000:02}:{milliseconds//60000%60:02}:{milliseconds//1000%60:02},{milliseconds%1000:03}"


def main():
    duration, subtitles = prepare_audio()
    total_frames = sum(round(s["duration"]*FPS) for s in STORY)
    duration = total_frames/FPS
    (OUT / "fluid-explainer.srt").write_text("\n\n".join(
        f"{i+1}\n{timestamp(s['start'])} --> {timestamp(s['end'])}\n{s['text']}"
        for i, s in enumerate(subtitles)) + "\n")
    (CACHE / "timeline.json").write_text(json.dumps({"duration": duration, "scenes": STORY, "subtitles": subtitles}, indent=2))
    transcript = "# Fluid: your app, your data, your way\n\n"
    transcript += f"A {duration:.0f}-second explainer for people who do not write software.\n\n"
    transcript += "The list, board, focus, and tools images are real reference-app captures. The assistant conversations and connection diagram are illustrative. They explain supported workflows rather than depicting a live model response. Voiceover is generated locally with macOS Samantha.\n\n"
    for scene in STORY:
        transcript += f"## {scene['chapter']} ({scene['start']:.1f}s)\n\n{scene['speech']}\n\n"
    transcript += "## Rebuild\n\nOn macOS, install Pillow, NumPy, and imageio-ffmpeg in a virtual environment, then run `python scripts/make-explainer.py` from this project. Assets come from `docs/`; intermediate audio is cached in `.fluid/video-build/`.\n"
    (OUT / "fluid-explainer-transcript.md").write_text(transcript)
    command = [FFMPEG, "-y", "-f", "rawvideo", "-vcodec", "rawvideo", "-pix_fmt", "rgb24",
               "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-i", str(CACHE / "narration.wav"),
               "-i", str(OUT / "fluid-explainer.srt"), "-map", "0:v", "-map", "1:a", "-map", "2:s",
               "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
               "-c:a", "aac", "-b:a", "160k", "-ar", str(SR), "-c:s", "mov_text",
               "-metadata:s:s:0", "language=eng", "-metadata", "title=Fluid — Your app. Your data. Your way.",
               "-metadata", "comment=Real reference-app captures with illustrative agent workflows. Locally synthesized narration. Open-source Fluid protocol demo.",
               "-movflags", "+faststart", "-t", f"{duration:.6f}", str(OUT / "fluid-explainer.mp4")]
    with (CACHE / "render.log").open("wb") as log:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log)
        frame_number = 0
        previous = None
        storyboard = []
        for index, scene in enumerate(STORY):
            frames = round(scene["duration"]*FPS)
            base_frames = {}
            for local in range(frames):
                progress = local/max(1, frames-1)
                # The app screenshots gently pan; agent text is revealed as a request.
                if scene["kind"] in ("intro", "outro", "diagram"):
                    quantized = 0
                elif scene["kind"] == "views":
                    quantized = min(2, int(progress*3))/3
                elif scene["kind"] == "ask":
                    quantized = round(progress*45)/45
                elif scene["kind"] == "agent":
                    quantized = 0 if progress <= 0.22 else 1
                else:
                    quantized = round(progress*16)/16
                if quantized not in base_frames:
                    base_frames[quantized] = draw_scene(index, quantized)
                    if len(base_frames) > 3:
                        del base_frames[next(iter(base_frames))]
                canvas = base_frames[quantized].copy()
                if previous is not None and local < 10:
                    canvas = Image.blend(previous, canvas, (local+1)/10)
                current_time = frame_number/FPS
                draw = ImageDraw.Draw(canvas)
                draw.rectangle((0, H-8, W, H), fill="#1e5144")
                draw.rectangle((0, H-8, round(W*current_time/duration), H), fill=SAGE)
                for subtitle in subtitles:
                    if subtitle["start"] <= current_time < subtitle["end"]:
                        caption(canvas, subtitle["text"])
                        break
                if local == frames//2:
                    poster = canvas.convert("RGB")
                    poster.save(CACHE / f"scene-{index+1:02}.jpg", quality=92)
                    storyboard.append(poster.resize((640, 360), Image.Resampling.LANCZOS))
                if index == 0 and local == round(FPS*2):
                    canvas.convert("RGB").save(OUT / "fluid-explainer-poster.png")
                process.stdin.write(canvas.convert("RGB").tobytes())
                frame_number += 1
            previous = draw_scene(index, 1)
            base_frames.clear()
            print(f"Rendered {index+1}/9: {scene['chapter']} ({frame_number}/{total_frames} frames)", flush=True)
        process.stdin.close()
        if process.wait() != 0:
            raise RuntimeError((CACHE / "render.log").read_text()[-4000:])
    contact = Image.new("RGB", (1920, 1080), "#fff")
    for i, poster in enumerate(storyboard):
        contact.paste(poster, ((i%3)*640, (i//3)*360))
    contact.save(CACHE / "storyboard.jpg", quality=94)
    print(json.dumps({"file": str(OUT / 'fluid-explainer.mp4'), "duration": duration,
                      "frames": total_frames, "bytes": (OUT / 'fluid-explainer.mp4').stat().st_size}), flush=True)


if __name__ == "__main__":
    main()
