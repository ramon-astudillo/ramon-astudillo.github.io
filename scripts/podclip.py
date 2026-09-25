#!/usr/bin/env python3
"""Add an AntennaPod timestamp share to the podcast annotations.

Usage:
    python scripts/podclip.py share.txt [--transcribe]
    xclip -o | python scripts/podclip.py - --transcribe

The share text looks like

    <Show>: <Episode title>
    Starting from: 00:18:14

    Episode webpage: https://...
    Media file: https://...#t=1094

    optional note typed after the share (any number of lines)

Each episode gets a data file in _data/podcasts/<slug>.yml and an index page
podcasts/<slug>.md; each clip gets its own page podcasts/<slug>/<t>.md. With
--transcribe, the audio around the timestamp is transcribed with
faster-whisper and split into the quote (starting at the timestamp) and the
text before and after it, and a link-preview card podcasts/<slug>/<t>.png is
drawn with the quote highlighted in its context.
"""
import argparse
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "_data" / "podcasts"
PAGE_DIR = ROOT / "podcasts"
FONT_DIR = Path("/usr/share/fonts/truetype/noto")
SITE = "ramon-astudillo.github.io"


def parse_share(text):
    lines = [line.strip() for line in text.strip().splitlines()]
    header = lines[0]
    show, _, title = header.partition(": ")
    share = {"show": show, "title": title or header, "note": ""}
    note_lines = []
    for line in lines[1:]:
        if line.startswith("Starting from:"):
            share["t"] = hms_to_seconds(line.split(":", 1)[1].strip())
        elif line.startswith("Episode webpage:"):
            share["episode_url"] = line.split(":", 1)[1].strip()
        elif line.startswith("Media file:"):
            share["media_url"] = line.split(":", 1)[1].strip().split("#")[0]
        elif line and not set(line) <= set("-="):
            note_lines.append(line)
    share["note"] = " ".join(note_lines)
    return share


def hms_to_seconds(hms):
    seconds = 0
    for part in hms.split(":"):
        seconds = seconds * 60 + int(part)
    return seconds


def seconds_to_hms(seconds):
    h, rest = divmod(int(seconds), 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:80]


def transcribe(media_url, start, duration, model_name, prompt):
    """Return [(start, end, word)] with times in seconds from the episode start."""
    from faster_whisper import WhisperModel

    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "clip.wav"
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-ss", str(start), "-i", media_url,
             "-t", str(duration), "-ac", "1", "-ar", "16000", str(wav)],
            check=True,
        )
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        segments, _ = model.transcribe(str(wav), initial_prompt=prompt,
                                       vad_filter=True, word_timestamps=True)
        # words keep their leading space; pieces like "-HI" or "%" have none
        return [(start + w.start, start + w.end, w.word)
                for s in segments for w in s.words]


def split_quote(words, t, length, max_length):
    """Quote runs from the timestamp to the first sentence end after `length`
    seconds (at most `max_length`); the rest is context before and after."""
    first = next((i for i, w in enumerate(words) if w[0] >= t - 1), len(words))
    last = first
    while last < len(words) and words[last][0] < t + max_length:
        last += 1
        if words[last - 1][1] >= t + length and words[last - 1][2].rstrip()[-1:] in ".?!":
            break
    join = lambda ws: "".join(w[2] for w in ws).strip()
    return join(words[:first]), join(words[first:last]), join(words[last:])


def wrap_words(draw, runs, font, width):
    """Greedy word wrap of [(text, highlighted)] into lines of [(x, word, highlighted)]."""
    lines, line, x = [], [], 0
    space = draw.textlength(" ", font=font)
    for text, highlighted in runs:
        for word in text.split():
            w = draw.textlength(word, font=font)
            if line and x + w > width:
                lines.append(line)
                line, x = [], 0
            line.append((x, word, highlighted))
            x += w + space
    if line:
        lines.append(line)
    return lines


