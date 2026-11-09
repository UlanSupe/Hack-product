"""Scores the edited video: music bed, sound effects and the narration, mixed to demo/work/mix.wav.

    python demo/sound.py

Reads demo/work/timeline.json (written by demo/plan.ts) and the prepared narration clips (demo/work/audio/*.wav).
Everything except the narration is synthesised here with numpy/scipy (no samples, nothing to license): a pad-and-arpeggio
music bed in A minor that follows the edit's intensity curve and ducks under the voice, and one synthesised effect per sound
event of the edit (transition whooshes, UI ticks, an alarm for the unsafe payment, a lock-and-chime for the refusal, an
impact for the audit event, counters, typing, a logo sting and an end stinger).
"""

import json
import pathlib
import wave

import numpy as np
from scipy import signal

SR = 48000
root = pathlib.Path(__file__).resolve().parent
work = root / "work"
tl = json.loads((work / "timeline.json").read_text())
TOTAL = tl["total"]
N = int(np.ceil(TOTAL * SR)) + SR // 2
rng = np.random.default_rng(20261108)


# ---- helpers -----------------------------------------------------------------------------------------------------------
def t_axis(dur: float) -> np.ndarray:
    return np.arange(int(dur * SR)) / SR


def adsr(n: int, a: float, d: float, s: float, r: float) -> np.ndarray:
    a_n, d_n, r_n = int(a * SR), int(d * SR), int(r * SR)
    env = np.ones(n) * s
    env[:a_n] = np.linspace(0, 1, max(1, a_n))
    env[a_n : a_n + d_n] = np.linspace(1, s, max(1, min(d_n, n - a_n)))[: max(0, min(d_n, n - a_n))]
    if r_n > 0:
        env[max(0, n - r_n) :] *= np.linspace(1, 0, min(r_n, n))
    return env


def lowpass(x: np.ndarray, fc: float, order: int = 2) -> np.ndarray:
    return signal.lfilter(*signal.butter(order, fc / (SR / 2), "low"), x)


def highpass(x: np.ndarray, fc: float, order: int = 2) -> np.ndarray:
    return signal.lfilter(*signal.butter(order, fc / (SR / 2), "high"), x)


def bandpass(x: np.ndarray, lo: float, hi: float, order: int = 2) -> np.ndarray:
    return signal.lfilter(*signal.butter(order, [lo / (SR / 2), hi / (SR / 2)], "band"), x)


def saw(freq: float, n: int, detune_cents: float = 0.0, phase: float = 0.0) -> np.ndarray:
    f = freq * 2 ** (detune_cents / 1200)
    return 2 * ((np.arange(n) / SR * f + phase) % 1.0) - 1


def reverb_ir(dur: float = 1.6, damp: float = 3500) -> np.ndarray:
    n = int(dur * SR)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / SR * (6.0 / dur))
    ir = lowpass(ir, damp, 1)
    ir[0] = 0
    return ir / np.sqrt(np.sum(ir**2))


IR = reverb_ir()


