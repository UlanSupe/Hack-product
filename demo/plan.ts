// Plans the edit: node demo/plan.ts [workDir]
//
// Combines the recording (scenes, scroll runs, element positions), the narration's word timestamps and the edit decision list
// (demo/edit.json) into demo/work/timeline.json: camera moves, highlights, labels, transitions and sound events on one
// timeline. demo/render.ts draws it, demo/sound.py scores it. Nothing is invented here: a beat whose phrase was not spoken,
// or whose element is not on the page, stops the plan.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Rect = { x: number; y: number; w: number; h: number };
type Cam = { cx: number; cy: number; z: number };
type Scene = { id: string; startS: number; audioStartS: number; endS: number };
type CueRun = { scene: string; name: string; startS: number; endS: number };
type Snap = {
  scene: string;
  state: string;
  tS: number;
  rects: Record<string, Rect>;
  texts: Record<string, string>;
  hires: string;
};
type Word = [string, number, number];
type Beat = {
  scene: string;
  anchor: string;
  state?: string;
  focus?: string[];
  kind: "info" | "success" | "warn" | "danger";
  label?: string;
  code?: string;
  fx?: string;
  sfx?: string;
  dur: number;
  counter?: { from: string; caption: string };
};

const work = process.argv[2] ?? join("demo", "work");
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const fail = (m: string): never => {
  console.error(`[plan] ${m}`);
  process.exit(1);
};
for (const f of ["scenes.json", "snaps.json", "words.json"])
  if (!existsSync(join(work, f)))
    fail(`${work}/${f} is missing: run prepare_audio.py, cue_times.py and record.ts first`);

const edit = readJson<{
  intro: { seconds: number };
  outro: { endCardSeconds: number };
  titles: Record<string, string>;
  transitions: Record<string, string>;
  cueTransitions: Record<string, string>;
  beats: Beat[];
  tagline: { scene: string; anchor: string; text: string }[];
}>(join("demo", "edit.json"));
const rec = readJson<{
  payment: string;
  scenes: Scene[];
  cueRuns: CueRun[];
  durations: Record<string, number>;
  dsf: number;
}>(join(work, "scenes.json"));
const snaps = readJson<Snap[]>(join(work, "snaps.json"));
const words = readJson<Record<string, Word[]>>(join(work, "words.json"));

// ---- geometry shared with the stage (demo/stage.html) -------------------------------------------------------------------
const STAGE = { w: 1920, h: 1080 };
const S = 1664 / 1280; // stage pixels per UI pixel at zoom 1
const UI = { w: 1280, h: 720 };
const WIDE: Cam = { cx: 640, cy: 346, z: 1 };

// ---- timeline mapping ------------------------------------------------------------------------------------------------
const INTRO = edit.intro.seconds;
const first = rec.scenes[0] ?? fail("no scenes");
const w0 = first.audioStartS - 0.3;
const toOut = (tRec: number) => tRec - w0 + INTRO;
const scenes = rec.scenes.map((s) => ({
  id: s.id,
  startT: toOut(s.startS),
  audioT: toOut(s.audioStartS),
  endT: toOut(s.endS),
  dur: rec.durations[s.id] ?? 0,
}));
const sceneOf = (id: string) =>
  scenes.find((s) => s.id === id) ?? fail(`scene ${id} was not recorded`);
const endFootage = scenes.at(-1)!.endT;
const total = endFootage + edit.outro.endCardSeconds;

// ---- anchors -> times ---------------------------------------------------------------------------------------------------
const NUM: Record<string, string[]> = {
  "24": ["twenty", "four"],
  "30": ["thirty"],
  "36": ["thirty", "six"],
};
const tok = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z0-9']+/g) ?? []).flatMap((t) => NUM[t] ?? [t]);
const lastIdx: Record<string, number> = {};
function anchorTime(scene: string, anchor: string): number {
  const ws = words[scene] ?? fail(`no words for ${scene}`);
  const want = tok(anchor);
  for (let i = lastIdx[scene] ?? 0; i + want.length <= ws.length; i++) {
    if (want.every((w, k) => ws[i + k]![0].replace(/'s$/, "") === w.replace(/'s$/, ""))) {
      lastIdx[scene] = i;
      return sceneOf(scene).audioT + ws[i]![1];
    }
  }
  return fail(`the phrase "${anchor}" was not found (in order) in the narration of ${scene}`);
}

