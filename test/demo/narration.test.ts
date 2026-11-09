import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

type Clip = { id: string; scene: string; windowSeconds: number; text: string };

const read = (p: string) => readFileSync(p, "utf8");
const doc = read("docs/DEMO_SCRIPT.md");
const clips = (JSON.parse(read("demo/narration.json")) as { clips: Clip[] }).clips;
const recorder = read("demo/record.ts");

/** The "Say" blocks of docs/DEMO_SCRIPT.md, by scene id (S1, S2, ..., S5A, S5B, ...). */
function sayBlocks(): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of doc.split(/\n### /).slice(1)) {
    const id = /^(S\d[ABC]?) /.exec(part)?.[1];
    if (id === undefined) continue;
    const say = [...part.matchAll(/^ {2}> (.+)$/gm)].map((m) => m[1]).join(" ");
    if (say !== "") out.set(id, say.trim());
  }
  return out;
}

const spoken = (text: string) =>
  text
    .replace(/\{\{\w+\}\}\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();

describe("demo narration (docs/DEMO_SCRIPT.md is the script; demo/narration.json only adds screen cues)", () => {
  it("every clip's spoken text equals the script's Say block, word for word", () => {
    const say = sayBlocks();
    for (const c of clips) {
      expect(say.get(c.scene), `no Say block for ${c.scene}`).toBeDefined();
      expect(spoken(c.text), c.id).toBe(say.get(c.scene));
    }
    expect(clips.map((c) => c.scene).sort()).toEqual([
      "S1",
      "S2",
      "S3",
      "S4",
      "S4B",
      "S5A",
      "S5B",
      "S6",
      "S7",
    ]);
  });

  it("every screen cue used in a clip has a handler in demo/record.ts, and every handler has a cue", () => {
    const used = new Set(
      clips.flatMap((c) => [...c.text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] as string)),
    );
    for (const cue of used)
      expect(recorder, `record.ts has no handler for cue ${cue}`).toMatch(new RegExp(`\\b${cue}:`));
    for (const cue of ["scroll", "audit", "panel", "protected", "compare"])
      expect(used.has(cue), `cue ${cue} is handled by record.ts but used by no clip`).toBe(true);
  });

  it("the scene windows sum to the planned length and stay under the 2:50 hard limit", () => {
    const planned = ["s1", "s2", "s3", "s4", "s4b", "s5a", "s6", "s7"].reduce(
      (sum, id) => sum + (clips.find((c) => c.id === id)?.windowSeconds ?? 0),
      0,
    );
    expect(planned).toBe(166);
    expect(planned).toBeLessThanOrEqual(170);
  });

  it("the payment scene never states a result the build did not produce: 5B says nothing was run, 5A says it is a real sandbox payment", () => {
    expect(spoken(clips.find((c) => c.id === "s5b")?.text ?? "")).toMatch(
      /has not yet been run against the PayPal Sandbox/,
    );
    expect(spoken(clips.find((c) => c.id === "s5a")?.text ?? "")).toMatch(
      /real payment in the PayPal Sandbox/,
    );
  });
});

describe("edit decision list (demo/edit.json)", () => {
  const edit = JSON.parse(read("demo/edit.json")) as {
    beats: {
      scene: string;
      anchor: string;
      kind: string;
      sfx?: string;
      focus?: string[];
      label?: string;
    }[];
    tagline: { scene: string }[];
    transitions: Record<string, string>;
  };
  const sceneIds = new Set(clips.map((c) => c.id));

  it("every beat belongs to a recorded scene, has an anchor phrase that is part of that scene's script, and a known colour", () => {
    for (const b of edit.beats) {
      expect(sceneIds.has(b.scene), `unknown scene ${b.scene}`).toBe(true);
      const script = spoken(clips.find((c) => c.id === b.scene)?.text ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9' ]+/g, " ");
      const words = b.anchor.toLowerCase().split(/\s+/);
      // numerals are spoken as words in the script ("twenty-four"), so a spelled-out anchor must appear as such
      expect(script.replace(/\s+/g, " "), `anchor "${b.anchor}" is not in ${b.scene}`).toContain(
        words.join(" "),
      );
      expect(["info", "success", "warn", "danger"]).toContain(b.kind);
    }
    for (const g of edit.tagline) expect(sceneIds.has(g.scene)).toBe(true);
    for (const id of Object.keys(edit.transitions)) expect(sceneIds.has(id)).toBe(true);
  });

  it("every focus target exists in the recorder, and every sound effect the edit asks for exists in the sound designer", () => {
    const sound = read("demo/sound.py");
    for (const b of edit.beats) {
      for (const f of b.focus ?? [])
        expect(recorder, `target ${f}`).toMatch(new RegExp(`\\b${f}:`));
      if (b.sfx) expect(sound, `effect ${b.sfx}`).toMatch(new RegExp(`"${b.sfx}": \\(fx_`));
    }
  });

  it("labels only restate what is true: the unverified PayPal state is never presented as verified", () => {
    const labels = edit.beats.map((b) => b.label ?? "").join(" | ");
    expect(labels).toMatch(/Not yet run against the PayPal Sandbox/);
    expect(labels).not.toMatch(/PayPal (confirmed|verified|captured|paid)/i);
  });
});
