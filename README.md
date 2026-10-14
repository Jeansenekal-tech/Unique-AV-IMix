# Unique AV IMix

**Unique AV IMix** is a live video production switcher for macOS: mix cameras, video files, graphics and audio with transitions, overlays and titles, and record and live-stream the result. It is modelled on the workflow of Windows production switchers such as vMix, so operators who know that workflow will feel at home.

It is an Electron app. Compositing runs on the GPU (WebGL/Metal), audio mixing uses Web Audio, and FFmpeg handles streaming with Apple VideoToolbox hardware encoding.

![screenshot](docs/screenshot.png)

## Features

### Inputs
| Type | Notes |
|---|---|
| **Camera / capture device** | Webcams, USB/HDMI capture cards, iPhone Continuity Camera, virtual cameras. Choose resolution, frame rate and embedded audio device. |
| **Audio input** | Microphones and audio interfaces, stereo or a single mono channel. |
| **Screen / window capture** | Picker with live thumbnails for every screen and window. |
| **Video file** | MP4, MOV (H.264/HEVC), WebM, MKV and more. Loop, auto play, auto pause and auto restart. |
| **Video list (playlist)** | Plays a list of files in order, with loop and shuffle. |
| **Image** | PNG (with alpha), JPG, GIF (animated), WebP, SVG. |
| **Audio file** | MP3, WAV, AAC, M4A, FLAC and more. |
| **Title / graphics** | 10 animated templates: Lower Third, Modern Lower Third, Headline, Ticker, Clock, Countdown, Scoreboard, Corner Bug, Plain Text and Full Screen Slate. You can change the fonts, colours and alignment. |
| **Colour** | Solid colour backgrounds. |
| **Web browser** | Any web page rendered offscreen, with transparency and custom CSS. Use it for HTML graphics and widgets. |
| **Stream URL** | Direct media URLs. |
| **Instant replay** | Shows the replay buffer as an input. |

Add inputs from the **＋ Add Input** button or the **Input** menu, or drop files onto the inputs area. Drag tiles to reorder them.

### Every input has
* **Position:** zoom, pan, crop, fit/fill/stretch, opacity and PiP presets.
* **Colour correction:** brightness, contrast, saturation, hue and gamma.
* **Keying:** chroma key (green or blue screen, with an eyedropper, similarity, smoothness and spill reduction) and luma key.
* **Layers:** up to 4 other inputs composited on top. Use them for PiP, side-by-side, quad split or virtual sets, with optional borders.
* **Audio:** volume, trim gain, balance, sync delay, 3-band EQ, compressor and noise gate. Routes to Master, Bus A and Bus B, with mute, solo and audio-follows-video.

### Switching
* **Preview / Output** monitors with transport controls (play/pause, seek, next item).
* **Cut**, **Quick Play**, **4 configurable transition buttons** and a **T-bar**.
* **23 transitions:** Fade, Wipe (4 directions), Slide (4), Push (4), Zoom, Cross Zoom, Iris, Dip to Black, Dip to White, Dissolve, Blinds (2) and Cube. There are also **2 stingers**: video files, with alpha via WebM, and a configurable cut point.
* **4 overlay channels** with Fade, Cut, Zoom and Slide in/out effects.
* **Fade to black.**
* Tally on every tile: red when on air, green when in preview.

### Audio mixer
* A channel strip per audio input with peak meters and peak hold, fader, mute, solo, Auto (audio follows video) and M/A/B bus routing.
* Master, Bus A and Bus B strips. Each output (recording, stream, speaker monitor) can take its audio from any bus.

### Outputs
* **Record** to MP4 (H.264/AAC) or WebM. Files are finalised with FFmpeg so they seek correctly.
* **Stream** to up to 3 destinations at once over RTMP, RTMPS or SRT. Presets cover YouTube, Twitch, Facebook and Restream. Encoding uses Apple VideoToolbox (hardware) or x264.
* **External output:** full-screen program output on any display, for projectors and LED walls.
* **Multiview output:** preview, program and every input with tally and labels on a second display.
* **Snapshot:** saves a PNG of the output.
* **Instant replay:** a rolling buffer of the output or any input. Play back the last N seconds in slow motion (0.1×–1×) and save Mark In/Out events.

### Automation and remote control
* **Keyboard shortcuts.** You can fully customise them, and a learn mode captures new keys.
* **MIDI control.** Learn mode supports notes and CCs, and CCs can drive faders and the T-bar.
* **Scripting** in JavaScript, for example `await API.Function('Fade', {Input: 2})`, plus `sleep()` and `log()`.
* **HTTP API** on port 8088, for example `GET /api?Function=Cut&Input=2`. It also serves XML state at `/api`, JSON at `/api/state.json` and a live snapshot at `/api/snapshot.jpg`.
* **TCP API** on port 8099: `FUNCTION`, `XML`, `TALLY` and `SUBSCRIBE TALLY`.
* The API uses the function names and XML layout that common switcher control surfaces expect, so tools such as Bitfocus Companion and Stream Deck can drive it.
* **Web controller:** open `http://<mac-ip>:8088/` on a phone or tablet. You can switch inputs, run overlays, edit titles, mix audio and start or stop the recording and stream. LAN access and a password are configured in *Settings → Web & API*.