def with_reverb(x: np.ndarray, wet: float = 0.35) -> np.ndarray:
    tail = signal.fftconvolve(x, IR)[: len(x) + len(IR) // 2]
    out = np.zeros(len(tail))
    out[: len(x)] += x * (1 - wet * 0.5)
    return out + tail * wet


def swept_noise(dur: float, f0: float, f1: float, bw_oct: float = 1.0, rise: float = 0.5) -> np.ndarray:
    """Noise through a band whose centre sweeps exponentially from f0 to f1 (a whoosh)."""
    n = int(dur * SR)
    x = rng.standard_normal(n)
    f, tt, Z = signal.stft(x, SR, nperseg=1024, noverlap=896)
    prog = np.clip(tt / dur, 0, 1)
    fc = f0 * (f1 / f0) ** prog
    mask = np.exp(-0.5 * (np.log2(np.maximum(f[:, None], 1.0) / fc[None, :]) / bw_oct) ** 2)
    _, y = signal.istft(Z * mask, SR, nperseg=1024, noverlap=896)
    y = y[:n]
    if len(y) < n:
        y = np.pad(y, (0, n - len(y)))
    shape = np.sin(np.pi * np.clip(np.linspace(0, 1, n) ** rise, 0, 1)) ** 1.5
    return y / (np.max(np.abs(y)) + 1e-9) * shape


def bell(freq: float, dur: float, brightness: float = 1.0) -> np.ndarray:
    t = t_axis(dur)
    parts = [(1.0, 1.0, 2.2), (2.76, 0.55 * brightness, 3.4), (5.4, 0.3 * brightness, 4.6), (8.93, 0.14 * brightness, 6.5)]
    y = sum(a * np.sin(2 * np.pi * freq * k * t) * np.exp(-t * d) for k, a, d in parts)
    return y * adsr(len(t), 0.002, 0.05, 1.0, 0.05)


# ---- sound effects (mono, peak ~ 1; scaled when placed) ----------------------------------------------------------------
def fx_tick() -> np.ndarray:
    t = t_axis(0.09)
    return (np.sin(2 * np.pi * 1850 * t) + 0.4 * np.sin(2 * np.pi * 3700 * t)) * np.exp(-t * 55)


def fx_pop() -> np.ndarray:
    t = t_axis(0.16)
    return np.sin(2 * np.pi * (500 + 700 * t / 0.16) * t) * np.exp(-t * 22)


def fx_count() -> np.ndarray:
    t = t_axis(0.04)
    return np.sin(2 * np.pi * 3100 * t) * np.exp(-t * 120)


def fx_type() -> np.ndarray:
    n = int(0.012 * SR)
    return highpass(rng.standard_normal(n), 3000) * np.exp(-np.arange(n) / SR * 400)


def fx_title() -> np.ndarray:
    return swept_noise(0.4, 900, 4200, 0.8) * 0.55


def fx_scroll() -> np.ndarray:
    return lowpass(swept_noise(1.0, 250, 1600, 1.3, 0.7), 2400) * 0.5


def fx_whoosh() -> np.ndarray:
    y = swept_noise(0.7, 350, 6500, 1.0, 0.8)
    t = t_axis(0.7)
    y += 0.25 * np.sin(2 * np.pi * (120 + 300 * (t / 0.7) ** 2) * t) * np.sin(np.pi * t / 0.7)
    return y


def fx_push() -> np.ndarray:
    y = swept_noise(0.6, 200, 2600, 1.2, 1.4)
    t = t_axis(0.5)
    thump = np.sin(2 * np.pi * 52 * t) * np.exp(-t * 9)
    out = np.zeros(int(1.0 * SR))
    out[: len(y)] += y * 0.8
    out[int(0.38 * SR) : int(0.38 * SR) + len(thump)] += thump * 0.9
    return out


def fx_flash() -> np.ndarray:
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    snap = highpass(rng.standard_normal(n), 2500) * np.exp(-t * 28)
    ping = np.sin(2 * np.pi * 2400 * t) * np.exp(-t * 14) * 0.5
    return snap * 0.7 + ping


def fx_alarm() -> np.ndarray:
    dur = 0.9
    t = t_axis(dur)
    f = 440 * (0.22 ** (t / dur))
    ph = 2 * np.pi * np.cumsum(f) / SR
    y = np.tanh(3.2 * (2 * ((ph / (2 * np.pi)) % 1) - 1)) * (0.6 + 0.4 * np.sin(2 * np.pi * 19 * t))
    y = lowpass(y, 2600) * np.exp(-t * 2.2)
    return y * adsr(len(t), 0.004, 0.0, 1.0, 0.15)


def fx_glitch() -> np.ndarray:
    out = np.zeros(int(0.7 * SR))
    for start in (0.0, 0.07, 0.15, 0.22, 0.34, 0.45):
        n = int(rng.uniform(0.018, 0.045) * SR)
        burst = np.round(rng.standard_normal(n) * 4) / 4  # bit-crushed noise
        burst = bandpass(burst, rng.uniform(600, 1500), rng.uniform(3000, 7000)) * rng.uniform(0.4, 0.9)
        out[int(start * SR) : int(start * SR) + n] += burst
    return out * 0.7


def fx_lock() -> np.ndarray:
    out = np.zeros(int(2.2 * SR))
    for at, g in ((0.0, 1.0), (0.085, 0.7)):
        n = int(0.03 * SR)
        click = highpass(rng.standard_normal(n), 1800) * np.exp(-np.arange(n) / SR * 160) * g
        out[int(at * SR) : int(at * SR) + n] += click
    t = t_axis(0.5)
    out[: len(t)] += np.sin(2 * np.pi * 118 * t) * np.exp(-t * 14) * 0.8
    c1, c2 = bell(659.25, 1.6, 0.8), bell(987.77, 1.4, 0.9)
    out[int(0.12 * SR) : int(0.12 * SR) + len(c1)] += c1 * 0.55
    out[int(0.24 * SR) : int(0.24 * SR) + len(c2)] += c2 * 0.5
    return with_reverb(out, 0.4)


def fx_hit() -> np.ndarray:
    dur = 1.8
    t = t_axis(dur)
    sub = np.sin(2 * np.pi * np.cumsum(40 + 55 * np.exp(-t * 9)) / SR) * np.exp(-t * 3.0)
    body = lowpass(rng.standard_normal(len(t)), 900) * np.exp(-t * 10) * 0.9
    out = sub + body
    return with_reverb(out, 0.3)[: int(2.6 * SR)]


def fx_chime() -> np.ndarray:
    out = np.zeros(int(2.0 * SR))
    for at, f in ((0.0, 880.0), (0.11, 1318.5)):
        b = bell(f, 1.7)
        out[int(at * SR) : int(at * SR) + len(b)] += b * 0.6
    return with_reverb(out, 0.45)


def fx_ripple() -> np.ndarray:
    dur = 1.2
    t = t_axis(dur)
    y = np.sin(2 * np.pi * np.cumsum(260 + 700 * (t / dur) ** 1.5) / SR) * np.sin(np.pi * t / dur) ** 2
    return with_reverb(y * 0.5, 0.5)[: int(1.8 * SR)]


def fx_riser() -> np.ndarray:
    dur = 3.2
    t = t_axis(dur)
    n = swept_noise(dur, 200, 7500, 1.4, 1.8) * (t / dur) ** 1.6
    tone = np.sin(2 * np.pi * np.cumsum(110 * (8 ** (t / dur))) / SR) * (t / dur) ** 2 * 0.35
    return (n * 0.9 + tone) * (1 - np.clip((t - (dur - 0.08)) / 0.08, 0, 1))


def fx_logo() -> np.ndarray:
    dur = 3.0
    t = t_axis(dur)
    pad = sum(np.sin(2 * np.pi * f * t) for f in (110, 164.8, 220, 329.6)) * adsr(len(t), 1.2, 0.5, 0.5, 1.0) * 0.14
    sweep = swept_noise(1.4, 200, 5200, 1.1, 0.9) * 0.55
    out = pad.copy()
    out[: len(sweep)] += sweep
    b = bell(880, 2.0, 1.0)
    out[int(1.0 * SR) : int(1.0 * SR) + len(b)] += b * 0.6
    sub = np.sin(2 * np.pi * 50 * t_axis(0.9)) * np.exp(-t_axis(0.9) * 4)
    out[int(0.95 * SR) : int(0.95 * SR) + len(sub)] += sub * 0.9
    return with_reverb(out, 0.35)


def fx_stinger() -> np.ndarray:
    dur = 3.6
    t = t_axis(dur)
    chord = sum(np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * 2 * f * t) for f in (110, 164.8, 220, 277.2, 329.6))
    out = chord * adsr(len(t), 0.02, 0.6, 0.45, 1.8) * 0.07
    b = bell(1318.5, 2.6, 1.0)
    out[: len(b)] += b * 0.5
    sub = np.sin(2 * np.pi * np.cumsum(40 + 50 * np.exp(-t_axis(1.5) * 8)) / SR) * np.exp(-t_axis(1.5) * 3)
    out[: len(sub)] += sub * 0.9
    return with_reverb(out, 0.45)


