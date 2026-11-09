# Demo video pipeline

Builds the submission video from the running app and the presenter's recorded voice. The script, scene timings and fallbacks are in [../docs/DEMO_SCRIPT.md](../docs/DEMO_SCRIPT.md); this folder only automates producing it. Nothing here changes the product, and nothing on screen is faked: the recorder drives the real production build in the installed Microsoft Edge and captures the page.

## What you need

- The app running as a **production build** with a migrated and seeded database and an operator passcode in `.env.local` (`npm run build`, `npm run db:migrate`, `npm run db:seed`, `npm start`; see the README).
- `npm run benchmark` run once, so the Cockpit has benchmark results.
- Python 3 with `av`, `numpy` and `Pillow` (`python -m pip install av numpy Pillow`). Verified with Python 3.12.0, av 18.0.0, numpy 2.4.6, Pillow 12.3.0; PyAV bundles its own FFmpeg libraries, so no separate ffmpeg is needed.
- Microsoft Edge (the same one the Playwright suite uses).

## Steps

```bash
python demo/prepare_audio.py --sheet     # writes demo/reading-sheet.md: the lines to read aloud
# record (or generate with a text-to-speech service) the clips s1 s2 s3 s4 s5b s6 s7 and put them in demo/audio/ (any common audio format)
python demo/prepare_audio.py [--payment 5A]  # trims silence, levels, measures; refuses if the video would be too long
python demo/cue_times.py [--payment 5A]  # word timestamps of every clip (needs faster-whisper and a cached model); required for the edit
node demo/record.ts [--payment 5A]       # records the scenes, timed to the measured clips; also stores sharp stills and element positions (5A: the live cut)
python demo/assemble.py                  # the PLAIN cut: demo/out/pactpay-demo.mp4 (H.264 + AAC, 1280x720, at most 2:50)

# the EDITED cut (camera moves, highlights, labels, transitions, titles, intro/outro, music and sound effects):
node demo/plan.ts                        # edit decision list (demo/edit.json) + word times + positions -> demo/work/timeline.json
node demo/render.ts                      # draws every frame at 1920x1080 (demo/stage.html in Edge); about 4 minutes
python demo/sound.py                     # synthesises the music bed and effects and mixes them with the narration -> mix.wav
python demo/encode.py                    # writes demo/out/pactpay-demo-edit.mp4 (H.264 1920x1080 + stereo AAC, at most 2:50)
python demo/encode.py --remux            # after changing only the sound: replaces the audio without re-encoding the video
```

`node demo/record.ts` creates one synthetic negotiation off camera (it uses 60.00 of the demo mandate's 150.00 budget) and prints its id; pass `--neg <id>` on later runs to reuse it. It reads `OPERATOR_PASSCODE` from the environment or `.env.local`, uses it only off camera, and never prints it.

## What it refuses to do

- Record scene **5B** (the honest "payment cannot start, nothing counts as paid" panel) if the server reports PayPal credentials, because the narration would then be false.
- Record scene **5A** (`--payment 5A`, which also records scene **4B**, the real model) unless the server reports PayPal credentials, `agents.mode` `llm` and the app's own panel says "Captured: PayPal reports the payment completed" with "Paid (captured): Yes" after the live run. 5A is **live**: it starts a real sandbox payment on camera, and the buyer's login and approval at PayPal happen off camera: you do them in the visible Edge window when the recorder prints `YOUR TURN`; capture is paused meanwhile and the edit labels the cut. It cannot check the rest of the gate in the script (the Cockpit evidence is on screen at the end); that is yours.
- Produce a file longer than 2:50, or finish if the recording contains page errors.
- Present a self-test as final: `python demo/prepare_audio.py --selftest` uses tone clips to check the pipeline and marks its output `SELFTEST`.

## The edit

`demo/edit.json` is the edit decision list: every beat is tied to a **spoken phrase** (matched against the word timestamps of the narration) and to **elements of the real page** (found by their text in `record.ts`). Labels, counters and codes only restate what the screen or the narration already shows; the counters are parsed from the numbers the page itself displays. `plan.ts` stops if a phrase was not spoken or an element is not on the page. The camera pushes in only on settled pages, using sharp 2560x1440 stills; during scrolls it uses the live frames. All music and effects are synthesised locally (nothing is sampled or licensed); the music ducks under the voice and the effects give way to it. `test/demo` checks that the plan, the script and the sound designer agree.

## Notes

- The recording is a screencast of the page (no cursor); scrolling is performed with real mouse-wheel events, smoothed. Scene timing comes from the length of each recorded clip, and the screen actions follow the words by position (`{{cue}}` markers in `narration.json`).
- `narration.json` only adds those cues; the spoken text must equal the script's "Say" blocks (a test checks it).
- `demo/audio/`, `demo/work/` and `demo/out/` are git-ignored. Uploading to YouTube is a manual step.
