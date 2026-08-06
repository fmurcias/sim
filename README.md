# FPV Sim

A browser-based FPV (first-person view) drone racing simulator in **acro/balance mode**. No install, no build, any device, any gamepad — it's a single HTML file.

## Running it

Open [fpv_sim_v5.html](fpv_sim_v5.html) directly in a browser.

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
| Reset drone / world | `R` |
| Open settings | `M` or the ⚙ button |

### Gamepad

Plug in a controller and it's used automatically (Mode 2 layout by default: left stick = throttle/yaw, right stick = pitch/roll). Gamepad input overrides keyboard whenever a controller is connected. Use the **CONTROLLER** settings tab to remap axes if the defaults don't match your stick, including an auto-detect wizard (see below).

### Flight modes

Click the mode badge (bottom-left of the HUD) to switch between:

- **ACRO** — pure rate control. Sticks command rotation speed; the drone holds whatever angle you leave it at. No self-leveling.
- **BALANCED** — angle/self-leveling mode. Sticks command a target bank/pitch angle and the drone levels itself out when the stick is centered. Easier for beginners.

## HUD

- **Telemetry** (top-left): speed, altitude, throttle %, camera tilt, FOV.
- **Gate counter** (top-center): current gate / total gates.
- **Attitude Indicator (ADI)** — the circular artificial-horizon dial (bottom-right) showing roll and pitch.
- **FPV attitude overlay** — a horizon bar across the center of the view (tilts with roll, slides with pitch) plus two side gauges for pitch and roll with a numeric readout. Toggle it on/off in **GENERAL** settings.
- **Throttle bar** (left edge).
- 🔊 mute engine sound, ⤢ toggle fullscreen, ⚙ open settings.

## Flying the circuit

Fly through the numbered gates in order — passing through the center of the current gate advances you to the next one. Clipping a gate's frame/pole, or hitting the ground hard, triggers a crash and respawn. Press `R` to reset your position (and reshuffle the gate layout, unless disabled — see below).

## Settings (⚙ / `M`)

### CONTROLLER

**Quick setup — AUTO-DETECT ALL**: runs a wizard that steps through each channel and samples ~2.5s of stick movement to infer its axis index and sign (inverted or not) automatically. Each channel also has its own individual **DETECT** button in the advanced table below if you only need to redo one.

**Camera & view** (works without a gamepad, including on mobile):

| Setting | What it controls | Range | Default |
|---|---|---|---|
| Camera tilt | Cockpit view angle — how far the camera looks down/up relative to the drone's nose | 0–90° | 20° |
| Field of view | Camera FOV — wider feels more "fisheye" and fast, narrower feels more zoomed-in | 50–120° | 85° |

Both are also bound to `↑`/`↓` (tilt) and `←`/`→` (FOV) while flying.

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

**Advanced settings (sliders)** — fine-tune any parameter individually; any manual tweak is tracked as "unsaved" (and un-marks the active preset) until you hit **SAVE**:

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

### GENERAL

- **Randomize world on every reset** — when on, pressing `R` reshuffles gates and trees along with your position. Turn it off to keep the same layout (R only resets your position); reshuffle manually with the **RANDOMIZE NOW** button that appears. Default: on.
- **Show attitude HUD (pitch/roll)** — toggles the FPV horizon bar and side gauges described above. Default: on.
- **Collide with gates** — when on, clipping a gate's frame or support pole triggers a crash instead of only counting a pass when you go through the center. Turn off to fly through gate frames freely. Default: on.
- **Collide with trees** — when on, touching a tree's trunk or foliage triggers a crash. Turn off to fly through the scenery — handy for practicing lines without being punished for clipping trees. Default: on.

All settings persist automatically in your browser (`localStorage`) — no account or save file needed.