def draw_card(path, show, title, time, before, quote, after):
    W, H, pad = 1200, 630, 64
    bg, ink, muted, mark = "#fbfaf7", "#1d1d1f", "#9a9a9f", "#ffe066"
    img = Image.new("RGB", (W, H), bg)
    draw = ImageDraw.Draw(img)
    head = ImageFont.truetype(str(FONT_DIR / "NotoSans-Bold.ttf"), 26)
    foot = ImageFont.truetype(str(FONT_DIR / "NotoSans-Regular.ttf"), 24)

    header = f"{show} · {title}"
    while draw.textlength(header, font=head) > W - 2 * pad:
        header = header[:-2].rstrip() + "…"
    draw.text((pad, pad - 16), header, font=head, fill=muted)
    fy = H - pad - 12
    draw.polygon([(pad, fy + 8), (pad, fy + 28), (pad + 17, fy + 18)], fill=muted)
    draw.text((pad + 28, fy), f"{time}   ·   {SITE}", font=foot, fill=muted)

    # Largest font size where the quote plus a little leading context fits,
    # then fill the remaining lines with trailing context.
    top, bottom = pad + 50, H - pad - 40
    for size in range(40, 21, -2):
        font = ImageFont.truetype(str(FONT_DIR / "NotoSerif-Regular.ttf"), size)
        line_h = int(size * 1.55)
        n_lines = (bottom - top) // line_h
        lead = " ".join(before.split()[-14:])
        runs = [("…" + lead if lead else "", False), (quote, True), (after, False)]
        lines = wrap_words(draw, runs, font, W - 2 * pad)
        quote_end = max(i for i, line in enumerate(lines) if any(h for _, _, h in line))
        if quote_end < n_lines:
            break
    lines = lines[:n_lines]

    for i, line in enumerate(lines):
        y = top + i * line_h
        marked = [(x, word) for x, word, h in line if h]
        if marked:
            x0 = pad + marked[0][0] - 6
            x1 = pad + marked[-1][0] + draw.textlength(marked[-1][1], font=font) + 6
            draw.rectangle((x0, y + size * 0.12, x1, y + size * 1.38), fill=mark)
        for x, word, h in line:
            if i == len(lines) - 1 and (x, word, h) == line[-1] and after:
                word += " …"
            draw.text((pad + x, y), word, font=font, fill=ink if h else muted)
    img.save(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("share", help="file with the AntennaPod share text, or - for stdin")
    parser.add_argument("--transcribe", action="store_true",
                        help="transcribe the audio around the timestamp")
    parser.add_argument("--before", type=int, default=30,
                        help="seconds of context before the timestamp to transcribe")
    parser.add_argument("--after", type=int, default=45,
                        help="seconds after the timestamp to transcribe")
    parser.add_argument("--length", type=int, default=15,
                        help="quote runs at least this many seconds, to the end of the sentence")
    parser.add_argument("--max-length", type=int, default=30,
                        help="but never longer than this")
    parser.add_argument("--margin", type=int, default=2,
                        help="seconds before the timestamp where playback starts")
    parser.add_argument("--model", default="small.en", help="faster-whisper model")
    args = parser.parse_args()

    text = sys.stdin.read() if args.share == "-" else Path(args.share).read_text()
    share = parse_share(text)
    slug = slugify(share["title"])
    t = share["t"]

    data_file = DATA_DIR / f"{slug}.yml"
    if data_file.exists():
        episode = yaml.safe_load(data_file.read_text())
    else:
        episode = {
            "show": share["show"],
            "title": share["title"],
            "episode_url": share["episode_url"],
            "media_url": share["media_url"],
            "clips": [],
        }

    clip = {"t": t, "start": max(0, t - args.margin), "time": seconds_to_hms(t),
            "note": share["note"]}
    if args.transcribe:
        start = max(0, t - args.before)
        words = transcribe(share["media_url"], start, args.before + args.after,
                           args.model, f"{share['show']}. {share['title']}.")
        clip["before"], clip["quote"], clip["after"] = split_quote(
            words, t, args.length, args.max_length)

    clips = [c for c in episode["clips"] if c["t"] != t] + [clip]
    episode["clips"] = sorted(clips, key=lambda c: c["t"])

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    data_file.write_text(yaml.safe_dump(episode, sort_keys=False, allow_unicode=True, width=100))

    write_page(PAGE_DIR / f"{slug}.md", {"layout": "podcast", "podcast": slug,
                                         "title": share["title"], "description": share["show"]})
    clip_dir = PAGE_DIR / slug
    clip_dir.mkdir(parents=True, exist_ok=True)
    write_page(clip_dir / f"{t}.md", {"layout": "clip", "podcast": slug, "t": t,
                                      "title": f"{share['title']} @ {clip['time']}"})
    if "quote" in clip:
        draw_card(clip_dir / f"{t}.png", share["show"], share["title"], clip["time"],
                  clip["before"], clip["quote"], clip["after"])

    print(f"podcasts/{slug}/{t}: clip at {clip['time']}")
    if "quote" in clip:
        print(f"quote: {clip['quote']}")


def write_page(path, front):
    if not path.exists():
        path.write_text("---\n" + yaml.safe_dump(front, sort_keys=False, allow_unicode=True)
                        + "---\n")


if __name__ == "__main__":
    main()
