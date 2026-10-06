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
| 4 | Media tab (Pexels and uploads) and timeline | next |
| 5 | Canvas & title, Ranking tab | |
| 6 | FFmpeg render | |

Working now: the full layout, autosaved projects, the script box, all three ways to make a
voiceover (AI read, recording, upload) plus background music, and word-timed captions drawn
in the preview as it plays. Buttons for later stages (Search, Render, …) are shown but
disabled.

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

Text goes through three steps before Kokoro speaks it:

1. **Normalization** (`backend/app/voiceover/normalize.py`): rewrites what speech engines read
   badly, such as units glued to numbers (`16GB` → "16 gigabytes", `450W`, `2.5GHz`), ranges
   (`5-10` → "5 to 10"), clock times, `9:16`, `#1` → "number 1", `2x`, `$1.5B` and emojis.
2. **misaki**, Kokoro's own grapheme-to-phoneme library: a pronunciation dictionary with
   part-of-speech-aware heteronyms ("read", "live"), and number reading ("9060" → "ninety
   sixty", "1080p" → "ten eighty p"). Words it doesn't know go to **espeak-ng**.
3. Kokoro turns the phonemes into audio, a couple of sentences at a time.

misaki is the G2P Kokoro was trained with, so it gives the best results, but its PyPI package
refuses to install on Python 3.13+. Its English part is pure Python and its dependencies (spaCy,
espeak-ng) all support Python 3.14, so a copy lives in `backend/app/voiceover/misaki`
(Apache 2.0, changes marked "Shorts Creator:").

If a word comes out wrong, the easiest fix is to spell it the way it sounds in the script. For
exact control, misaki's override syntax works too: `[Kokoro](/kˈOkəɹO/)`.

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
- After you change the script and regenerate the voiceover, the panel tells you the captions
  are out of date: regenerate them.

The model is set by `WHISPER_MODEL` in `.env` (`small.en` by default; `base.en` is faster,
`medium.en` more accurate). It always runs on the CPU.

The caption and title fonts (Montserrat, Anton, Bebas Neue, Poppins, Archivo Black, Bangers,
Oswald, Inter) are bundled in `backend/app/fonts` under the SIL Open Font License. The preview
and the final render use the same font files, so text looks the same in both.

### Projects

Projects save themselves about a second after every change, to
`projects\<id>\project.json`. Click the project name in the top bar to rename it, start a
**New project**, or **Open** an earlier one. The app reopens your last project on start.

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
engine and its DirectML-to-CPU fallback, voiceover and music uploads, caption alignment, and,
once the models are downloaded, real speech generation and a Kokoro → Whisper → captions
round trip. `npm run test:frontend` runs the frontend unit tests (caption grouping, editing
and layout). CI runs it on the newest Python (3.14) only and keeps
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
  app/mix/              background music
  tests/                pytest suite
frontend/               React + TypeScript + Vite
  src/components/ui/    shared controls (buttons, tabs, sliders, alerts, ...)
  src/features/         one folder per feature: script, voiceover, mix, media,
                        ranking, captions, canvas, preview, timeline, projects, topbar
  src/layout/           left and right side panels
  src/state/            project document, autosave, editor UI state
  src/styles/global.css design tokens; change --accent to re-theme the app
scripts/                setup.mjs, dev.mjs, test.mjs (plain Node, no dependencies)
projects/               your saved projects (not committed)
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
- **Keyboard**: Space plays/pauses the preview (when you aren't typing).
