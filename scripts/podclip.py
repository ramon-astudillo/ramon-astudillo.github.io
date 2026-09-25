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

Each episode gets a data file in _data/podcasts/<slug>.yml and a page in
podcasts/<slug>.md. With --transcribe, a window of audio around the
timestamp is downloaded with ffmpeg and transcribed with faster-whisper,
and the text is stored as the clip's quote.
"""
import argparse
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "_data" / "podcasts"
PAGE_DIR = ROOT / "podcasts"


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


def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:80]


def transcribe(media_url, start, duration, model_name, prompt):
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
                                       vad_filter=True)
        return [(start + s.start, start + s.end, s.text.strip())
                for s in segments]


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("share", help="file with the AntennaPod share text, or - for stdin")
    parser.add_argument("--transcribe", action="store_true",
                        help="transcribe the audio around the timestamp into the quote")
    parser.add_argument("--before", type=int, default=45,
                        help="seconds before the timestamp to transcribe")
    parser.add_argument("--after", type=int, default=10,
                        help="seconds after the timestamp to transcribe")
    parser.add_argument("--margin", type=int, default=2,
                        help="seconds before the timestamp where playback starts")
    parser.add_argument("--model", default="small.en", help="faster-whisper model")
    args = parser.parse_args()

    text = sys.stdin.read() if args.share == "-" else Path(args.share).read_text()
    share = parse_share(text)
    slug = slugify(share["title"])

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

    clip = {"t": share["t"], "start": max(0, share["t"] - args.margin), "note": share["note"]}
    if args.transcribe:
        start = max(0, share["t"] - args.before)
        segments = transcribe(share["media_url"], start, args.before + args.after,
                              args.model, f"{share['show']}. {share['title']}.")
        if segments:
            clip["quote"] = " ".join(seg[2] for seg in segments)

    clips = [c for c in episode["clips"] if c["t"] != clip["t"]] + [clip]
    episode["clips"] = sorted(clips, key=lambda c: c["t"])

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    data_file.write_text(yaml.safe_dump(episode, sort_keys=False, allow_unicode=True, width=100))

    page_file = PAGE_DIR / f"{slug}.md"
    if not page_file.exists():
        front = {"layout": "podcast", "podcast": slug,
                 "title": share["title"], "description": share["show"]}
        page_file.write_text("---\n" + yaml.safe_dump(front, sort_keys=False, allow_unicode=True)
                             + "---\n")

    print(f"{data_file.relative_to(ROOT)}: clip at {share['t']}s")
    if "quote" in clip:
        print(f"quote ({clip['start']}s): {clip['quote']}")


if __name__ == "__main__":
    main()
