# Shorts Creator

A local web app for making vertical YouTube Shorts (1080×1920, 30 fps) from a script.
It runs entirely on your PC: a React + TypeScript + Vite frontend and a Python FastAPI
backend for the heavy work. Everything is free: no paid APIs, no credits.

- **AI voiceover** with [Kokoro TTS](https://huggingface.co/hexgrad/Kokoro-82M), running locally
- **Word-timed captions** with [faster-whisper](https://github.com/SYSTRAN/faster-whisper), running locally
- **Stock footage** from [Pixabay](https://pixabay.com/api/docs/) or [Pexels](https://www.pexels.com/api/) (free API keys)
- **AI clips** with LTX-2.5 in [ComfyUI](https://www.comfy.org/), and **scene descriptions and prompts** written by a
  language model in [LM Studio](https://lmstudio.ai/) or [Ollama](https://ollama.com/), all on your PC
- **Final render** with FFmpeg

## Build status

The app is built in stages. Each stage is tested before the next one starts.

| Stage | What | Status |
| --- | --- | --- |
| 1 | Project setup, full layout, autosaved projects | ✅ done |
| 2 | Script panel and voiceover (Kokoro AI read, record, upload) | ✅ done |
| 3 | Captions with faster-whisper and caption preview | ✅ done |
| 4 | Media tab (Pexels and uploads) and timeline | ✅ done |
| 5 | Canvas & title, Ranking tab | ✅ done |
| 6 | FFmpeg render | ✅ done |
| 7 | AI Scenes, part A: scenes from the script, stock footage and AI previews per scene | ✅ done |
| 7 | AI Scenes, part B: finals made from the chosen preview, all scenes at once, finals on the timeline | ✅ done |
| 7 | AI Scenes, part C: a local language model writes the scenes' descriptions and prompts | 🧪 ready to test |

Working now: the full layout, autosaved projects, the script box, all three ways to make a
voiceover (AI read, recording, upload) plus background music, word-timed captions, a media
library shared by all projects (Pixabay and Pexels search, your own clips and images, Auto-fill,
Generate shot), a timeline whose clips, voiceover and captions play together in the preview,
clips that fill the frame or fit inside it over a blurred or solid background, a title,
ranking overlays for countdown videos, scenes (the video cut into 2 to 5 second stretches, each
with stock footage, or AI previews to choose from and a final made from the chosen one, their
descriptions and prompts written by a language model on your PC if you like), and the final render
to a Shorts-ready MP4.

## Windows setup

You need four free tools. Install them once, then open a **new** terminal so it sees them.

1. **Node.js 22 LTS** (or newer)
   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```
2. **Python 3.14** (3.12 and 3.13 also work)
   ```powershell
   winget install Python.Python.3.14
   ```
   Or use the installer from [python.org](https://www.python.org/downloads/) and tick
   **Add python.exe to PATH**.
3. **FFmpeg** (see [Installing FFmpeg](#installing-ffmpeg) for the manual route)
   ```powershell
   winget install --id Gyan.FFmpeg -e
   ```
4. **Git**
   ```powershell
   winget install Git.Git
   ```

Then get the code and install everything the app needs:

```powershell
git clone https://github.com/Blobby132/Youtube_help.git
cd Youtube_help
npm run setup
```

`npm run setup` (or double-click `setup.bat`) creates a `.env` file and a Python environment
in `backend\.venv`, installs the Python and npm packages, and downloads the Kokoro voice model
(about 350 MB) and the Whisper caption model (about 480 MB), once, into `models\`. Run it
again whenever you pull an update.

### Stock video API keys (Pixabay, Pexels)

Stock search needs a free key from at least one of these:

- **Pixabay**: log in at <https://pixabay.com>, then copy your key from
  <https://pixabay.com/api/docs/> (it's shown in the "Parameters" section once you're logged in).
- **Pexels**: <https://www.pexels.com/api/> (Pexels has paused new keys; an existing key still
  works).

Open `.env` in the project folder and paste the key(s) in, then restart the app:

```ini
PIXABAY_API_KEY=your-pixabay-key
PEXELS_API_KEY=your-pexels-key
```

With one key, the app uses that source. With both, the Media tab shows a **Source** switch.
Keys stay on your PC: the backend reads them and never sends them to the browser.

## Running the app

```powershell
npm run dev
```

Or double-click `start.bat`. This starts the backend (port 8765) and the frontend
(port 5173) together and opens <http://127.0.0.1:5173> in your browser. The terminal shows
both logs, tagged `[api]` and `[web]`. Press **Ctrl+C** to stop both.

If a port is taken, set `BACKEND_PORT` or `FRONTEND_PORT` in `.env`.

## AI voiceover (Kokoro)

The AI read runs [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) locally through ONNX
Runtime. It uses the **CPU by default**: during development a 46-second voiceover took 12
seconds on a modest cloud CPU. Pick a voice (▶ plays a sample), set the speed, and click
**Generate AI read**. The app also takes a microphone recording (silence at both ends is
trimmed) or an uploaded MP3/WAV/M4A, and optional background music.

### Using an AMD (or other) GPU on Windows

Kokoro can run on any DirectX 12 GPU, including AMD Radeon cards, through DirectML:

1. In `.env`, set `TTS_DEVICE=directml`.
2. Run `npm run setup` again. It swaps the `onnxruntime` package for `onnxruntime-directml`.
3. Start the app. The AI read card shows where Kokoro runs, e.g. "runs locally on DirectML (GPU)".

If DirectML is missing or fails, Kokoro falls back to the CPU on its own and logs why in the
terminal. Set `TTS_DEVICE=cpu` and run setup again to switch back. CPU stays the default
because it works on every PC.

### How pronunciation works

Text goes through these steps before Kokoro speaks it. They change only what Kokoro reads: your
script, the captions and the caption list keep your original spelling.

1. **Your pronunciation list** (see below) replaces the terms you've listed.
2. **Normalization** (`backend/app/voiceover/normalize.py`): rewrites what speech engines read
   badly, such as units glued to numbers (`16GB` → "16 gigabytes", `450W`, `2.5GHz`), decimals
   read in full with trailing zeros (`5.0` → "five point zero", `2.50` → "two point five
   zero"; money like `$2.50` is still "two dollars and fifty cents"), ranges (`5-10` → "5 to
   10"), clock times, `9:16`, `#1` → "number 1", `2x`, `$1.5B` and emojis.
3. **misaki**, Kokoro's own grapheme-to-phoneme library: a pronunciation dictionary with
   part-of-speech-aware heteronyms ("read", "live"), and number reading ("9060" → "ninety
   sixty", "1080p" → "ten eighty p"). Words it doesn't know go to **espeak-ng**.
4. Kokoro turns the phonemes into audio, a couple of sentences at a time.

misaki is the G2P Kokoro was trained with, so it gives the best results, but its PyPI package
refuses to install on Python 3.13+. Its English part is pure Python and its dependencies (spaCy,
espeak-ng) all support Python 3.14, so a copy lives in `backend/app/voiceover/misaki`
(Apache 2.0, changes marked "Shorts Creator:").

### Pronunciations list

If a word or symbol comes out wrong, add it under **Pronunciations** in the Script & voice tab:
what's **written** in the script, and how it should be **spoken**, e.g. `5.0` → "five point oh"
or `GHz` → "gigahertz". ▶ reads the written text the way a voiceover would. Regenerate the AI
read to apply changes.

- The list is saved once for the whole app (`data\pronunciations.json`), not per project.
- Entries win over the default rules, and your spoken text is used exactly as typed.
- A term matches as a whole: `5.0` doesn't match inside `15.0` or `5.01`, while `GHz` does
  match in `2.5GHz`. Matching is case-sensitive.
- The longest term wins (`RTX 4090` before `RTX`); if a term is listed twice, the lower entry
  is used.
- Captions still match the voiceover when it says something other than the script: each word
  is matched both as written and as spoken.

For exact control over sounds, misaki's phoneme syntax works in the spoken text and in the
script: `[Kokoro](/kˈOkəɹO/)`.

`npm test` writes pronunciation samples (e.g. "The RX 9060 XT has 16GB of VRAM and renders at
1080p.") in three voices to `backend\tests\output\`, so you can listen to them.

## Captions (faster-whisper)

**Generate captions** listens to the voiceover with
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) on the CPU and gets a time for
every word: on a 4-core cloud CPU a 46-second voiceover took about 8 seconds.

- **Your spelling, Whisper's timing.** Whisper writes what it hears ("RX9060XD", "16 GB"),
  so the app lines its words up with your script letter by letter and keeps your wording
  ("RX 9060 XT", "16GB") with the heard timing. If a recording strays from the script (less
  than 60% of it matches), the captions use what Whisper heard instead.
- **Starts on the word.** Whisper tends to start words early; each start is moved to where the
  voice actually begins, so captions don't appear before the word.
- **Style**: font, size, colours, outline, shadow, position, UPPERCASE, and 1–4 words per
  caption. Captions also break at sentence ends, after commas, and at pauses. With 2+ words
  the word being spoken gets the highlight colour.
- **Fix typos** in the caption list; timing stays the same. Typing more or fewer words shares
  the caption's time between them. Clear a caption to remove it.
- After you change the script and regenerate the voiceover, a warning pinned to the top of
  the Captions tab says the captions are out of date, with a button to regenerate them.

The model is set by `WHISPER_MODEL` in `.env` (`small.en` by default; `base.en` is faster,
`medium.en` more accurate). It always runs on the CPU.

The caption and title fonts (Montserrat, Anton, Bebas Neue, Poppins, Archivo Black, Bangers,
Oswald, Inter) are bundled in `backend/app/fonts` under the SIL Open Font License. The preview
and the final render use the same font files, so text looks the same in both.

### Projects

Projects save themselves about a second after every change, to
`projects\<id>\project.json`. Click the project name in the top bar to rename it, start a
**New project**, or **Open** an earlier one. The app reopens your last project on start.

## Media library

Everything you download or import goes into one **library** that all your projects share, so a
clip downloaded once can be used in any number of videos. It lives in `library\` in the app
folder (`LIBRARY_DIR` in `.env` moves it): `library.json` lists the clips, `clips\` holds the
files and `thumbs\` the thumbnails. Each clip records:

- where it came from: `pixabay`, `pexels`, `upload` (your own files) or `ai` (shots the app
  makes itself, coming with "Generate shot"), and an **AI-generated** flag;
- its resolution and length. Clips narrower than 1080 pixels are marked **Low res**: they are
  scaled up to fill the 1080×1920 frame and can look soft (AI clips are often 448×832);
- for Pixabay videos, the video id, its page URL and the uploader; for Pexels videos, the video
  id, its page URL and the photographer. Both are shown as a credit.

Tick or untick **AI-generated** on any library card to change the flag later. **+** puts a
clip in the first gap on the timeline; you can also drag a card onto the video track. The
trash button deletes a clip from the library (and from your PC); if a project uses it, the app
asks first and leaves a gap where it was.

Every way into the library goes through one backend function,
`Library.add_clip(file, source, metadata)` in `backend/app/library/store.py`. It reads the file
with ffprobe, converts it to H.264 if the browser can't play it, makes a thumbnail and records
the source. The coming "Generate shot" button will save ComfyUI results through it too.

### Stock footage (Pixabay, Pexels)

Type a few words under **Stock footage** and press **Search**. **Portrait**, **Landscape** and
**Any** filter the results (portrait by default; with Any, portrait videos are listed first);
each result is labelled Portrait or Landscape, and wide videos are cropped to 9:16 on the
timeline. Hover a result to preview it. **Add** downloads it into the library: the smallest
file that covers the whole 1080×1920 frame without being scaled up, which means the 1080×1920
file of a portrait video (its 4K file looks the same in a 1080p Short and is about four times
bigger) and the 4K file of a landscape video, so its 9:16 crop stays sharp. It is always at
least 1080 pixels wide when the source has such a file. The same rule applies to both sources.

**Pixabay** follows Pixabay's API rules:

- It can't filter videos by orientation, so the app works it out from each video's width and
  height. It reads Pixabay's results 200 at a time (Pixabay returns at most 500 per search)
  until it has a page of matches, so "Portrait" may show fewer results than Pixabay has videos.
- Every answer is cached for 24 hours (in `data\cache\pixabay`): searching the same words
  again, or switching the orientation filter, doesn't ask Pixabay again.
- Videos are downloaded into the library rather than linked to, and the results say they come
  from Pixabay. Search uses Pixabay's safe search.
- The rate limit (100 requests a minute by default) is read from Pixabay's `X-RateLimit-*`
  headers. Once it's used up, the app stops asking, the Media tab says when you can search
  again, and **Search** shows a countdown. Searches you've already made still work.

If a key is missing, or the source refuses a request, the Media tab shows the reason (no key,
key rejected, rate limit used up, no connection). Pexels keys allow 200 requests an hour.

### Your own clips (and ComfyUI)

Drop video clips or images on **Your files**, or click it to choose them (MP4, MOV, WebM,
MKV, AVI, GIF, JPG, PNG, WebP). Before importing, each file has an **AI-generated** checkbox. It
is ticked for you when the name looks like a ComfyUI output, such as `LTX_2_5_t2v_00017_.mp4`
or `ComfyUI_00001_.png` (a 5-digit counter with a trailing underscore), or `AnimateDiff_00003.mp4`
(Video Combine) with a video-model name in it. Files the browser can't play (HEVC, ProRes, AVI,
…) are converted to H.264 once, on import; phone videos filmed upright stay upright.

### Generate shot (AI clips with ComfyUI)

**Generate shot** in the Media tab makes video clips from a prompt with LTX-2.5 in
[ComfyUI](https://www.comfy.org/) on your PC, and saves them into the library. The app talks to
ComfyUI from the backend; the browser never does.

1. Open ComfyUI Desktop and leave it running. The Media tab shows **ComfyUI connected** (or
   explains that ComfyUI needs to be open; the button stays disabled until it is).
2. If ComfyUI isn't on `http://127.0.0.1:8188`, set its address in `.env`, e.g.
   `COMFYUI_URL=http://127.0.0.1:8000` (ComfyUI Desktop uses port 8000 unless you change it;
   the Media tab says so when it finds ComfyUI there instead).
3. Click **Generate shot**, describe the shot, and pick its length (2 to 5 seconds), quality
   (**Draft**: 0.4 megapixels, about 480×864; **Final**: 0.8 megapixels, about 672×1200) and how
   many **variations** (1 to 4, each with its own random seed). Shots are always 9:16 at 24 fps.

Each clip takes about 3 to 5 minutes. The variations go into ComfyUI's queue and the **Shots**
list shows each one's place in the queue, its progress (which sampling pass and step) and the
time it has been running. **Cancel** removes a waiting shot from ComfyUI's queue or stops the
running one. The list lives in the backend (`data\generations.json`), so reloading the page,
or even restarting the app while ComfyUI keeps working, loses nothing.

A finished shot is downloaded from ComfyUI and added to the library (not the timeline, since
you'll usually pick one of several variations), marked AI-generated, with LTX's generated
sound kept in the file (clip audio is muted on the timeline unless you turn it on). Its library
card shows the prompt, with:

- **Copy prompt**;
- **Generate again**: the same prompt and settings with a new seed;
- **Final quality** (on Draft clips): the same prompt and seed at 0.8 megapixels. The result
  won't match the draft exactly, because a different resolution changes the video even with
  the same seed.

The clip also stores its seed, quality, resolution, length and the workflow file it came from.

The Scenes tab's **previews** and **finals** are made by these same jobs (see [Scenes](#scenes)).
They aren't in the Shots list (the Scenes tab shows them, and **Clear finished** leaves them
alone). The library hides previews unless you tick **Scene previews** above it; finals are listed
like any clip. A scene preview's card doesn't offer **Final quality**: its final is made in the
Scenes tab, from the preview itself.

**The workflow.** `comfy\ltx_t2v_api.json` is the LTX-2.5 text-to-video workflow exported
from ComfyUI with *Workflow → Export (API)*. The app changes only these inputs, listed in one
place (`backend/app/comfy/workflow.py`):

| Setting | Node (found by type and title) |
| --- | --- |
| Prompt | the *Prompt* text node (`PrimitiveStringMultiline`) |
| Seed | the `RandomNoise` of the first sampling pass (the one starting from the empty latent); the refine pass keeps its own seed |
| Quality | `ResolutionSelector`: megapixels 0.4 or 0.8, aspect ratio 9:16 |
| Length | the *Duration* number (seconds); the workflow turns it into frames |
| Frame rate | the *Frame Rate* number, always 24 |
| Result | the `Save Video` node |

To use a changed workflow, export it the same way over `comfy\ltx_t2v_api.json` (or point
`COMFYUI_WORKFLOW` in `.env` at another file). If one of those inputs can't be found, the Media
tab names what's missing; if ComfyUI rejects the workflow (for example a model file that isn't
installed), it shows ComfyUI's reason.

**Scene previews and finals** are made from the same workflow file, rewired by the app (nothing
else to export). LTX-2.5 samples twice: a first pass at half the size, then the
`LTXVLatentUpsampler` doubles that latent and a refine pass sharpens it. So:

- a **preview** runs only the first pass of a Final-quality (0.8 megapixel) shot, decodes it with
  the workflow's own decoders, and saves its video and audio latents with two added `SaveLatent`
  nodes (plus a *Preview as Text* of the exact prompt text, in case the prompt enhancer rewrote it).
  The app downloads the latents and keeps them with the preview's clip in the library
  (`library\latents`);
- its **final** sends those latents to ComfyUI's input folder (the same upload ComfyUI's own image
  loader uses), puts two `LoadLatent` nodes in place of the first pass, and runs only the upscale
  and refine passes, reading the same prompt text.

So a final is exactly what the whole workflow would have made from that preview's first pass, at
twice its width and height, not a new video. The refine pass keeps the workflow's own seed; only
**Regenerate final** gives it a new one. The two passes are found by how the nodes are connected
(a `SamplerCustomAdvanced` starting from *Empty LTXV Latent Video*, then *Separate AV Latent*,
the upsampler, the refine sampler and its *Separate AV Latent*); a workflow without them still
makes ordinary shots, and the Scenes tab says why finals couldn't match previews made with it.

### Auto-fill

**Auto-fill from script** picks search words from each sentence (its nouns, with compounds
like "airplane window" kept together, using spaCy), finds a video for each sentence on the
source chosen in the Media tab (Pixabay or Pexels, whichever has a key; portrait videos first)
and places it on the timeline from the moment that sentence starts. With captions it
uses their word times; otherwise it spreads the sentences over the voiceover by word count.
Very short sentences share a clip with their neighbour, a sentence with no match is covered by
the clip before it, and a clip shorter than its sentence plays slower. It replaces the clips on
the timeline (after asking); **Undo** brings them back.

## Timeline

- **Video track.** Drop clips from the library anywhere on it. Dropped in a gap, a clip fills
  the gap (as far as its footage goes); dropped on another clip, it goes before or after it and
  pushes later clips along just enough to make room.
- **Move and reorder.** Drag a clip into empty space to move it. Drop it on another clip to swap
  their order: the clips in between shift over, and the cuts outside that stretch stay where
  they are.
- **Trim.** Drag either edge of a clip. A clip can't use more footage than it has.
- **Snapping.** Edges snap to the start and end of every word and caption, to other clips, to
  the playhead and to the start and end of the video, so cuts land on the voiceover. A label
  shows what it snapped to. Hold **Alt** while dragging to place freely.
- **Length.** The video is as long as the voiceover. Stretches with no clip are hatched on the
  track (and black in the video); clips past the end of the voiceover are dimmed and left out.
- **Split** cuts the clip at the playhead, **Delete** (or the Delete key) removes the selected
  clip, and **Fit to voiceover** closes every gap and ends the last clip with the voiceover. It
  keeps your cuts: each clip runs until the next one starts, using more of its footage, and
  plays slower if it runs out. **Undo/Redo** (Ctrl+Z, Ctrl+Shift+Z) cover all clip edits,
  every ranking change and every scene change, in the order you made them.
- **9:16 crop.** A clip fills the 1080×1920 frame and is cropped. Select a clip and use
  **Crop position** in the **Clip settings** card beside the preview (left–right for wide
  clips, top–bottom for tall ones), or drag the picture in the preview. On a narrow window the
  clip settings move to the timeline toolbar. Images can be any length.
- **Fit inside.** For a clip that isn't 9:16, **Frame** in **Clip settings** switches between
  **Fill** (cropped, as above) and **Fit inside**: the whole picture shows, as large as fits,
  with the background from the **Canvas & title** tab around it. Its timeline clip shows a
  **Fit** badge. Split keeps the setting, and Undo covers it.
- **Clip audio** is muted. In **Clip settings**, click **Muted** to keep its sound under the
  voiceover (useful for sound effects in AI clips), with its own volume. You can also change a
  clip's speed there.
- **Preview.** Play shows the clips, voiceover and captions together, kept in step with the
  voiceover.

## Canvas & title

- **Background** fills the frame around clips set to **Fit inside**: a **blurred** copy of the
  clip (the strength is the blur radius in frame pixels) or a **solid colour**. Clips set to
  Fill cover it, and stretches with no clip stay black.
- **Title**: an optional headline at the top of the video (from 150 pixels down, below
  YouTube's own buttons), with its font, size and colour, and a full-width **background bar**
  in its own colour (without the bar, the text gets an outline). Show it for the **whole
  video** or for its **first seconds** (1 to 15). Long titles wrap onto more lines.

Captions, the title and the ranking are drawn over the clips in the preview, captions on top.
Their positions are shared numbers (`frontend/src/features/preview/captionLayout.ts` and
`frontend/src/features/canvas/overlayLayout.ts`) so the render places them the same way.

## Scenes

The **Scenes** tab cuts the video into scenes, each with its own picture: an AI clip made by
ComfyUI, or stock footage from Pixabay. The scenes are cut by rules; you type each scene's visual
description, prompt and search text, or have a language model on your PC write them (see
[Write scenes with AI](#write-scenes-with-ai)).

- **Create scenes from script** cuts the narration at sentence ends, then, where a sentence is
  too long, at commas or pauses, so that every scene is **2 to 5 seconds** long (LTX clips fall
  apart beyond about 5 seconds). A sentence too short for a scene of its own is grouped with a
  neighbour; only when no comma or pause works is a sentence cut between other words. The scenes
  run from the start of the video to its end with no gaps. Times come from the captions' words
  when there are captions (and they aren't out of date); otherwise the script's words are spread
  over the voiceover, or over its estimated length (155 words a minute) without one, as Auto-fill
  does. When scenes already exist it asks first, and Undo brings the old ones back.
- **Each scene** has its number, start and end, its **narration** (the words in its time, from the
  captions or the estimate), a **source** (AI, Stock or None), a **visual description**, the
  **ComfyUI prompt** (shown for AI scenes) and the **stock search text** (shown for Stock scenes).
- **Times** work like ranking entries: type a start or end (`0:03.04` or `3.04`; Enter applies,
  Escape cancels), or drag a scene's edges on the **Scenes** track of the timeline. Edges snap to
  words, caption changes, clip edges, the playhead and the ends of the video (hold Alt to place
  freely). Scenes never overlap. An edge a scene shares with the next one moves both, so the cut
  stays where they meet; hold Shift while dragging to move only this scene's edge. A time that
  can't be used (not a time, an end before the start, a scene under 0.5 s, an overlap) changes
  nothing and says why. Click a scene on the track to open it in the Scenes tab.
- **Split** cuts a scene at the playhead (when it's inside the scene), else at the word nearest
  its middle; the first part keeps the scene and its previews, the second copies its texts.
  **Merge** joins a scene with the next one. **Add scene** puts a 3-second scene at the playhead
  (or in the first free time). **Delete** removes a scene.
- **Undo/Redo** (the timeline's buttons, Ctrl+Z and Ctrl+Shift+Z, also from inside the scene
  fields) cover every scene change, including typing (as one step per field), "Use this" and
  placing stock footage, in one history with the clip and ranking edits.

### Stock scenes

**Find footage** searches Pixabay for the scene's search text (portrait videos first). **Use** on a
result downloads it into the library, as Add does in the Media tab, and puts it on the timeline
over exactly the scene's time, in place of what's there: clips inside are removed and clips across
its edges trimmed. Footage shorter than the scene plays slower (down to quarter speed). Undo takes
it off again.

### AI scenes

- **Previews** (1 to 4, 2 by default) is how many **Generate previews** makes. They're Generate
  shot jobs, each with its own random seed, as long as the scene rounded up to whole seconds (2 to
  5). Each is the first pass of its final, at half the final's width and height (about 320×608),
  so its final matches it (see [the workflow](#generate-shot-ai-clips-with-comfyui)). Generating
  again adds more; previews are only removed when you delete them (the trash button, which also
  deletes the clip and its saved first pass from the library).
- Each scene lists its previews with their seed and state: **Queued**, **Generating** (with the
  job's real progress), **Completed**, **Failed** or **Cancelled**, and a status line per running
  preview, e.g. "Scene 3: preview 2 of 2, seed 123456, 62%", with ComfyUI's own step message under
  it. Nothing is estimated.
- **Use this** picks the scene's preview; the chosen one is highlighted, and you can pick another
  at any time. **Cancel** stops one that's waiting or running.
- A failed preview shows ComfyUI's error and **Retry**, which makes only that preview again, with
  the same prompt, seed and length. Nothing else in any scene changes.
- Previews are saved through `Library.add_clip` with source `ai`, AI-generated, and with their
  prompt, seed, project id, scene id and type `preview` in the clip's `generation` metadata.
- Undoing, deleting, merging or recreating scenes never removes a preview: a preview whose scene
  is gone is listed under **Previews from removed scenes** (Undo brings the scene back with them).

**Finals.** Once a scene has a chosen preview, **Generate final** makes its final from that
preview itself (its first pass, upscaled and refined), so it's the same shot at the Final size,
about 640×1216. Afterwards the button is **Regenerate final**: the chosen preview again (another
one, if you've changed your choice; the card says when the final is from a different preview)
with a new refine seed, for the same shot with small differences in detail. Neither changes any
other scene. The final shows its state and progress like a preview; a failed one shows ComfyUI's
error and **Retry** (the same preview and refine seed). Earlier finals stay in the library.
Finals are saved through `Library.add_clip` with source `ai`, AI-generated, and type `final`, the
project and scene ids, the preview they came from (`previewItemId`, `previewShotId`) and the refine
seed in the clip's `generation` metadata.

Previews made before this (part A) have no saved first pass, so a final made from one would be a
different video. Such a preview says so, and when it's the chosen one, the scene says so and
**Generate final** stays off: generate new previews and choose one of those.

**All scenes at once.** The **AI scenes** section above the scene list has:

- **Generate all previews**: previews for every AI scene that has none (a scene without a prompt
  shows that instead, with Retry).
- **Generate all finals**, available once every AI scene has a chosen preview: a final for each
  scene that has none from its chosen preview (scenes whose final is made or being made are left
  alone). Neither button chooses a preview for you.
- A **progress panel** listing each scene with its state (queued and how many are ahead,
  generating with its percentage, completed, failed) and a **total** percentage over every job.
  A scene that fails shows its error and a **Retry** for that scene only; the others keep going.
  A scene's own Generate previews or Generate final joins the panel while it's running; once
  everything has finished, **Close** clears it. All the jobs go through the same Generate shot jobs
  and ComfyUI's queue, which makes them one at a time.

**On the timeline.** A finished final has **Add to timeline**, and **Add all to timeline** adds
every finished final that isn't on the timeline yet. Each goes over exactly its scene's start and
end, in place of what's there (as stock footage does; a final shorter than its scene plays slower).
If clips are already in a scene's time, it asks first: for one scene, whether to replace them; for
Add all, whether to replace them or only fill the scenes that are empty. A final already on the
timeline is never added again (its card says **On the timeline**). Each Add is one undo step,
however many finals it places.

### Write scenes with AI

A language model running on your PC can fill in the scenes for you: for each one it suggests the
**source** (AI or Stock), a **visual description**, the **stock search text** and the **ComfyUI
prompt**. Any server with the OpenAI API works; [LM Studio](https://lmstudio.ai/) and
[Ollama](https://ollama.com/) are the two the app knows best. A small instruction-following model,
such as Qwen3 8B, is a good place to start.

**Setting it up**

1. **LM Studio**: download a model, then start the server (*Developer* → *Start server*; it listens
   on `http://127.0.0.1:1234`). **Ollama**: `ollama pull qwen3:8b`; Ollama's server runs on
   `http://127.0.0.1:11434`.
2. In `.env`, set the address and the model's name exactly as the server lists it, then restart the app:
   ```ini
   LLM_URL=http://127.0.0.1:1234/v1        # Ollama: http://127.0.0.1:11434/v1
   LLM_MODEL=qwen/qwen3-8b                 # Ollama: qwen3:8b
   ```
3. The Scenes tab's **Write with AI** section shows **Language model connected** with the model and
   the server, or why it isn't (no server, `LLM_MODEL` not set, a model the server doesn't list). If
   nothing answers at `LLM_URL` but LM Studio or Ollama answers on its usual port, it says so.

**Sharing the GPU with ComfyUI.** The language model and ComfyUI use the same GPU, and running both at
once can run out of video memory or slow both to a crawl, so they take turns:

- While ComfyUI has anything in its queue (the app's previews and finals, or a job started in ComfyUI
  itself), **Write scenes with AI** and **Rewrite prompt** wait and say why. The backend checks
  ComfyUI's queue again just before the model starts.
- When ComfyUI is idle, it's asked to unload its models first (its `/free` API, what ComfyUI's own
  *Unload models* button does). A ComfyUI from before 2024 can't be asked; the result says so.
- After every run, the server is asked to unload the model: LM Studio 0.4 and newer
  (`/api/v1/models/unload`) and Ollama (`keep_alive: 0`). Other servers (and older LM Studio) keep it
  loaded, and the app says so.
- While the model writes, **Generate shot**, previews and finals wait for it, saying why.

**Write scenes with AI** (once there are scenes) sends the script and every scene, with its narration
and the times of its words, to the model a few scenes at a time (so a long video fits a small
context window), with the prompt rules from `prompts/ltx_guide.md`. The progress bar follows the
model's answer as it streams in ("Writing scene 4 of 9…").

- **Structured answers.** The model answers in JSON that follows a schema (servers that can't enforce
  a schema get plain JSON mode). Every answer is checked: each scene present once, a source of AI or
  Stock, no empty text, and no prompt too short to describe a shot (under 12 words) or copied from
  the guide's example (small models do both). An answer that can't be used is sent back once with
  what's wrong; if the second one can't be used either, nothing changes and the error shows **what
  the model wrote** (both answers). An answer cut short because the model ran out of context says
  how to give it more.
- **Your edits are kept.** A field counts as yours when it isn't empty and isn't what the AI last wrote
  there (the app remembers that per field), and a source counts as yours when you picked another
  one. Those are never overwritten without asking: the model is told you wrote them, and when it has
  other text for one, a dialog shows yours and its own (**Keep mine** is preselected). Fields you
  edit while it's writing are treated the same way. Clear a field to let the AI fill it again.
- **Merging and splitting.** The model may suggest merging a scene with the next or splitting one in
  two, with a reason. The app only offers a change if every scene it makes is **2 to 5 seconds**
  long, and a split always cuts where a word starts (by the captions' word times, or the estimate
  without captions). The dialog lists each one with a tick box (a merge that would replace text you
  wrote in the second scene starts unticked), and what was left out and why.
- Closing the dialog keeps the answer: **Review** opens it again. **Discard** throws it away.
- When there's nothing to ask, the text goes straight in. Either way it's **one undo step**.

**Rewrite prompt** (beside each AI scene's ComfyUI prompt) asks the model for that scene's prompt
alone, from its narration, its description, the current prompt and what the scenes around it show.
If the prompt has your own text, it asks first. Undo brings the old prompt back.

**The prompt guide.** `prompts/ltx_guide.md` holds the rules the model writes prompts by. Edit it to
improve them: it's read at every run, so no restart is needed (comments `<!-- … -->` are notes for
you and aren't sent). It starts with rules learned from testing LTX-2.5: one flowing paragraph in
present tense, describing the shot in the order things happen; the shot type, and a still camera
unless movement matters; an end state, so the clip doesn't drift; one clear action per shot; what
should be seen rather than negations; materials and shapes named precisely; no words like shatter,
burst or debris unless that's the action; a short description of the sound; a vertical 9:16
composition. `LTX_GUIDE` in `.env` points at another file.

### Saved with the project

Scenes, their times and texts (and what the AI last wrote in each field), each preview's seed,
prompt and last job state, the chosen
preview, each final (its preview, refine seed and last job state) and the progress panel are
saved in `project.json`; the clips themselves stay in the library and the project only
refers to them by id. The project keeps following the jobs, so a preview or final that finished
while the app was closed shows up when you open it again (found by its job id in the library if the jobs
list no longer has it). Projects saved before scenes open with no scenes; nothing else changes,
so the project version stays the same.

## Ranking

The **Ranking** tab is for countdown videos like "Top 5 …". Each entry shows a big rank number
("#3") and its label at the top of the video during its own stretch of time, under the title if
there is one.

- **Add entry** times the new entry to the selected clip's span, or else the sentence under the
  playhead (from the captions), or else a few seconds from the playhead. Entries never overlap,
  so a new entry is trimmed to the time no other entry uses. **Set time** on an entry does the
  same for an existing one.
- **Type an entry's start and end** in its two time fields, as minutes and seconds (`0:03.04`)
  or as seconds (`3.04`). **Enter** applies (so does leaving the field) and **Escape** cancels.
  A time that isn't one, an end before the start, an entry shorter than 0.2 s or a time that
  overlaps another entry changes nothing and says why under the entry. To move an entry later
  past its own end, change the end first.
- **Drag an entry's edges** on the **Ranks** track to change when it shows. Edges snap to words,
  caption changes, clip edges, the playhead and the ends of the video (hold Alt to place freely),
  and stop at the next entry. Click an entry to open the Ranking tab.
- Entries are listed **in the order they play**. Drag them by the handle, or use the arrows, to
  reorder. **Count down** numbers the first entry #N and the last #1; **Count up** starts at
  #1. Click an entry's number to show it in the preview.
- **Look**: the font, the number's size (the label is about a third of it) and the colours of
  the number and the label.
- **Warnings** in the list: an entry without a time yet, and an entry that starts before the one
  above it, so the count would run out of order.
- **Undo/Redo** (the timeline's buttons, Ctrl+Z and Ctrl+Shift+Z) cover every ranking change:
  adding, removing and reordering entries, labels (typing undoes as one step), times (typed or
  dragged), the count's direction, turning it on or off and the look. Ctrl+Z works anywhere in
  the Ranking tab, the label fields included; in a time field you're typing in, it undoes the
  typing first.

Entries keep their times whatever happens to the clips: Auto-fill, Delete, Split, Fit to
voiceover and moving clips never change them. Projects saved before this linked each entry to a
clip; opening one gives each entry its clip's span, so the video looks the same.

### AI disclosure

When a project's timeline contains a clip flagged AI-generated, the top bar says **Contains AI**
(with the number of clips) and the **Open project** list marks the project. YouTube asks you to
disclose realistic AI-generated or altered content when you upload; the finished render
reminds you. The flag is stored once, on the library clip, so changing it there updates every
project that uses the clip. The backend answers the same question for any saved project at
`GET /api/projects/<id>/disclosure` (`app/library/usage.py`, `ai_clips`), and the render asks
it too.

## Render

**Render** in the top bar makes the final video with FFmpeg: 1080×1920 H.264 (yuv420p) with
AAC audio at 48 kHz, ready to stream (faststart). It's saved as
`exports\<project name>\<project name>.mp4`; rendering again adds `(2)`, `(3)`, ... so earlier
videos are kept. Set `EXPORTS_DIR` in `.env` to put them somewhere else.

- **Checks first.** Before it starts, the dialog lists anything worth knowing: gaps in the
  timeline (they render black), clips that run past the end of the voiceover (cut off),
  out-of-date captions, missing media, low-resolution clips that will be scaled up, and a
  video longer than 3 minutes (the Shorts limit). They're warnings: **Render anyway** goes ahead.
- **Quality.** **Best quality** is libx264 at CRF 18 on the CPU. **Fast (GPU)** uses AMD's
  hardware encoder (h264_amf); it's only offered when your FFmpeg has it and a test encode
  works, which the backend checks once when it starts.
- **Frame rate.** Clips with different rates (24, 25, 30 fps) are converted to one: 30 fps,
  unless every clip shares another standard rate (then that one, e.g. 25 fps).
- **Matches the preview.** Trims, speed, the Fill crop, Fit inside over the blurred or solid
  background, the title (and its time limit), ranking overlays with their times, captions with
  the spoken-word highlight, the voiceover, music and clip audio at their volumes. The text is
  drawn by the preview's own code with the same font files, one transparent image per change
  (a new word, rank or title), and FFmpeg lays each image over exactly its frames, so a caption
  can't wrap differently in the video. Colours follow the browser too: a video with no colour
  information is read as BT.709 when it's HD, as browsers do.
- **In the background.** A progress bar, the elapsed time and **Cancel render** (which deletes
  the half-made file). You can close the dialog and keep working; the Render button shows the
  progress. When it's done: **Play** opens it in your video player, **Open folder** shows it in
  Explorer, and if the video contains AI-generated clips you're reminded to mark it as altered
  or synthetic content when you upload it to YouTube.

## Installing FFmpeg

`winget install --id Gyan.FFmpeg -e` is the easiest way. To install it by hand instead:

1. Download `ffmpeg-release-essentials.zip` from <https://www.gyan.dev/ffmpeg/builds/>.
2. Extract it to `C:\ffmpeg`, so that `C:\ffmpeg\bin\ffmpeg.exe` exists.
3. Add `C:\ffmpeg\bin` to your PATH: press Start, type **environment variables**, open
   **Edit the system environment variables** → **Environment Variables…** → select **Path**
   under *User variables* → **Edit** → **New** → `C:\ffmpeg\bin` → **OK**.
4. Open a new terminal and check it works:
   ```powershell
   ffmpeg -version
   ```

## Tests

```powershell
npm test
```

runs the backend test suite with pytest (`npm test -- -k projects` passes arguments through).
It covers the text normalization, phonemes (including the RX 9060 XT sentence), the Kokoro
engine and its DirectML-to-CPU fallback, voiceover and music uploads, caption alignment, the
media library (imports, conversion, the AI flag, deleting, AI disclosure), Pexels and Pixabay
search and downloads against fake APIs (no keys or network needed), including Pixabay's 24-hour
cache, rate limit and orientation filter, Auto-fill and which source it uses, and, once the models
are downloaded, real speech generation and a Kokoro → Whisper → captions round trip. Generate
shot is tested against a fake ComfyUI server (its HTTP and websocket API): the workflow mapping
on the real `comfy\ltx_t2v_api.json`, submitting variations, queue positions, live progress,
saving finished shots to the library, failures, cancelling, a lost job, an unreachable ComfyUI
and picking up jobs again after a restart, plus scene previews: their seeds, saving them with
their project and scene, Retry rerunning only the failed one, and Clear finished leaving them.
Write scenes with AI is tested against a fake language model server (answering as LM Studio, Ollama or
a plain OpenAI-compatible server) and the fake ComfyUI: a valid answer, an invalid answer then a valid
one, two invalid answers (the raw output comes back), a server error, edited fields kept, merges and
splits held to the 2 to 5 second rule and cut on word times, long videos sent a few scenes at a time,
plain JSON mode for servers without schemas, nothing running while ComfyUI has jobs and ComfyUI
waiting while the model writes, ComfyUI freed first and the model unloaded after, Rewrite prompt, and
the guide read at every run. The render tests render small projects with real
FFmpeg and check the MP4: length, size, frame rate (mixed 24/25/30 fps → 30, all 25 → 25),
codecs, 48 kHz audio and clip audio, faststart, and the picture at chosen frames (the Fill crop,
Fit inside over a solid and a blurred background, gaps, trims, speed, overlays at exactly their
frames), plus the checks, file names, cancelling and the render API.
`npm run test:frontend` runs the frontend unit tests (caption grouping and layout, the
out-of-date check, every timeline edit, snapping, undo, the 9:16 crop and Fit inside, the title
and ranking layout, rank numbers, warnings and time ranges, typed times, undo and redo of every
ranking change, upgrading older projects (clip links to times), Auto-fill timing and the
ComfyUI file-name check, and for scenes: creating and grouping them with and without captions,
dragged and typed times, split, merge, add and delete, undo and redo of every scene change,
saving and opening older projects, placing stock footage, and generating, following, choosing,
retrying and deleting previews, and Write scenes with AI: which fields count as yours, applying the
answer with your choices, edits made while it writes, merges and splits, and Rewrite prompt). `npm
run test:e2e` drives the real frontend in Chromium against a
fake backend: dragging a clip onto the timeline and playing it, reordering, trimming,
splitting, the crop control, Pexels and Pixabay results, the source switch, the rate-limit
countdown, imports with the AI flag, and Generate shot (the dialog, the jobs list across a
reload, cancelling, and an AI clip's Copy prompt, Generate again and Final quality), Fit inside
over a solid and a blurred background, the title bar and its timing, and ranking entries (timing
from the selection and the sentence, dragging and snapping edges, typed times and their
messages, Undo and Redo of ranking edits from the buttons and the keyboard, clip edits leaving
them alone, reordering, warnings, the overlay in the preview, saving), scenes (creating them
with and without captions, asking before replacing them, typed and dragged times with snapping,
split, merge, add, delete and undo, AI previews with their status lines, choosing, Retry, and
saving across a reload, the library filter, Find footage on Pixabay, Write scenes with AI with its
review dialog, merges, the raw output of a failed answer, Rewrite prompt and the GPU shared with
ComfyUI), and the render dialog
(warnings, quality choice, progress, cancel, the finished screen) (on a new machine, first
run `npx playwright install chromium` once inside the `frontend` folder).
`npm --prefix frontend run test:render` renders a project for real (the backend, FFmpeg and
Chromium) and compares frames of the MP4 with the preview canvas at chosen times: the whole
picture, the rank number and the highlighted caption word must be where the layout puts them
and where the preview drew them. CI runs the tests on the newest Python (3.14) only and keeps
the pronunciation samples as a downloadable artifact, plus a lint and type-checked build of
the frontend.

## Project layout

```
backend/                FastAPI app (Python)
  app/core/             settings, logging, errors, health, background jobs, FFmpeg helpers
  app/projects/         project storage (projects/<id>/project.json, media/ next to it)
  app/voiceover/        Kokoro engine, text normalization, G2P, voice catalog, uploads
  app/voiceover/misaki/ vendored misaki English G2P (Apache 2.0)
  app/captions/         faster-whisper transcription, script alignment, caption job
  app/fonts/            caption/title fonts (OFL) shared by preview and render
  app/pronunciations/   the app-wide pronunciation list (data/pronunciations.json)
  app/library/          the shared media library: add_clip, imports, AI disclosure
  app/pexels/           Pexels search and downloads
  app/pixabay/          Pixabay search (24-hour cache, rate limit) and downloads
  app/comfy/            Generate shot: the ComfyUI workflow mapping, client and jobs
  app/llm/              Write scenes with AI: the language model client, the writer, GPU sharing
  app/stock/            what both share: the file choice, orientation, downloads
  app/autofill/         search words per sentence and one clip per sentence
  app/mix/              background music
  app/render/           the final render: plan and checks, FFmpeg command, encoders, API
  tests/                pytest suite
frontend/               React + TypeScript + Vite
  src/components/ui/    shared controls (buttons, tabs, sliders, alerts, ...)
  src/features/         one folder per feature: script, voiceover, mix, media, library, generate,
                        scenes, ranking, captions, canvas, preview, render, timeline, projects,
                        topbar
  src/layout/           left and right side panels
  src/state/            project document, autosave, editor UI state
  src/styles/global.css design tokens; change --accent to re-theme the app
  e2e/                  end-to-end tests (Playwright, fake backend)
  e2e-render/           the render test with the real backend and FFmpeg
comfy/                  the ComfyUI workflow for Generate shot (API format)
prompts/                ltx_guide.md: how the language model writes ComfyUI prompts (edit it)
scripts/                setup.mjs, dev.mjs, test.mjs (plain Node, no dependencies)
projects/               your saved projects (not committed)
library/                the media library shared by all projects (not committed)
data/                   app-wide data, e.g. the pronunciation list (not committed)
exports/                finished videos, one folder per project (not committed)
```

## Troubleshooting

- **"ComfyUI isn't running"** while it is: check the address ComfyUI shows (ComfyUI Desktop:
  Settings → Server Config, port 8000 by default) and set `COMFYUI_URL` in `.env` to match,
  then restart the app.
- **"Language model isn't running"**: start LM Studio's server (*Developer* → *Start server*) or
  Ollama, check `LLM_URL` and `LLM_MODEL` in `.env`, restart the app, then click the ↻ next to
  the status.
- **"It ran out of room before finishing"**: the model's context is too small for its answer. In
  LM Studio, raise *Context Length* when loading the model (8192 is plenty); for Ollama, set
  `OLLAMA_CONTEXT_LENGTH=8192` and restart it.

- **"Python 3.12 or newer was not found"**: install Python (above), open a new terminal,
  run `npm run setup` again.
- **Setup used the wrong Python**: delete the `backend\.venv` folder and run
  `npm run setup` again; it prefers 3.14, then 3.13, then 3.12.
- **The page says the backend is not running**: check the `[api]` lines in the terminal
  for the error. The page reconnects by itself once the backend is up.
- **`ffmpeg` is not recognized**: FFmpeg is not on PATH yet. Open a new terminal after
  installing, or follow the manual steps above. Uploads and recordings need it.
- **"Microphone access was blocked"**: click the icon left of the address bar, allow the
  microphone for 127.0.0.1, and try again.
- **The Kokoro download failed**: run `npm run setup` again (or click Generate AI read). Each
  file's checksum is verified, so a broken download is never used.
- **The Whisper download failed**: run `npm run setup` again (or click Generate captions). It
  comes from Hugging Face, so that site must be reachable.
- **Pixabay or Pexels says the key was rejected**: check `PIXABAY_API_KEY` or `PEXELS_API_KEY`
  in `.env` (no quotes or spaces) and restart the app; `.env` is read when the app starts.
- **An imported clip takes a while**: files the browser can't play (HEVC, ProRes, AVI, …) are
  converted to H.264 on import; the progress bar shows how far along it is.
- **A clip on the timeline says "Missing clip"**: it was deleted from the library. Delete it
  from the timeline or drop another clip in its place.
- **Keyboard**: Space plays/pauses the preview, Delete removes the selected clip, Ctrl+Z and
  Ctrl+Shift+Z (or Ctrl+Y) undo and redo clip, ranking and scene edits. In a text field outside
  the Ranking and Scenes tabs they undo your typing instead.
