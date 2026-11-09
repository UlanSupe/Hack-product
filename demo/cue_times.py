"""Finds the exact moment of each screen cue in the prepared narration clips (optional, more precise than word counting),
and writes every spoken word with its time (demo/work/words.json) for the edit.

    python demo/cue_times.py [--payment 5A|5B]

Transcribes demo/work/audio/<id>.wav locally with faster-whisper (word timestamps), finds the words that follow each
{{cue}} marker in demo/narration.json, and writes demo/work/cues.json (seconds from the start of each prepared clip).
node demo/record.ts uses it when present and otherwise estimates the times from the word count.

Needs `pip install faster-whisper` and a Whisper model already in the local cache (nothing is downloaded unless you pass
--allow-download). Run it after `python demo/prepare_audio.py`.
"""

import argparse
import json
import pathlib
import re
import sys

ap = argparse.ArgumentParser()
ap.add_argument("--payment", default="5B", choices=["5A", "5B"])
ap.add_argument("--model", default="small")
ap.add_argument("--allow-download", action="store_true")
args = ap.parse_args()

root = pathlib.Path(__file__).resolve().parent
work = root / "work"
clips = {c["id"]: c for c in json.loads((root / "narration.json").read_text(encoding="utf-8"))["clips"]}
pay_id = "s5a" if args.payment == "5A" else "s5b"
ids = ["s1", "s2", "s3", "s4"] + (["s4b"] if args.payment == "5A" else []) + [pay_id, "s6", "s7"]

try:
    from faster_whisper import WhisperModel
except ImportError:
    sys.exit("faster-whisper is not installed: skip this step (record.ts then estimates the cue times)")

try:
    model = WhisperModel(args.model, device="cpu", compute_type="int8", local_files_only=not args.allow_download)
except Exception as e:  # model not cached
    sys.exit(f"Whisper model '{args.model}' is not in the local cache ({type(e).__name__}); use --allow-download or skip this step")

NUMBERS = {
    "24": ["twenty", "four"],
    "30": ["thirty"],
    "36": ["thirty", "six"],
    "10": ["ten"],
    "58": ["fifty", "eight"],
    "50": ["fifty"],
    "60": ["sixty"],
    "17": ["seventeen"],
    "110": ["one", "hundred", "ten"],
    "524": ["five", "hundred", "twenty", "four"],
}


def tokens(text: str) -> list[str]:
    out: list[str] = []
    for raw in re.findall(r"[A-Za-z0-9$]+(?:[-'][A-Za-z0-9]+)*", text.lower().replace("_", " ")):
        for part in re.split(r"[-]", raw.replace("$", "")):
            part = part.strip("'")
            if part:
                out.extend(NUMBERS.get(part, [part]))
    return out


result: dict[str, dict[str, float]] = {}
all_words: dict[str, list[list]] = {}
for cid in ids:
    text = clips[cid]["text"]
    markers = [(m.group(1), text[m.end():]) for m in re.finditer(r"\{\{(\w+)\}\}", text)]
    segs, _ = model.transcribe(str(work / "audio" / f"{cid}.wav"), language="en", beam_size=5, word_timestamps=True)
    heard: list[tuple[str, float]] = []  # flattened word tokens with the start time of the word they came from
    all_words[cid] = []
    for s in segs:
        for w in s.words:
            for t in tokens(w.word):
                heard.append((t, float(w.start)))
                all_words[cid].append([t, round(float(w.start), 3), round(float(w.end), 3)])
    spoken_total = len(tokens(re.sub(r"\{\{\w+\}\}", " ", text)))
    found: dict[str, float] = {}
    for name, rest in markers:
        anchor = tokens(rest)[:3]
        before = len(tokens(re.sub(r"\{\{\w+\}\}", " ", text[: text.index("{{" + name + "}}")])))
        prior = before / max(1, spoken_total)
        hits = [i for i in range(len(heard) - len(anchor) + 1) if [h[0] for h in heard[i : i + len(anchor)]] == anchor]
        if not hits:
            print(f"{cid}.{name}: anchor {anchor} not found in the transcript; record.ts will estimate it")
            continue
        # several hits (a repeated phrase): take the one closest to where the word count says it should be
        best = min(hits, key=lambda i: abs(i / max(1, len(heard)) - prior))
        found[name] = round(heard[best][1], 3)
        print(f"{cid}.{name}: {found[name]:.2f}s  (words '{' '.join(anchor)}')")
    result[cid] = found

(work / "cues.json").write_text(json.dumps(result, indent=2))
(work / "words.json").write_text(json.dumps(all_words))  # every spoken word token with start/end seconds, for the edit
print(f"wrote {work / 'cues.json'}")
