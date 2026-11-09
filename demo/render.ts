// Renders the edited video, frame by frame: node demo/render.ts [--times 3,14.5,60] [--resume] [--out dir]
//
// Loads demo/stage.html (a deterministic page that draws any moment of demo/work/timeline.json) in Edge at 1920x1080 and
// captures a JPEG per frame into demo/work/render/ (30 fps), which demo/encode.py turns into the video. With --times it renders
// only those moments (seconds) into demo/work/preview/ so the edit can be inspected before the full render.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const work = opt("work") ?? join("demo", "work");
const times = opt("times")?.split(",").map(Number);
const resume = args.includes("--resume");
const outDir = opt("out") ?? join(work, times ? "preview" : "render");

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const fail = (m: string): never => {
  console.error(`[render] ${m}`);
  process.exit(1);
};
for (const f of ["timeline.json", "frames.json"])
  if (!existsSync(join(work, f))) fail(`${work}/${f} is missing: run record.ts and plan.ts first`);

type Timeline = {
  fps: number;
  total: number;
  toOut: { w0: number; intro: number };
  stills: { file: string; from: number; until: number }[];
};
const tl = readJson<Timeline & Record<string, unknown>>(join(work, "timeline.json"));
const shots = readJson<{ epoch0: number; frames: { t: number; file: string }[] }>(
  join(work, "frames.json"),
);
const url = (p: string) => pathToFileURL(resolve(p)).href;

const frames = shots.frames
  .map((f) => ({
    t: f.t - shots.epoch0 - tl.toOut.w0 + tl.toOut.intro,
    url: url(join(work, "frames", f.file)),
  }))
  .sort((a, b) => a.t - b.t);
const stills = tl.stills.map((s) => ({
  from: s.from,
  until: s.until,
  url: url(join(work, s.file)),
}));

if (!resume) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await (
  await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
).newPage();
const problems: string[] = [];
page.on("pageerror", (e) => problems.push(e.message));
page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
await page.goto(url(join("demo", "stage.html")));
await page.evaluate(
  ([a, b, c]) => (window as unknown as { init: (...x: unknown[]) => boolean }).init(a, b, c),
  [tl, frames, stills] as const,
);
const cdp = await page.context().newCDPSession(page);

const grab = async (t: number, file: string) => {
  await page.evaluate(
    (x) => (window as unknown as { renderFrame: (t: number) => Promise<boolean> }).renderFrame(x),
    t,
  );
  const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
  writeFileSync(file, Buffer.from(shot.data, "base64"));
};

if (times) {
  for (const t of times) {
    await grab(t, join(outDir, `t${t.toFixed(2).padStart(7, "0")}.jpg`));
    console.log(`[render] preview t=${t}`);
  }
} else {
  const n = Math.ceil(tl.total * tl.fps);
  const started = Date.now();
  let done = 0;
  for (let i = 0; i < n; i++) {
    const file = join(outDir, `${String(i).padStart(5, "0")}.jpg`);
    if (resume && existsSync(file)) continue;
    await grab(i / tl.fps, file);
    done++;
    if (done % 200 === 0) {
      const per = (Date.now() - started) / done;
      console.log(
        `[render] ${i + 1}/${n} frames, ${(per / 1000).toFixed(2)} s/frame, about ${Math.round(((n - i - 1) * per) / 60000)} min left`,
      );
    }
  }
  console.log(`[render] ${n} frames in ${((Date.now() - started) / 60000).toFixed(1)} min`);
}
await browser.close();
if (problems.length > 0) {
  console.error(problems.slice(0, 8).join("\n"));
  fail("the stage reported errors");
}
