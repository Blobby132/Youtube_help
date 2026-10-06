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
| 2 | Script panel and voiceover (Kokoro AI read, record, upload) | next |
| 3 | Captions with faster-whisper and caption preview | |
| 4 | Media tab (Pexels and uploads) and timeline | |
| 5 | Canvas & title, Ranking tab | |
| 6 | FFmpeg render | |

In stage 1 the layout is complete. The script box, voice picker, sliders, caption style,
canvas and title settings already save with the project. Buttons for features from later
stages (Generate AI read, Search, Render, …) are shown but disabled.

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

`npm run setup` (or double-click `setup.bat`) creates a Python environment in
`backend\.venv`, installs the Python and npm packages, and creates a `.env` file.
Run it again whenever you pull an update.

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
CI runs it on the newest Python (3.14) only, plus a lint and type-checked build of the
frontend.

## Project layout

```
backend/                FastAPI app (Python)
  app/core/             settings, logging, error handling, health check
  app/projects/         project storage (projects/<id>/project.json)
  app/voiceover/        Kokoro voices (TTS arrives in stage 2)
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
  installing, or follow the manual steps above.
