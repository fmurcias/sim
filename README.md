# FPV Sim

A browser-based free FPV (first-person view) drone racing simulator in **acro/balance mode**, rendered to look like real FPV footage: photographed HDR skies, cascaded sun shadows, a textured flying field with real grass and procedural trees, and a camera model with auto exposure, motion blur and a wide FPV lens. No build step, no framework, any device, any gamepad — it is a static site: [index.html](index.html), ES modules in [src/](src/) and assets in [assets/](assets/), installable and playable offline (see below).

![alt text](assets/collage.png)

## Running it

Serve the folder with any static web server and open it — nothing to install, nothing to build:

```
python3 -m http.server 8000      # then open http://localhost:8000
```

(Browsers refuse to load ES modules and textures from `file://`, so double-clicking `index.html` no longer works — the page says so if you try. Any static host such as GitHub Pages works as-is.)

It also installs as an app (see [Installing](#installing--offline-use)) for a full-screen, offline-capable experience on both desktop and mobile.

## Controls

### Keyboard

| Action | Keys |
|---|---|
| Throttle up / down | `SPACE` / `SHIFT` |
| Pitch (forward/back) | `W` / `S` |
| Roll (left/right) | `A` / `D` |
| Yaw (rotate) | `Q` / `E` |
| Camera tilt | `↑` / `↓` |
| Field of view (FOV) | `←` / `→` |
| Reset run / world | `R` |
| Open settings | `M` or the ⚙ button |
| Close settings | `ESC` |
| Show keybind hint again | `?` |
| Performance overlay (FPS, draw calls, resolution) | `P` |

### Gamepad

Plug in a controller and it's used automatically (Mode 2 layout by default: left stick = throttle/yaw, right stick = pitch/roll). A connected controller takes over as soon as you actually move a stick — leaving one plugged in but idle doesn't disable the keyboard, and any keypress hands control back. Use the **CONTROLLER** settings tab to remap axes if the defaults don't match your stick, including an auto-detect wizard (see below).

### Touch (phone / tablet)

Two on-screen sticks appear automatically on touch devices, laid out like Mode 2:

- **Left stick** — throttle (vertical) and yaw (horizontal). The throttle axis is **self-latching**: it stays where you leave it, like a real throttle stick. Yaw springs back to centre.
- **Right stick** — pitch and roll, both self-centering.

Extra **MODE** and **↺** buttons appear in the HUD button row for the flight-mode and reset actions that would otherwise need a keyboard. Set **Virtual sticks** in **CONTROLLER** settings to `ALWAYS ON` / `OFF` to override the automatic detection.

### Flight modes

Click the mode badge (bottom-left of the HUD, or bottom-centre with the touch sticks up) to switch between:

- **ACRO** — pure rate control. Sticks command rotation speed; the drone holds whatever angle you leave it at. No self-leveling.
- **BALANCED** — angle/self-leveling mode. Sticks command a target bank/pitch angle and the drone levels itself out when the stick is centered. Easier for beginners.

## HUD

- **Telemetry** (top-left): speed, altitude, throttle %, camera tilt, FOV.
- **Gate + lap counter** (top-center): current gate / total gates, and the current lap number.
- **Lap timer** (below the gate counter) — see [Lap timing](#lap-timing).
- **Attitude Indicator (ADI)** — the circular artificial-horizon dial (bottom-right) showing roll and pitch.
- **FPV attitude overlay** — a horizon bar across the center of the view (tilts with roll, slides with pitch) plus two side gauges for pitch and roll with a numeric readout. Toggle it on/off in **GENERAL** settings.
- **Throttle bar** (left edge; hidden when the touch sticks are up, since the left stick shows it).
- **Crash banner** — names what you hit (gate, tree, ground or obstacle) and shows a countdown bar until the respawn.
- 🔊 mute engine sound, ⤢ toggle fullscreen, ⚙ open settings.

The keybind hint along the bottom fades out after ~15 seconds of flight. Press `?` or open settings to bring it back.

## Flying the circuit

Fly through the numbered gates in order — passing through the center of the current gate advances you to the next one. The next gate's LED strip glows yellow, gates still to come glow a dim orange, and passed gates turn green. Clipping a gate's padded frame or its pole, hitting a tree, hitting the ground hard, or flying into the pilots' tents, flags, cones or floodlight towers triggers a crash.

The field is not flat: it has gentle relief, rolling hills beyond the course and a hazy ridge line on the horizon. Altitude (`ALT`) is measured above the ground directly below you.

After a crash you respawn **just short of the gate you were heading for, facing it**, so a late mistake costs you a few seconds rather than the whole run — your gate progress and lap clock are preserved. Press `R` for a full restart (and to reshuffle the gate layout, unless disabled — see below).

## Lap timing

A lap runs from crossing gate 1 to crossing gate 1 again.

- The **running lap time** starts on your first gate and keeps counting through crashes — the respawn delay is the penalty.
- Each gate posts a **split**, and the `+/-` figure next to `BEST` shows how far ahead (green) or behind (red) that split is versus your best lap.
- Completing a lap flashes the time and compares it to your **best lap**, which persists in `localStorage`.
- A lap in which you crashed is **dirty**: the clock turns red and that lap cannot set a new best, though it still displays.

Clear the stored best from **GENERAL → LAP TIMING**.

## Settings (⚙ / `M`)

Close the panel with **▶ FLY**, `ESC`, `M`, or a click outside it.

Most sections have a small **ⓘ** button next to their title. Click it for an in-app explanation of what that section does; the button fills in while its note is open. Notes are collapsed by default so the controls all fit on one screen, and whichever ones you leave open are remembered between sessions. Everything they say is also covered — usually in more detail — in the sections below.

The two **ADVANCED SETTINGS** blocks (in CONTROLLER and PHYSICS) collapse the same way and likewise remember their state.

### CONTROLLER

**Quick setup — AUTO-DETECT ALL**: runs a wizard that steps through each channel and samples ~2.5s of stick movement to infer its axis index and sign (inverted or not) automatically. Each channel also has its own individual **DETECT** button in the advanced table below if you only need to redo one.

**Virtual sticks** — `AUTO` (touch devices only, the default), `ALWAYS ON`, or `OFF`. See [Touch](#touch-phone--tablet).

**Manual / advanced settings** — expand for the raw axis mapping:

| Channel | Controls | Default stick |
|---|---|---|
| Throttle | Vertical thrust | Left stick ↑↓ |
| Yaw | Rotate around the vertical axis | Left stick ←→ |
| Roll | Tilt sideways | Right stick ←→ |
| Pitch | Tilt forward/back | Right stick ↑↓ |

Each channel row lets you pick the physical **axis index**, an **invert** checkbox, and shows a **live value bar** fed by the raw gamepad signal, plus its own DETECT button.

- **Deadzone (deadband)** — ignores stick input below this threshold, so a controller that doesn't rest exactly at center (drift) doesn't produce phantom input. 0–25%, default 5%.

### PHYSICS

Four presets tune how the drone feels:

| Preset | Feel |
|---|---|
| **Beginner** | Smooth, stable flight, moderate thrust, slow turns |
| **Racing** | The classic agile-but-controllable balance |
| **Freestyle** | Maximum angular agility for flips and acro tricks |
| **Cinematic** | Slow, smooth movements for relaxed camera shots |

The simulator actually starts on a tuned **default** configuration that doesn't exactly match any preset (punchy but controllable) — it's what you get on first load, before picking a preset or touching a slider.

**Advanced settings (sliders)** — fine-tune any parameter individually. Changes apply live and **autosave** about half a second after you stop dragging (any manual tweak un-marks the active preset); the **SAVE** button is an explicit "commit now" that stamps the time in the footer:

| Slider | What it controls | Range | Default |
|---|---|---|---|
| Idle (motors armed at 0%) | Minimum thrust the motors produce even with the stick at zero — armed motors never truly cut out mid-flight | 0–30% | 1% |
| Power (TWR) | Engine power vs. weight (thrust-to-weight ratio) — higher means more punch and faster climbs | ×1.7–×10 | ×5.3 |
| Hover stick % | Where on the throttle stick's travel the drone hovers in place, independent of TWR | 30–70% | 50% |
| Linear drag | Air resistance opposing velocity — higher feels like flying underwater (kills momentum fast), lower feels floaty/weightless | 0.01–0.60 | 0.14 |
| Roll/pitch rates | Maximum rotation speed at full roll/pitch stick deflection | 100–1200°/s | 620°/s |
| Yaw rate | Maximum rotation speed at full yaw stick deflection | 50–720°/s | 400°/s |
| Response (snap) | How quickly rotation speed reacts to stick input — higher feels snappier and more direct | 5–50 | 41 |
| Angular drag | Braking applied to rotation — higher stops spins/flips faster | 0.70–1.00 | 0.90 |

A live **analysis panel** below the sliders derives human-readable stats from the current configuration — thrust-to-weight ratio, max net acceleration, approximate terminal velocity, and a qualitative note on how the current drag/thrust combo will feel.

### CAMERA

A model of a real FPV camera. Everything here needs graphics quality MEDIUM or higher (LOW skips post-processing).

| Setting | What it controls | Options | Default |
|---|---|---|---|
| Camera tilt | Cockpit view angle — how far the camera looks down/up relative to the drone's nose | 0–90° | 20° |
| Field of view | How wide the centre of the image is | 50–120° | 85° |
| Lens | `FPV WIDE` bends straight lines toward the frame edges like a real ~150° FPV lens; `RECTILINEAR` keeps them straight | FPV WIDE / RECTILINEAR | FPV WIDE |
| Motion blur | Follows a real shutter: racers fly unfiltered (fast shutter, crisp); freestyle pilots add ND filters for smooth blurred footage | OFF / NO ND 1/1000 s / ND8 1/250 s / ND16 1/120 s | ND8 |
| Colour | Colour profile of the feed | DIGITAL HD / ACTION CAM / FLAT-LOG | DIGITAL HD |
| Video feed | `ANALOG` simulates a 5.8 GHz analog link: 480 lines, colour smear and static that grows with range from the launch pad and when trees block the line of sight | DIGITAL / ANALOG | DIGITAL |
| Auto exposure | Meters the scene like a real camera: pitch up into the sky and the ground darkens; dive into shade and it opens up (with more sensor noise) | on / off | on |
| Camera shake | Motor vibration plus propwash wobble when you descend through your own wash — visual only, never affects physics. 0 turns it off | 0–100% | 35% |

Tilt and FOV are also bound to `↑`/`↓` and `←`/`→` while flying, and everything persists between sessions.

### GENERAL

- **Environment** — `MIDDAY`, `GOLDEN HOUR`, `OVERCAST` or `NIGHT`. Each is a real photographed HDR sky (Poly Haven, CC0) that lights the whole scene, sets the sun position and shadows, and tints the distant haze. NIGHT is moonlit, with floodlight towers around the course, glowing gate LEDs and grainier camera sensor noise. Each preset remembers its own "show trees" preference.
- **Graphics quality** — one setting drives resolution, anti-aliasing, shadow cascades, ambient occlusion, camera effects and grass density. Defaults to LOW on every device (step up if your GPU has headroom — the `P` overlay shows the frame rate), and applies instantly:

  | Tier | Meant for | Shadows | Ambient occlusion | Grass | Notes |
  |---|---|---|---|---|---|
  | LOW | weak phones | none | none | none | no post-processing at all |
  | MEDIUM | phones | 1 cascade | none | light | SMAA, lower render scale when frames run long |
  | HIGH | laptops / integrated GPUs | 2 cascades | half-res | dense | 4× MSAA, lower render scale when frames run long |
  | ULTRA | discrete GPUs | 3 cascades | full-res | densest | 4× MSAA, 2× pixel ratio |

- **Map** — appears only when captured real-world maps are installed (see [Captured maps](#captured-maps)). `FIELD` is the procedural flying field.
- **Lap timing** — shows the stored best lap and a **CLEAR BEST** button.
- **Randomize world on every reset** — when on, pressing `R` reshuffles gates and trees along with your position. Turn it off to keep the same layout (R only resets your position); reshuffle manually with the **RANDOMIZE NOW** button that appears. Default: on.
- **Show attitude HUD (pitch/roll)** — toggles the FPV horizon bar and side gauges described above. Default: on.
- **Show trees** — draws the trees around the course and the woods beyond it. Hidden trees never collide, whatever "Collide with trees" is set to. Default: on, and each environment remembers your choice separately.
- **Collide with gates** — when on, clipping a gate's frame or support pole triggers a crash instead of only counting a pass when you go through the center. Turn off to fly through gate frames freely. Default: on.
- **Collide with trees** — when on, touching a tree's trunk or foliage triggers a crash. Turn off to fly through the scenery — handy for practicing lines without being punished for clipping trees. Default: on.

### Footer

- **↺ RESET** returns the physics sliders to the tuned default. It asks once — the button changes to `↺ CONFIRM?` for a few seconds, and only a second click actually resets.
- **💾 SAVE** commits immediately and stamps the time. It's optional: physics autosaves on its own, and every other setting writes through the moment you change it.
- **▶ FLY** closes the panel.

All settings persist automatically in your browser (`localStorage`) — no account or save file needed. Nothing leaves your machine.

## How it looks real

A short tour of what replaced the flat-colour look (details in the module headers):

- **Light** — each environment is a photographed HDR sky ([src/render/sky.js](src/render/sky.js)). It is shown as the background, pre-filtered into image-based lighting for every material, and its sun is measured (direction, colour, energy) to drive a shadow-casting sun with camera-following cascaded shadow maps ([src/render/environment.js](src/render/environment.js)). Distant terrain fades into height fog tinted by the same sky.
- **Ground** — a single warped terrain mesh from the course out to a 3.5 km horizon, textured by blending four scanned CC0 materials with anti-tiling and a worn racing line generated from the gate layout ([src/render/terrain.js](src/render/terrain.js)). Physics lands on exactly the triangles you see.
- **Vegetation** — GPU-placed grass that sways, glows when back-lit and flattens under your prop wash ([src/render/grass.js](src/render/grass.js)); procedural oak, ash, aspen and pine trees with baked impostors for the distant woods ([src/render/vegetation.js](src/render/vegetation.js)).
- **Race day** — padded fabric gates with LED strips ([src/render/gates.js](src/render/gates.js)), a pilots' area with tents, feather flags, cones and a safety net, prop-wash dust, and the drone's own shadow chasing you across the grass ([src/render/props.js](src/render/props.js)).
- **Camera** — auto exposure, shutter-accurate motion blur, bloom, AgX tone mapping, colour profiles, barrel lens distortion with chromatic aberration, sensor grain and an optional analog feed ([src/render/post.js](src/render/post.js)).

Everything runs in the browser on three.js r184 (WebGL2); the libraries are pinned in the import map in [index.html](index.html). Asset credits and licences are in [assets/CREDITS.md](assets/CREDITS.md).

## Captured maps

Real places can be flown as photographic Gaussian-splat scans (rendered with [Spark](https://sparkjs.dev)). None ship with the simulator; add your own by following [assets/maps/README.md](assets/maps/README.md) — capture, optional low-poly collider, gate positions, and one entry in `assets/maps/maps.json`. Any capture can be previewed straight away with `?splat=path/to/capture.spz`.

## Installing / offline use

The site is a PWA (Progressive Web App): a **service worker** ([sw.js](sw.js)) caches the page and everything it needs — its modules, the pinned libraries from the jsDelivr CDN, and the sky and terrain assets (about 20 MB) — the first time you visit. After that, reloading or reopening the site works **with no internet connection at all**, whether or not you've formally "installed" it.

Installing just adds a proper icon and drops the browser chrome (address bar, tabs) for a full-screen, app-like window:

| Platform | How |
|---|---|
| **Android** (Chrome / Edge / Samsung Internet) | Tap **⋮ → Install app** (or the install banner Chrome shows automatically). Launches full-screen, locked to landscape. |
| **Desktop** (Chrome / Edge, Windows / macOS / Linux / ChromeOS) | Click the **install icon** in the address bar (or **⋮ → Install FPV Sim…**). Opens in its own app window. |
| **iOS / iPadOS** (Safari) | **Share → Add to Home Screen**. This is Apple's own mechanism — Safari doesn't show an automatic install prompt like Chrome does, so it's a manual step every time on a new device. |
| **Firefox desktop** | No install button (Mozilla dropped desktop PWA install UI), but the site still works fully — including offline — in a regular tab. |

You don't need to install it for the offline behavior — just visiting the page once while online is enough for the service worker to take over. Installing only changes how it's launched afterward.

**Updating**: the service worker serves the cached copy instantly and re-fetches the latest version in the background for *next* time (a "stale-while-revalidate" cache), so you'll always be at most one visit behind the live site — no manual refresh trick needed.

## Development tools

Everything in [tools/](tools/) is optional and only for working on the simulator:

| Tool | What it does |
|---|---|
| `node tools/shot.mjs --shots tools/shots.json --out shots/` | Headless-Chrome screenshots from fixed viewpoints (`?seed=` makes the world reproducible) for before/after comparisons; fails on any console error |
| `node tools/shot.mjs --test tools/physics-test.js` | Physics and collision regression tests (climb, landing on slopes, gate passes, gate/tree/obstacle crashes, respawn) |
| `node tools/offline-test.mjs` | Loads once, cuts the network, reloads, and checks the simulator still starts |
| `python3 tools/prep_sky.py <sky.hdr> assets/env/<name>` | Converts a Poly Haven HDRI into the compact sky format (8-bit base + gain map + measured sun) |
| `python3 tools/prep_textures.py <ambientcg dir> <id> assets/textures <name>` | Packs an ambientCG PBR set into albedo + normal/roughness JPEGs |

URL parameters useful while developing: `?seed=N`, `?env=midday|golden|overcast|night`, `?q=low|medium|high|ultra`, `?stats=1`, `?autostart=1`, `?splat=<url>`.

## Notes

The simulation runs on a **fixed 1/120s timestep** with an accumulator, so flight feel and collision accuracy don't change with your frame rate — a slow machine renders fewer frames rather than running the physics in slow motion or letting a fast drone tunnel through a gate bar.

The 3D libraries are loaded from a CDN on first visit and cached by the service worker from then on (see [Installing / offline use](#installing--offline-use)). If the very first load fails to reach the CDN — no cache yet and no connection — the page says so instead of showing a black screen.
