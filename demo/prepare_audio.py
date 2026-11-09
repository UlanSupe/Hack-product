"""Trims, levels and measures the narration clips the presenter recorded.

    python demo/prepare_audio.py [--audio-dir demo/audio] [--payment 5A|5B] [--selftest]

Reads demo/audio/s1 ... s7 (s5a or s5b for the payment scene) in any common format (wav, mp3, m4a, aac, ogg, opus, flac,
webm, mp4), removes the silence before and after the speech, levels each clip to the same loudness, and writes
demo/work/audio/<id>.wav plus demo/work/durations.json (seconds), which demo/record.ts uses to time the screen capture.

--selftest generates tone "clips" of the right lengths instead of reading real recordings. It exists only to check the
pipeline before a voice is available; its output is marked SELFTEST and must never be published.
"""

import argparse
import json
import math
import pathlib
import sys
import wave

import av
import numpy as np

RATE = 48000
EXTS = (".wav", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".webm", ".mp4")
HARD_LIMIT_S = 170.0  # the hard maximum of the brief: 2:50
PER_SCENE_OVERHEAD_S = 0.4 + 0.8 + 0.6  # lead + tail + typical page load (see demo/record.ts)

root = pathlib.Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument("--audio-dir", default=str(root / "audio"))
ap.add_argument("--payment", default="5B", choices=["5A", "5B"])
ap.add_argument("--selftest", action="store_true")
ap.add_argument("--sheet", action="store_true", help="write demo/reading-sheet.md (the lines to read aloud) and exit")
args = ap.parse_args()

narration = json.loads((root / "narration.json").read_text(encoding="utf-8"))["clips"]

PRONOUNCE = {
    "OVER_PER_TX_CAP": "читать как: «over per T-X cap»",
    "POLICY_DENIED": "читать как: «policy denied»",
    "S-I-M-B-001": "читать по буквам: «S, I, M, B, zero, zero, one»",
}


def write_sheet() -> None:
    lines = [
        "# Реплики для озвучки (читайте по-английски, спокойно, не торопясь)",
        "",
        "Как записывать:",
        "1. Каждую реплику записывайте **отдельным файлом** (Диктофон Windows, телефон или любая программа). Формат любой: m4a, mp3, wav.",
        "2. Назовите файлы по номеру реплики: `s1`, `s2`, `s3`, `s4`, `s5b`, `s6`, `s7` (например `s1.m4a`) и положите в папку `demo/audio/`.",
        "3. Тихая комната, микрофон близко. Перед первым словом и после последнего можно помолчать: паузы я обрежу сам.",
        "4. Читайте ровным темпом около 150 слов в минуту. Если реплика длиннее указанного лимита, перезапишите чуть бодрее; ускорять запись я не буду.",
        "5. Если ошиблись, перезапишите реплику целиком. Склеивать несколько дублей не нужно.",
        "6. Реплику `s5a` записывайте **только** если мы вместе решим показать настоящий платёж PayPal Sandbox. Сейчас нужна `s5b`.",
        "",
    ]
    for c in narration:
        text = " ".join(t for t in c["text"].split() if not (t.startswith("{{") and t.endswith("}}")))
        n = len(text.split())
        notes = [v for k, v in PRONOUNCE.items() if k in text]
        optional = "  (ТОЛЬКО для настоящего платежа)" if c["id"] == "s5a" else ""
        lines += [f"## Файл `{c['id']}` — не длиннее {c['windowSeconds']} с, около {n} слов{optional}", "", f"> {text}", ""]
        lines += [f"- {note}" for note in notes] + ([""] if notes else [])
    (root / "reading-sheet.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {root / 'reading-sheet.md'}")


if args.sheet:
    write_sheet()
    sys.exit(0)
pay_id = "s5a" if args.payment == "5A" else "s5b"
order = ["s1", "s2", "s3", "s4"] + (["s4b"] if args.payment == "5A" else []) + [pay_id, "s6", "s7"]
clips = {c["id"]: c for c in narration}
work = root / "work"
(work / "audio").mkdir(parents=True, exist_ok=True)
(work / "cues.json").unlink(missing_ok=True)  # cue times belong to the clips they were measured on; re-run cue_times.py
audio_dir = pathlib.Path(args.audio_dir)


def words(text: str) -> int:
    return len([t for t in text.split() if not (t.startswith("{{") and t.endswith("}}"))])


def decode(path: pathlib.Path) -> np.ndarray:
    """Any audio file -> mono float32 at 48 kHz."""
    chunks = []
    with av.open(str(path)) as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise SystemExit(f"{path.name}: no audio stream")
        resampler = av.AudioResampler(format="flt", layout="mono", rate=RATE)
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        raise SystemExit(f"{path.name}: empty audio")
    return np.concatenate(chunks).astype(np.float32)