### Projects
* Save and open a whole production as an `.imix` file: inputs, settings, transitions, overlays, stingers, stream destinations, shortcuts and scripts.
* The last session is restored automatically on launch.
* Output formats: 720p, 1080p, 1440p, 4K, vertical 1080×1920, square and PAL SD, at 24, 25, 30, 50 or 60 fps.

## Installing on a Mac

1. Download the `.dmg` for your Mac from the GitHub Actions build artifacts or a release. Use **arm64** for Apple Silicon (M1–M4) and **x64** for Intel.
2. Drag **Unique AV IMix** to Applications.
3. Builds are unsigned unless you add signing certificates, so the first time you open the app, right-click it and choose **Open**. You can also run:
   ```sh
   xattr -dr com.apple.quarantine "/Applications/Unique AV IMix.app"
   ```
4. Allow **Camera**, **Microphone** and **Screen Recording** when macOS asks. You can change these later in *System Settings → Privacy & Security*.

FFmpeg is bundled in the app. You can point to another FFmpeg build in *Settings → Streaming*, for example one installed with `brew install ffmpeg`.

## Building from source

```sh
npm install          # installs Electron, electron-builder and ffmpeg-static
npm start            # run the app
npm run dist:mac     # build .dmg + .zip into dist/ (run on a Mac)
```

Every push runs `.github/workflows/build-mac.yml`. It runs the tests and then builds Apple Silicon and Intel `.dmg` files. To sign and notarise the builds, add the `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` repository secrets.

### Tests
```sh
node test/browser-smoke.mjs                 # UI + engine in headless Chromium (needs playwright + ffmpeg)
xvfb-run -a node test/electron-smoke.mjs    # full app: HTTP/TCP API, recording, FFmpeg streaming, browser input
```

## Keyboard shortcuts (defaults)

| Key | Action |
|---|---|
| Space | Transition 1 |
| Enter | Cut |
| Q / W / E | Transitions 2–4 |
| 1–9 | Put that input in Preview |
| ⇧ 1–9 | Cut that input to Output |
| F1–F4 | Toggle overlay 1–4 with the Preview input |
| B | Fade to black |
| ⌘R / ⇧⌘R | Record / Stream |
| ⌘S / ⌘O | Save / Open project |

Click a tile to put it in Preview. Double-click a tile to open its settings, and right-click it for more actions.

## API quick reference

```
GET http://127.0.0.1:8088/api?Function=PreviewInput&Input=3
GET http://127.0.0.1:8088/api?Function=Fade&Duration=500
GET http://127.0.0.1:8088/api?Function=OverlayInput1In&Input=Lower%20Third
GET http://127.0.0.1:8088/api?Function=SetText&Input=4&SelectedName=Name&Value=Jane
GET http://127.0.0.1:8088/api?Function=SetVolume&Input=2&Value=80
GET http://127.0.0.1:8088/api?Function=StartStopRecording
GET http://127.0.0.1:8088/api                      → XML state
```

`Input` accepts an input's number, its title or its key. The full list of more than 150 functions is under *Help → API Reference* in the app.

## Architecture

```
main.js                 Electron main: windows, menus, permissions, IPC
main/protocol.js        imix:// scheme – serves the UI and local media (with Range support)
main/ffmpeg.js          FFmpeg discovery, live streaming (tee muxer → RTMP/SRT), remux
main/api-server.js      HTTP + TCP control API and web controller
main/browser-input.js   Offscreen Chromium pages for web browser inputs
preload.js              window.imix bridge
src/engine/mixer.js     Production state machine + render loop (worker-timed)
src/engine/compositor.js  WebGL compositor: inputs → layers → preview/program, transitions, overlays
src/engine/gl.js        GLSL: colour correction, chroma/luma key, 11 transition shaders
src/engine/inputs.js    Input types
src/engine/audio.js     Web Audio mixer (EQ, compressor, gate, delay, buses, meters)
src/engine/titles.js    Title templates
src/engine/outputs.js   Recording, streaming, external/multiview output, snapshots
src/engine/replay.js    Instant replay buffer
src/engine/api.js       Function dispatcher + XML/JSON state
src/engine/automation.js  Shortcuts, MIDI, scripting
src/ui/*                Interface
src/web/index.html      Remote web controller
```

## Not included (yet)

vMix has had more than 15 years of development, and some of its features depend on proprietary SDKs or Windows-only drivers. These are **not** in this version:

* **NDI** inputs and outputs (needs the NDI SDK).
* **SRT / RTMP inputs** (receiving streams). SRT and RTMP *outputs* are supported.
* **Virtual camera output** into Zoom or Teams (needs a signed macOS camera extension).
* **Video calls** (vMix Call), **PTZ camera control**, **3D virtual sets**, **multi-camera ISO recording** (MultiCorder), a visual **title designer** (GT Designer), **VST audio plugins** and **data sources** for titles.
* Instant replay records one source at a time. vMix can record up to 8 cameras.

The engine is modular, with one class per input or output, so each of these can be added on its own later.