FX = {
    "tick": (fx_tick, 0.26), "pop": (fx_pop, 0.22), "count": (fx_count, 0.16), "type": (fx_type, 0.13),
    "title": (fx_title, 0.3), "scroll": (fx_scroll, 0.2), "whoosh": (fx_whoosh, 0.5), "push": (fx_push, 0.55),
    "flash": (fx_flash, 0.5), "alarm": (fx_alarm, 0.42), "glitch": (fx_glitch, 0.32), "lock": (fx_lock, 0.62),
    "hit": (fx_hit, 0.62), "chime": (fx_chime, 0.38), "ripple": (fx_ripple, 0.3), "riser": (fx_riser, 0.4),
    "logo": (fx_logo, 0.6), "stinger": (fx_stinger, 0.62),
}
_cache: dict[str, np.ndarray] = {}


def place(buf: np.ndarray, at: float, name: str, gain: float = 1.0) -> None:
    if name not in FX:
        return
    fn, level = FX[name]
    if name not in _cache:
        y = fn()
        _cache[name] = y / (np.max(np.abs(y)) + 1e-9)
    y = _cache[name] * level * gain
    i = int(at * SR)
    if i < 0 or i >= len(buf):
        return
    end = min(len(buf), i + len(y))
    pan = {"tick": 0.0, "count": 0.0, "type": 0.0}.get(name, 0.0)
    buf[i:end, 0] += y[: end - i] * (1 - 0.3 * max(0, pan))
    buf[i:end, 1] += y[: end - i] * (1 + 0.3 * min(0, pan))