def find(clip_id: str) -> pathlib.Path | None:
    names = [clip_id] + (["s5"] if clip_id in ("s5a", "s5b") else [])
    for n in names:
        for ext in EXTS:
            p = audio_dir / f"{n}{ext}"
            if p.exists():
                return p
    return None


def db(x: float) -> float:
    return 20 * math.log10(max(x, 1e-9))


def process(samples: np.ndarray) -> tuple[np.ndarray, dict]:
    win = int(RATE * 0.02)
    n = len(samples) // win
    if n < 5:
        raise SystemExit("clip is too short to contain speech")
    frames = samples[: n * win].reshape(n, win)
    rms_db = np.array([db(float(np.sqrt(np.mean(f * f)))) for f in frames])
    floor = float(np.percentile(rms_db, 10))
    thr = max(-50.0, floor + 12.0)
    voiced = np.where(rms_db > thr)[0]
    if len(voiced) == 0:
        raise SystemExit("no speech found (the recording is silent or too quiet)")
    start = max(0, int(voiced[0] * win - 0.12 * RATE))
    end = min(len(samples), int((voiced[-1] + 1) * win + 0.25 * RATE))
    clip = samples[start:end].copy()
    # level: voiced RMS -> -20 dBFS, at most +20 dB of gain, peak kept under about -1 dBFS
    voiced_rms = float(np.sqrt(np.mean(np.concatenate([frames[i] for i in voiced]) ** 2)))
    gain = min(10 ** ((-20.0 - db(voiced_rms)) / 20), 10.0)
    peak = float(np.max(np.abs(clip))) or 1e-9
    gain = min(gain, 0.89 / peak)
    clip *= gain
    fade = int(0.01 * RATE)
    clip[:fade] *= np.linspace(0, 1, fade)
    clip[-fade:] *= np.linspace(1, 0, fade)
    return clip, {"floor_db": round(floor, 1), "voiced_rms_db": round(db(voiced_rms), 1), "gain_db": round(db(gain), 1)}


def write_wav(path: pathlib.Path, samples: np.ndarray) -> None:
    pcm = np.clip(samples, -1.0, 1.0)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((pcm * 32767).astype("<i2").tobytes())


def selftest_clip(seconds: float) -> np.ndarray:
    """Speech-like bursts (a tone with a 4 Hz amplitude envelope) with silence before and after."""
    t = np.arange(int(seconds * RATE)) / RATE
    tone = 0.3 * np.sin(2 * np.pi * 220 * t) * (0.55 + 0.45 * np.sin(2 * np.pi * 4 * t))
    return np.concatenate([np.zeros(int(0.6 * RATE)), tone, np.zeros(int(0.9 * RATE))]).astype(np.float32)


if args.selftest:
    audio_dir = work / "selftest-audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    for cid in order:
        write_wav(audio_dir / f"{cid}.wav", selftest_clip(words(clips[cid]["text"]) * 0.4))
    (work / "SELFTEST").write_text("tone clips, not a real voice: never publish this output\n")
elif (work / "SELFTEST").exists():
    (work / "SELFTEST").unlink()

missing = [cid for cid in order if find(cid) is None]
if missing:
    print(f"Missing recordings in {audio_dir}: {', '.join(missing)}")
    print("Name the files s1, s2, s3, s4, s5b (or s5a), s6, s7 with any common audio extension.")
    sys.exit(1)

durations: dict[str, float] = {}
problems: list[str] = []
for cid in order:
    src = find(cid)
    clip, info = process(decode(src))
    write_wav(work / "audio" / f"{cid}.wav", clip)
    durations[cid] = round(len(clip) / RATE, 3)
    window = clips[cid]["windowSeconds"]
    flag = ""
    if durations[cid] > window:
        flag = f"  <-- longer than its {window}s window"
        problems.append(f"{cid} is {durations[cid]:.1f}s, longer than {window}s")
    print(f"{cid:4s} {src.name:14s} {durations[cid]:5.1f}s (window {window}s)  levels {info}{flag}")

total = sum(durations.values()) + len(order) * PER_SCENE_OVERHEAD_S
print(f"Estimated video length: {total:.1f}s (hard limit {HARD_LIMIT_S:.0f}s, planned 161s)")
(work / "durations.json").write_text(json.dumps(durations, indent=2))
if total > HARD_LIMIT_S - 5:
    print("TOO LONG: re-record the longest clips more briskly (do not speed the audio up).")
    sys.exit(2)
if problems:
    print("WARNING: " + "; ".join(problems) + ". The video still fits; scenes just run longer than planned.")
print("SELFTEST: tone clips only. Not a real voice." if args.selftest else "OK")
