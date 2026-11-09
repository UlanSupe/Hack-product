"""Encodes the edited video: the rendered frames (demo/work/render) and the mix (demo/work/mix.wav) into one MP4.

    python demo/encode.py            # frames + mix
    python demo/encode.py --remux    # keep the existing video, replace only the audio (after re-running sound.py)

H.264 1920x1080 at 30 fps with stereo AAC; writes demo/out/pactpay-demo-edit.mp4 and refuses to finish if it is longer than
2:50. (demo/assemble.py is the plain, unedited cut of the same footage.)
"""

import glob
import pathlib
import sys
import wave
from fractions import Fraction

import av
import numpy as np
from PIL import Image

FPS = 30
W, H = 1920, 1080
SR = 48000
HARD_LIMIT_S = 170.0

root = pathlib.Path(__file__).resolve().parent
work = root / "work"
out_dir = root / "out"
out_dir.mkdir(exist_ok=True)
out_path = out_dir / "pactpay-demo-edit.mp4"

REMUX = "--remux" in sys.argv
def tl_total() -> float:
    import json

    return json.loads((work / "timeline.json").read_text())["total"]


frames = sorted(glob.glob(str(work / "render" / "*.jpg")))
if not frames and not REMUX:
    sys.exit("no rendered frames: run `node demo/render.ts` first")
if not (work / "mix.wav").exists():
    sys.exit("demo/work/mix.wav is missing: run `python demo/sound.py` first")
duration = (len(frames) / FPS) if frames else tl_total()
if duration > HARD_LIMIT_S:
    sys.exit(f"TOO LONG: {duration:.1f}s is over the 2:50 limit")

with wave.open(str(work / "mix.wav"), "rb") as w:
    assert w.getframerate() == SR and w.getnchannels() == 2 and w.getsampwidth() == 2
    pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32).reshape(-1, 2) / 32767
want = int(round(duration * SR))
pcm = pcm[:want] if len(pcm) >= want else np.pad(pcm, ((0, want - len(pcm)), (0, 0)))

src = None
if REMUX:
    tmp = out_path.with_suffix(".old.mp4")
    if out_path.exists():
        out_path.replace(tmp)
    src = av.open(str(tmp))
out = av.open(str(out_path), "w", options={"movflags": "+faststart"})
if src is not None:
    vs = out.add_stream_from_template(src.streams.video[0])
else:
    vs = out.add_stream("libx264", rate=FPS)
    vs.width, vs.height, vs.pix_fmt = W, H, "yuv420p"
    vs.options = {"crf": "17", "preset": "medium"}
aus = out.add_stream("aac", rate=SR)
aus.layout = "stereo"
aus.bit_rate = 192_000

resampler = av.AudioResampler(format="fltp", layout="stereo", rate=SR)
audio_packets = []
pos = 0
while pos < len(pcm):
    chunk = np.ascontiguousarray(pcm[pos : pos + 1024])  # (n, 2) interleaved L R
    af = av.AudioFrame.from_ndarray(chunk.reshape(1, -1), format="flt", layout="stereo")
    af.sample_rate = SR
    af.pts = pos
    for rf in resampler.resample(af):
        audio_packets.extend(aus.encode(rf))
    pos += 1024
audio_packets.extend(aus.encode(None))
audio_packets.sort(key=lambda p: float(p.pts * p.time_base))


def flush_audio_until(t: float) -> None:
    while audio_packets and float(audio_packets[0].pts * audio_packets[0].time_base) <= t:
        out.mux(audio_packets.pop(0))


if src is not None:
    for packet in src.demux(src.streams.video[0]):
        if packet.dts is None:
            continue
        packet.stream = vs
        out.mux(packet)
        flush_audio_until(float(packet.pts * packet.time_base) if packet.pts is not None else 0)
    src.close()
    frames = []
for i, path in enumerate(frames):
    img = Image.open(path).convert("RGB")
    if img.size != (W, H):
        img = img.resize((W, H), Image.LANCZOS)
    vf = av.VideoFrame.from_ndarray(np.asarray(img), format="rgb24").reformat(format="yuv420p")
    vf.pts = i
    vf.time_base = Fraction(1, FPS)
    for p in vs.encode(vf):
        out.mux(p)
    flush_audio_until((i + 1) / FPS)
    if (i + 1) % 600 == 0:
        print(f"encoded {i + 1}/{len(frames)} frames")
if src is None:
    for p in vs.encode(None):
        out.mux(p)
flush_audio_until(1e9)
out.close()

with av.open(str(out_path)) as c:
    v, a = c.streams.video[0], c.streams.audio[0]
    dur = float(c.duration) / av.time_base
    print(f"wrote {out_path}")
    print(f"  duration {dur:.1f}s ({int(dur // 60)}:{int(dur % 60):02d}), video {v.codec_context.name} {v.width}x{v.height}, audio {a.codec_context.name} {a.rate} Hz {a.layout.name}")
    if dur > HARD_LIMIT_S:
        sys.exit(f"TOO LONG: {dur:.1f}s")