# ---- music ------------------------------------------------------------------------------------------------------------
BPM = 96
BEAT = 60 / BPM
CHORDS = [(220.0, [0, 3, 7]), (174.61, [0, 4, 7]), (261.63, [0, 4, 7]), (196.0, [0, 4, 7])]  # Am F C G, root in Hz, semitones
MINOR_FIRST = True


def note(root_hz: float, semis: int, octave: int = 0) -> float:
    return root_hz * 2 ** ((semis + 12 * octave) / 12)


def level_curve() -> np.ndarray:
    pts = tl["music"]
    ts = [p["t"] for p in pts] + [TOTAL]
    lv = [p["level"] for p in pts] + [pts[-1]["level"]]
    x = np.arange(N) / SR
    return np.interp(x, ts, lv)


def dips() -> np.ndarray:
    """Music gain: briefly pulled back before a refusal/audit hit, so the hit lands."""
    g = np.ones(N)
    for e in tl["sfx"]:
        if e["type"] in ("lock", "hit"):
            a, b = int((e["t"] - 0.5) * SR), int(e["t"] * SR)
            g[a:b] *= np.linspace(1, 0.15, b - a)
            c = int((e["t"] + 1.4) * SR)
            g[b:c] *= 0.15 + 0.85 * np.linspace(0, 1, c - b) ** 1.5
    return g


def music() -> np.ndarray:
    out = np.zeros((N, 2))
    lvl = level_curve()
    pad = np.zeros((N, 2))
    chord_len = 8 * BEAT  # two bars per chord
    n_chords = int(TOTAL / chord_len) + 2
    for ci in range(n_chords):
        root_hz, semis = CHORDS[ci % 4]
        start = int(ci * chord_len * SR)
        n = int((chord_len + 1.4) * SR)
        if start >= N:
            break
        env = adsr(n, 1.1, 0.4, 0.85, 1.3)
        for k, sm in enumerate(semis + [12]):
            f = note(root_hz, sm, 0)
            for d, side in ((-8, 0), (-3, 0), (4, 1), (9, 1)):
                v = saw(f, n, d, rng.random()) * 0.045 * env
                end = min(N, start + n)
                pad[start:end, side] += v[: end - start]
                pad[start:end, 1 - side] += v[: end - start] * 0.35
    pad[:, 0] = lowpass(pad[:, 0], 1500)
    pad[:, 1] = lowpass(pad[:, 1], 1500)
    out += pad * (0.55 + 0.45 * lvl[:, None])

    bass = np.zeros(N)
    for ci in range(n_chords):
        root_hz, _ = CHORDS[ci % 4]
        for beat in (0, 3, 4, 6):
            at = int((ci * chord_len + beat * BEAT) * SR)
            t = t_axis(0.9)
            f = root_hz / 2
            y = (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * 2 * f * t)) * np.exp(-t * 4.2)
            end = min(N, at + len(t))
            if at < N:
                bass[at:end] += y[: end - at] * 0.5
    out += bass[:, None] * (0.35 + 0.55 * lvl[:, None])

    arp = np.zeros((N, 2))
    pattern = [0, 2, 1, 3, 2, 1, 3, 2]
    step = BEAT / 4
    n_steps = int(TOTAL / step)
    for i in range(n_steps):
        ci = int(i * step / chord_len)
        root_hz, semis = CHORDS[ci % 4]
        tones = [note(root_hz, s, 1) for s in semis] + [note(root_hz, semis[0], 2)]
        f = tones[pattern[i % 8]]
        at = int(i * step * SR)
        gain = max(0.0, (lvl[min(at, N - 1)] - 0.45) * 1.9)
        if gain <= 0.02 or at >= N:
            continue
        t = t_axis(0.22)
        y = (np.sin(2 * np.pi * f * t) + 0.35 * np.sign(np.sin(2 * np.pi * f * t))) * np.exp(-t * 17)
        end = min(N, at + len(t))
        side = i % 2
        arp[at:end, side] += y[: end - at] * 0.07 * gain
        arp[at:end, 1 - side] += y[: end - at] * 0.03 * gain
    for rep, g in ((int(BEAT * 0.75 * SR), 0.45), (int(BEAT * 1.5 * SR), 0.2)):  # ping-pong echo
        arp[rep:, 0] += arp[:-rep, 1] * g
        arp[rep:, 1] += arp[:-rep, 0] * g
    out += arp

    hats = np.zeros(N)
    for i in range(int(TOTAL / (BEAT / 2))):
        at = int(i * (BEAT / 2) * SR)
        if i % 2 == 0 or at >= N:
            continue
        gain = max(0.0, (lvl[min(at, N - 1)] - 0.6) * 2.6)
        if gain <= 0.03:
            continue
        n = int(0.035 * SR)
        h = highpass(rng.standard_normal(n), 7000) * np.exp(-np.arange(n) / SR * 120)
        end = min(N, at + n)
        hats[at:end] += h[: end - at] * 0.05 * gain
    out += hats[:, None]
    return out * dips()[:, None]


