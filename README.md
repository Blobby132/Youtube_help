# Shorts Creator

A local web app for making vertical YouTube Shorts (1080×1920, 30 fps) from a script.
It runs entirely on your PC: a React + TypeScript + Vite frontend and a Python FastAPI
backend for the heavy work. Everything is free: no paid APIs, no credits.

- **AI voiceover** with [Kokoro TTS](https://huggingface.co/hexgrad/Kokoro-82M), running locally
- **Word-timed captions** with [faster-whisper](https://github.com/SYSTRAN/faster-whisper), running locally
- **Stock footage** from [Pexels](https://www.pexels.com/api/) (free API key)
- **Final render** with FFmpeg

## Build status

The app is built in stages. Each stage is tested before the next one starts.

| Stage | What | Status |
| --- | --- | --- |
| 1 | Project setup, full layout, autosaved projects | ✅ done |
| 2 | Script panel and voiceover (Kokoro AI read, record, upload) | ✅ done |
| 3 | Captions with faster-whisper and caption preview | ✅ done |
| 4 | Media tab (Pexels and uploads) and timeline | ✅ done |
| 5 | Canvas & title, Ranking tab | next |
| 6 | FFmpeg render | |

Working now: the full layout, autosaved projects, the script box, all three ways to make a
voiceover (AI read, recording, upload) plus background music, word-timed captions, a media
library shared by all projects (Pexels search, your own clips and images, Auto-fill), and a
timeline whose clips, voiceover and captions play together in the preview. Render (stage 6)
is shown but disabled.

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

### Pexels API key

Stock search needs a free key: sign up at <https://www.pexels.com/api/>, then open `.env`
in the project folder and paste it in:

```ini
PEXELS_API_KEY=your-key-here
```

The key stays on your PC. It is read by the backend only and never sent to the browser.

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

- where it came from: `pexels`, `upload` (your own files) or `ai` (shots the app makes itself,
  coming with "Generate shot"), and an **AI-generated** flag;
- its resolution and length. Clips narrower than 1080 pixels are marked **Low res**: they are
  scaled up to fill the 1080×1920 frame and can look soft (AI clips are often 448×832);
- for Pexels videos, the video id, its page URL and the photographer, shown as a credit.

Tick or untick **AI-generated** on any library card to change the flag later. **+** puts a
clip in the first gap on the timeline; you can also drag a card onto the video track. The
trash button deletes a clip from the library (and from your PC); if a project uses it, the app
asks first and leaves a gap where it was.

Every way into the library goes through one backend function,
`Library.add_clip(file, source, metadata)` in `backend/app/library/store.py`. It reads the file
with ffprobe, converts it to H.264 if the browser can't play it, makes a thumbnail and records
the source. The coming "Generate shot" button will save ComfyUI results through it too.

### Stock footage (Pexels)

Type a few words under **Stock footage** and press **Search**. Results are portrait videos by
default; **Any** includes wide ones (listed after the portrait ones), which are cropped to 9:16.
Hover a result to preview it. **Add** downloads it into the library: the smallest file that
covers the whole 1080×1920 frame without being scaled up, which means the 1080×1920 file of a
portrait video (its 4K file looks the same in a 1080p Short and is about four times bigger) and
the 4K file of a landscape video, so its 9:16 crop stays sharp. It is always at least 1080
pixels wide when Pexels has such a file.

If the key is missing or Pexels refuses a request, the Media tab shows the reason (no key, key
rejected, rate limit used up, no connection). Free keys allow 200 requests an hour.

### Your own clips (and ComfyUI)

Drop video clips or images on **Your files**, or click it to choose them (MP4, MOV, WebM,
MKV, AVI, GIF, JPG, PNG, WebP). Before importing, each file has an **AI-generated** checkbox. It
is ticked for you when the name looks like a ComfyUI output, such as `LTX_2_5_t2v_00017_.mp4`
or `ComfyUI_00001_.png` (a 5-digit counter with a trailing underscore), or `AnimateDiff_00003.mp4`
(Video Combine) with a video-model name in it. Files the browser can't play (HEVC, ProRes, AVI,
…) are converted to H.264 once, on import; phone videos filmed upright stay upright.

### Auto-fill

**Auto-fill from script** picks search words from each sentence (its nouns, with compounds
like "airplane window" kept together, using spaCy), finds a portrait Pexels video for each
sentence and places it on the timeline from the moment that sentence starts. With captions it
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
  plays slower if it runs out. **Undo/Redo** (Ctrl+Z, Ctrl+Shift+Z) cover all clip edits.
- **9:16 crop.** Every clip fills the 1080×1920 frame and is cropped. Select a clip to set
  which part stays (left–right for wide clips, top–bottom for tall ones) in the timeline
  toolbar, or drag the picture in the preview. Images can be any length.
- **Clip audio** is muted. Select a clip and click **Muted** to keep its sound under the
  voiceover (useful for sound effects in AI clips), with its own volume. You can also change a
  clip's speed there.
- **Preview.** Play shows the clips, voiceover and captions together, kept in step with the
  voiceover.

### AI disclosure

When a project's timeline contains a clip flagged AI-generated, the top bar says **Contains AI**
(with the number of clips) and the **Open project** list marks the project. YouTube asks you to
disclose realistic AI-generated or altered content when you upload; the export (stage 6) will
remind you. The flag is stored once, on the library clip, so changing it there updates every
project that uses the clip. The backend answers the same question for any saved project at
`GET /api/projects/<id>/disclosure` (`app/library/usage.py`, `ai_clips`), which the render will
use.

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
media library (imports, conversion, the AI flag, deleting, AI disclosure), Pexels search and
downloads against a fake Pexels (no key or network needed), Auto-fill, and, once the models
are downloaded, real speech generation and a Kokoro → Whisper → captions round trip.
`npm run test:frontend` runs the frontend unit tests (caption grouping and layout, the
out-of-date check, every timeline edit, snapping, undo, the 9:16 crop, Auto-fill timing and the
ComfyUI file-name check). `npm run test:e2e` drives the real frontend in Chromium against a
fake backend: dragging a clip onto the timeline and playing it, reordering, trimming,
splitting, Pexels results and errors, and imports with the AI flag (on a new machine, first
run `npx playwright install chromium` once inside the `frontend` folder). CI runs it on the newest Python (3.14) only and keeps
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
  app/autofill/         search words per sentence and one clip per sentence
  app/mix/              background music
  tests/                pytest suite
frontend/               React + TypeScript + Vite
  src/components/ui/    shared controls (buttons, tabs, sliders, alerts, ...)
  src/features/         one folder per feature: script, voiceover, mix, media, library,
                        ranking, captions, canvas, preview, timeline, projects, topbar
  src/layout/           left and right side panels
  src/state/            project document, autosave, editor UI state
  src/styles/global.css design tokens; change --accent to re-theme the app
  e2e/                  end-to-end tests (Playwright, fake backend)
scripts/                setup.mjs, dev.mjs, test.mjs (plain Node, no dependencies)
projects/               your saved projects (not committed)
library/                the media library shared by all projects (not committed)
data/                   app-wide data, e.g. the pronunciation list (not committed)
```

## Troubleshooting

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
- **Pexels says the key was rejected**: check `PEXELS_API_KEY` in `.env` (no quotes or spaces)
  and restart the app; `.env` is read when the app starts.
- **An imported clip takes a while**: files the browser can't play (HEVC, ProRes, AVI, …) are
  converted to H.264 on import; the progress bar shows how far along it is.
- **A clip on the timeline says "Missing clip"**: it was deleted from the library. Delete it
  from the timeline or drop another clip in its place.
- **Keyboard**: Space plays/pauses the preview, Delete removes the selected clip, Ctrl+Z and
  Ctrl+Shift+Z undo and redo clip edits (when you aren't typing).
