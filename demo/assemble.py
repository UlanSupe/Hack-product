"""Builds the final MP4: the recorded screen (constant 30 fps, H.264) with the presenter's clips placed at their scenes (AAC).

    python demo/assemble.py

Needs demo/work/frames.json + demo/work/frames/*.jpg and demo/work/scenes.json (node demo/record.ts) and
demo/work/audio/*.wav (python demo/prepare_audio.py). Writes demo/out/pactpay-demo.mp4 and refuses to finish if it is
longer than 2:50.
"""

import json
import pathlib
import sys
import wave
from fractions import Fraction

import av
import numpy as np
from PIL import Image

RATE = 48000
FPS = 30
W, H = 1280, 720
HARD_LIMIT_S = 170.0
PRE_ROLL_S = 0.3  # the video starts this long before the first word

root = pathlib.Path(__file__).resolve().parent
work = root / "work"
out_dir = root / "out"
out_dir.mkdir(exist_ok=True)
selftest = (work / "SELFTEST").exists()
out_path = out_dir / ("pactpay-demo-SELFTEST.mp4" if selftest else "pactpay-demo.mp4")

log = json.loads((work / "scenes.json").read_text())
scenes = log["scenes"]
if not (work / "frames.json").exists():
    sys.exit("demo/work/frames.json is missing: run `node demo/record.ts` first")
shots = json.loads((work / "frames.json").read_text())
epoch0 = shots["epoch0"]
frames = sorted(({"t": f["t"] - epoch0, "file": work / "frames" / f["file"]} for f in shots["frames"]), key=lambda f: f["t"])
if not frames:
    sys.exit("the recording has no frames")

w0 = scenes[0]["audioStartS"] - PRE_ROLL_S  # recorder-clock time of output t = 0
end_u = scenes[-1]["endS"] - w0
print(f"{len(frames)} screen frames; output length {end_u:.1f}s")
if end_u > HARD_LIMIT_S:
    sys.exit(f"TOO LONG: {end_u:.1f}s is over the 2:50 limit. Re-record the longest clips more briskly.")


def read_wav(path: pathlib.Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == RATE and w.getnchannels() == 1 and w.getsampwidth() == 2
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32767


# 1. Audio: every clip placed at its scene's narration start.
total = int(np.ceil(end_u * RATE))
mix = np.zeros(total, dtype=np.float32)
for s in scenes:
    clip = read_wav(work / "audio" / f"{s['id']}.wav")
    at = int(round((s["audioStartS"] - w0) * RATE))
    if at < 0 or at + len(clip) > total:
        sys.exit(f"clip {s['id']} does not fit the timeline")
    mix[at : at + len(clip)] += clip
mix = np.clip(mix, -1.0, 1.0)

out = av.open(str(out_path), "w", options={"movflags": "+faststart"})
vs = out.add_stream("libx264", rate=FPS)
vs.width, vs.height, vs.pix_fmt = W, H, "yuv420p"
vs.options = {"crf": "18", "preset": "medium"}
aus = out.add_stream("aac", rate=RATE)
aus.layout = "mono"
aus.bit_rate = 128_000

resampler = av.AudioResampler(format="fltp", layout="mono", rate=RATE)
audio_packets = []
pos = 0
while pos < len(mix):
    chunk = mix[pos : pos + 1024]
    frame = av.AudioFrame.from_ndarray(chunk.reshape(1, -1), format="flt", layout="mono")
    frame.sample_rate = RATE
    frame.pts = pos
    for rf in resampler.resample(frame):
        audio_packets.extend(aus.encode(rf))
    pos += 1024
audio_packets.extend(aus.encode(None))
audio_packets.sort(key=lambda p: float(p.pts * p.time_base))


def flush_audio_until(t: float) -> None:
    while audio_packets and float(audio_packets[0].pts * audio_packets[0].time_base) <= t:
        out.mux(audio_packets.pop(0))


# 2. Video: constant frame rate by holding the latest screen frame, trimmed to [w0, w0 + end_u].
out_i = 0


def emit(yuv: np.ndarray) -> None:
    global out_i
    f = av.VideoFrame.from_ndarray(yuv, format="yuv420p")
    f.pts = out_i
    f.time_base = Fraction(1, FPS)
    for p in vs.encode(f):
        out.mux(p)
    out_i += 1
    flush_audio_until(out_i / FPS)


def load(path: pathlib.Path) -> np.ndarray:
    img = Image.open(path).convert("RGB")
    if img.size != (W, H):
        img = img.resize((W, H), Image.LANCZOS)
    return av.VideoFrame.from_ndarray(np.asarray(img), format="rgb24").reformat(format="yuv420p").to_ndarray()


cur = None
for f in frames:
    p = f["t"] - w0
    while cur is not None and out_i / FPS < min(p, end_u):
        emit(cur)
    if out_i / FPS >= end_u:
        break
    cur = load(f["file"])
while cur is not None and out_i / FPS < end_u:
    emit(cur)
for p in vs.encode(None):
    out.mux(p)
flush_audio_until(1e9)
out.close()

# 3. Verify what was written.
with av.open(str(out_path)) as c:
    v, a = c.streams.video[0], c.streams.audio[0]
    dur = float(c.duration) / av.time_base
    print(f"wrote {out_path}")
    print(
        f"  duration {dur:.1f}s ({int(dur // 60)}:{int(dur % 60):02d}), video {v.codec_context.name} {v.width}x{v.height}, "
        f"audio {a.codec_context.name} {a.rate} Hz"
    )
    if dur > HARD_LIMIT_S:
        sys.exit(f"TOO LONG: {dur:.1f}s")
if selftest:
    print("SELFTEST: tone clips, not a real voice. Never publish this file.")
else:
    print("Upload this file to YouTube yourself (public). Then run the checks in docs/DEMO_SCRIPT.md section 9.")