# ---- the mix ----------------------------------------------------------------------------------------------------------
def read_wav(p: pathlib.Path) -> np.ndarray:
    with wave.open(str(p), "rb") as w:
        assert w.getframerate() == SR and w.getnchannels() == 1 and w.getsampwidth() == 2
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32767


voice = np.zeros(N)
for v in tl["voice"]:
    clip = read_wav(work / "audio" / f"{v['id']}.wav")
    i = int(round(v["t"] * SR))
    voice[i : i + len(clip)] += clip[: N - i]

# narration envelope -> sidechain for the music
frame = int(0.02 * SR)
rms = np.sqrt(np.convolve(voice**2, np.ones(frame) / frame, mode="same"))
on = np.clip((rms - 0.012) / 0.03, 0, 1)
att = signal.lfilter([1 - np.exp(-1 / (0.03 * SR))], [1, -np.exp(-1 / (0.03 * SR))], on)
rel = signal.lfilter([1 - np.exp(-1 / (0.45 * SR))], [1, -np.exp(-1 / (0.45 * SR))], att)
duck = 1 - 0.74 * np.maximum(att, rel)

mus = music() * duck[:, None]
sfx = np.zeros((N, 2))
for e in tl["sfx"]:
    place(sfx, e["t"], e["type"], e.get("gain", 1.0))

sfx *= (1 - 0.4 * att)[:, None]  # effects give way a little to the narration, so no word is covered
mix = np.stack([voice, voice], axis=1) * 1.0 + mus * 0.95 + sfx
# fade in / out of the whole bed
fade_in, fade_out = int(0.4 * SR), int(1.2 * SR)
end_i = int(TOTAL * SR)
mix[:fade_in] *= np.linspace(0, 1, fade_in)[:, None]
mix[end_i - fade_out : end_i] *= np.linspace(1, 0, fade_out)[:, None]
mix[end_i:] = 0
mix = mix[: end_i]
# a soft limiter so peaks never clip
peak = np.max(np.abs(mix))
mix = np.tanh(mix * 1.15) / np.tanh(1.15)
mix *= 0.93 / max(1e-9, np.max(np.abs(mix)))
with wave.open(str(work / "mix.wav"), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((np.clip(mix, -1, 1) * 32767).astype("<i2").tobytes())

v_on = mix[np.abs(voice[:end_i]) > 0.02]
print(f"wrote {work / 'mix.wav'}  ({end_i / SR:.1f} s, stereo, {SR} Hz)")
print(f"peak before limiter {peak:.2f}; RMS overall {20 * np.log10(np.sqrt(np.mean(mix**2)) + 1e-9):.1f} dBFS")
print(f"music during narration: {20 * np.log10(np.sqrt(np.mean((mus[:end_i][np.abs(voice[:end_i]) > 0.02]) ** 2)) + 1e-9):.1f} dBFS; "
      f"narration alone: {20 * np.log10(np.sqrt(np.mean(voice[:end_i][np.abs(voice[:end_i]) > 0.02] ** 2)) + 1e-9):.1f} dBFS")