// ---- helpers ---------------------------------------------------------------------------------------------------------
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const union = (rs: Rect[]): Rect => {
  const x0 = Math.min(...rs.map((r) => r.x));
  const y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w));
  const y1 = Math.max(...rs.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
const warnings: string[] = [];

function camFor(r: Rect): Cam {
  let z = Math.min((0.72 * STAGE.w) / (S * (r.w + 72)), (0.58 * STAGE.h) / (S * (r.h + 72)));
  z = z < 1.08 ? 1 : Math.min(1.75, z);
  if (z === 1) return WIDE;
  let cx = r.x + r.w / 2;
  let cy = r.y + r.h / 2 + 40 / (S * z); // the target sits a little above the middle; the label lives below
  const hw = STAGE.w / 2 / (S * z);
  const hh = STAGE.h / 2 / (S * z);
  cx = 2 * hw >= UI.w + 120 ? 640 : clamp(cx, hw - 60, UI.w + 60 - hw);
  cy = 2 * hh >= UI.h + 140 ? WIDE.cy : clamp(cy, hh - 70, UI.h + 70 - hh);
  return { cx: +cx.toFixed(1), cy: +cy.toFixed(1), z: +z.toFixed(3) };
}

function snapFor(scene: string, state: string): Snap {
  const [sc, st] = state.includes(":") ? (state.split(":") as [string, string]) : [scene, state];
  return snaps.find((s) => s.scene === sc && s.state === st) ?? fail(`no snapshot ${sc}:${st}`);
}

// ---- beats -----------------------------------------------------------------------------------------------------------
const scrollRuns = rec.cueRuns.map((r) => ({ ...r, t0: toOut(r.startS), t1: toOut(r.endS) }));
// only the scenes that were recorded: the other payment scene (5A or 5B) has no footage and no word times
const beats = edit.beats
  .filter((b) => words[b.scene] !== undefined)
  .map((b) => {
    let t = anchorTime(b.scene, b.anchor);
    const state = b.state ?? "nav";
    const run = scrollRuns.find(
      (r) =>
        r.scene === (state.includes(":") ? state.split(":")[0] : b.scene) &&
        r.name === (state.includes(":") ? state.split(":")[1] : state),
    );
    if (run && t < run.t1 + 0.15) {
      warnings.push(
        `${b.scene} "${b.anchor}": moved from ${t.toFixed(2)} to ${(run.t1 + 0.15).toFixed(2)} (the page was still scrolling)`,
      );
      t = run.t1 + 0.15;
    }
    let rect: Rect | null = null;
    let counter: { text: string; caption: string } | null = null;
    if (b.focus && b.focus.length > 0) {
      const sn = snapFor(b.scene, state);
      rect = union(
        b.focus.map(
          (n) => sn.rects[n] ?? fail(`target ${n} missing in snapshot ${b.scene}:${state}`),
        ),
      );
      const vis =
        Math.max(0, Math.min(rect.x + rect.w, UI.w) - Math.max(rect.x, 0)) *
        Math.max(0, Math.min(rect.y + rect.h, UI.h) - Math.max(rect.y, 0));
      if (vis < 0.6 * rect.w * rect.h)
        warnings.push(
          `${b.scene} "${b.anchor}": only ${Math.round((100 * vis) / (rect.w * rect.h))}% of the target is inside the window`,
        );
      if (b.counter) {
        const text = sn.texts[b.counter.from] ?? "";
        const m = /(\d+) of (\d+)/.exec(text);
        if (m) counter = { text: `${m[1]} / ${m[2]}`, caption: b.counter.caption };
        else
          warnings.push(
            `${b.scene} "${b.anchor}": no "N of M" in the on-screen text "${text}", counter skipped`,
          );
      }
    }
    return { ...b, t: +t.toFixed(3), rect, counter };
  });
for (let i = 1; i < beats.length; i++) {
  const a = beats[i - 1]!;
  const b = beats[i]!;
  if (a.scene === b.scene && b.t < a.t + 0.5)
    warnings.push(
      `${b.scene} "${b.anchor}" starts only ${(b.t - a.t).toFixed(2)}s after "${a.anchor}"`,
    );
}

// ---- sharp stills: valid from the snapshot until the page changes (next scroll in the scene, or the next scene) -----------
const stills = snaps.map((sn) => {
  const nextRun = scrollRuns
    .filter((r) => r.scene === sn.scene && r.startS > sn.tS)
    .map((r) => r.startS);
  const sceneIdx = rec.scenes.findIndex((s) => s.id === sn.scene);
  const nextScene = rec.scenes[sceneIdx + 1]?.startS ?? rec.scenes[sceneIdx]!.endS;
  // A scene's loaded page is shown from the moment of the cut (or from the very start for the first scene), so the viewer
  // never sees the page loading; the transition hides the cut itself.
  const sc = scenes.find((x) => x.id === sn.scene);
  const hasCut = sc !== undefined && edit.transitions[sc.id] !== undefined;
  const from =
    sn.state === "nav" && sc && sc === scenes[0]
      ? 0
      : sn.state === "nav" && hasCut
        ? sc.audioT - 0.25
        : toOut(sn.tS);
  return {
    file: sn.hires,
    from: +from.toFixed(3),
    until: +toOut(Math.min(...nextRun, nextScene)).toFixed(3),
    scene: sn.scene,
    state: sn.state,
  };
});

// ---- camera segments ---------------------------------------------------------------------------------------------------
type Seg = { t0: number; t1: number; t2: number; t3: number; from: Cam; to: Cam };
const segs: Seg[] = [];
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerpCam = (a: Cam, b: Cam, u: number): Cam => ({
  cx: a.cx + (b.cx - a.cx) * u,
  cy: a.cy + (b.cy - a.cy) * u,
  z: a.z + (b.z - a.z) * u,
});
function camAt(t: number): Cam {
  let seg: Seg | undefined;
  for (const s of segs) if (s.t0 <= t) seg = s;
  if (!seg) return WIDE;
  if (t < seg.t1) return lerpCam(seg.from, seg.to, ease((t - seg.t0) / (seg.t1 - seg.t0)));
  if (t <= seg.t2) return seg.to;
  if (t < seg.t3) return lerpCam(seg.to, WIDE, ease((t - seg.t2) / (seg.t3 - seg.t2)));
  return WIDE;
}
type Ev = { t: number; cam: Cam; hold: number; ret: number };
const evs: Ev[] = [
  ...beats
    .filter((b) => b.rect)
    .map((b) => ({ t: b.t, cam: camFor(b.rect!), hold: b.dur, ret: 0.9 })),
  ...scrollRuns.map((r) => ({ t: r.t0 + 0.2, cam: WIDE, hold: r.t1 - r.t0 - 0.1, ret: 0.01 })),
].sort((a, b) => a.t - b.t);
for (const e of evs) {
  const t0 = e.t - 0.45;
  segs.push({
    t0,
    t1: e.t + 0.15,
    t2: e.t + e.hold,
    t3: e.t + e.hold + e.ret,
    from: camAt(t0),
    to: e.cam,
  });
}

// ---- transitions, titles, tagline, sound events ----------------------------------------------------------------------
const transitions: { t: number; type: string; dur: number }[] = [];
for (const [id, type] of Object.entries(edit.transitions)) {
  const s = scenes.find((x) => x.id === id);
  if (s) transitions.push({ t: +(s.audioT - 0.25).toFixed(3), type, dur: 0.5 });
}
for (const [key, type] of Object.entries(edit.cueTransitions)) {
  // "scene:cue" cuts when the cue starts; "scene:cue@end" cuts when it ends (for example the return from PayPal).
  const [sc, rest] = key.split(":");
  const [name, at] = (rest ?? "").split("@");
  const r = scrollRuns.find((x) => x.scene === sc && x.name === name);
  if (r)
    transitions.push({ t: +(at === "end" ? r.t1 - 0.1 : r.t0 + 0.04).toFixed(3), type, dur: 0.35 });
}
transitions.sort((a, b) => a.t - b.t);

const titles = scenes
  .filter((s) => edit.titles[s.id])
  .map((s, i) => ({
    id: s.id,
    n: i + 1,
    text: edit.titles[s.id]!,
    t: +(s.audioT + 0.15).toFixed(3),
    dur: 2.6,
  }));
const tagline = edit.tagline.map((x) => ({
  text: x.text,
  t: +anchorTime(x.scene, x.anchor).toFixed(3),
}));

const sfx: { t: number; type: string; gain?: number }[] = [{ t: 0.1, type: "logo" }];
for (const tr of transitions)
  sfx.push({
    t: +(tr.t - 0.12).toFixed(3),
    type: tr.type === "flash" ? "flash" : tr.type === "push" ? "push" : "whoosh",
    gain: 1,
  });
for (const b of beats) {
  sfx.push({ t: +(b.t - 0.05).toFixed(3), type: b.sfx ?? "tick" });
  if (b.fx === "glitch") sfx.push({ t: +(b.t - 0.05).toFixed(3), type: "glitch" });
  if (b.fx === "ripple") sfx.push({ t: +(b.t + 0.05).toFixed(3), type: "ripple" });
  if (b.counter)
    for (let k = 0; k < 6; k++) sfx.push({ t: +(b.t + 0.15 + k * 0.07).toFixed(3), type: "count" });
  if (b.code)
    for (let k = 0; k < Math.min(b.code.length, 18); k++)
      sfx.push({ t: +(b.t + 0.25 + k * 0.035).toFixed(3), type: "type" });
}
for (const t of titles) sfx.push({ t: +(t.t - 0.05).toFixed(3), type: "title" });
for (const r of scrollRuns) sfx.push({ t: +r.t0.toFixed(3), type: "scroll" });
for (const g of tagline) sfx.push({ t: +(g.t - 0.03).toFixed(3), type: "pop" });
sfx.push({ t: +endFootage.toFixed(3), type: "stinger" });
sfx.sort((a, b) => a.t - b.t);

const music = [
  { t: 0, level: 0.5 },
  ...scenes.map((s) => ({
    t: +s.startT.toFixed(3),
    id: s.id,
    level:
      (
        {
          s1: 0.45,
          s2: 0.55,
          s3: 0.7,
          s4: 0.8,
          s4b: 0.7,
          s5b: 0.45,
          s5a: 0.5,
          s6: 0.85,
          s7: 0.7,
        } as Record<string, number>
      )[s.id] ?? 0.5,
  })),
  { t: +endFootage.toFixed(3), level: 0.55 },
];

const timeline = {
  version: 1,
  fps: 30,
  stage: STAGE,
  geometry: { S, UI, WIDE },
  total: +total.toFixed(3),
  intro: INTRO,
  endFootage: +endFootage.toFixed(3),
  toOut: { w0, intro: INTRO },
  payment: rec.payment,
  dsf: rec.dsf,
  scenes: scenes.map((s) => ({
    ...s,
    startT: +s.startT.toFixed(3),
    audioT: +s.audioT.toFixed(3),
    endT: +s.endT.toFixed(3),
  })),
  voice: scenes.map((s) => ({ id: s.id, t: +s.audioT.toFixed(3), dur: s.dur })),
  beats,
  stills,
  segs: segs.map((s) => ({
    ...s,
    t0: +s.t0.toFixed(3),
    t1: +s.t1.toFixed(3),
    t2: +s.t2.toFixed(3),
    t3: +s.t3.toFixed(3),
  })),
  transitions,
  titles,
  tagline,
  sfx,
  music,
  endCard: { t: +endFootage.toFixed(3), dur: edit.outro.endCardSeconds },
};
writeFileSync(join(work, "timeline.json"), JSON.stringify(timeline, null, 2));

console.log(
  `[plan] ${beats.length} beats, ${segs.length} camera moves, ${transitions.length} transitions, ${sfx.length} sound events; total ${total.toFixed(1)} s`,
);
for (const w of warnings) console.log(`[plan] note: ${w}`);
if (total > 170) fail(`the video would be ${total.toFixed(1)} s: over the 2:50 limit`);
